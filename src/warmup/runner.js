import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb } from '../db.js';
import { generateToken } from '../crypto.js';
import { getMailboxById, listMailboxes } from '../mailboxes/accounts.js';
import { getRandomTemplate, getRandomReplyTemplate } from './content.js';
import { getOrCreateTodayPlan, isWithinWarmupWindow } from './planner.js';
import { getMailboxHealth } from './health.js';
import { sendQueue } from '../queue.js';

let warmupRunnerTimer = null;
let isRunnerActive = false;

/**
 * Enqueue a delivery processing job for a sent warm-up message (5.2)
 * Runs 60-120 seconds later, retrying up to 5 times with backoff
 */
export function enqueueDeliveryJob(warmupId, senderId, partnerId, subject, messageId, delaySeconds = null) {
  const db = getDb();
  const delay = delaySeconds !== null ? delaySeconds : (60 + Math.floor(Math.random() * 61));
  const nextRunAt = new Date(Date.now() + delay * 1000).toISOString();

  const info = db.prepare(`
    INSERT INTO warmup_delivery_jobs (
      warmup_id, sender_id, partner_id, original_subject, original_message_id, attempts, next_run_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(warmupId, senderId, partnerId, subject, messageId, nextRunAt);

  return info.lastInsertRowid;
}

/**
 * Enqueue a threaded reply job (5.3)
 * Schedules a reply after a random delay (5m - 6h)
 */
export function enqueueReplyJob(warmupId, fromMailboxId, toMailboxId, inReplyTo, subject, delayMs = null) {
  const db = getDb();
  const delay = delayMs !== null
    ? delayMs
    : Math.floor((5 * 60 + Math.random() * (355 * 60)) * 1000); // 5 minutes to 6 hours
  const scheduledAt = new Date(Date.now() + delay).toISOString();

  const replySubject = (subject && subject.toLowerCase().startsWith('re:')) ? subject : `Re: ${subject || 'Warmup note'}`;

  const info = db.prepare(`
    INSERT INTO warmup_reply_jobs (
      warmup_id, from_mailbox_id, to_mailbox_id, in_reply_to, references_header, subject, thread_depth, scheduled_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(warmupId, fromMailboxId, toMailboxId, inReplyTo, inReplyTo, replySubject, scheduledAt);

  return info.lastInsertRowid;
}

/**
 * Process pending delivery jobs (5.2)
 */
export async function processDueDeliveryJobs(options = {}) {
  const db = getDb();
  const nowIso = options.now ? options.now.toISOString() : new Date().toISOString();

  const dueJobs = db.prepare(`
    SELECT * FROM warmup_delivery_jobs
    WHERE status = 'pending' AND datetime(next_run_at) <= datetime(?)
    ORDER BY next_run_at ASC LIMIT 10
  `).all(nowIso);

  for (const job of dueJobs) {
    const partner = getMailboxById(job.partner_id, true);
    const sender = getMailboxById(job.sender_id, true);
    if (!partner || !sender) {
      db.prepare(`
        UPDATE warmup_delivery_jobs
        SET status = 'failed', last_error = 'Mailbox not found', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(job.id);
      continue;
    }

    const currentAttempts = (job.attempts || 0) + 1;

    try {
      const result = await processPartnerWarmupImap(partner, sender, job.warmup_id, job, options);
      if (result && result.found) {
        // Success: record real Message-ID
        db.prepare(`
          UPDATE warmup_delivery_jobs
          SET status = 'completed',
              attempts = ?,
              original_message_id = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(currentAttempts, result.messageId || job.original_message_id, job.id);

        // 5.3: For about 35% of received warm-up messages, schedule a reply from the partner
        if (options.forceReply || Math.random() < 0.35) {
          enqueueReplyJob(
            job.warmup_id,
            partner.id,
            sender.id,
            result.messageId || job.original_message_id,
            job.original_subject,
            options.replyDelayMs
          );
        }
      } else {
        // Not found on this attempt: retry up to 5 times with backoff
        if (currentAttempts >= 5) {
          db.prepare(`
            UPDATE warmup_delivery_jobs
            SET status = 'failed',
                attempts = ?,
                last_error = 'Message not found after 5 attempts',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(currentAttempts, job.id);
        } else {
          const backoffSec = Math.min(600, Math.pow(2, currentAttempts) * 30);
          const nextRunAt = new Date(Date.now() + backoffSec * 1000).toISOString();
          db.prepare(`
            UPDATE warmup_delivery_jobs
            SET attempts = ?,
                next_run_at = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(currentAttempts, nextRunAt, job.id);
        }
      }
    } catch (err) {
      if (currentAttempts >= 5) {
        db.prepare(`
          UPDATE warmup_delivery_jobs
          SET status = 'failed', attempts = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(currentAttempts, err.message, job.id);
      } else {
        const backoffSec = Math.pow(2, currentAttempts) * 30;
        const nextRunAt = new Date(Date.now() + backoffSec * 1000).toISOString();
        db.prepare(`
          UPDATE warmup_delivery_jobs
          SET attempts = ?, next_run_at = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(currentAttempts, nextRunAt, err.message, job.id);
      }
    }
  }
}

/**
 * Process pending threaded reply jobs (5.3)
 */
export async function processDueReplyJobs(options = {}) {
  const db = getDb();
  const nowIso = options.now ? options.now.toISOString() : new Date().toISOString();

  const dueReplies = db.prepare(`
    SELECT * FROM warmup_reply_jobs
    WHERE status = 'pending' AND datetime(scheduled_at) <= datetime(?)
    ORDER BY scheduled_at ASC LIMIT 10
  `).all(nowIso);

  for (const job of dueReplies) {
    const fromMailbox = getMailboxById(job.from_mailbox_id, true);
    const toMailbox = getMailboxById(job.to_mailbox_id, true);
    if (!fromMailbox || !toMailbox) {
      db.prepare(`UPDATE warmup_reply_jobs SET status = 'failed' WHERE id = ?`).run(job.id);
      continue;
    }

    db.prepare(`UPDATE warmup_reply_jobs SET status = 'sending' WHERE id = ?`).run(job.id);

    try {
      const template = getRandomReplyTemplate();
      const transporter = options.customTransport || nodemailer.createTransport({
        host: fromMailbox.smtp_host,
        port: fromMailbox.smtp_port,
        secure: Boolean(fromMailbox.smtp_secure),
        auth: {
          user: fromMailbox.smtp_user,
          pass: fromMailbox.smtp_pass
        },
        tls: fromMailbox.allow_self_signed ? { rejectUnauthorized: false } : undefined
      });

      const mailOptions = {
        from: `"${fromMailbox.display_name}" <${fromMailbox.email}>`,
        to: toMailbox.email,
        subject: job.subject,
        text: template.body,
        headers: {
          'X-MailCheck-Warmup': job.warmup_id,
          'In-Reply-To': job.in_reply_to,
          'References': job.references_header
        }
      };

      const info = options.mockSend
        ? await options.mockSend(mailOptions)
        : await sendQueue.enqueue(fromMailbox.smtp_host, () => transporter.sendMail(mailOptions));

      const replyMsgId = (info && info.messageId) ? info.messageId : `<reply-${job.warmup_id}-${Date.now()}@mailcheck.local>`;

      // 5.3: Record each as a warmup_event with direction 'replied'
      db.prepare(`
        INSERT INTO warmup_events (
          mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, subject, status, created_at
        ) VALUES (?, ?, 'replied', ?, ?, ?, 'sent', CURRENT_TIMESTAMP)
      `).run(fromMailbox.id, toMailbox.id, replyMsgId, job.warmup_id, job.subject);

      db.prepare(`UPDATE warmup_reply_jobs SET status = 'sent' WHERE id = ?`).run(job.id);

      // 5.3: For about 30% of those replies, original sender replies once more (threads reach 2-3)
      if (job.thread_depth === 1 && (options.forceDepth2 || Math.random() < 0.30)) {
        const secondDelay = options.secondReplyDelayMs !== undefined
          ? options.secondReplyDelayMs
          : Math.floor((5 * 60 + Math.random() * (355 * 60)) * 1000);
        const secondScheduledAt = new Date(Date.now() + secondDelay).toISOString();

        db.prepare(`
          INSERT INTO warmup_reply_jobs (
            warmup_id, from_mailbox_id, to_mailbox_id, in_reply_to, references_header, subject, thread_depth, scheduled_at, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 2, ?, 'pending', CURRENT_TIMESTAMP)
        `).run(
          job.warmup_id,
          toMailbox.id,
          fromMailbox.id,
          replyMsgId,
          `${job.references_header} ${replyMsgId}`,
          job.subject,
          secondScheduledAt
        );
      }
    } catch (err) {
      db.prepare(`UPDATE warmup_reply_jobs SET status = 'failed' WHERE id = ?`).run(job.id);
    }
  }
}

/**
 * Execute a single warm-up exchange step
 */
export async function executeWarmupCycle(options = {}) {
  if (isRunnerActive && !options.force) return;
  isRunnerActive = true;

  try {
    const db = getDb();
    const allMailboxes = listMailboxes();
    // 5.5: Only mailboxes in warming status without connection/auth errors
    const warmingPool = allMailboxes.filter(m => m.status === 'warming' && !m.error_reason);

    // Rule 5.5: Require at least 2 connected mailboxes in warmup pool
    if (warmingPool.length < 2) {
      return { skipped: true, poolSize: warmingPool.length, reason: 'Warm-up pool requires at least 2 connected mailboxes.' };
    }

    // Rule 5.1: Check window (default 09:00 - 18:00)
    const windowStartRow = db.prepare("SELECT value FROM settings WHERE key = 'warmup_window_start'").get();
    const windowEndRow = db.prepare("SELECT value FROM settings WHERE key = 'warmup_window_end'").get();
    const windowStart = windowStartRow ? windowStartRow.value : '09:00';
    const windowEnd = windowEndRow ? windowEndRow.value : '18:00';

    const now = options.now || new Date();
    if (!isWithinWarmupWindow(windowStart, windowEnd, now) && !options.force) {
      return { skipped: true, reason: 'Current time is outside warm-up window.' };
    }

    const todayDateStr = now.toISOString().slice(0, 10);
    const nowIso = now.toISOString();

    // Process each warming mailbox
    for (const senderSummary of warmingPool) {
      const sender = getMailboxById(senderSummary.id, true);
      if (!sender) continue;

      // Check health and auto-pause if unhealthy
      const health = getMailboxHealth(sender.id);
      if (health.autoPaused) {
        continue;
      }

      // Check today's plan & sent count
      const plan = getOrCreateTodayPlan(sender, todayDateStr);
      const todaySentRow = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM warmup_events
        WHERE mailbox_id = ? AND direction = 'sent' AND date(created_at) = date('now')
      `).get(sender.id);

      const todaySent = todaySentRow ? todaySentRow.cnt : 0;
      // Rule 5.1: Never exceed the day's planned_sends
      if (todaySent >= plan.planned_sends && !options.force) {
        continue;
      }

      // Rule 5.1: Find next scheduled send time that has passed
      let scheduleItem = null;
      if (!options.force) {
        scheduleItem = db.prepare(`
          SELECT id, send_at
          FROM warmup_schedule
          WHERE mailbox_id = ? AND date = ? AND status = 'pending' AND datetime(send_at) <= datetime(?)
          ORDER BY send_at ASC
          LIMIT 1
        `).get(sender.id, todayDateStr, nowIso);

        if (!scheduleItem) {
          continue; // No pending scheduled send whose time has arrived
        }

        // Claim schedule item
        const updateResult = db.prepare(`
          UPDATE warmup_schedule SET status = 'claimed' WHERE id = ? AND status = 'pending'
        `).run(scheduleItem.id);

        if (updateResult.changes === 0) continue;
      }

      // Pick a random partner from the pool (excluding self)
      const potentialPartners = warmingPool.filter(m => m.id !== sender.id);
      if (potentialPartners.length === 0) continue;
      const partnerSummary = potentialPartners[Math.floor(Math.random() * potentialPartners.length)];
      const partner = getMailboxById(partnerSummary.id, true);
      if (!partner) continue;

      // Generate random warm-up email
      const template = getRandomTemplate();
      const warmupId = generateToken();

      try {
        // 1. Send from sender to partner
        const sendResult = await sendWarmupEmail(sender, partner, template, warmupId, options);

        if (scheduleItem) {
          db.prepare("UPDATE warmup_schedule SET status = 'sent' WHERE id = ?").run(scheduleItem.id);
        }

        // 2. Rule 5.2: Enqueue delivery processing job
        const deliveryDelay = options.deliveryDelay !== undefined
          ? options.deliveryDelay
          : (options.mockImapProcessor || options.force ? 0 : (60 + Math.floor(Math.random() * 61)));
        enqueueDeliveryJob(warmupId, sender.id, partner.id, template.subject, sendResult.messageId, deliveryDelay);
      } catch (err) {
        if (scheduleItem) {
          db.prepare("UPDATE warmup_schedule SET status = 'failed' WHERE id = ?").run(scheduleItem.id);
        }
        console.error(`Warmup send error from ${sender.email}:`, err.message);
      }
    }

    // Process due delivery & reply jobs
    await processDueDeliveryJobs(options);
    await processDueReplyJobs(options);

    return { success: true };
  } catch (err) {
    console.error('Warmup runner error:', err.message);
    return { error: err.message };
  } finally {
    isRunnerActive = false;
  }
}

/**
 * Send an outbound warm-up email
 */
export async function sendWarmupEmail(sender, partner, template, warmupId, options = {}) {
  const db = getDb();

  const transporter = options.customTransport || nodemailer.createTransport({
    host: sender.smtp_host,
    port: sender.smtp_port,
    secure: Boolean(sender.smtp_secure),
    auth: {
      user: sender.smtp_user,
      pass: sender.smtp_pass
    },
    tls: sender.allow_self_signed ? { rejectUnauthorized: false } : undefined
  });

  const mailOptions = {
    from: `"${sender.display_name}" <${sender.email}>`,
    to: partner.email,
    subject: template.subject,
    text: template.body,
    headers: {
      'X-MailCheck-Warmup': warmupId
    }
  };

  const info = options.mockSend
    ? await options.mockSend(mailOptions)
    : await sendQueue.enqueue(sender.smtp_host, () => transporter.sendMail(mailOptions));

  const messageId = (info && info.messageId) ? info.messageId : `<warmup-${warmupId}@mailcheck.local>`;

  // Record sent event
  db.prepare(`
    INSERT INTO warmup_events (
      mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, subject, status, created_at
    ) VALUES (?, ?, 'sent', ?, ?, ?, 'sent', CURRENT_TIMESTAMP)
  `).run(sender.id, partner.id, messageId, warmupId, template.subject);

  return { messageId, warmupId };
}

/**
 * Partner mailbox IMAP processing (5.2 & 5.4):
 * 1. Locate message via X-MailCheck-Warmup header (resolving \Junk special-use first)
 * 2. Record REAL Message-ID header, not IMAP UID
 * 3. If in Spam, move to INBOX and record 'spam_rescued'
 * 4. Mark as read (\Seen)
 * 5. Star (\Flagged) for ~40% of messages
 * 6. NEVER touch non-warm-up mail (5.4)
 */
export async function processPartnerWarmupImap(partner, sender, warmupId, job = {}, options = {}) {
  const db = getDb();

  if (options.mockImapProcessor) {
    const res = await options.mockImapProcessor(partner, sender, warmupId, job);
    return (res && typeof res === 'object') ? res : { found: true, messageId: job.original_message_id || `<warmup-${warmupId}@mailcheck.local>` };
  }

  const client = new ImapFlow({
    host: partner.imap_host,
    port: partner.imap_port,
    secure: Boolean(partner.imap_secure),
    auth: {
      user: partner.imap_user,
      pass: partner.imap_pass
    },
    logger: false,
    tls: partner.allow_self_signed ? { rejectUnauthorized: false } : undefined
  });

  try {
    await client.connect();

    // 5.2 Rule: Resolve Spam/Junk folder through IMAP special-use (\Junk) flags first, then common names
    let spamFolder = null;
    try {
      const list = await client.list();
      for (const mb of list) {
        if (mb.specialUse === '\\Junk' || (mb.flags && mb.flags.has && mb.flags.has('\\Junk'))) {
          spamFolder = mb.path;
          break;
        }
      }
    } catch {}

    if (!spamFolder) {
      const candidates = ['Junk', 'Spam', '[Gmail]/Spam', 'Junk E-mail', 'Bulk Mail'];
      spamFolder = candidates[0];
    }

    const foldersToCheck = ['INBOX', spamFolder];
    let foundMsgUid = null;
    let foundFolder = null;
    let realMessageId = null;
    let isSpam = false;

    for (const folder of foldersToCheck) {
      if (!folder) continue;
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          // 5.2: Search by header { 'x-mailcheck-warmup': warmupId } rather than scanning all unseen
          let matchingUids = [];
          try {
            matchingUids = await client.search({ header: ['x-mailcheck-warmup', warmupId] });
          } catch {}

          if (matchingUids && matchingUids.length > 0) {
            for (const uid of matchingUids) {
              const msg = await client.fetchOne(uid, { source: true, uid: true });
              if (msg && msg.source) {
                const parsed = await simpleParser(msg.source);
                const headerVal = parsed.headers.get('x-mailcheck-warmup');
                if (headerVal === warmupId) {
                  foundMsgUid = uid;
                  foundFolder = folder;
                  realMessageId = parsed.messageId || parsed.headers.get('message-id') || `<warmup-${warmupId}@mailcheck.local>`;
                  if (folder === spamFolder || folder.toLowerCase().includes('spam') || folder.toLowerCase().includes('junk')) {
                    isSpam = true;
                  }
                  break;
                }
              }
            }
          } else {
            // Safe fallback scan: inspect unseen messages, checking headers without modifying flags
            const messages = client.fetch({ unseen: true }, { source: true, uid: true });
            for await (const msg of messages) {
              const parsed = await simpleParser(msg.source);
              const headerVal = parsed.headers.get('x-mailcheck-warmup');
              // 5.4 SAFETY: NEVER touch any message without matching header!
              if (headerVal === warmupId) {
                foundMsgUid = msg.uid;
                foundFolder = folder;
                realMessageId = parsed.messageId || parsed.headers.get('message-id') || `<warmup-${warmupId}@mailcheck.local>`;
                if (folder === spamFolder || folder.toLowerCase().includes('spam') || folder.toLowerCase().includes('junk')) {
                  isSpam = true;
                }
                break;
              }
            }
          }
        } finally {
          lock.release();
        }

        if (foundMsgUid) break;
      } catch {
        // Folder may not exist on this IMAP server
      }
    }

    if (!foundMsgUid || !foundFolder) {
      await client.logout();
      return { found: false };
    }

    // Found matching message: process with lock
    const lock = await client.getMailboxLock(foundFolder);
    try {
      const subject = job.original_subject || 'Warmup message';
      if (isSpam) {
        // Move from Spam to INBOX
        await client.messageMove({ uid: foundMsgUid }, 'INBOX');
        db.prepare(`
          INSERT INTO warmup_events (
            mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, subject, status, created_at
          ) VALUES (?, ?, 'received', ?, ?, ?, 'spam_rescued', CURRENT_TIMESTAMP)
        `).run(partner.id, sender.id, realMessageId, warmupId, subject);
      } else {
        db.prepare(`
          INSERT INTO warmup_events (
            mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, subject, status, created_at
          ) VALUES (?, ?, 'received', ?, ?, ?, 'inbox', CURRENT_TIMESTAMP)
        `).run(partner.id, sender.id, realMessageId, warmupId, subject);
      }

      // Mark as seen
      await client.messageFlagsAdd({ uid: foundMsgUid }, ['\\Seen']);

      // Star / Flag for ~40% of messages
      if (options.forceStar || Math.random() < 0.40) {
        await client.messageFlagsAdd({ uid: foundMsgUid }, ['\\Flagged']);
      }
    } finally {
      lock.release();
    }

    await client.logout();
    return { found: true, messageId: realMessageId, inSpam };
  } catch (err) {
    try { await client.logout(); } catch {}
    throw err;
  }
}

/**
 * Start periodic background warm-up loop (every 5 minutes)
 */
export function startWarmupRunner(intervalMs = 300000) {
  if (warmupRunnerTimer) return;
  executeWarmupCycle();
  warmupRunnerTimer = setInterval(() => {
    executeWarmupCycle();
  }, intervalMs);
}

export function stopWarmupRunner() {
  if (warmupRunnerTimer) {
    clearInterval(warmupRunnerTimer);
    warmupRunnerTimer = null;
  }
}
