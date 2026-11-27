import nodemailer from 'nodemailer';
import { getDb, getSetting } from '../db.js';
import { getMailboxById } from '../mailboxes/accounts.js';
import { checkMailboxCapacity, isWithinSendWindow } from '../mailboxes/limits.js';
import { isSuppressed, addSuppression } from './suppression.js';
import { renderSpintax, renderVariables, injectTrackingAndFooter, rewriteLinks, htmlToPlainText } from './render.js';
import { prepareTracking, registerTrackingLink } from './tracking.js';
import { sendQueue } from '../queue.js';
import { generateToken } from '../crypto.js';

let engineInterval = null;
let isProcessingTick = false;

// Memory map of last send timestamp per mailbox ID to enforce gap spacing
const mailboxLastSendMap = new Map();

/**
 * Calculate random send gap between min and max seconds
 */
export function calculateRandomSendGap(minSeconds, maxSeconds) {
  const min = Math.max(1, parseInt(minSeconds, 10) || 90);
  const max = Math.max(min, parseInt(maxSeconds, 10) || 240);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Perform a single execution tick of the campaign sending scheduler
 * @param {Object} [options] Options for testing (e.g. mockSend, ignoreSchedule, ignoreGaps)
 */
export async function runSchedulerTick(options = {}) {
  if (isProcessingTick && !options.force) {
    return { skipped: true, reason: 'Tick already in progress' };
  }
  isProcessingTick = true;

  const results = {
    processedCampaigns: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0
  };

  try {
    const db = getDb();
    const postalAddress = getSetting('postal_address') || '';

    // 2.8 Sweeper: any lead_step in 'claimed' for > 10 min
    // without message_id -> release to pending; with message_id -> mark sent
    db.prepare(`
      UPDATE lead_steps
      SET status = 'pending', mailbox_id = NULL, last_error = 'Swept: claimed > 10m without message_id'
      WHERE status = 'claimed'
        AND scheduled_at <= datetime('now', '-10 minutes')
        AND (message_id IS NULL OR message_id = '')
    `).run();

    db.prepare(`
      UPDATE lead_steps
      SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = 'Swept: claimed > 10m with message_id'
      WHERE status = 'claimed'
        AND scheduled_at <= datetime('now', '-10 minutes')
        AND message_id IS NOT NULL AND message_id != ''
    `).run();

    // Fetch active running campaigns
    const runningCampaigns = db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all();
    results.processedCampaigns = runningCampaigns.length;

    for (const campaign of runningCampaigns) {
      // 1. Check schedule window (unless explicitly bypassed in tests)
      if (!options.ignoreSchedule) {
        const schedule = {
          timezone: campaign.timezone,
          send_days: JSON.parse(campaign.send_days_json || '[1,2,3,4,5]'),
          window_start: campaign.window_start,
          window_end: campaign.window_end
        };
        if (!isWithinSendWindow(schedule)) {
          continue;
        }
      }

      // 2. Fetch assigned mailboxes for campaign
      const mbRows = db.prepare('SELECT mailbox_id FROM campaign_mailboxes WHERE campaign_id = ?').all(campaign.id);
      if (mbRows.length === 0) continue;

      const availableMailboxes = [];
      for (const row of mbRows) {
        const mb = getMailboxById(row.mailbox_id, true);
        if (!mb) continue;
        const capacity = checkMailboxCapacity(mb);
        if (capacity.canSend) {
          availableMailboxes.push({ mailbox: mb, capacity });
        }
      }

      if (availableMailboxes.length === 0) {
        // No mailboxes currently have sending allowance
        continue;
      }

      // 3. Fetch candidate lead steps due for sending
      const candidateSteps = db.prepare(`
        SELECT ls.*, l.email as lead_email, l.first_name, l.last_name, l.company, l.custom_fields_json,
               l.status as lead_status, ss.step_number, ss.condition,
               sv.subject, sv.body_html, sv.body_text
        FROM lead_steps ls
        JOIN leads l ON l.id = ls.lead_id
        JOIN sequence_steps ss ON ss.id = ls.sequence_step_id
        JOIN step_variants sv ON sv.id = ls.variant_id
        WHERE ls.campaign_id = ?
          AND (
            (ls.status = 'pending' AND ls.scheduled_at <= datetime('now'))
            OR (ls.status = 'retrying' AND ls.next_retry_at <= datetime('now'))
          )
        ORDER BY ls.scheduled_at ASC
        LIMIT 25
      `).all(campaign.id);

      if (candidateSteps.length === 0) continue;

      let rotationIndex = 0;

      for (const step of candidateSteps) {
        const email = (step.lead_email || '').toLowerCase().trim();

        // Safety check 1: Lead status & Global suppression
        if (isSuppressed(email) || step.lead_status === 'unsubscribed' || step.lead_status === 'bounced') {
          db.prepare("UPDATE lead_steps SET status = 'skipped', last_error = 'Suppressed or inactive' WHERE id = ?").run(step.id);
          results.skipped++;
          continue;
        }

        // Safety check 2: Condition "if_no_reply"
        if (step.condition === 'if_no_reply') {
          const replyExists = db.prepare(`
            SELECT id FROM replies
            WHERE lead_id = ?
              AND lead_step_id IN (SELECT id FROM lead_steps WHERE campaign_id = ?)
              AND is_auto_reply = 0
            LIMIT 1
          `).get(step.lead_id, campaign.id);

          if (replyExists) {
            db.prepare("UPDATE lead_steps SET status = 'skipped', last_error = 'Recipient replied' WHERE id = ?").run(step.id);
            results.skipped++;
            continue;
          }
        }

        // Pick next available mailbox
        const currentMbEntry = availableMailboxes[rotationIndex % availableMailboxes.length];
        const selectedMailbox = currentMbEntry.mailbox;
        rotationIndex++;

        // Enforce gap between sends for this mailbox
        const nowMs = Date.now();
        if (!options.ignoreGaps) {
          if (selectedMailbox.next_send_at) {
            const nextSendTime = new Date(selectedMailbox.next_send_at).getTime();
            if (nowMs < nextSendTime) {
              continue;
            }
          }
          const lastSend = mailboxLastSendMap.get(selectedMailbox.id) || 0;
          const minGapMs = (campaign.min_gap_seconds || 90) * 1000;
          if (nowMs - lastSend < minGapMs) {
            continue;
          }
        }

        // 4. ATOMIC CLAIM: DB Transaction guarantees step cannot be double-sent
        const claimResult = db.transaction(() => {
          return db.prepare(`
            UPDATE lead_steps
            SET status = 'claimed',
                mailbox_id = ?
            WHERE id = ? AND status IN ('pending', 'retrying')
          `).run(selectedMailbox.id, step.id);
        })();

        if (claimResult.changes === 0) {
          // Already claimed by another worker or race avoided
          continue;
        }

        // 5. Send message
        try {
          await executeSendStep({
            step,
            mailbox: selectedMailbox,
            campaign,
            postalAddress,
            options
          });

          // 2.9 Random send gap persisted in DB
          const gapSec = calculateRandomSendGap(campaign.min_gap_seconds, campaign.max_gap_seconds);
          const nextSendIso = new Date(Date.now() + gapSec * 1000).toISOString();
          db.prepare('UPDATE mailboxes SET next_send_at = ? WHERE id = ?').run(nextSendIso, selectedMailbox.id);
          selectedMailbox.next_send_at = nextSendIso;
          mailboxLastSendMap.set(selectedMailbox.id, Date.now());
          results.sent++;
        } catch (err) {
          handleSendFailure(step.id, step.lead_email, step.retry_count || 0, err, selectedMailbox.id);
          const errorClass = classifySendError(err);
          if (errorClass === 'hard') {
            results.failed++;
          } else if (errorClass === 'auth') {
            // Mailbox marked as error, step pending
          } else {
            results.retried++;
          }
        }
      }
    }

    // 2.8 Campaign completion: after each tick, mark a running campaign 'completed'
    // when no lead_steps remain in pending, retrying or claimed
    db.prepare(`
      UPDATE campaigns
      SET status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM lead_steps
          WHERE lead_steps.campaign_id = campaigns.id
            AND lead_steps.status IN ('pending', 'retrying', 'claimed')
        )
    `).run();
  } catch (err) {
    console.error('Campaign scheduler error:', err);
  } finally {
    isProcessingTick = false;
  }

  return results;
}

/**
 * Execute sending of a claimed lead step
 */
async function executeSendStep({ step, mailbox, campaign, postalAddress, options = {} }) {
  const db = getDb();

  // Setup tracking URLs and headers
  const tracking = prepareTracking(step.id, mailbox.email, step.open_token);

  const lead = {
    email: step.lead_email,
    first_name: step.first_name || '',
    last_name: step.last_name || '',
    company: step.company || '',
    custom_fields: step.custom_fields_json ? JSON.parse(step.custom_fields_json) : {}
  };

  let subject = renderSpintax(renderVariables(step.subject, lead));
  let rawBody = renderSpintax(renderVariables(step.body_html, lead));

  // Threading for follow-up steps (step_number > 1)
  let threadMessageId = null;
  const extraHeaders = { ...tracking.headers };

  if (step.step_number > 1) {
    const firstStep = db.prepare(`
      SELECT message_id FROM lead_steps ls
      JOIN sequence_steps ss ON ss.id = ls.sequence_step_id
      WHERE ls.lead_id = ? AND ls.campaign_id = ? AND ss.step_number = 1 AND ls.status = 'sent'
      LIMIT 1
    `).get(step.lead_id, campaign.id);

    if (firstStep && firstStep.message_id) {
      threadMessageId = firstStep.message_id;
      extraHeaders['In-Reply-To'] = threadMessageId;
      extraHeaders['References'] = threadMessageId;
      if (!/^re:/i.test(subject)) {
        subject = `Re: ${subject}`;
      }
    }
  }

  // Rewrite URLs for click tracking (excluding unsubscribe)
  const trackedBody = rewriteLinks(rawBody, (url) => registerTrackingLink(step.id, url), tracking.publicBaseUrl);

  // Inject open tracking pixel and postal footer
  const finalHtml = injectTrackingAndFooter(trackedBody, {
    openToken: tracking.openToken,
    unsubscribeUrl: tracking.unsubscribeUrl,
    postalAddress,
    publicBaseUrl: tracking.publicBaseUrl
  });

  const plainText = htmlToPlainText(finalHtml);

  // Nodemailer sending
  const mailOptions = {
    from: `"${mailbox.display_name}" <${mailbox.email}>`,
    to: step.lead_email,
    subject,
    html: finalHtml,
    text: plainText,
    headers: extraHeaders
  };

  let sentResult;
  if (options.mockSend) {
    sentResult = await options.mockSend(mailOptions);
  } else {
    const transporter = nodemailer.createTransport({
      host: mailbox.smtp_host,
      port: mailbox.smtp_port,
      secure: Boolean(mailbox.smtp_secure),
      auth: {
        user: mailbox.smtp_user,
        pass: mailbox.smtp_pass
      },
      tls: mailbox.allow_self_signed ? { rejectUnauthorized: false } : undefined
    });

    sentResult = await sendQueue.enqueue(mailbox.smtp_host, () => transporter.sendMail(mailOptions));
  }

  const messageId = sentResult?.messageId || `<${generateToken()}@${mailbox.email.split('@')[1]}>`;

  // Update lead_step as successfully sent
  db.prepare(`
    UPDATE lead_steps
    SET status = 'sent',
        sent_at = CURRENT_TIMESTAMP,
        message_id = ?,
        thread_message_id = ?,
        open_token = ?,
        last_error = NULL
    WHERE id = ?
  `).run(messageId, threadMessageId, tracking.openToken, step.id);

  // Record sent event
  db.prepare(`
    INSERT INTO email_events (lead_step_id, type, token, timestamp, meta_json)
    VALUES (?, 'sent', ?, CURRENT_TIMESTAMP, ?)
  `).run(step.id, tracking.openToken, JSON.stringify({ mailbox_id: mailbox.id, variant_id: step.variant_id }));

  // Schedule next sequence step if available
  scheduleNextStep(step, campaign);
}

/**
 * Classify SMTP sending errors into 'hard', 'auth', or 'network'/'soft'
 * @param {Error|Object} err
 * @returns {'hard' | 'auth' | 'network' | 'soft'}
 */
export function classifySendError(err) {
  if (!err) return 'soft';

  const code = (err.code || '').toUpperCase();
  const responseCode = Number(err.responseCode) || (err.response ? parseInt(String(err.response).slice(0, 3), 10) : 0);
  const command = (err.command || '').toUpperCase();
  const message = (err.message || '').toLowerCase();
  const responseStr = String(err.response || '').toLowerCase();

  // 1. AUTH or CONFIG failures
  // EAUTH, responseCode 535/534/530, TLS errors: do NOT touch lead
  if (
    code === 'EAUTH' ||
    responseCode === 535 ||
    responseCode === 534 ||
    responseCode === 530 ||
    code === 'ETLS' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    command === 'STARTTLS' ||
    command.startsWith('AUTH') ||
    message.includes('authentication') ||
    message.includes('bad credentials') ||
    message.includes('self-signed') ||
    message.includes('certificate') ||
    message.includes('handshake')
  ) {
    return 'auth';
  }

  // 2. HARD failure
  // ONLY when the failure is at the recipient stage (err.command is 'RCPT TO' or response is 550, 551, 553 or 554 about recipient)
  // and responseCode is 550-554
  const is55x = (responseCode >= 550 && responseCode <= 554) || (/55[0-4]/.test(responseStr));
  const isRcptStage = command === 'RCPT TO' || command === 'RCPT';
  const isRecipientText = /recipient|user unknown|mailbox not found|address rejected|user not found|does not exist|invalid address|no such user/i.test(message + ' ' + responseStr);

  if (is55x && (isRcptStage || isRecipientText)) {
    return 'hard';
  }

  if (isRcptStage && /55[0-4]/.test(message)) {
    return 'hard';
  }

  // 3. NETWORK failures and 4xx (soft retry)
  if (
    code === 'ECONNECTION' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNREFUSED' ||
    (responseCode >= 400 && responseCode < 500) ||
    /timeout|connect|socket|dns|network/i.test(message)
  ) {
    return 'network';
  }

  return 'soft';
}

/**
 * Handle failure when sending an email
 */
export function handleSendFailure(stepId, email, retryCount, err, mailboxId) {
  const db = getDb();
  const errorMsg = err.message || 'SMTP Send Failed';
  const classification = classifySendError(err);

  if (classification === 'auth') {
    // Auth or config failure: do NOT touch lead. Release step back to 'pending',
    // mark mailbox status 'error' with error_reason, and stop sending from it.
    db.prepare(`
      UPDATE lead_steps
      SET status = 'pending', mailbox_id = NULL, last_error = ?
      WHERE id = ?
    `).run(errorMsg, stepId);

    if (mailboxId) {
      db.prepare(`
        UPDATE mailboxes
        SET status = 'error', error_reason = ?
        WHERE id = ?
      `).run(errorMsg, mailboxId);
    }
  } else if (classification === 'hard') {
    // Hard bounce -> mark failed, record bounce_hard, suppress email
    db.prepare(`
      UPDATE lead_steps
      SET status = 'failed', last_error = ?
      WHERE id = ?
    `).run(errorMsg, stepId);

    db.prepare(`
      INSERT INTO email_events (lead_step_id, type, timestamp, meta_json)
      VALUES (?, 'bounce_hard', CURRENT_TIMESTAMP, ?)
    `).run(stepId, JSON.stringify({ error: errorMsg }));

    addSuppression(email, 'hard_bounce');

    db.prepare("UPDATE leads SET status = 'bounced' WHERE email = ?").run(email);
  } else {
    // Soft failure / Network / 4xx -> retry with backoff up to 3 times, lead untouched
    const nextRetry = (retryCount || 0) + 1;
    if (nextRetry < 3) {
      db.prepare(`
        UPDATE lead_steps
        SET status = 'retrying',
            retry_count = ?,
            next_retry_at = datetime('now', '+15 minutes'),
            last_error = ?
        WHERE id = ?
      `).run(nextRetry, errorMsg, stepId);
    } else {
      db.prepare(`
        UPDATE lead_steps
        SET status = 'failed',
            retry_count = ?,
            last_error = ?
        WHERE id = ?
      `).run(nextRetry, `Exceeded 3 retries: ${errorMsg}`, stepId);
    }
  }
}

/**
 * Schedule next step in the campaign sequence
 */
export function scheduleNextStep(currentStep, campaign) {
  const db = getDb();
  const nextStep = db.prepare(`
    SELECT * FROM sequence_steps
    WHERE campaign_id = ? AND step_number = ?
    LIMIT 1
  `).get(campaign.id, currentStep.step_number + 1);

  if (!nextStep) {
    // Check if campaign is finished
    const pendingCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM lead_steps
      WHERE campaign_id = ? AND status IN ('pending', 'retrying', 'claimed')
    `).get(campaign.id).cnt;

    if (pendingCount === 0) {
      db.prepare("UPDATE campaigns SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);
    }
    return;
  }

  const variants = db.prepare('SELECT * FROM step_variants WHERE sequence_step_id = ?').all(nextStep.id);
  if (variants.length === 0) return;

  const chosenVariant = variants[Math.floor(Math.random() * variants.length)];
  const delayDays = nextStep.delay_days ?? 1;
  const baseTime = currentStep.sent_at || new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO lead_steps (
      campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at
    ) VALUES (
      ?, ?, ?, ?, 'pending', datetime(?, '+' || ? || ' days')
    )
  `).run(campaign.id, currentStep.lead_id, nextStep.id, chosenVariant.id, baseTime, delayDays);
}

/**
 * Start 30-second scheduler interval
 */
export function startEngine(intervalMs = 30000) {
  if (engineInterval) return;
  runSchedulerTick();
  engineInterval = setInterval(() => {
    runSchedulerTick();
  }, intervalMs);
}

/**
 * Stop scheduler interval
 */
export function stopEngine() {
  if (engineInterval) {
    clearInterval(engineInterval);
    engineInterval = null;
  }
}
