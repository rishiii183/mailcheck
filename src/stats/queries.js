import { getDb } from '../db.js';

/**
 * Standard percentage rate calculation rounded to 1 decimal place
 * @param {number} numerator 
 * @param {number} denominator 
 * @returns {number} 0 to 100
 */
export function calculateRate(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Standardized Metrics Definitions (Batch 3):
 * - contacted: distinct leads that received at least one sent step.
 * - emailsSent: count of 'sent' events.
 * - delivered: emailsSent minus distinct sent steps with a bounce event.
 * - openRate: distinct leads with a likely-real open ÷ contacted.
 * - openRateAny: distinct leads with any open (incl. machine/proxy) ÷ contacted.
 * - clickRate: distinct leads with a non-bot click ÷ contacted (excludes is_probable_bot).
 * - replyRate: distinct leads with a real (non-auto) reply ÷ contacted.
 * - bounceRate: distinct bounced leads ÷ contacted.
 * - unsubscribeRate: distinct unsubscribed leads ÷ contacted.
 * - Denominators:
 *   - Campaign & Overview totals: 'per_lead' (denominator = contacted)
 *   - Per-step & per-variant stats: 'per_email' (denominator = sent)
 */

/**
 * Global overview statistics for date range
 */
export function getOverviewStats(daysOrFrom = 30, maybeTo = null) {
  const db = getDb();
  let from = null;
  let to = null;

  if (typeof daysOrFrom === 'string' && daysOrFrom.includes('-')) {
    from = daysOrFrom;
    to = maybeTo;
  } else if (typeof daysOrFrom === 'number' || (daysOrFrom && !isNaN(parseInt(daysOrFrom, 10)) && !String(daysOrFrom).includes('-'))) {
    const days = parseInt(daysOrFrom, 10) || 30;
    const endD = maybeTo ? new Date(maybeTo) : new Date();
    const startD = new Date(endD.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    from = startD.toISOString().slice(0, 10);
    to = endD.toISOString().slice(0, 10);
  } else {
    from = daysOrFrom;
    to = maybeTo;
  }

  const params = [];
  if (from && to) {
    params.push(from, to);
  } else if (from) {
    params.push(from);
  } else if (to) {
    params.push(to);
  }

  const buildDateCondition = (prefix = '') => {
    const col = prefix ? `${prefix}.timestamp` : 'timestamp';
    if (from && to) return `date(${col}) BETWEEN date(?) AND date(?)`;
    if (from) return `date(${col}) >= date(?)`;
    if (to) return `date(${col}) <= date(?)`;
    return '';
  };

  const dateCondEE = buildDateCondition('ee');
  const dateCondPlain = buildDateCondition('');

  const whereEE = (extra) => {
    const parts = [];
    if (dateCondEE) parts.push(dateCondEE);
    if (extra) parts.push(extra);
    return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  };

  const wherePlain = (extra) => {
    const parts = [];
    if (dateCondPlain) parts.push(dateCondPlain);
    if (extra) parts.push(extra);
    return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  };

  // 1. emailsSent = count of 'sent' events
  const sentRow = db.prepare(`SELECT COUNT(*) as cnt FROM email_events ${wherePlain("type = 'sent'")}`).get(...params);
  const emailsSent = sentRow ? sentRow.cnt : 0;

  // 2. contacted = distinct leads that received at least one sent step
  const contactedRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'sent'")}
  `).get(...params);
  const contacted = contactedRow ? contactedRow.cnt : 0;

  // 3. Bounces
  // Bounced steps count (for delivered calculation)
  const bouncedStepsRow = db.prepare(`
    SELECT COUNT(DISTINCT ee.lead_step_id) as cnt
    FROM email_events ee
    ${whereEE("ee.type IN ('bounce_hard', 'bounce_soft')")}
  `).get(...params);
  const bouncedSteps = bouncedStepsRow ? bouncedStepsRow.cnt : 0;

  // Distinct bounced leads (for bounce rate)
  const bouncedLeadsRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type IN ('bounce_hard', 'bounce_soft')")}
  `).get(...params);
  const bouncedLeads = bouncedLeadsRow ? bouncedLeadsRow.cnt : 0;

  // delivered = emailsSent minus distinct sent steps with a bounce event
  const delivered = Math.max(0, emailsSent - bouncedSteps);

  // 4. Opens
  // Distinct leads with any open (incl. machine/proxy)
  const openAnyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'open'")}
  `).get(...params);
  const openedAny = openAnyRow ? openAnyRow.cnt : 0;

  // Distinct leads with a likely-real open (is_probable_bot = 0 or null)
  const openHumanRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'open' AND (json_extract(ee.meta_json, '$.is_probable_bot') IS NULL OR json_extract(ee.meta_json, '$.is_probable_bot') = 0)")}
  `).get(...params);
  const openedHuman = openHumanRow ? openHumanRow.cnt : 0;

  // Distinct leads with Gmail proxy opens (GoogleImageProxy)
  const gmailProxyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'open' AND (json_extract(ee.meta_json, '$.is_gmail_proxy') = 1 OR json_extract(ee.meta_json, '$.user_agent') LIKE '%GoogleImageProxy%')")}
  `).get(...params);
  const gmailProxyOpens = gmailProxyRow ? gmailProxyRow.cnt : 0;

  // 5. Clicks
  // Distinct leads with a non-bot click
  const clickRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'click' AND (json_extract(ee.meta_json, '$.is_probable_bot') IS NULL OR json_extract(ee.meta_json, '$.is_probable_bot') = 0)")}
  `).get(...params);
  const clicked = clickRow ? clickRow.cnt : 0;

  const clickAnyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'click'")}
  `).get(...params);
  const clickedAny = clickAnyRow ? clickAnyRow.cnt : 0;

  // 6. Replies
  // Distinct leads with a real (non-auto) reply
  const replyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'reply' AND (json_extract(ee.meta_json, '$.is_auto_reply') IS NULL OR json_extract(ee.meta_json, '$.is_auto_reply') = 0)")}
  `).get(...params);
  const replied = replyRow ? replyRow.cnt : 0;

  // 7. Unsubscribes
  // Distinct unsubscribed leads
  const unsubRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    ${whereEE("ee.type = 'unsubscribe'")}
  `).get(...params);
  const unsubscribed = unsubRow ? unsubRow.cnt : 0;

  // Rates: denominator is contacted leads
  const openRate = calculateRate(openedHuman, contacted);
  const openRateAny = calculateRate(openedAny, contacted);
  const clickRate = calculateRate(clicked, contacted);
  const replyRate = calculateRate(replied, contacted);
  const bounceRate = calculateRate(bouncedLeads, contacted);
  const unsubscribeRate = calculateRate(unsubscribed, contacted);

  // 2.10 Daily timeline (30 days ascending, filling missing days with zeros, respecting from/to)
  let endD = to ? new Date(to) : new Date();
  if (isNaN(endD.getTime())) endD = new Date();
  let startD = from ? new Date(from) : new Date(endD.getTime() - 29 * 24 * 60 * 60 * 1000);
  if (isNaN(startD.getTime())) startD = new Date(endD.getTime() - 29 * 24 * 60 * 60 * 1000);

  const formatYmd = (d) => d.toISOString().slice(0, 10);
  const startDayStr = formatYmd(startD);
  const endDayStr = formatYmd(endD);

  const eventCountsQuery = `
    SELECT
      date(timestamp) as day,
      SUM(CASE WHEN type = 'sent' THEN 1 ELSE 0 END) as sent,
      COUNT(DISTINCT CASE WHEN type = 'open' THEN lead_step_id END) as opened,
      COUNT(DISTINCT CASE WHEN type = 'reply' THEN lead_step_id END) as replied,
      COUNT(DISTINCT CASE WHEN type = 'click' THEN lead_step_id END) as clicked,
      COUNT(DISTINCT CASE WHEN type IN ('bounce_hard', 'bounce_soft') THEN lead_step_id END) as bounced
    FROM email_events
    WHERE date(timestamp) >= date(?) AND date(timestamp) <= date(?)
    GROUP BY date(timestamp)
    ORDER BY date(timestamp) ASC
  `;
  const dbDays = db.prepare(eventCountsQuery).all(startDayStr, endDayStr);
  const dbDaysMap = new Map();
  for (const d of dbDays) {
    dbDaysMap.set(d.day, d);
  }

  const timeline = [];
  const targetEnd = new Date(endD);
  targetEnd.setUTCHours(0, 0, 0, 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date(targetEnd.getTime() - i * 24 * 60 * 60 * 1000);
    const dayStr = d.toISOString().slice(0, 10);
    const found = dbDaysMap.get(dayStr);
    timeline.push({
      date: dayStr,
      day: dayStr,
      sent: found ? (found.sent || 0) : 0,
      opened: found ? (found.opened || 0) : 0,
      replied: found ? (found.replied || 0) : 0,
      clicked: found ? (found.clicked || 0) : 0,
      bounced: found ? (found.bounced || 0) : 0
    });
  }

  return {
    totals: {
      contacted,
      emailsSent,
      sent: emailsSent, // backwards compatibility
      delivered,
      opened: openedHuman,
      uniqueOpens: openedAny, // backwards compatibility
      likelyRealOpens: openedHuman, // backwards compatibility
      openedAny, // "opened (any, incl. machine)"
      openedHuman, // "opened (verified human)"
      gmailProxyOpens, // "Gmail proxy opens"
      clicked,
      clickedAny,
      replied,
      bounced: bouncedLeads,
      bouncedSteps,
      unsubscribed,
      denominator: 'per_lead'
    },
    rates: {
      openRate, // likely-real open ÷ contacted
      openRateAny, // any open ÷ contacted
      likelyRealOpenRate: openRate, // backwards compatibility alias
      clickRate, // non-bot click ÷ contacted
      replyRate, // real reply ÷ contacted
      bounceRate, // bounced leads ÷ contacted
      unsubscribeRate, // unsubscribed leads ÷ contacted
      denominator: 'per_lead'
    },
    timeline,
    disclaimer: 'Open rates are statistical estimates due to privacy protections and machine mail scanning.'
  };
}

/**
 * Campaign-specific deep statistics & breakdown
 * Standardized to Batch 3 definitions with clear per-lead and per-email labeling
 */
export function getCampaignStats(campaignId) {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;

  // Total Leads assigned to this campaign
  const leadsCount = db.prepare('SELECT COUNT(DISTINCT lead_id) as cnt FROM lead_steps WHERE campaign_id = ?').get(campaignId).cnt;

  // 1. emailsSent = total count of 'sent' events
  const sentRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'sent'
  `).get(campaignId);
  const emailsSent = sentRow ? sentRow.cnt : 0;

  // 2. contacted = distinct leads that received at least one sent step
  const contactedRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'sent'
  `).get(campaignId);
  const contacted = contactedRow ? contactedRow.cnt : 0;

  // 3. Bounces
  // Bounced steps count (for delivered calculation)
  const bouncedStepsRow = db.prepare(`
    SELECT COUNT(DISTINCT ee.lead_step_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type IN ('bounce_hard', 'bounce_soft')
  `).get(campaignId);
  const bouncedSteps = bouncedStepsRow ? bouncedStepsRow.cnt : 0;

  // Distinct bounced leads (for bounce rate)
  const bouncedLeadsRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type IN ('bounce_hard', 'bounce_soft')
  `).get(campaignId);
  const bouncedLeads = bouncedLeadsRow ? bouncedLeadsRow.cnt : 0;

  // delivered = emailsSent minus distinct sent steps with a bounce event
  const delivered = Math.max(0, emailsSent - bouncedSteps);

  // 4. Opens
  // Distinct leads with any open (incl. machine/proxy)
  const openedAnyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'open'
  `).get(campaignId);
  const openedAny = openedAnyRow ? openedAnyRow.cnt : 0;

  // Distinct leads with a likely-real open (is_probable_bot = 0 or null)
  const openedHumanRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'open'
      AND (json_extract(ee.meta_json, '$.is_probable_bot') IS NULL OR json_extract(ee.meta_json, '$.is_probable_bot') = 0)
  `).get(campaignId);
  const openedHuman = openedHumanRow ? openedHumanRow.cnt : 0;

  // Distinct leads with Gmail proxy opens (GoogleImageProxy)
  const gmailProxyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'open'
      AND (json_extract(ee.meta_json, '$.is_gmail_proxy') = 1 OR json_extract(ee.meta_json, '$.user_agent') LIKE '%GoogleImageProxy%')
  `).get(campaignId);
  const gmailProxyOpens = gmailProxyRow ? gmailProxyRow.cnt : 0;

  // 5. Clicks
  // Distinct leads with a non-bot click
  const clickRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'click'
      AND (json_extract(ee.meta_json, '$.is_probable_bot') IS NULL OR json_extract(ee.meta_json, '$.is_probable_bot') = 0)
  `).get(campaignId);
  const clicked = clickRow ? clickRow.cnt : 0;

  const clickAnyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'click'
  `).get(campaignId);
  const clickedAny = clickAnyRow ? clickAnyRow.cnt : 0;

  // 6. Replies
  // Distinct leads with a real (non-auto) reply
  const replyRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'reply'
      AND (json_extract(ee.meta_json, '$.is_auto_reply') IS NULL OR json_extract(ee.meta_json, '$.is_auto_reply') = 0)
  `).get(campaignId);
  const replied = replyRow ? replyRow.cnt : 0;

  // 7. Unsubscribes
  // Distinct unsubscribed leads
  const unsubRow = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'unsubscribe'
  `).get(campaignId);
  const unsubscribed = unsubRow ? unsubRow.cnt : 0;

  // Rates: denominator is contacted leads
  const openRate = calculateRate(openedHuman, contacted);
  const openRateAny = calculateRate(openedAny, contacted);
  const clickRate = calculateRate(clicked, contacted);
  const replyRate = calculateRate(replied, contacted);
  const bounceRate = calculateRate(bouncedLeads, contacted);
  const unsubscribeRate = calculateRate(unsubscribed, contacted);

  // Step breakdown (denominator labeled: per-email)
  const steps = db.prepare(`
    SELECT ss.id, ss.step_number,
      COUNT(DISTINCT CASE WHEN ee.type = 'sent' THEN ls.id END) as sent,
      COUNT(DISTINCT CASE WHEN ee.type = 'open' THEN ls.id END) as opened,
      COUNT(DISTINCT CASE WHEN ee.type = 'open' AND (json_extract(ee.meta_json, '$.is_probable_bot') IS NULL OR json_extract(ee.meta_json, '$.is_probable_bot') = 0) THEN ls.id END) as opened_human,
      COUNT(DISTINCT CASE WHEN ee.type = 'click' AND (json_extract(ee.meta_json, '$.is_probable_bot') IS NULL OR json_extract(ee.meta_json, '$.is_probable_bot') = 0) THEN ls.id END) as clicked,
      COUNT(DISTINCT CASE WHEN ee.type = 'reply' AND (json_extract(ee.meta_json, '$.is_auto_reply') IS NULL OR json_extract(ee.meta_json, '$.is_auto_reply') = 0) THEN ls.id END) as replied,
      COUNT(DISTINCT CASE WHEN ee.type IN ('bounce_hard', 'bounce_soft') THEN ls.id END) as bounced
    FROM sequence_steps ss
    LEFT JOIN lead_steps ls ON ls.sequence_step_id = ss.id
    LEFT JOIN email_events ee ON ee.lead_step_id = ls.id
    WHERE ss.campaign_id = ?
    GROUP BY ss.id, ss.step_number
    ORDER BY ss.step_number ASC
  `).all(campaignId);

  for (const s of steps) {
    s.denominator = 'per_email';
    s.delivered = Math.max(0, s.sent - s.bounced);
    s.open_rate = calculateRate(s.opened_human || s.opened, s.sent);
    s.reply_rate = calculateRate(s.replied, s.sent);
    s.bounce_rate = calculateRate(s.bounced, s.sent);
  }

  // Per-variant A/B comparison (denominator labeled: per-email)
  const variants = db.prepare(`
    SELECT sv.id, sv.variant_letter, sv.subject,
      COUNT(DISTINCT CASE WHEN ee.type = 'sent' THEN ls.id END) as sent,
      COUNT(DISTINCT CASE WHEN ee.type = 'open' THEN ls.id END) as opened,
      COUNT(DISTINCT CASE WHEN ee.type = 'open' AND (json_extract(ee.meta_json, '$.is_probable_bot') IS NULL OR json_extract(ee.meta_json, '$.is_probable_bot') = 0) THEN ls.id END) as opened_human,
      COUNT(DISTINCT CASE WHEN ee.type = 'reply' AND (json_extract(ee.meta_json, '$.is_auto_reply') IS NULL OR json_extract(ee.meta_json, '$.is_auto_reply') = 0) THEN ls.id END) as replied
    FROM step_variants sv
    JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
    LEFT JOIN lead_steps ls ON ls.variant_id = sv.id
    LEFT JOIN email_events ee ON ee.lead_step_id = ls.id
    WHERE ss.campaign_id = ?
    GROUP BY sv.id, sv.variant_letter, sv.subject
    ORDER BY sv.variant_letter ASC
  `).all(campaignId);

  for (const v of variants) {
    v.denominator = 'per_email';
    v.open_rate = calculateRate(v.opened_human || v.opened, v.sent);
    v.reply_rate = calculateRate(v.replied, v.sent);
  }

  // Per-mailbox performance (denominator labeled: per-email)
  const mailboxPerformance = db.prepare(`
    SELECT m.id, m.email, m.display_name,
      COUNT(DISTINCT CASE WHEN ee.type = 'sent' THEN ls.id END) as sent,
      COUNT(DISTINCT CASE WHEN ee.type = 'open' THEN ls.id END) as opened,
      COUNT(DISTINCT CASE WHEN ee.type = 'reply' THEN ls.id END) as replied,
      COUNT(DISTINCT CASE WHEN ee.type IN ('bounce_hard', 'bounce_soft') THEN ls.id END) as bounced
    FROM campaign_mailboxes cm
    JOIN mailboxes m ON m.id = cm.mailbox_id
    LEFT JOIN lead_steps ls ON ls.mailbox_id = m.id AND ls.campaign_id = cm.campaign_id
    LEFT JOIN email_events ee ON ee.lead_step_id = ls.id
    WHERE cm.campaign_id = ?
    GROUP BY m.id
  `).all(campaignId);

  for (const mb of mailboxPerformance) {
    mb.denominator = 'per_email';
    mb.bounce_rate = calculateRate(mb.bounced, mb.sent);
    mb.open_rate = calculateRate(mb.opened, mb.sent);
    mb.reply_rate = calculateRate(mb.replied, mb.sent);
  }

  const resultData = {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status
    },
    funnel: {
      leads: leadsCount,
      contacted,
      emailsSent,
      sent: emailsSent, // backwards compatibility
      delivered,
      opened: openedHuman,
      uniqueOpens: openedAny, // backwards compatibility
      openedAny, // "opened (any, incl. machine)"
      openedHuman, // "opened (verified human)"
      gmailProxyOpens, // "Gmail proxy opens"
      clicked,
      clickedAny,
      replied,
      bounced: bouncedLeads,
      unsubscribed,
      denominator: 'per_lead'
    },
    totals: {
      leads: leadsCount,
      contacted,
      emailsSent,
      sent: emailsSent,
      delivered,
      opened: openedHuman,
      uniqueOpens: openedAny,
      openedAny,
      openedHuman,
      gmailProxyOpens,
      clicked,
      clickedAny,
      replied,
      bounced: bouncedLeads,
      unsubscribed,
      denominator: 'per_lead'
    },
    rates: {
      openRate, // likely-real open ÷ contacted
      openRateAny, // any open ÷ contacted
      likelyRealOpenRate: openRate, // backwards compatibility alias
      clickRate, // non-bot click ÷ contacted
      replyRate, // real reply ÷ contacted
      bounceRate, // bounced leads ÷ contacted
      unsubscribeRate, // unsubscribed leads ÷ contacted
      denominator: 'per_lead'
    },
    steps,
    variants,
    mailboxPerformance,
    disclaimer: 'Open rates are statistical estimates due to privacy protections and machine mail scanning.'
  };

  return resultData;
}

/**
 * Filter campaign leads by segment status with pagination
 * Filters: 'all', 'opened', 'not_opened', 'replied', 'bounced', 'unsubscribed', 'opened_no_reply', 'no_activity'
 * @param {number} campaignId
 * @param {string} [filter='all']
 * @param {number} [limit=50]
 * @param {number} [offset=0]
 * @returns {{ items: Array, total: number }}
 */
export function getCampaignLeads(campaignId, filter = 'all', limit = 50, offset = 0) {
  const db = getDb();

  let havingFilter = '';
  switch (filter) {
    case 'opened':
      havingFilter = 'open_count > 0';
      break;
    case 'not_opened':
      havingFilter = 'sent_count > 0 AND open_count = 0';
      break;
    case 'opened_no_reply':
      havingFilter = 'open_count > 0 AND reply_count = 0';
      break;
    case 'replied':
      havingFilter = 'reply_count > 0';
      break;
    case 'bounced':
      havingFilter = "bounce_count > 0 OR lead_status = 'bounced'";
      break;
    case 'unsubscribed':
      havingFilter = "unsub_count > 0 OR lead_status = 'unsubscribed'";
      break;
    case 'no_activity':
      havingFilter = 'sent_count > 0 AND open_count = 0 AND click_count = 0 AND reply_count = 0';
      break;
    case 'all':
    default:
      havingFilter = '';
      break;
  }

  const whereClause = havingFilter ? `WHERE ${havingFilter}` : '';

  const baseQuery = `
    FROM (
      SELECT
        l.id as lead_id, l.email, l.first_name, l.last_name, l.company, l.status as lead_status,
        COUNT(DISTINCT CASE WHEN ee.type = 'sent' THEN ls.id END) as sent_count,
        COUNT(DISTINCT CASE WHEN ee.type = 'open' THEN ls.id END) as open_count,
        COUNT(DISTINCT CASE WHEN ee.type = 'click' THEN ls.id END) as click_count,
        COUNT(DISTINCT CASE WHEN ee.type = 'reply' THEN ls.id END) as reply_count,
        COUNT(DISTINCT CASE WHEN ee.type IN ('bounce_hard', 'bounce_soft') THEN ls.id END) as bounce_count,
        COUNT(DISTINCT CASE WHEN ee.type = 'unsubscribe' THEN ls.id END) as unsub_count
      FROM leads l
      JOIN lead_steps ls ON ls.lead_id = l.id
      LEFT JOIN email_events ee ON ee.lead_step_id = ls.id
      WHERE ls.campaign_id = ?
      GROUP BY l.id, l.email, l.first_name, l.last_name, l.company, l.status
    ) sub
    ${whereClause}
  `;

  const totalRow = db.prepare(`SELECT COUNT(*) as cnt ${baseQuery}`).get(campaignId);
  const total = totalRow ? totalRow.cnt : 0;

  const parsedLimit = Math.max(1, parseInt(limit, 10) || 50);
  const parsedOffset = Math.max(0, parseInt(offset, 10) || 0);

  const items = db.prepare(`SELECT * ${baseQuery} ORDER BY lead_id ASC LIMIT ? OFFSET ?`).all(campaignId, parsedLimit, parsedOffset);

  const result = Object.assign(Object.create(Array.prototype), {
    items,
    leads: items,
    total,
    length: items.length,
    toJSON() {
      return { items: this.items, total: this.total, leads: this.leads };
    }
  });
  result[Symbol.iterator] = function* () { yield* items; };
  for (let i = 0; i < items.length; i++) {
    result[i] = items[i];
  }

  return result;
}

/**
 * Fetch chronological event timeline for an individual lead
 */
export function getLeadTimeline(leadId, campaignId = null) {
  const db = getDb();
  let query = `
    SELECT ee.id, ee.type, ee.timestamp, ee.meta_json,
           ls.campaign_id, c.name as campaign_name, ss.step_number
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    JOIN campaigns c ON c.id = ls.campaign_id
    JOIN sequence_steps ss ON ss.id = ls.sequence_step_id
    WHERE ls.lead_id = ?
  `;
  const params = [leadId];

  if (campaignId) {
    query += ' AND ls.campaign_id = ?';
    params.push(campaignId);
  }

  query += ' ORDER BY ee.timestamp ASC, ee.id ASC';

  return db.prepare(query).all(...params);
}
