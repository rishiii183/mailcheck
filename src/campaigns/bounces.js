import { getDb } from '../db.js';
import { addSuppression } from './suppression.js';

/**
 * Classify bounce severity based on status code or error pattern
 * @param {string} text 
 * @returns {'hard' | 'soft'}
 */
export function classifyBounceCode(text) {
  if (!text) return 'hard';
  const clean = text.toLowerCase();

  // Explicit DSN status codes
  const dsnMatch = clean.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/);
  if (dsnMatch) {
    return dsnMatch[1].startsWith('5') ? 'hard' : 'soft';
  }

  // SMTP 3-digit error codes
  const smtpMatch = clean.match(/\b([45]\d{2})\b/);
  if (smtpMatch) {
    return smtpMatch[1].startsWith('5') ? 'hard' : 'soft';
  }

  // Common soft bounce keywords
  if (
    clean.includes('mailbox full') ||
    clean.includes('quota exceeded') ||
    clean.includes('over quota') ||
    clean.includes('temporary failure') ||
    clean.includes('try again later') ||
    clean.includes('greylisted')
  ) {
    return 'soft';
  }

  // Default to hard bounce
  return 'hard';
}

/**
 * Check if an incoming email looks like a Delivery Status Notification / Bounce
 */
export function isBounceMessage(parsedEmail) {
  if (!parsedEmail) return false;

  const getHeader = (name) => {
    const h = parsedEmail.headers;
    if (!h) return '';
    if (typeof h.get === 'function') return h.get(name) || '';
    return h[name.toLowerCase()] || h[name] || '';
  };

  const from = (parsedEmail.from?.text || parsedEmail.from?.value?.[0]?.address || '').toLowerCase();
  const subject = (parsedEmail.subject || '').toLowerCase();
  const contentType = String(getHeader('content-type')).toLowerCase();

  const isBounceSender = (
    from.includes('mailer-daemon') ||
    from.includes('postmaster') ||
    from.includes('mail-daemon') ||
    from.includes('mail delivery subsystem') ||
    from.includes('bounce')
  );

  const isBounceSubject = (
    subject.includes('delivery status notification') ||
    subject.includes('undelivered mail') ||
    subject.includes('failure notice') ||
    subject.includes('returned mail') ||
    subject.includes('mail delivery failed') ||
    subject.includes('undeliverable')
  );

  const isDsnReport = contentType.includes('multipart/report') || contentType.includes('delivery-status');

  return isBounceSender || isBounceSubject || isDsnReport;
}

/**
 * Parse bounce details from a bounce email
 */
export function parseBounce(parsedEmail) {
  const fullText = [
    parsedEmail.subject || '',
    parsedEmail.text || '',
    parsedEmail.html || ''
  ].join(' ');

  const bounceType = classifyBounceCode(fullText);

  // Extract recipient address mentioned in bounce body
  let recipientEmail = null;
  const recipientMatch = fullText.match(/(?:for|to|recipient)\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/i)
    || fullText.match(/Final-Recipient:\s*rfc822;\s*([^\s\r\n;]+)/i);

  if (recipientMatch) {
    recipientEmail = recipientMatch[1].toLowerCase().trim();
  }

  // Extract original Message-ID if quoted
  let originalMessageId = null;
  const msgIdMatch = fullText.match(/Message-ID:\s*(<[^>]+>)/i)
    || (parsedEmail.inReplyTo ? [null, parsedEmail.inReplyTo] : null)
    || (parsedEmail.references ? [null, Array.isArray(parsedEmail.references) ? parsedEmail.references[0] : parsedEmail.references] : null);

  if (msgIdMatch) {
    originalMessageId = msgIdMatch[1].trim();
  }

  return {
    isBounce: true,
    isHard: bounceType === 'hard',
    type: bounceType, // 'hard' or 'soft'
    recipientEmail,
    originalMessageId,
    details: fullText.slice(0, 300)
  };
}

/**
 * Process a detected bounce and update DB, lead, and suppression
 */
export function processBounce(bounceInfo) {
  const db = getDb();
  let step = null;

  // 1. Try to find lead_step by original Message-ID
  if (bounceInfo.originalMessageId) {
    step = db.prepare('SELECT * FROM lead_steps WHERE message_id = ?').get(bounceInfo.originalMessageId);
  }

  // 2. Fallback to finding latest sent lead_step by recipient email
  if (!step && bounceInfo.recipientEmail) {
    step = db.prepare(`
      SELECT ls.* FROM lead_steps ls
      JOIN leads l ON l.id = ls.lead_id
      WHERE l.email = ? AND ls.status = 'sent'
      ORDER BY ls.sent_at DESC LIMIT 1
    `).get(bounceInfo.recipientEmail);
  }

  if (step) {
    const eventType = bounceInfo.type === 'hard' ? 'bounce_hard' : 'bounce_soft';

    // Record email event
    db.prepare(`
      INSERT INTO email_events (lead_step_id, type, timestamp, meta_json)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    `).run(step.id, eventType, JSON.stringify({ details: bounceInfo.details }));

    if (bounceInfo.type === 'hard') {
      // Mark lead as bounced
      db.prepare("UPDATE leads SET status = 'bounced' WHERE id = ?").run(step.lead_id);

      // Stop remaining sequence steps for this lead
      db.prepare(`
        UPDATE lead_steps
        SET status = 'skipped', last_error = 'Hard bounce recorded'
        WHERE lead_id = ? AND status IN ('pending', 'retrying')
      `).run(step.lead_id);

      // Add to global suppression
      const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(step.lead_id);
      if (lead) {
        addSuppression(lead.email, 'hard_bounce');
      }
    }
  }

  return { processed: Boolean(step), bounceInfo };
}
