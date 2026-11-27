import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { calculateRate, getOverviewStats, getCampaignStats, getCampaignLeads, getLeadTimeline } from '../src/stats/queries.js';

describe('Stats Queries & Aggregations (Step 7)', () => {
  let db;

  before(() => {
    db = initDb(':memory:');

    // Seed test data
    db.prepare("INSERT INTO lists (id, name) VALUES (1, 'Q1 Leads')").run();
    db.prepare("INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted) VALUES (1, 'sales@company.com', 'Sales', 'smtp.company.com', 'sales', 'enc', 'imap.company.com', 'sales', 'enc')").run();
    db.prepare("INSERT INTO campaigns (id, name, status, list_id) VALUES (1, 'Outreach 2026', 'running', 1)").run();
    db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (1, 1)").run();

    // Steps & Variants
    db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 1, 1)").run();
    db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html, body_text) VALUES (1, 1, 'A', 'Subject A', '<p>A</p>', 'A')").run();
    db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html, body_text) VALUES (2, 1, 'B', 'Subject B', '<p>B</p>', 'B')").run();

    // 4 Leads:
    // Lead 1: Sent, Opened (Human), Clicked, Replied
    // Lead 2: Sent, Opened (Bot)
    // Lead 3: Sent, Bounced (Hard)
    // Lead 4: Sent, Unsubscribed
    for (let i = 1; i <= 4; i++) {
      db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (?, 1, ?, 'active')").run(i, `lead${i}@domain.com`);
      db.prepare(`
        INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at, sent_at)
        VALUES (?, 1, ?, 1, ?, 1, 'sent', datetime('now'), datetime('now'))
      `).run(i, i, (i % 2 === 1 ? 1 : 2));

      // Event: Sent
      db.prepare("INSERT INTO email_events (lead_step_id, type, timestamp) VALUES (?, 'sent', datetime('now', '-1 hour'))").run(i);
    }

    // Lead 1: Open (Human), Click, Reply
    db.prepare("INSERT INTO email_events (lead_step_id, type, meta_json, timestamp) VALUES (1, 'open', '{\"is_probable_bot\":0}', datetime('now', '-50 minutes'))").run();
    db.prepare("INSERT INTO email_events (lead_step_id, type, meta_json, timestamp) VALUES (1, 'click', '{\"url\":\"https://example.com\"}', datetime('now', '-40 minutes'))").run();
    db.prepare("INSERT INTO email_events (lead_step_id, type, timestamp) VALUES (1, 'reply', datetime('now', '-30 minutes'))").run();

    // Lead 2: Open (Bot)
    db.prepare("INSERT INTO email_events (lead_step_id, type, meta_json, timestamp) VALUES (2, 'open', '{\"is_probable_bot\":1}', datetime('now', '-50 minutes'))").run();

    // Lead 3: Bounce Hard
    db.prepare("INSERT INTO email_events (lead_step_id, type, timestamp) VALUES (3, 'bounce_hard', datetime('now', '-55 minutes'))").run();

    // Lead 4: Unsubscribe
    db.prepare("INSERT INTO email_events (lead_step_id, type, timestamp) VALUES (4, 'unsubscribe', datetime('now', '-45 minutes'))").run();
  });

  after(() => {
    closeDb();
  });

  describe('1. Rate Calculation Helper', () => {
    it('calculates rounded percentages correctly and handles zero division', () => {
      assert.equal(calculateRate(0, 0), 0);
      assert.equal(calculateRate(5, 0), 0);
      assert.equal(calculateRate(1, 3), 33.3);
      assert.equal(calculateRate(2, 3), 66.7);
      assert.equal(calculateRate(1, 2), 50);
      assert.equal(calculateRate(10, 10), 100);
    });
  });

  describe('2. Overview Statistics & Bot Separation', () => {
    it('aggregates sent, delivered, opens, bot opens, clicks, replies, and bounces accurately', () => {
      const stats = getOverviewStats();

      // Sent = 4
      assert.equal(stats.totals.sent, 4);
      // Bounced = 1 (Lead 3)
      assert.equal(stats.totals.bounced, 1);
      // Delivered = 4 - 1 = 3
      assert.equal(stats.totals.delivered, 3);
      // Unique opens = 2 (Lead 1 + Lead 2)
      assert.equal(stats.totals.uniqueOpens, 2);
      // Likely real opens = 1 (Lead 1 only; Lead 2 was bot)
      assert.equal(stats.totals.likelyRealOpens, 1);
      // Clicked = 1 (Lead 1)
      assert.equal(stats.totals.clicked, 1);
      // Replied = 1 (Lead 1)
      assert.equal(stats.totals.replied, 1);
      // Unsubscribed = 1 (Lead 4)
      assert.equal(stats.totals.unsubscribed, 1);

      // Under Batch 3 definitions: denominator is contacted (4 leads)
      // Open rate (verified human): 1 / 4 = 25.0%
      assert.equal(stats.rates.openRate, 25.0);
      // Open rate (any, incl. machine): 2 / 4 = 50.0%
      assert.equal(stats.rates.openRateAny, 50.0);
      // Likely real open rate alias: 1 / 4 = 25.0%
      assert.equal(stats.rates.likelyRealOpenRate, 25.0);
      // Bounce rate: 1 / 4 = 25.0%
      assert.equal(stats.rates.bounceRate, 25.0);
      // Click rate: 1 / 4 = 25.0%
      assert.equal(stats.rates.clickRate, 25.0);
      // Reply rate: 1 / 4 = 25.0%
      assert.equal(stats.rates.replyRate, 25.0);
      // Unsubscribe rate: 1 / 4 = 25.0%
      assert.equal(stats.rates.unsubscribeRate, 25.0);
      assert.equal(stats.rates.denominator, 'per_lead');

      assert.ok(stats.disclaimer);
    });
  });

  describe('3. Campaign Detail & Segment Filters', () => {
    it('returns campaign funnel and per-variant A/B comparison', () => {
      const campStats = getCampaignStats(1);
      assert.equal(campStats.funnel.leads, 4);
      assert.equal(campStats.funnel.sent, 4);
      assert.equal(campStats.funnel.delivered, 3);
      assert.equal(campStats.variants.length, 2);
      assert.equal(campStats.mailboxPerformance.length, 1);
    });

    it('filters lead segments: opened_no_reply, never_opened, replied, bounced', () => {
      // Lead 2 opened but never replied
      const openedNoReply = getCampaignLeads(1, 'opened_no_reply');
      assert.equal(openedNoReply.length, 1);
      assert.equal(openedNoReply[0].email, 'lead2@domain.com');

      // Lead 3 & 4 never opened
      const neverOpened = getCampaignLeads(1, 'not_opened');
      assert.equal(neverOpened.length, 2);
      const neverOpenedEmails = neverOpened.map(l => l.email);
      assert.ok(neverOpenedEmails.includes('lead3@domain.com'));
      assert.ok(neverOpenedEmails.includes('lead4@domain.com'));

      // Lead 1 replied
      const replied = getCampaignLeads(1, 'replied');
      assert.equal(replied.length, 1);
      assert.equal(replied[0].email, 'lead1@domain.com');

      // Lead 3 bounced
      const bounced = getCampaignLeads(1, 'bounced');
      assert.equal(bounced.length, 1);
      assert.equal(bounced[0].email, 'lead3@domain.com');
    });

    it('returns chronological lead timeline', () => {
      const timeline = getLeadTimeline(1, 1);
      assert.equal(timeline.length, 4); // sent, open, click, reply
      assert.equal(timeline[0].type, 'sent');
      assert.equal(timeline[1].type, 'open');
      assert.equal(timeline[2].type, 'click');
      assert.equal(timeline[3].type, 'reply');
    });
  });
});
