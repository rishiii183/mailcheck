import { getDb } from '../db.js';

/**
 * Calculates current campaign send allowance for a mailbox based on warm-up stage
 * @param {Object} mailbox 
 * @param {Date} [customDate=new Date()]
 * @returns {number} Allowed daily sends for campaigns
 */
export function getMailboxEffectiveDailyCap(mailbox, customDate = new Date()) {
  const configuredCap = mailbox.campaign_daily_cap || 50;

  if (mailbox.status === 'error' || mailbox.status === 'paused') {
    return 0;
  }

  // If mailbox is fully ready and not warming, use configured cap
  if (mailbox.status !== 'warming' || !mailbox.warmup_start_date) {
    return configuredCap;
  }

  // Calculate days elapsed in warm-up (1-indexed day count)
  const start = new Date(mailbox.warmup_start_date).getTime();
  const now = customDate.getTime();
  const diffDays = Math.max(0, Math.floor((now - start) / (1000 * 60 * 60 * 24))) + 1;

  if (diffDays <= 7) {
    // Days 1-7: No campaign sending, 100% warm-up focus
    return 0;
  } else if (diffDays <= 14) {
    // Week 2: Conservative limit of 10/day
    return Math.min(10, configuredCap);
  } else if (diffDays <= 21) {
    // Week 3: Scaled up to 25/day
    return Math.min(25, configuredCap);
  }

  // Week 4+: Full configured cap
  return configuredCap;
}

/**
 * Get number of campaign emails sent by this mailbox today (UTC or local)
 * @param {number} mailboxId 
 * @returns {number}
 */
export function getMailboxSentToday(mailboxId) {
  let sentToday = 0;
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM lead_steps
      WHERE mailbox_id = ?
        AND status = 'sent'
        AND date(sent_at) = date('now')
    `).get(mailboxId);

    sentToday = row ? row.cnt : 0;
  } catch {
    // Handle in-memory or uninitialized DB
  }
  return sentToday;
}

/**
 * Check if the mailbox has capacity to send another email today
 * @param {Object} mailbox 
 * @param {Date} [customDate=new Date()]
 * @returns {{ canSend: boolean, remaining: number, effectiveCap: number, sentToday: number, reason?: string }}
 */
export function checkMailboxCapacity(mailbox, customDate = new Date()) {
  const effectiveCap = getMailboxEffectiveDailyCap(mailbox, customDate);
  const sentToday = getMailboxSentToday(mailbox.id);
  const remaining = Math.max(0, effectiveCap - sentToday);

  if (mailbox.status === 'error' || mailbox.status === 'paused') {
    return {
      canSend: false,
      remaining: 0,
      effectiveCap: 0,
      sentToday,
      reason: `Mailbox is currently ${mailbox.status}`
    };
  }

  if (effectiveCap === 0 && mailbox.status === 'warming') {
    return {
      canSend: false,
      remaining: 0,
      effectiveCap,
      sentToday,
      reason: 'Mailbox is in early warm-up phase (Days 1-7). Campaign sends are paused to build initial reputation.'
    };
  }

  if (remaining <= 0) {
    return {
      canSend: false,
      remaining: 0,
      effectiveCap,
      sentToday,
      reason: `Daily sending limit reached (${sentToday}/${effectiveCap})`
    };
  }

  return {
    canSend: true,
    remaining,
    effectiveCap,
    sentToday
  };
}

/**
 * Alias helper for getMailboxLimits used in accounts.js
 */
export function getMailboxLimits(mailbox, customDate = new Date()) {
  const cap = checkMailboxCapacity(mailbox, customDate);
  return {
    status: mailbox.status,
    configuredCap: mailbox.campaign_daily_cap || 50,
    effectiveCap: cap.effectiveCap,
    sentToday: cap.sentToday,
    remainingToday: cap.remaining,
    canSend: cap.canSend,
    reason: cap.reason || null
  };
}

/**
 * Check if current time falls within schedule send window and days
 * 6.6 Rule: Use hourCycle: 'h23' in Intl formatter to avoid the "24:00" midnight quirk
 * @param {Object} schedule 
 * @param {Date} [date=new Date()]
 * @returns {boolean}
 */
export function isWithinSendWindow(schedule, date = new Date()) {
  const timezone = schedule.timezone || 'UTC';
  const sendDays = schedule.send_days || [1, 2, 3, 4, 5]; // 1 = Monday ... 7 = Sunday
  const windowStart = schedule.window_start || '09:00';
  const windowEnd = schedule.window_end || '17:00';

  // Format current time in campaign's timezone
  const now = date || new Date();
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  });

  const [currentHourStr, currentMinStr] = timeFormatter.format(now).split(':');
  const currentMinutes = parseInt(currentHourStr, 10) * 60 + parseInt(currentMinStr, 10);

  const [startH, startM] = windowStart.split(':').map(n => parseInt(n, 10));
  const [endH, endM] = windowEnd.split(':').map(n => parseInt(n, 10));
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Day of week in timezone: Mon=1 ... Sun=7
  const weekdayStr = weekdayFormatter.format(now);
  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const currentDay = dayMap[weekdayStr] || 1;

  if (!sendDays.includes(currentDay)) {
    return false;
  }

  if (startMinutes <= endMinutes) {
    if (currentMinutes < startMinutes || currentMinutes >= endMinutes) {
      return false;
    }
  } else {
    // Window crosses midnight (e.g., 22:00 - 04:00)
    if (currentMinutes < startMinutes && currentMinutes >= endMinutes) {
      return false;
    }
  }

  return true;
}

/**
 * Calculate random gap between sends with jitter (in milliseconds)
 * @param {number} minGapSec 
 * @param {number} maxGapSec 
 * @returns {number}
 */
export function calculateRandomSendGap(minGapSec = 90, maxGapSec = 240) {
  const min = Math.min(minGapSec, maxGapSec);
  const max = Math.max(minGapSec, maxGapSec);
  // Add random jitter of +/- 5%
  const baseSec = min + Math.random() * (max - min);
  const jitter = (Math.random() - 0.5) * 0.1 * baseSec;
  return Math.round((baseSec + jitter) * 1000);
}
