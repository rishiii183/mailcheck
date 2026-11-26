import { getDb } from '../db.js';

/**
 * Calculate the daily warm-up email target based on warm-up day
 * Formula:
 * - Day 1: 3 emails
 * - Day 2+: +2 emails per day (e.g. Day 2 = 5, Day 3 = 7, Day 4 = 9 ...)
 * - Capped at maxDailyCap (default 40)
 * - After reaching cap or after ~20 days, maintenance mode at ~15-20/day if configured
 * 
 * @param {number} dayNumber 1-based day index
 * @param {number} [maxCap=40] 
 * @param {boolean} [maintenance=false]
 * @returns {number}
 */
export function calculateWarmupTarget(dayNumber, maxCap = 40, maintenance = false) {
  if (dayNumber <= 0) return 0;

  if (maintenance) {
    return 15;
  }

  // Linear ramp: 3 + (day - 1) * 2
  const ramp = 3 + (dayNumber - 1) * 2;

  return Math.min(ramp, maxCap);
}

/**
 * Generate randomized send timestamps for a target number of emails
 * distributed throughout a time window (e.g., 09:00 to 18:00) with jitter
 * @param {number} count Total emails to plan
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} [startHour="09:00"]
 * @param {string} [endHour="18:00"]
 * @returns {string[]} Array of ISO timestamps
 */
export function generateRandomSchedule(count, dateStr, startHour = '09:00', endHour = '18:00') {
  if (count <= 0) return [];

  const [startH, startM] = startHour.split(':').map(Number);
  const [endH, endM] = endHour.split(':').map(Number);

  const startMs = new Date(`${dateStr}T${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00Z`).getTime();
  const endMs = new Date(`${dateStr}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00Z`).getTime();
  const windowSpanMs = Math.max(1000, endMs - startMs);

  const timestamps = [];
  for (let i = 0; i < count; i++) {
    // Distribute with random jitter so sends are never in a fixed pattern
    const randomOffset = Math.random() * windowSpanMs;
    const sendTime = new Date(startMs + randomOffset);
    timestamps.push(sendTime.toISOString());
  }

  // Sort chronologically
  return timestamps.sort();
}

/**
 * Create or fetch today's warm-up plan for a mailbox
 */
export function getOrCreateTodayPlan(mailbox, targetDateStr = null) {
  const db = getDb();
  const dateStr = targetDateStr || new Date().toISOString().slice(0, 10);

  // Check if plan already exists for today
  let plan = db.prepare(`
    SELECT * FROM warmup_plans
    WHERE mailbox_id = ? AND target_date = ?
  `).get(mailbox.id, dateStr);

  if (plan) return plan;

  // Calculate warm-up day number
  const startDate = mailbox.warmup_start_date ? new Date(mailbox.warmup_start_date) : new Date();
  const targetDate = new Date(`${dateStr}T00:00:00Z`);
  const daysDiff = Math.max(0, Math.floor((targetDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
  const dayNumber = daysDiff + 1;

  const targetCount = calculateWarmupTarget(dayNumber, mailbox.daily_warmup_target || 40);

  const info = db.prepare(`
    INSERT INTO warmup_plans (mailbox_id, day_number, planned_sends, target_date, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(mailbox.id, dayNumber, targetCount, dateStr);

  return db.prepare('SELECT * FROM warmup_plans WHERE id = ?').get(info.lastInsertRowid);
}
