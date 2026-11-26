import { getDb } from '../db.js';

/**
 * Calculate rolling 7-day health metrics and reputation score (0-100) for a mailbox
 * @param {number} mailboxId 
 */
export function getMailboxHealth(mailboxId) {
  const db = getDb();
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (!mailbox) {
    return {
      mailboxId,
      placementRate: 100,
      inboxCount: 0,
      spamCount: 0,
      rescuedFromSpam: 0,
      bouncesCount: 0,
      warmupDays: 0,
      reputationScore: 100,
      autoPaused: false,
      reason: 'Mailbox not found'
    };
  }

  // 1. Warm-up days completed
  let warmupDays = 0;
  if (mailbox.warmup_start_date) {
    const startMs = new Date(mailbox.warmup_start_date).getTime();
    const nowMs = Date.now();
    warmupDays = Math.max(0, Math.floor((nowMs - startMs) / (1000 * 60 * 60 * 24)));
  }

  // 2. Rolling 7-day warmup events received in pool
  // Status 'inbox', 'spam_rescued', 'bounced'
  const events = db.prepare(`
    SELECT status, COUNT(*) as cnt
    FROM warmup_events
    WHERE partner_mailbox_id = ?
      AND created_at >= datetime('now', '-7 days')
    GROUP BY status
  `).all(mailboxId);

  let inboxCount = 0;
  let spamCount = 0;
  let rescuedCount = 0;

  for (const ev of events) {
    if (ev.status === 'inbox' || ev.status === 'read' || ev.status === 'starred') {
      inboxCount += ev.cnt;
    } else if (ev.status === 'spam_rescued') {
      spamCount += ev.cnt;
      rescuedCount += ev.cnt;
    }
  }

  const totalPoolReceived = inboxCount + spamCount;
  // If no warm-up mail received yet, placement rate defaults to 100%
  const placementRate = totalPoolReceived > 0
    ? Math.round((inboxCount / totalPoolReceived) * 1000) / 10
    : 100;

  // 3. Count recent bounces (past 7 days)
  const bounceRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.mailbox_id = ?
      AND ee.type IN ('bounce_hard', 'bounce_soft')
      AND ee.timestamp >= datetime('now', '-7 days')
  `).get(mailboxId);
  const bouncesCount = bounceRow ? bounceRow.cnt : 0;

  // 4. Reputation score calculation (0 to 100)
  // Baseline = 100
  let score = 100;

  // Penalty for low placement rate
  if (totalPoolReceived >= 5 && placementRate < 90) {
    score -= Math.round((90 - placementRate) * 1.5);
  }

  // Penalty for bounces
  if (bouncesCount > 0) {
    score -= Math.min(40, bouncesCount * 10);
  }

  // Small bonus for completed warmup days (building longevity)
  if (warmupDays > 7 && score >= 70) {
    score = Math.min(100, score + Math.min(10, Math.floor(warmupDays / 2)));
  }

  const reputationScore = Math.max(0, Math.min(100, score));

  // 5. Auto-pause check:
  // Auto-pause warm-up and any campaign sending on repeated bounces (>= 3), auth errors, or placement rate < 70%
  let autoPauseReason = null;
  if (bouncesCount >= 3) {
    autoPauseReason = `Repeated bounce threshold exceeded (${bouncesCount} bounces in past 7 days)`;
  } else if (totalPoolReceived >= 5 && placementRate < 70) {
    autoPauseReason = `Inbox placement rate dropped to ${placementRate}% (below 70% safe threshold)`;
  } else if (mailbox.error_reason && mailbox.status === 'error') {
    autoPauseReason = `Mailbox authentication error: ${mailbox.error_reason}`;
  }

  let autoPaused = false;
  if (autoPauseReason && mailbox.status === 'warming') {
    db.prepare(`
      UPDATE mailboxes
      SET status = 'paused',
          error_reason = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(`Auto-paused: ${autoPauseReason}`, mailboxId);
    autoPaused = true;
  }

  return {
    mailboxId,
    placementRate,
    inboxCount,
    spamCount,
    rescuedFromSpam: rescuedCount,
    bouncesCount,
    warmupDays,
    reputationScore,
    autoPaused,
    reason: autoPauseReason
  };
}

/**
 * Get warmup plan history & progress for mailbox
 */
export function getWarmupPlan(mailboxId) {
  const db = getDb();
  const plans = db.prepare(`
    SELECT * FROM warmup_plans
    WHERE mailbox_id = ?
    ORDER BY target_date DESC
    LIMIT 14
  `).all(mailboxId);

  // Today's sent count
  const todaySentRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM warmup_events
    WHERE mailbox_id = ?
      AND direction = 'sent'
      AND date(created_at) = date('now')
  `).get(mailboxId);

  return {
    todaySent: todaySentRow ? todaySentRow.cnt : 0,
    history: plans
  };
}
