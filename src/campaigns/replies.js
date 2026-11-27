import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb } from '../db.js';
import { getMailboxById, listMailboxes } from '../mailboxes/accounts.js';
import { isBounceMessage, parseBounce, processBounce } from './bounces.js';
import { addSuppression } from './suppression.js';

let pollerInterval = null;

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

  // Check if it's a bounce first (c)
  if (isBounceMessage(parsed)) {
    const bounceInfo = parseBounce(parsed);
    const bounceResult = processBounce(bounceInfo);
    return { isBounce: true, matched: true, ...bounceResult };
  }

  const fromEmail = (parsed.from?.value?.[0]?.address || parsed.from?.text || '').toLowerCase().trim();
  const subject = parsed.subject || '';
  const bodyText = parsed.text || '';
  const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 160);

  // 6.4 Unsubscribe-by-email:
  // When an incoming message goes to the List-Unsubscribe mailto address with subject containing "unsubscribe", add sender to suppression list
  const isUnsubscribeSubject = subject && /unsubscribe/i.test(subject);
  if (isUnsubscribeSubject && fromEmail) {
    addSuppression(fromEmail, 'email_unsubscribe');
    let leadRow = db.prepare('SELECT id FROM leads WHERE email = ?').get(fromEmail);
    if (leadRow) {
      db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE id = ?").run(leadRow.id);
      const stepRow = db.prepare('SELECT id FROM lead_steps WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(leadRow.id);
      if (stepRow) {
        db.prepare("INSERT INTO email_events (type, lead_step_id, meta_json) VALUES ('unsubscribe', ?, ?)").run(stepRow.id, JSON.stringify({ source: 'email' }));
      }
    }
    return { isUnsubscribe: true, matched: true, suppressed: fromEmail };
  }

  // Match reply by In-Reply-To or References (a)
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

  // 2. Fallback match (b): sender email has a sent step in the last 60 days
  if (!matchedStep && fromEmail) {
    matchedStep = db.prepare(`
      SELECT ls.* FROM lead_steps ls
      JOIN leads l ON l.id = ls.lead_id
      WHERE l.email = ? AND ls.status = 'sent'
        AND ls.sent_at >= datetime('now', '-60 days')
      ORDER BY ls.sent_at DESC LIMIT 1
    `).get(fromEmail);
  }

  // Drop everything else - do not store in replies table
  if (!matchedStep) {
    return { matched: false, dropped: true };
  }

  const leadId = matchedStep.lead_id;
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
    matchedStep.id,
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
    matched: true,
    leadStepId: matchedStep.id
  };
}

/**
 * Poll IMAP for a single mailbox using imapflow or an injected client
 * @param {Object} mailbox
 * @param {Object} [options]
 */
export async function pollMailboxReplies(mailbox, options = {}) {
  if (!mailbox || !mailbox.imap_host || !mailbox.imap_user) return;

  const clientFactory = options.clientFactory || ((cfg) => new ImapFlow(cfg));
  const client = clientFactory({
    host: mailbox.imap_host,
    port: mailbox.imap_port,
    secure: Boolean(mailbox.imap_secure),
    auth: {
      user: mailbox.imap_user,
      pass: mailbox.imap_pass
    },
    logger: false,
    tls: mailbox.allow_self_signed ? { rejectUnauthorized: false } : undefined
  });

  const folder = 'INBOX';
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);

    try {
      const db = getDb();
      let syncRow = db.prepare('SELECT * FROM mailbox_sync WHERE mailbox_id = ? AND folder = ?').get(mailbox.id, folder);
      let lastUid = syncRow ? (syncRow.last_uid || 0) : 0;
      const currentUidValidity = String(client.mailbox?.uidValidity || '');

      // Reset last_uid if UIDVALIDITY changed
      if (syncRow && syncRow.uidvalidity && syncRow.uidvalidity !== currentUidValidity) {
        lastUid = 0;
      }

      // Fetch only UIDs greater than last_uid
      const searchRange = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';
      const fetchedMessages = [];

      // ImapFlow Architecture Note:
      // We collect all candidate messages into an array first and complete the fetch stream
      // before processing message contents or issuing messageFlagsAdd. Calling IMAP commands
      // while an active fetch generator stream is open causes re-entrant command deadlocks,
      // socket stream contention, and parser crashes in ImapFlow.
      try {
        const stream = client.fetch(searchRange, { source: true, uid: true, headers: true }, { uid: true });
        for await (const msg of stream) {
          if (msg.uid > lastUid) {
            fetchedMessages.push({
              uid: msg.uid,
              source: msg.source,
              headers: msg.headers
            });
          }
        }
      } catch (fetchErr) {
        // Mailbox empty or range invalid on some servers
      }

      fetchedMessages.sort((a, b) => a.uid - b.uid);

      let maxProcessedUid = lastUid;
      const uidsToFlagSeen = [];

      for (const msg of fetchedMessages) {
        if (msg.uid > maxProcessedUid) {
          maxProcessedUid = msg.uid;
        }

        const parsed = await simpleParser(msg.source);

        // Ignore messages with X-MailCheck-Warmup header (belong to warm-up module)
        const hasWarmupHeader = parsed.headers?.has('x-mailcheck-warmup') ||
                                Boolean(parsed.headers?.get('x-mailcheck-warmup')) ||
                                /x-mailcheck-warmup/i.test(msg.source?.toString('utf8')?.slice(0, 2000) || '');

        if (hasWarmupHeader) {
          continue;
        }

        const result = processIncomingEmail(parsed, mailbox.id);
        if (result && (result.matched || result.isBounce || result.isUnsubscribe)) {
          uidsToFlagSeen.push(msg.uid);
        }
      }

      // Never touch flags on anything that is not a matched reply or a bounce
      if (uidsToFlagSeen.length > 0 && typeof client.messageFlagsAdd === 'function') {
        for (const uid of uidsToFlagSeen) {
          await client.messageFlagsAdd({ uid }, ['\\Seen']);
        }
      }

      // Update mailbox_sync tracking
      db.prepare(`
        INSERT INTO mailbox_sync (mailbox_id, folder, last_uid, uidvalidity, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mailbox_id, folder) DO UPDATE SET
          last_uid = excluded.last_uid,
          uidvalidity = excluded.uidvalidity,
          updated_at = CURRENT_TIMESTAMP
      `).run(mailbox.id, folder, maxProcessedUid, currentUidValidity);

    } finally {
      if (lock && typeof lock.release === 'function') {
        lock.release();
      }
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
export function startReplyPoller(intervalMs = 120000, options = {}) {
  if (pollerInterval) return;

  const pollAll = async () => {
    try {
      const mailboxes = listMailboxes();
      for (const mb of mailboxes) {
        const fullMb = getMailboxById(mb.id, true);
        if (fullMb && fullMb.status !== 'error') {
          await pollMailboxReplies(fullMb, options);
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
