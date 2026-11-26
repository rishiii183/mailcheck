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
 * Global overview statistics for date range
 */
export function getOverviewStats(from = null, to = null) {
  const db = getDb();
  const params = [];
  let dateClause = '';

  if (from && to) {
    dateClause = 'WHERE timestamp BETWEEN ? AND ?';
    params.push(from, to);
  } else if (from) {
    dateClause = 'WHERE timestamp >= ?';
    params.push(from);
  } else if (to) {
    dateClause = 'WHERE timestamp <= ?';
    params.push(to);
  }

  // 1. Total sends
  const sentRow = db.prepare(`SELECT COUNT(*) as cnt FROM email_events ${dateClause ? dateClause + " AND type = 'sent'" : "WHERE type = 'sent'"}`).get(...params);
  const sent = sentRow ? sentRow.cnt : 0;

  // 2. Hard bounces
  const bounceRow = db.prepare(`SELECT COUNT(DISTINCT lead_step_id) as cnt FROM email_events ${dateClause ? dateClause + " AND type IN ('bounce_hard', 'bounce_soft')" : "WHERE type IN ('bounce_hard', 'bounce_soft')"}`).get(...params);
  const bounced = bounceRow ? bounceRow.cnt : 0;

  // 3. Delivered = sent - bounced
  const delivered = Math.max(0, sent - bounced);

  // 4. Opens
  const openRow = db.prepare(`SELECT COUNT(DISTINCT lead_step_id) as cnt FROM email_events ${dateClause ? dateClause + " AND type = 'open'" : "WHERE type = 'open'"}`).get(...params);
  const uniqueOpens = openRow ? openRow.cnt : 0;

  // Likely real human opens (is_probable_bot = 0)
  const realOpenRow = db.prepare(`
    SELECT COUNT(DISTINCT lead_step_id) as cnt
    FROM email_events
    ${dateClause ? dateClause + " AND type = 'open'" : "WHERE type = 'open'"}
      AND (json_extract(meta_json, '$.is_probable_bot') IS NULL OR json_extract(meta_json, '$.is_probable_bot') = 0)
  `).get(...params);
  const likelyRealOpens = realOpenRow ? realOpenRow.cnt : 0;

  // 5. Clicks
  const clickRow = db.prepare(`SELECT COUNT(DISTINCT lead_step_id) as cnt FROM email_events ${dateClause ? dateClause + " AND type = 'click'" : "WHERE type = 'click'"}`).get(...params);
  const clicked = clickRow ? clickRow.cnt : 0;

  // 6. Replies (real replies, excluding auto_reply)
  const replyRow = db.prepare(`SELECT COUNT(DISTINCT lead_step_id) as cnt FROM email_events ${dateClause ? dateClause + " AND type = 'reply'" : "WHERE type = 'reply'"}`).get(...params);
  const replied = replyRow ? replyRow.cnt : 0;

  // 7. Unsubscribes
  const unsubRow = db.prepare(`SELECT COUNT(DISTINCT lead_step_id) as cnt FROM email_events ${dateClause ? dateClause + " AND type = 'unsubscribe'" : "WHERE type = 'unsubscribe'"}`).get(...params);
  const unsubscribed = unsubRow ? unsubRow.cnt : 0;

  // Rates
  const openRate = calculateRate(uniqueOpens, delivered);
  const likelyRealOpenRate = calculateRate(likelyRealOpens, delivered);
  const clickRate = calculateRate(clicked, delivered);
  const replyRate = calculateRate(replied, delivered);
  const bounceRate = calculateRate(bounced, sent);
  const unsubscribeRate = calculateRate(unsubscribed, delivered);

  // Daily timeline (last 30 days)
  const timeline = db.prepare(`
    SELECT
      date(timestamp) as day,
      SUM(CASE WHEN type = 'sent' THEN 1 ELSE 0 END) as sent,
      COUNT(DISTINCT CASE WHEN type = 'open' THEN lead_step_id END) as opened,
      COUNT(DISTINCT CASE WHEN type = 'reply' THEN lead_step_id END) as replied,
      COUNT(DISTINCT CASE WHEN type = 'click' THEN lead_step_id END) as clicked
    FROM email_events
    GROUP BY date(timestamp)
    ORDER BY date(timestamp) ASC
    LIMIT 30
  `).all();

  return {
    totals: {
      sent,
      delivered,
      uniqueOpens,
      likelyRealOpens,
      clicked,
      replied,
      bounced,
      unsubscribed
    },
    rates: {
      openRate,
      likelyRealOpenRate,
      clickRate,
      replyRate,
      bounceRate,
      unsubscribeRate
    },
    timeline,
    disclaimer: 'Open rates are statistical estimates due to privacy protections and machine mail scanning.'
  };
}

/**
 * Campaign-specific deep statistics & breakdown
 */
export function getCampaignStats(campaignId) {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;

  // Total Leads associated with this campaign
  const leadsCount = db.prepare('SELECT COUNT(DISTINCT lead_id) as cnt FROM lead_steps WHERE campaign_id = ?').get(campaignId).cnt;

  // Sent count
  const sent = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'sent'
  `).get(campaignId).cnt;

  // Bounces
  const bounced = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type IN ('bounce_hard', 'bounce_soft')
  `).get(campaignId).cnt;

  const delivered = Math.max(0, sent - bounced);

  // Opens
  const uniqueOpens = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'open'
  `).get(campaignId).cnt;

  // Clicks
  const clicked = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'click'
  `).get(campaignId).cnt;

  // Replies
  const replied = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'reply'
  `).get(campaignId).cnt;

  // Unsubscribes
  const unsubscribed = db.prepare(`
    SELECT COUNT(DISTINCT ls.lead_id) as cnt
    FROM email_events ee
    JOIN lead_steps ls ON ls.id = ee.lead_step_id
    WHERE ls.campaign_id = ? AND ee.type = 'unsubscribe'
  `).get(campaignId).cnt;

  // Step breakdown
  const steps = db.prepare(`
    SELECT ss.id, ss.step_number,
      COUNT(DISTINCT CASE WHEN ee.type = 'sent' THEN ls.id END) as sent,
      COUNT(DISTINCT CASE WHEN ee.type = 'open' THEN ls.id END) as opened,
      COUNT(DISTINCT CASE WHEN ee.type = 'click' THEN ls.id END) as clicked,
      COUNT(DISTINCT CASE WHEN ee.type = 'reply' THEN ls.id END) as replied,
      COUNT(DISTINCT CASE WHEN ee.type IN ('bounce_hard', 'bounce_soft') THEN ls.id END) as bounced
    FROM sequence_steps ss
    LEFT JOIN lead_steps ls ON ls.sequence_step_id = ss.id
    LEFT JOIN email_events ee ON ee.lead_step_id = ls.id
    WHERE ss.campaign_id = ?
    GROUP BY ss.id, ss.step_number
    ORDER BY ss.step_number ASC
  `).all(campaignId);

  // Per-variant A/B comparison
  const variants = db.prepare(`
    SELECT sv.id, sv.variant_letter, sv.subject,
      COUNT(DISTINCT CASE WHEN ee.type = 'sent' THEN ls.id END) as sent,
      COUNT(DISTINCT CASE WHEN ee.type = 'open' THEN ls.id END) as opened,
      COUNT(DISTINCT CASE WHEN ee.type = 'reply' THEN ls.id END) as replied
    FROM step_variants sv
    JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
    LEFT JOIN lead_steps ls ON ls.variant_id = sv.id
    LEFT JOIN email_events ee ON ee.lead_step_id = ls.id
    WHERE ss.campaign_id = ?
    GROUP BY sv.id, sv.variant_letter, sv.subject
    ORDER BY sv.variant_letter ASC
  `).all(campaignId);

  for (const v of variants) {
    v.open_rate = calculateRate(v.opened, v.sent);
    v.reply_rate = calculateRate(v.replied, v.sent);
  }

  // Per-mailbox performance
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
    mb.bounce_rate = calculateRate(mb.bounced, mb.sent);
    mb.open_rate = calculateRate(mb.opened, mb.sent);
  }

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status
    },
    funnel: {
      leads: leadsCount,
      sent,
      delivered,
      opened: uniqueOpens,
      uniqueOpens,
      clicked,
      replied,
      bounced,
      unsubscribed
    },
    totals: {
      leads: leadsCount,
      sent,
      delivered,
      opened: uniqueOpens,
      uniqueOpens,
      clicked,
      replied,
      bounced,
      unsubscribed
    },
    rates: {
      openRate: calculateRate(uniqueOpens, delivered),
      clickRate: calculateRate(clicked, delivered),
      replyRate: calculateRate(replied, delivered),
      bounceRate: calculateRate(bounced, sent),
      unsubscribeRate: calculateRate(unsubscribed, delivered)
    },
    steps,
    variants,
    mailboxPerformance
  };
}

/**
 * Filter campaign leads by segment status
 * Filters: 'all', 'opened', 'not_opened', 'replied', 'bounced', 'unsubscribed', 'opened_no_reply'
 */
export function getCampaignLeads(campaignId, filter = 'all') {
  const db = getDb();

  let query = `
    SELECT DISTINCT
      l.id as lead_id, l.email, l.first_name, l.last_name, l.company, l.status as lead_status,
      (SELECT COUNT(*) FROM email_events ee JOIN lead_steps ls ON ls.id = ee.lead_step_id WHERE ls.lead_id = l.id AND ls.campaign_id = ? AND ee.type = 'sent') as sent_count,
      (SELECT COUNT(*) FROM email_events ee JOIN lead_steps ls ON ls.id = ee.lead_step_id WHERE ls.lead_id = l.id AND ls.campaign_id = ? AND ee.type = 'open') as open_count,
      (SELECT COUNT(*) FROM email_events ee JOIN lead_steps ls ON ls.id = ee.lead_step_id WHERE ls.lead_id = l.id AND ls.campaign_id = ? AND ee.type = 'click') as click_count,
      (SELECT COUNT(*) FROM email_events ee JOIN lead_steps ls ON ls.id = ee.lead_step_id WHERE ls.lead_id = l.id AND ls.campaign_id = ? AND ee.type = 'reply') as reply_count,
      (SELECT COUNT(*) FROM email_events ee JOIN lead_steps ls ON ls.id = ee.lead_step_id WHERE ls.lead_id = l.id AND ls.campaign_id = ? AND ee.type IN ('bounce_hard', 'bounce_soft')) as bounce_count,
      (SELECT COUNT(*) FROM email_events ee JOIN lead_steps ls ON ls.id = ee.lead_step_id WHERE ls.lead_id = l.id AND ls.campaign_id = ? AND ee.type = 'unsubscribe') as unsub_count
    FROM leads l
    JOIN lead_steps ls ON ls.lead_id = l.id
    WHERE ls.campaign_id = ?
  `;

  const rows = db.prepare(query).all(campaignId, campaignId, campaignId, campaignId, campaignId, campaignId, campaignId);

  // Apply segment filter in JS or SQL
  return rows.filter(r => {
    switch (filter) {
      case 'opened':
        return r.open_count > 0;
      case 'not_opened':
        return r.sent_count > 0 && r.open_count === 0;
      case 'opened_no_reply':
        return r.open_count > 0 && r.reply_count === 0;
      case 'replied':
        return r.reply_count > 0;
      case 'bounced':
        return r.bounce_count > 0 || r.lead_status === 'bounced';
      case 'unsubscribed':
        return r.unsub_count > 0 || r.lead_status === 'unsubscribed';
      case 'no_activity':
        return r.sent_count > 0 && r.open_count === 0 && r.click_count === 0 && r.reply_count === 0;
      case 'all':
      default:
        return true;
    }
  });
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

  query += ' ORDER BY ee.timestamp ASC';

  return db.prepare(query).all(...params);
}
