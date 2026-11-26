import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb } from '../db.js';
import { getMailboxById, listMailboxes } from '../mailboxes/accounts.js';
import { isBounceMessage, parseBounce, processBounce } from './bounces.js';

let pollerInterval = null;
const activeClients = new Map();

/**
 * Detect whether an incoming email is an automated auto-reply or Out of Office notification
 */
export function isAutoReply(headers = {}, subject = '', bodyText = '') {
  const cleanSubject = (subject || '').toLowerCase();
  const cleanBody = (bodyText || '').toLowerCase();

  // 1. Auto-Submitted header (RFC 3834)
  const autoSubmitted = (
    headers['auto-submitted'] ||
    (headers.get && headers.get('auto-submitted')) ||
    ''
  ).toLowerCase();

  if (autoSubmitted && autoSubmitted !== 'no') {
    return true;
  }

  // 2. Proprietary auto-reply headers
  const xAutoreply = headers['x-autoreply'] || (headers.get && headers.get('x-autoreply'));
  const xAutoResponse = headers['x-auto-response-suppress'] || (headers.get && headers.get('x-auto-response-suppress'));
  const precedence = (headers['precedence'] || (headers.get && headers.get('precedence')) || '').toLowerCase();

  if (xAutoreply || xAutoResponse || precedence === 'auto_reply' || precedence === 'bulk') {
    return true;
  }

  // 3. Subject line patterns
  if (
    cleanSubject.includes('out of office') ||
    cleanSubject.includes('automatic reply:') ||
    cleanSubject.includes('autoreply:') ||
    cleanSubject.includes('auto:') ||
    cleanSubject.includes('away from the office') ||
    cleanSubject.includes('away until') ||
    cleanSubject.includes('on annual leave') ||
    cleanSubject.includes('vacation responder') ||
    cleanSubject.includes('absence notice')
  ) {
    return true;
  }

  // 4. Body text patterns
  if (
    cleanBody.includes('i am currently out of the office') ||
    cleanBody.includes('i am out of office') ||
    cleanBody.includes('i will be away from') ||
    cleanBody.includes('i am on leave') ||
    cleanBody.includes('i will have limited access to email') ||
    cleanBody.includes('this is an automated response') ||
    cleanBody.includes('this is an automated email')
  ) {
    return true;
  }

  return false;
}

/**
 * Process a parsed incoming email: match to campaigns, record replies or bounces
 */
export function processIncomingEmail(parsed, mailboxId) {
  const db = getDb();

  // Check if it's a bounce first
  if (isBounceMessage(parsed)) {
    const bounceInfo = parseBounce(parsed);
    return processBounce(bounceInfo);
  }

  const fromEmail = (parsed.from?.value?.[0]?.address || parsed.from?.text || '').toLowerCase().trim();
  const subject = parsed.subject || '';
  const bodyText = parsed.text || '';
  const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 160);

  // Match reply by In-Reply-To or References
  const inReplyTo = parsed.inReplyTo || null;
  const references = parsed.references
    ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
    : [];

  let matchedStep = null;

  // 1. Match by Message-ID references
  if (inReplyTo) {
    matchedStep = db.prepare('SELECT * FROM lead_steps WHERE message_id = ?').get(inReplyTo);
  }

  if (!matchedStep && references.length > 0) {
    for (const ref of references) {
      matchedStep = db.prepare('SELECT * FROM lead_steps WHERE message_id = ?').get(ref);
      if (matchedStep) break;
    }
  }

  // 2. Fallback: match by sender email in active leads
  if (!matchedStep && fromEmail) {
    matchedStep = db.prepare(`
      SELECT ls.* FROM lead_steps ls
      JOIN leads l ON l.id = ls.lead_id
      WHERE l.email = ? AND ls.status = 'sent'
      ORDER BY ls.sent_at DESC LIMIT 1
    `).get(fromEmail);
  }

  const leadId = matchedStep ? matchedStep.lead_id : null;
  const autoReply = isAutoReply(parsed.headers || {}, subject, bodyText);

  // Validate mailboxId if provided
  let validMailboxId = null;
  if (mailboxId) {
    const mbRow = db.prepare('SELECT id FROM mailboxes WHERE id = ?').get(mailboxId);
    if (mbRow) validMailboxId = mbRow.id;
  }

  // Store in replies table
  const info = db.prepare(`
    INSERT INTO replies (
      lead_step_id, mailbox_id, lead_id, from_email,
      subject, snippet, body_text, is_auto_reply, label, handled, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'neutral', 0, CURRENT_TIMESTAMP)
  `).run(
    matchedStep ? matchedStep.id : null,
    validMailboxId,
    leadId,
    fromEmail,
    subject,
    snippet,
    bodyText,
    autoReply ? 1 : 0
  );

  const replyId = Number(info.lastInsertRowid);

  // If this is a real human reply (not automated):
  if (!autoReply && matchedStep) {
    // Record 'reply' event in email_events
    db.prepare(`
      INSERT INTO email_events (lead_step_id, type, timestamp, meta_json)
      VALUES (?, 'reply', CURRENT_TIMESTAMP, ?)
    `).run(matchedStep.id, JSON.stringify({ reply_id: replyId, from: fromEmail }));

    // Stop future sequence steps for this lead under condition "if_no_reply"
    db.prepare(`
      UPDATE lead_steps
      SET status = 'skipped', last_error = 'Sequence stopped on lead reply'
      WHERE lead_id = ? AND campaign_id = ? AND status IN ('pending', 'retrying')
    `).run(matchedStep.lead_id, matchedStep.campaign_id);
  }

  return {
    replyId,
    isAutoReply: autoReply,
    matched: Boolean(matchedStep),
    leadStepId: matchedStep ? matchedStep.id : null
  };
}

/**
 * Poll IMAP for a single mailbox using imapflow
 */
export async function pollMailboxReplies(mailbox) {
  if (!mailbox || !mailbox.imap_host || !mailbox.imap_user) return;

  const client = new ImapFlow({
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: Boolean(mailbox.imap_secure),
    auth: {
      user: mailbox.imap_user,
      pass: mailbox.imap_pass
    },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Fetch unseen messages or recent messages from the past 2 days
      const searchCriteria = { seen: false };
      const messages = client.fetch(searchCriteria, { source: true, uid: true });

      for await (const msg of messages) {
        try {
          const parsed = await simpleParser(msg.source);
          processIncomingEmail(parsed, mailbox.id);
          // Mark as seen
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        } catch (err) {
          console.error(`Error parsing incoming email for mailbox ${mailbox.id}:`, err.message);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error(`IMAP polling error for ${mailbox.email}:`, err.message);
  }
}

/**
 * Label a reply (interested, not_interested, neutral)
 */
export function labelReply(id, label) {
  const db = getDb();
  const validLabels = ['interested', 'not_interested', 'neutral'];
  if (!validLabels.includes(label)) {
    throw new Error(`Invalid label "${label}". Must be one of: ${validLabels.join(', ')}`);
  }
  db.prepare('UPDATE replies SET label = ? WHERE id = ?').run(label, id);
  return db.prepare('SELECT * FROM replies WHERE id = ?').get(id);
}

/**
 * Mark a reply as handled / unhandled
 */
export function markReplyHandled(id, handled = 1) {
  const db = getDb();
  db.prepare('UPDATE replies SET handled = ? WHERE id = ?').run(handled ? 1 : 0, id);
  return db.prepare('SELECT * FROM replies WHERE id = ?').get(id);
}

/**
 * List replies with optional filters
 */
export function listReplies({ label, handled, isAutoReply, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (label) {
    conditions.push('r.label = ?');
    params.push(label);
  }
  if (handled !== undefined) {
    conditions.push('r.handled = ?');
    params.push(handled ? 1 : 0);
  }
  if (isAutoReply !== undefined) {
    conditions.push('r.is_auto_reply = ?');
    params.push(isAutoReply ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT r.*, m.email as mailbox_email, l.first_name, l.last_name, l.company, c.name as campaign_name
    FROM replies r
    LEFT JOIN mailboxes m ON m.id = r.mailbox_id
    LEFT JOIN leads l ON l.id = r.lead_id
    LEFT JOIN lead_steps ls ON ls.id = r.lead_step_id
    LEFT JOIN campaigns c ON c.id = ls.campaign_id
    ${whereClause}
    ORDER BY r.received_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const countRow = db.prepare(`SELECT COUNT(*) as count FROM replies r ${whereClause}`).get(...params);

  return { items: rows, total: countRow.count };
}

/**
 * Start the global IMAP poller loop (every 2 minutes)
 */
export function startReplyPoller(intervalMs = 120000) {
  if (pollerInterval) return;

  const pollAll = async () => {
    try {
      const mailboxes = listMailboxes();
      for (const mb of mailboxes) {
        const fullMb = getMailboxById(mb.id, true);
        if (fullMb && fullMb.status !== 'error') {
          await pollMailboxReplies(fullMb);
        }
      }
    } catch (err) {
      console.error('Reply poller cycle error:', err.message);
    }
  };

  pollAll();
  pollerInterval = setInterval(pollAll, intervalMs);
}

export function stopReplyPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
