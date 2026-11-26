import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb } from '../db.js';
import { generateToken } from '../crypto.js';
import { getMailboxById, listMailboxes } from '../mailboxes/accounts.js';
import { getRandomTemplate } from './content.js';
import { getOrCreateTodayPlan } from './planner.js';
import { getMailboxHealth } from './health.js';
import { sendQueue } from '../queue.js';

let warmupRunnerTimer = null;
let isRunnerActive = false;

/**
 * Execute a single warm-up exchange step
 */
export async function executeWarmupCycle(options = {}) {
  if (isRunnerActive && !options.force) return;
  isRunnerActive = true;

  try {
    const db = getDb();
    const allMailboxes = listMailboxes();
    const warmingPool = allMailboxes.filter(m => m.status === 'warming');

    // Rule: Require at least 2 connected mailboxes in warmup pool
    if (warmingPool.length < 2) {
      return { skipped: true, reason: 'Warm-up pool requires at least 2 connected mailboxes.' };
    }

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
      const plan = getOrCreateTodayPlan(sender);
      const todaySentRow = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM warmup_events
        WHERE mailbox_id = ? AND direction = 'sent' AND date(created_at) = date('now')
      `).get(sender.id);

      const todaySent = todaySentRow ? todaySentRow.cnt : 0;
      if (todaySent >= plan.planned_sends && !options.force) {
        continue; // Target reached for today
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

      // 1. Send from sender to partner
      await sendWarmupEmail(sender, partner, template, warmupId, options);

      // 2. Partner mailbox processes warm-up (find, rescue from spam if needed, mark read, star)
      if (!options.skipImapProcessing) {
        await processPartnerWarmupImap(partner, sender, warmupId, options);
      }
    }
  } catch (err) {
    console.error('Warmup runner error:', err.message);
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
    tls: { rejectUnauthorized: false }
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
 * Partner mailbox IMAP processing:
 * 1. Locate message via X-MailCheck-Warmup header
 * 2. If in Spam, move to INBOX and record 'spam_rescued'
 * 3. Mark as read
 * 4. Star (flag) message for ~40% of messages
 * 5. Send automated reply for ~35% of messages
 */
export async function processPartnerWarmupImap(partner, sender, warmupId, options = {}) {
  const db = getDb();

  // If mock processor passed in options for tests
  if (options.mockImapProcessor) {
    return options.mockImapProcessor(partner, sender, warmupId);
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
    tls: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // Check INBOX first, then Spam/Junk
    const foldersToCheck = ['INBOX', 'Junk', 'Spam', '[Gmail]/Spam'];
    let foundInSpam = false;
    let foundMessageUid = null;
    let foundFolder = null;

    for (const folder of foldersToCheck) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const messages = client.fetch({ unseen: true }, { source: true, uid: true });
          for await (const msg of messages) {
            const parsed = await simpleParser(msg.source);
            const headerWarmupId = parsed.headers.get('x-mailcheck-warmup');

            // SAFETY: NEVER touch any message without the warm-up header!
            if (headerWarmupId === warmupId) {
              foundMessageUid = msg.uid;
              foundFolder = folder;
              if (folder.toLowerCase().includes('spam') || folder.toLowerCase().includes('junk')) {
                foundInSpam = true;
              }
              break;
            }
          }
        } finally {
          lock.release();
        }

        if (foundMessageUid) break;
      } catch {
        // Folder may not exist on this IMAP server
      }
    }

    if (foundMessageUid && foundFolder) {
      const lock = await client.getMailboxLock(foundFolder);
      try {
        // If in Spam, move to INBOX!
        if (foundInSpam) {
          await client.messageMove({ uid: foundMessageUid }, 'INBOX');
          db.prepare(`
            INSERT INTO warmup_events (
              mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at
            ) VALUES (?, ?, 'received', ?, ?, 'spam_rescued', CURRENT_TIMESTAMP)
          `).run(partner.id, sender.id, foundMessageUid, warmupId);
        } else {
          db.prepare(`
            INSERT INTO warmup_events (
              mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at
            ) VALUES (?, ?, 'received', ?, ?, 'inbox', CURRENT_TIMESTAMP)
          `).run(partner.id, sender.id, foundMessageUid, warmupId);
        }

        // Mark as seen
        await client.messageFlagsAdd({ uid: foundMessageUid }, ['\\Seen']);

        // Star / Flag for ~40% of messages
        if (Math.random() < 0.40) {
          await client.messageFlagsAdd({ uid: foundMessageUid }, ['\\Flagged']);
        }
      } finally {
        lock.release();
      }
    }

    await client.logout();
  } catch (err) {
    console.warn(`Warmup IMAP processing error on ${partner.email}:`, err.message);
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
