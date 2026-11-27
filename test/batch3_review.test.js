import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db.js';
import { config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { createAdminServer } from '../src/admin.js';
import { getOverviewStats, getCampaignStats, calculateRate } from '../src/stats/queries.js';
import { isProbableBot, isGmailProxy, detectBot } from '../src/campaigns/tracking.js';
import { isProbableBot as publicIsProbableBot } from '../src/public.js';

describe('BATCH 3 Regression Suite (Metrics You Can Trust & Unified Bot Detection)', () => {
  let db;
  let adminServer;
  const testApiKey = config.admin.apiKey;
  const authHeaders = {
    'x-api-key': testApiKey,
    host: 'localhost:3000'
  };

  before(async () => {
    db = initDb(':memory:');
    adminServer = createAdminServer();
    await adminServer.ready();
  });

  after(async () => {
    await adminServer.close();
    closeDb();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM suppression').run();
    db.prepare('DELETE FROM email_events').run();
    db.prepare('DELETE FROM tracking_links').run();
    db.prepare('DELETE FROM lead_steps').run();
    db.prepare('DELETE FROM leads').run();
    db.prepare('DELETE FROM lists').run();
    db.prepare('DELETE FROM step_variants').run();
    db.prepare('DELETE FROM sequence_steps').run();
    db.prepare('DELETE FROM campaign_mailboxes').run();
    db.prepare('DELETE FROM campaigns').run();
    db.prepare('DELETE FROM mailbox_dns_checks').run();
    db.prepare('DELETE FROM mailboxes').run();
    db.prepare('DELETE FROM verification_results').run();
    db.prepare('DELETE FROM settings').run();

    db.prepare("INSERT INTO settings (key, value) VALUES ('postal_address', '123 Test St, Test City')").run();
  });

  // Helper to insert a valid mailbox
  function insertTestMailbox(id, email = `mb${id}@test.com`) {
    db.prepare(`
      INSERT INTO mailboxes (
        id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted,
        imap_host, imap_user, imap_pass_encrypted, status
      ) VALUES (?, ?, 'Sender', 'smtp.test.com', 'user', ?, 'imap.test.com', 'user', ?, 'ready')
    `).run(id, email, encrypt('pass'), encrypt('pass'));
  }

  // =========================================================================
  // 3.1 Unified Bot Detection (tracking.js & public.js)
  // =========================================================================
  describe('3.1 Unified Bot Detection in tracking.js and imported in public.js', () => {
    it('detectBot correctly classifies GoogleImageProxy as machine/proxy', () => {
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GoogleImageProxy';
      const result = detectBot(ua, null);
      assert.equal(result.isBot, true);
      assert.equal(result.isGmailProxy, true);
      assert.ok(result.reason.includes('GoogleImageProxy'));
    });

    it('detectBot flags Apple Mail Privacy Protection (AMPP) and crawlers', () => {
      const amppUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
      const result = detectBot(amppUa, null);
      assert.equal(result.isBot, true);
      assert.equal(result.isGmailProxy, false);

      const crawlerUa = 'Mozilla/5.0 (compatible; bingpreview/1.0; +http://www.bing.com/bingpreview.htm)';
      const crawlerRes = detectBot(crawlerUa, null);
      assert.equal(crawlerRes.isBot, true);
    });

    it('detectBot flags requests occurring within 5 seconds of send time', () => {
      const now = new Date();
      const sent2sAgo = new Date(now.getTime() - 2000);
      const normalUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

      const fastRes = detectBot(normalUa, sent2sAgo.toISOString(), now);
      assert.equal(fastRes.isBot, true);
      assert.ok(fastRes.reason.includes('5 seconds'));

      // 60 seconds later -> human
      const sent60sAgo = new Date(now.getTime() - 60000);
      const humanRes = detectBot(normalUa, sent60sAgo.toISOString(), now);
      assert.equal(humanRes.isBot, false);
      assert.equal(humanRes.isGmailProxy, false);
      assert.equal(humanRes.reason, null);
    });

    it('public.js re-exports the unified isProbableBot and shares single implementation', () => {
      assert.equal(typeof publicIsProbableBot, 'function');
      assert.equal(publicIsProbableBot, isProbableBot); // Exact reference match
      assert.equal(publicIsProbableBot('GoogleImageProxy'), true);
      assert.equal(isGmailProxy('GoogleImageProxy'), true);
      assert.equal(isGmailProxy('Mozilla/5.0 Chrome/120'), false);
    });
  });

  // =========================================================================
  // 3.2 Fixture with 10 Leads x 3 Steps: Exact Metrics & Rates
  // =========================================================================
  describe('3.2 Comprehensive 10 Leads x 3 Steps Metrics Fixture', () => {
    beforeEach(() => {
      // 1. Setup Campaign, List, Mailbox, and 3 Sequence Steps
      db.prepare("INSERT INTO lists (id, name) VALUES (100, 'Batch 3 Lead List')").run();
      insertTestMailbox(100, 'outreach@test.com');
      db.prepare("INSERT INTO campaigns (id, name, list_id, status) VALUES (100, 'B3 Metrics Camp', 100, 'running')").run();
      db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (100, 100)").run();

      for (let s = 1; s <= 3; s++) {
        db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number, delay_days) VALUES (?, 100, ?, 1)").run(100 + s, s);
        db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (?, ?, 'A', ?, '<p>Body</p>')").run(1000 + s, 100 + s, `Step ${s} Subj`);
      }

      // 2. Insert 10 Leads
      for (let l = 1; l <= 10; l++) {
        db.prepare("INSERT INTO leads (id, list_id, email, first_name, status) VALUES (?, 100, ?, ?, 'active')").run(
          l,
          `lead${l}@testdomain.com`,
          `Lead${l}`
        );
      }

      // 3. Populate lead steps and email events per specification:
      // Lead 1: Sent step 1, Sent step 2. Opened step 1 (human). Replied on step 1 AND step 2!
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1001, 100, 1, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (1, 1001, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (2, 1001, 'open', '{\"is_probable_bot\":0}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (3, 1001, 'reply', '{\"is_auto_reply\":0}')").run();

      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1002, 100, 1, 102, 1002, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (4, 1002, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (5, 1002, 'reply', '{\"is_auto_reply\":0}')").run();

      // Lead 2: Sent step 1. Opened step 1 (human), Clicked step 1 (human non-bot)
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1003, 100, 2, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (6, 1003, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (7, 1003, 'open', '{\"is_probable_bot\":0}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (8, 1003, 'click', '{\"is_probable_bot\":0}')").run();

      // Lead 3: Sent step 1. Opened via GoogleImageProxy (Gmail proxy open)
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1004, 100, 3, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (9, 1004, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (10, 1004, 'open', '{\"is_probable_bot\":1,\"is_gmail_proxy\":1,\"user_agent\":\"GoogleImageProxy\"}')").run();

      // Lead 4: Sent step 1, Sent step 2. Opened step 2 (human). Clicked step 2 (bot click -> excluded from non-bot clicks)
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1005, 100, 4, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (11, 1005, 'sent', '{}')").run();

      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1006, 100, 4, 102, 1002, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (12, 1006, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (13, 1006, 'open', '{\"is_probable_bot\":0}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (14, 1006, 'click', '{\"is_probable_bot\":1,\"bot_reason\":\"Fast hit <= 5s\"}')").run();

      // Lead 5: Sent step 1. Bounced hard on step 1
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1007, 100, 5, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (15, 1007, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (16, 1007, 'bounce_hard', '{}')").run();

      // Lead 6: Sent step 1, Sent step 2. Bounced soft on step 2
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1008, 100, 6, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (17, 1008, 'sent', '{}')").run();

      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1009, 100, 6, 102, 1002, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (18, 1009, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (19, 1009, 'bounce_soft', '{}')").run();

      // Lead 7: Sent step 1. Auto-reply (is_auto_reply = 1 -> excluded from real replies)
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1010, 100, 7, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (20, 1010, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (21, 1010, 'reply', '{\"is_auto_reply\":1}')").run();

      // Lead 8: Sent step 1. Unsubscribed
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1011, 100, 8, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (22, 1011, 'sent', '{}')").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (23, 1011, 'unsubscribe', '{}')").run();

      // Lead 9: Sent step 1, Sent step 2, Sent step 3 (no engagement)
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1012, 100, 9, 101, 1001, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (24, 1012, 'sent', '{}')").run();

      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1013, 100, 9, 102, 1002, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (25, 1013, 'sent', '{}')").run();

      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, sent_at) VALUES (1014, 100, 9, 103, 1003, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (id, lead_step_id, type, meta_json) VALUES (26, 1014, 'sent', '{}')").run();

      // Lead 10: In list but NEVER sent any email (pending step)
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (1015, 100, 10, 101, 1001, 'pending', CURRENT_TIMESTAMP)").run();
    });

    it('verifies exact counts: contacted, emailsSent, delivered, and distinct lead metrics', () => {
      const stats = getCampaignStats(100);

      // Total leads assigned = 10
      assert.equal(stats.funnel.leads, 10);

      // contacted = 9 (Leads 1 through 9 received at least one sent email)
      assert.equal(stats.funnel.contacted, 9);

      // emailsSent = 14 total sent events
      assert.equal(stats.funnel.emailsSent, 14);
      assert.equal(stats.funnel.sent, 14);

      // delivered = 14 - 2 bounced steps = 12
      assert.equal(stats.funnel.delivered, 12);

      // Human opens: Leads 1, 2, 4 = 3 distinct leads
      assert.equal(stats.funnel.openedHuman, 3);
      assert.equal(stats.funnel.opened, 3);

      // Gmail proxy opens: Lead 3 = 1 distinct lead
      assert.equal(stats.funnel.gmailProxyOpens, 1);

      // Any opens (incl. machine/proxy): Leads 1, 2, 3, 4 = 4 distinct leads
      assert.equal(stats.funnel.openedAny, 4);

      // Clicks: non-bot click = Lead 2 only (Lead 4 was bot click -> excluded) = 1 distinct lead
      assert.equal(stats.funnel.clicked, 1);
      assert.equal(stats.funnel.clickedAny, 2);

      // Replies: Lead 1 replied on step 1 AND step 2 -> counted ONCE = 1 lead (Lead 7 auto-reply excluded)
      assert.equal(stats.funnel.replied, 1);

      // Bounces: Leads 5 and 6 = 2 distinct leads
      assert.equal(stats.funnel.bounced, 2);

      // Unsubscribes: Lead 8 = 1 distinct lead
      assert.equal(stats.funnel.unsubscribed, 1);
    });

    it('verifies every rate to one decimal place with contacted (9) as denominator', () => {
      const stats = getCampaignStats(100);
      const rates = stats.rates;

      // Open rate (verified human): 3 / 9 = 33.3%
      assert.equal(rates.openRate, 33.3);

      // Open rate (any, incl. machine): 4 / 9 = 44.4%
      assert.equal(rates.openRateAny, 44.4);

      // Click rate (non-bot): 1 / 9 = 11.1%
      assert.equal(rates.clickRate, 11.1);

      // Reply rate (real non-auto): 1 / 9 = 11.1%
      assert.equal(rates.replyRate, 11.1);

      // Bounce rate: 2 / 9 = 22.2%
      assert.equal(rates.bounceRate, 22.2);

      // Unsubscribe rate: 1 / 9 = 11.1%
      assert.equal(rates.unsubscribeRate, 11.1);

      // Denominator label check
      assert.equal(rates.denominator, 'per_lead');
      assert.equal(stats.funnel.denominator, 'per_lead');
    });

    it('verifies per-step and per-variant statistics label denominators as per_email', () => {
      const stats = getCampaignStats(100);

      assert.equal(stats.steps.length, 3);
      for (const step of stats.steps) {
        assert.equal(step.denominator, 'per_email');
        assert.equal(typeof step.sent, 'number');
        assert.equal(typeof step.delivered, 'number');
        assert.equal(typeof step.open_rate, 'number');
      }

      assert.equal(stats.variants.length, 3);
      for (const v of stats.variants) {
        assert.equal(v.denominator, 'per_email');
        assert.equal(typeof v.sent, 'number');
        assert.equal(typeof v.open_rate, 'number');
        assert.equal(typeof v.reply_rate, 'number');
      }
    });

    it('GET /api/campaigns/:id/stats API route returns standardized metrics and labels', async () => {
      const res = await adminServer.inject({
        method: 'GET',
        url: '/api/campaigns/100/stats',
        headers: authHeaders
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.payload);

      assert.equal(data.funnel.contacted, 9);
      assert.equal(data.funnel.emailsSent, 14);
      assert.equal(data.funnel.delivered, 12);
      assert.equal(data.funnel.openedHuman, 3);
      assert.equal(data.funnel.openedAny, 4);
      assert.equal(data.funnel.gmailProxyOpens, 1);
      assert.equal(data.funnel.replied, 1);
      assert.equal(data.rates.openRate, 33.3);
      assert.equal(data.rates.openRateAny, 44.4);
      assert.equal(data.rates.replyRate, 11.1);
      assert.equal(data.rates.denominator, 'per_lead');
      assert.ok(data.disclaimer.includes('Open rates are statistical estimates'));
    });

    it('GET /api/stats/overview API route matches global metrics with contacted denominator', async () => {
      const res = await adminServer.inject({
        method: 'GET',
        url: '/api/stats/overview?days=30',
        headers: authHeaders
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.payload);

      assert.equal(data.totals.contacted, 9);
      assert.equal(data.totals.emailsSent, 14);
      assert.equal(data.totals.delivered, 12);
      assert.equal(data.totals.openedHuman, 3);
      assert.equal(data.totals.openedAny, 4);
      assert.equal(data.totals.gmailProxyOpens, 1);
      assert.equal(data.totals.replied, 1);
      assert.equal(data.rates.openRate, 33.3);
      assert.equal(data.rates.openRateAny, 44.4);
      assert.equal(data.rates.clickRate, 11.1);
      assert.equal(data.rates.replyRate, 11.1);
      assert.equal(data.rates.bounceRate, 22.2);
      assert.equal(data.rates.denominator, 'per_lead');
      assert.ok(data.disclaimer);
    });
  });
});
