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
  // Status 'inbox', 'spam_rescued', 'bounced' (5.7: only count observed deliveries)
  const events = db.prepare(`
    SELECT status, COUNT(*) as cnt
    FROM warmup_events
    WHERE partner_mailbox_id = ?
      AND direction = 'received'
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

/**
 * 5.7 Rule: Warmup status summary endpoint helper
 * Returns pool health, today's planned vs sent, last error, next scheduled send
 */
export function getWarmupPoolStatus() {
  const db = getDb();
  const allMailboxes = db.prepare('SELECT * FROM mailboxes').all();
  const warmingMailboxes = allMailboxes.filter(m => m.status === 'warming' && !m.error_reason);

  const poolSize = warmingMailboxes.length;
  const poolOk = poolSize >= 2;
  const poolMessage = poolOk
    ? `Warm-up pool active with ${poolSize} mailboxes.`
    : `Warm-up pool requires at least 2 active mailboxes in 'warming' status (currently: ${poolSize}).`;

  const todayStr = new Date().toISOString().slice(0, 10);

  // Today's planned sends across all warming mailboxes
  let totalPlanned = 0;
  for (const mb of warmingMailboxes) {
    const plan = db.prepare(`
      SELECT planned_sends FROM warmup_plans WHERE mailbox_id = ? AND target_date = ?
    `).get(mb.id, todayStr);
    totalPlanned += plan ? plan.planned_sends : (mb.daily_warmup_target || 40);
  }

  // Today's sent count
  const todaySentRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM warmup_events
    WHERE direction = 'sent' AND date(created_at) = date('now')
  `).get();
  const todaySent = todaySentRow ? todaySentRow.cnt : 0;

  // Next scheduled send
  const nextSendRow = db.prepare(`
    SELECT send_at FROM warmup_schedule
    WHERE status = 'pending' AND datetime(send_at) >= datetime('now')
    ORDER BY send_at ASC LIMIT 1
  `).get();
  const nextScheduledSend = nextSendRow ? nextSendRow.send_at : null;

  // Last error
  const lastFailedJob = db.prepare(`
    SELECT last_error FROM warmup_delivery_jobs
    WHERE status = 'failed' AND last_error IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1
  `).get();

  const lastMailboxError = warmingMailboxes.find(m => m.error_reason)?.error_reason || null;
  const lastError = lastFailedJob ? lastFailedJob.last_error : lastMailboxError;

  // Detailed mailboxes summary
  const mailboxesSummary = warmingMailboxes.map(mb => {
    const health = getMailboxHealth(mb.id);
    const mbPlan = db.prepare(`
      SELECT planned_sends FROM warmup_plans WHERE mailbox_id = ? AND target_date = ?
    `).get(mb.id, todayStr);
    const mbSent = db.prepare(`
      SELECT COUNT(*) as cnt FROM warmup_events
      WHERE mailbox_id = ? AND direction = 'sent' AND date(created_at) = date('now')
    `).get(mb.id)?.cnt || 0;
    const mbNextSend = db.prepare(`
      SELECT send_at FROM warmup_schedule
      WHERE mailbox_id = ? AND status = 'pending'
      ORDER BY send_at ASC LIMIT 1
    `).get(mb.id)?.send_at || null;

    return {
      id: mb.id,
      email: mb.email,
      status: mb.status,
      today_planned: mbPlan ? mbPlan.planned_sends : (mb.daily_warmup_target || 40),
      today_sent: mbSent,
      next_send_at: mbNextSend,
      placement_rate: health.placementRate,
      reputation_score: health.reputationScore,
      error_reason: mb.error_reason,
      health
    };
  });

  return {
    pool: {
      ok: poolOk,
      size: poolSize,
      message: poolMessage
    },
    today: {
      planned: totalPlanned,
      sent: todaySent
    },
    last_error: lastError,
    next_scheduled_send: nextScheduledSend,
    mailboxes: mailboxesSummary
  };
}
