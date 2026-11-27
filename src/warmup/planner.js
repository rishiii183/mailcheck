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
 * Checks whether current time is within the warm-up delivery window (local timezone default)
 * @param {string} [windowStart="09:00"]
 * @param {string} [windowEnd="18:00"]
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isWithinWarmupWindow(windowStart = '09:00', windowEnd = '18:00', now = new Date()) {
  const [startH, startM] = windowStart.split(':').map(Number);
  const [endH, endM] = windowEnd.split(':').map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

/**
 * Ensure the warmup_schedule table is populated with timestamps for the day
 * @param {number} mailboxId 
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} count 
 */
export function ensureWarmupSchedule(mailboxId, dateStr, count) {
  try {
    const db = getDb();
    const existingCountRow = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM warmup_schedule
      WHERE mailbox_id = ? AND date = ?
    `).get(mailboxId, dateStr);

    if (existingCountRow && existingCountRow.cnt > 0) {
      return;
    }

    const windowStartRow = db.prepare("SELECT value FROM settings WHERE key = 'warmup_window_start'").get();
    const windowEndRow = db.prepare("SELECT value FROM settings WHERE key = 'warmup_window_end'").get();
    const windowStart = windowStartRow ? windowStartRow.value : '09:00';
    const windowEnd = windowEndRow ? windowEndRow.value : '18:00';

    const timestamps = generateRandomSchedule(count, dateStr, windowStart, windowEnd);
    const insertStmt = db.prepare(`
      INSERT INTO warmup_schedule (mailbox_id, date, send_at, status)
      VALUES (?, ?, ?, 'pending')
    `);

    const insertTx = db.transaction(() => {
      for (const t of timestamps) {
        insertStmt.run(mailboxId, dateStr, t);
      }
    });
    insertTx();
  } catch {}
}

/**
 * Create or fetch today's warm-up plan for a mailbox, and populate warmup_schedule
 */
export function getOrCreateTodayPlan(mailbox, targetDateStr = null) {
  const db = getDb();
  const dateStr = targetDateStr || new Date().toISOString().slice(0, 10);

  // Check if plan already exists for today
  let plan = db.prepare(`
    SELECT * FROM warmup_plans
    WHERE mailbox_id = ? AND target_date = ?
  `).get(mailbox.id, dateStr);

  if (!plan) {
    // 5.6 Rule: Fix timezone handling for warmup_start_date (store ISO UTC everywhere)
    const startDateStr = mailbox.warmup_start_date
      ? new Date(mailbox.warmup_start_date).toISOString().slice(0, 10)
      : dateStr;
    const startDate = new Date(`${startDateStr}T00:00:00Z`);
    const targetDate = new Date(`${dateStr}T00:00:00Z`);
    const daysDiff = Math.max(0, Math.floor((targetDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const dayNumber = daysDiff + 1;

    const targetCount = calculateWarmupTarget(dayNumber, mailbox.daily_warmup_target || 40);

    const info = db.prepare(`
      INSERT INTO warmup_plans (mailbox_id, day_number, planned_sends, target_date, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `).run(mailbox.id, dayNumber, targetCount, dateStr);

    plan = db.prepare('SELECT * FROM warmup_plans WHERE id = ?').get(info.lastInsertRowid);
  }

  // 5.1 Rule: Store the day's send times in warmup_schedule table
  ensureWarmupSchedule(mailbox.id, dateStr, plan.planned_sends);

  return plan;
}
