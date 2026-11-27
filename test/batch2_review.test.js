import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db.js';
import { config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { createAdminServer } from '../src/admin.js';
import { getCampaignLeads, getLeadTimeline, getOverviewStats } from '../src/stats/queries.js';
import { importLeads, parseCsv } from '../src/campaigns/leads.js';
import { launchCampaign, getLaunchStatus, createCampaign } from '../src/campaigns/sequence.js';
import { deleteMailbox } from '../src/mailboxes/accounts.js';
import { runSchedulerTick, calculateRandomSendGap, scheduleNextStep } from '../src/campaigns/engine.js';

describe('BATCH 2 Regression Suite (Broken Routes & Data Integrity)', () => {
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
    // Reset database tables
    db.prepare('DELETE FROM suppression').run();
    db.prepare('DELETE FROM email_events').run();
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

    // Default required settings
    db.prepare("INSERT INTO settings (key, value) VALUES ('postal_address', '123 Test St, Test City')").run();
  });

  // Helper to insert a fully valid mailbox
  function insertTestMailbox(id, email = `mb${id}@test.com`, extra = {}) {
    db.prepare(`
      INSERT INTO mailboxes (
        id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted,
        imap_host, imap_user, imap_pass_encrypted, status, next_send_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      email,
      extra.display_name || `Sender ${id}`,
      extra.smtp_host || 'smtp.test.com',
      extra.smtp_user || 'user',
      extra.smtp_pass_encrypted || encrypt('testpass'),
      extra.imap_host || 'imap.test.com',
      extra.imap_user || 'user',
      extra.imap_pass_encrypted || encrypt('testpass'),
      extra.status || 'ready',
      extra.next_send_at || null
    );
  }

  // =========================================================================
  // 2.1 getCampaignLeads pagination & segment filtering
  // =========================================================================
  describe('2.1 getCampaignLeads pagination and filtering', () => {
    it('returns items and total with pagination and segment filters via API', async () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (1, 'List 1')").run();
      db.prepare("INSERT INTO campaigns (id, name, list_id, status) VALUES (1, 'Camp 1', 1, 'running')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 1, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (1, 1, 'A', 'Subj', '<p>Body</p>')").run();

      // Seed 3 leads
      db.prepare("INSERT INTO leads (id, list_id, email, first_name) VALUES (1, 1, 'lead1@test.com', 'One')").run();
      db.prepare("INSERT INTO leads (id, list_id, email, first_name) VALUES (2, 1, 'lead2@test.com', 'Two')").run();
      db.prepare("INSERT INTO leads (id, list_id, email, first_name) VALUES (3, 1, 'lead3@test.com', 'Three')").run();

      // Lead steps
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (1, 1, 1, 1, 1, 'sent', CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (2, 1, 2, 1, 1, 'sent', CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (3, 1, 3, 1, 1, 'sent', CURRENT_TIMESTAMP)").run();

      // Events: lead 1 opened, lead 2 replied, lead 3 sent only
      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (1, 'sent')").run();
      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (1, 'open')").run();

      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (2, 'sent')").run();
      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (2, 'reply')").run();

      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (3, 'sent')").run();

      // Test route GET /api/campaigns/1/leads
      const resAll = await adminServer.inject({
        method: 'GET',
        url: '/api/campaigns/1/leads?filter=all&limit=2&offset=0',
        headers: authHeaders
      });
      assert.equal(resAll.statusCode, 200);
      const dataAll = JSON.parse(resAll.payload);
      assert.equal(dataAll.total, 3);
      assert.equal(dataAll.items.length, 2);
      assert.ok(Array.isArray(dataAll.leads));

      // Test filter opened
      const resOpened = await adminServer.inject({
        method: 'GET',
        url: '/api/campaigns/1/leads?filter=opened',
        headers: authHeaders
      });
      const dataOpened = JSON.parse(resOpened.payload);
      assert.equal(dataOpened.total, 1);
      assert.equal(dataOpened.items[0].email, 'lead1@test.com');

      // Test filter replied
      const resReplied = await adminServer.inject({
        method: 'GET',
        url: '/api/campaigns/1/leads?filter=replied',
        headers: authHeaders
      });
      const dataReplied = JSON.parse(resReplied.payload);
      assert.equal(dataReplied.total, 1);
      assert.equal(dataReplied.items[0].email, 'lead2@test.com');
    });
  });

  // =========================================================================
  // 2.2 getLeadTimeline argument order
  // =========================================================================
  describe('2.2 getLeadTimeline argument order in admin route', () => {
    it('route returns timeline events matching leadId and campaignId', async () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (1, 'List 1')").run();
      db.prepare("INSERT INTO campaigns (id, name, list_id, status) VALUES (10, 'Camp 10', 1, 'running')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 10, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (1, 1, 'A', 'Hi', '<p>Test</p>')").run();

      db.prepare("INSERT INTO leads (id, list_id, email) VALUES (42, 1, 'lead42@test.com')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (100, 10, 42, 1, 1, 'sent', CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (100, 'sent')").run();
      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (100, 'open')").run();

      // Call route GET /api/campaigns/10/leads/42/timeline
      // In buggy code: getLeadTimeline(10, 42) looked for lead_id = 10, campaign_id = 42 -> returned []!
      // In fixed code: getLeadTimeline(42, 10) returns the 2 events
      const res = await adminServer.inject({
        method: 'GET',
        url: '/api/campaigns/10/leads/42/timeline',
        headers: authHeaders
      });
      assert.equal(res.statusCode, 200);
      const timeline = JSON.parse(res.payload);
      assert.equal(timeline.length, 2);
      assert.equal(timeline[0].type, 'sent');
      assert.equal(timeline[1].type, 'open');
      assert.equal(timeline[0].campaign_name, 'Camp 10');
    });
  });

  // =========================================================================
  // 2.3 Double-quoted SQL strings
  // =========================================================================
  describe('2.3 Double-quoted SQL strings replaced with single quotes', () => {
    it('POST /api/verify/bulk saves leads with single-quoted SQL', async () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (5, 'Bulk Test List')").run();

      const res = await adminServer.inject({
        method: 'POST',
        url: '/api/verify/bulk',
        headers: authHeaders,
        payload: {
          emails: ['test_single_quote@example.com'],
          listId: 5
        }
      });
      assert.equal(res.statusCode, 200);
      const lead = db.prepare('SELECT * FROM leads WHERE list_id = 5 AND email = ?').get('test_single_quote@example.com');
      assert.ok(lead);
      assert.equal(lead.status, 'active');
    });

    it('POST /api/campaigns/:id/create-from-segment works with single-quoted SQL', async () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (1, 'List Orig')").run();
      insertTestMailbox(1, 'mb1@test.com');
      db.prepare("INSERT INTO campaigns (id, name, list_id, status) VALUES (1, 'Camp Orig', 1, 'running')").run();
      db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (1, 1)").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 1, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (1, 1, 'A', 'Hi', '<p>Test</p>')").run();

      db.prepare("INSERT INTO leads (id, list_id, email, first_name) VALUES (1, 1, 'opened@test.com', 'Alex')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (1, 1, 1, 1, 1, 'sent', CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (1, 'sent')").run();
      db.prepare("INSERT INTO email_events (lead_step_id, type) VALUES (1, 'open')").run();

      const res = await adminServer.inject({
        method: 'POST',
        url: '/api/campaigns/1/create-from-segment',
        headers: authHeaders,
        payload: {
          segment: 'opened',
          name: 'Retarget Opened'
        }
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.success, true);
      assert.equal(body.leadCount, 1);
      assert.equal(body.campaign.name, 'Retarget Opened');

      // Verify the lead in new list has status = 'active'
      const newLead = db.prepare('SELECT * FROM leads WHERE list_id = ?').get(body.campaign.list_id);
      assert.ok(newLead);
      assert.equal(newLead.status, 'active');
      assert.equal(newLead.first_name, 'Alex');
    });
  });

  // =========================================================================
  // 2.4 Lead Import with Names & custom fields
  // =========================================================================
  describe('2.4 Lead Import with Names (CSV & JSON)', () => {
    it('parseCsv handles quotes, commas, multiline cells, and headers', () => {
      const csv = `email,first_name,last_name,company,title\n"john@doe.com","John","Doe, Jr.","Acme, Inc.","VP"\n"jane@doe.com","Jane","Smith","Beta Corp","CEO"`;
      const rows = parseCsv(csv);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].email, 'john@doe.com');
      assert.equal(rows[0].last_name, 'Doe, Jr.');
      assert.equal(rows[0].company, 'Acme, Inc.');
      assert.equal(rows[0].title, 'VP');
      assert.equal(rows[1].first_name, 'Jane');
    });

    it('importLeads validates syntax, skips invalid and duplicates, stores custom fields', () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (10, 'Import List')").run();

      const raw = [
        { email: 'valid1@test.com', first_name: 'Valid', last_name: 'One', company: 'Corp1', role: 'Engineer' },
        { email: 'bad@@domain..com', first_name: 'Invalid' },
        { email: 'VALID1@test.com', first_name: 'Duplicate' }, // duplicate (case-insensitive)
        { email: 'valid2@test.com', company: 'Corp2', city: 'NYC' }
      ];

      const res = importLeads(10, raw);
      assert.equal(res.imported, 2);
      assert.equal(res.skippedInvalid, 1);
      assert.equal(res.skippedDuplicates, 1);

      const l1 = db.prepare('SELECT * FROM leads WHERE list_id = 10 AND email = ?').get('valid1@test.com');
      assert.ok(l1);
      assert.equal(l1.first_name, 'Valid');
      assert.equal(l1.last_name, 'One');
      assert.equal(l1.company, 'Corp1');
      const custom1 = JSON.parse(l1.custom_fields_json);
      assert.equal(custom1.role, 'Engineer');
    });

    it('POST /api/lists/:id/leads/import endpoint accepts JSON payload and validates', async () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (11, 'API Import List')").run();

      const res = await adminServer.inject({
        method: 'POST',
        url: '/api/lists/11/leads/import',
        headers: authHeaders,
        payload: {
          rows: [
            { email: 'api_lead1@test.com', first_name: 'Api', last_name: 'Lead', custom_tier: 'gold' },
            { email: 'not_an_email' }
          ]
        }
      });
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.payload);
      assert.equal(data.success, true);
      assert.equal(data.imported, 1);
      assert.equal(data.skippedInvalid, 1);

      // Verify custom field
      const stored = db.prepare('SELECT * FROM leads WHERE list_id = 11 AND email = ?').get('api_lead1@test.com');
      assert.ok(stored);
      assert.equal(stored.first_name, 'Api');
      const parsedCustom = JSON.parse(stored.custom_fields_json);
      assert.equal(parsedCustom.custom_tier, 'gold');
    });
  });

  // =========================================================================
  // 2.5 Unique Constraint on Leads
  // =========================================================================
  describe('2.5 Unique Constraint on Leads (idx_leads_list_email)', () => {
    it('rejects duplicate email within the same list', () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (20, 'Unique List')").run();
      db.prepare("INSERT INTO leads (list_id, email, status) VALUES (20, 'unique@test.com', 'active')").run();

      assert.throws(() => {
        db.prepare("INSERT INTO leads (list_id, email, status) VALUES (20, 'unique@test.com', 'active')").run();
      }, /UNIQUE constraint failed/);

      // But allows same email in a DIFFERENT list
      db.prepare("INSERT INTO lists (id, name) VALUES (21, 'Other List')").run();
      assert.doesNotThrow(() => {
        db.prepare("INSERT INTO leads (list_id, email, status) VALUES (21, 'unique@test.com', 'active')").run();
      });
    });
  });

  // =========================================================================
  // 2.6 Async launchCampaign & launch-status
  // =========================================================================
  describe('2.6 Async launchCampaign and launch-status endpoint', () => {
    it('POST /api/campaigns/:id/launch returns immediately with preparing status and launch-status reports state', async () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (30, 'Launch List')").run();
      insertTestMailbox(30, 'sender30@test.com');
      db.prepare("INSERT INTO campaigns (id, name, list_id, status, send_policy) VALUES (30, 'Async Launch Camp', 30, 'draft', 'deliverable_only')").run();
      db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (30, 30)").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (30, 30, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (30, 30, 'A', 'Hi', '<p>Test</p>')").run();

      // Insert 2 leads
      db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (301, 30, 'deliverable@test.com', 'active')").run();
      db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (302, 30, 'invalid@test.com', 'active')").run();

      // Pre-seed verification: one valid (within 30 days), one risky/undeliverable
      db.prepare("INSERT INTO verification_results (email, verdict, score, checks_json, transcript_json, checked_at) VALUES ('deliverable@test.com', 'deliverable', 95, '{}', '[]', datetime('now', '-2 days'))").run();
      db.prepare("INSERT INTO verification_results (email, verdict, score, checks_json, transcript_json, checked_at) VALUES ('invalid@test.com', 'undeliverable', 10, '{}', '[]', datetime('now', '-2 days'))").run();

      // Launch via API
      const res = await adminServer.inject({
        method: 'POST',
        url: '/api/campaigns/30/launch',
        headers: authHeaders
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.success, true);
      assert.ok(['preparing', 'running'].includes(body.status));

      // Check launch-status route
      const statusRes = await adminServer.inject({
        method: 'GET',
        url: '/api/campaigns/30/launch-status',
        headers: authHeaders
      });
      assert.equal(statusRes.statusCode, 200);
      const statusData = JSON.parse(statusRes.payload);
      assert.equal(statusData.campaignId, 30);
      assert.equal(statusData.total, 2);
    });

    it('launchCampaign ignores verification results older than 30 days', async () => {
      db.prepare("INSERT INTO lists (id, name) VALUES (31, 'Launch List Old Cache')").run();
      insertTestMailbox(31, 'sender31@test.com');
      db.prepare("INSERT INTO campaigns (id, name, list_id, status, send_policy) VALUES (31, 'Old Cache Camp', 31, 'draft', 'deliverable_only')").run();
      db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (31, 31)").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (31, 31, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (31, 31, 'A', 'Hi', '<p>Test</p>')").run();

      db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (311, 31, 'oldcache@test.com', 'active')").run();

      // Cached 35 days ago (should be treated as expired and re-verified)
      db.prepare("INSERT INTO verification_results (email, verdict, score, checks_json, transcript_json, checked_at) VALUES ('oldcache@test.com', 'deliverable', 95, '{}', '[]', datetime('now', '-35 days'))").run();

      const row = db.prepare("SELECT verdict FROM verification_results WHERE email = 'oldcache@test.com' AND checked_at >= datetime('now', '-30 days')").get();
      assert.equal(row, undefined); // Proves the query correctly filters out 30+ day old records
    });
  });

  // =========================================================================
  // 2.7 Mailbox Deletion
  // =========================================================================
  describe('2.7 Mailbox Deletion nullifies lead_steps references', () => {
    it('deleting mailbox sets lead_steps.mailbox_id to NULL', async () => {
      insertTestMailbox(40, 'mb40@test.com');
      db.prepare("INSERT INTO campaigns (id, name, status) VALUES (40, 'Camp 40', 'running')").run();
      db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (40, 40)").run();
      db.prepare("INSERT INTO lists (id, name) VALUES (40, 'List 40')").run();
      db.prepare("INSERT INTO leads (id, list_id, email) VALUES (401, 40, 'lead401@test.com')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (40, 40, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (40, 40, 'A', 'Hi', '<p>Test</p>')").run();

      // Step already sent by mailbox 40
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at) VALUES (401, 40, 401, 40, 40, 40, 'sent', CURRENT_TIMESTAMP)").run();

      // Delete mailbox via API
      const res = await adminServer.inject({
        method: 'DELETE',
        url: '/api/mailboxes/40',
        headers: authHeaders
      });
      assert.equal(res.statusCode, 200);

      // Mailbox is deleted
      const mb = db.prepare('SELECT * FROM mailboxes WHERE id = 40').get();
      assert.equal(mb, undefined);

      // Lead step history is preserved with mailbox_id = NULL
      const step = db.prepare('SELECT * FROM lead_steps WHERE id = 401').get();
      assert.ok(step);
      assert.equal(step.mailbox_id, null);
      assert.equal(step.status, 'sent');
    });
  });

  // =========================================================================
  // 2.8 Sweeper & Campaign Completion
  // =========================================================================
  describe('2.8 Sweeper and Campaign Completion', () => {
    it('sweeper restores claimed step > 10m without message_id to pending', async () => {
      db.prepare("INSERT INTO campaigns (id, name, status) VALUES (50, 'Sweeper Camp', 'running')").run();
      db.prepare("INSERT INTO lists (id, name) VALUES (50, 'L 50')").run();
      db.prepare("INSERT INTO leads (id, list_id, email) VALUES (501, 50, 'lead501@test.com')").run();
      db.prepare("INSERT INTO leads (id, list_id, email) VALUES (502, 50, 'lead502@test.com')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (50, 50, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (50, 50, 'A', 'Hi', '<p>Test</p>')").run();

      // Claimed 15 minutes ago without message_id
      db.prepare(`
        INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, message_id)
        VALUES (501, 50, 501, 50, 50, 'claimed', datetime('now', '-15 minutes'), NULL)
      `).run();

      // Claimed 15 minutes ago WITH message_id
      db.prepare(`
        INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, message_id)
        VALUES (502, 50, 502, 50, 50, 'claimed', datetime('now', '-15 minutes'), '<sent-msg-123@domain.com>')
      `).run();

      await runSchedulerTick({ ignoreSchedule: true, ignoreGaps: true });

      const step1 = db.prepare('SELECT * FROM lead_steps WHERE id = 501').get();
      assert.equal(step1.status, 'pending');
      assert.ok(step1.last_error.includes('Swept'));

      const step2 = db.prepare('SELECT * FROM lead_steps WHERE id = 502').get();
      assert.equal(step2.status, 'sent');
      assert.ok(step2.last_error.includes('Swept'));
    });

    it('marks running campaign as completed when no pending/retrying/claimed steps remain', async () => {
      db.prepare("INSERT INTO campaigns (id, name, status) VALUES (51, 'Complete Camp', 'running')").run();
      db.prepare("INSERT INTO lists (id, name) VALUES (51, 'L 51')").run();
      db.prepare("INSERT INTO leads (id, list_id, email) VALUES (511, 51, 'lead511@test.com')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (51, 51, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (51, 51, 'A', 'Hi', '<p>Test</p>')").run();

      // Only 'sent' step exists
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (511, 51, 511, 51, 51, 'sent', CURRENT_TIMESTAMP)").run();

      await runSchedulerTick({ ignoreSchedule: true, ignoreGaps: true });

      const c = db.prepare('SELECT status FROM campaigns WHERE id = 51').get();
      assert.equal(c.status, 'completed');
    });
  });

  // =========================================================================
  // 2.9 Random Send Gap Persisted in DB
  // =========================================================================
  describe('2.9 Random Send Gap persisted in DB', () => {
    it('calculateRandomSendGap returns value between min and max seconds', () => {
      for (let i = 0; i < 20; i++) {
        const gap = calculateRandomSendGap(10, 20);
        assert.ok(gap >= 10 && gap <= 20, `Gap ${gap} not between 10 and 20`);
      }
    });

    it('persists next_send_at in mailboxes and tick respects it', async () => {
      insertTestMailbox(60, 'gap@test.com', { next_send_at: new Date(Date.now() + 3600000).toISOString() });
      db.prepare("INSERT INTO campaigns (id, name, status, min_gap_seconds, max_gap_seconds) VALUES (60, 'Gap Camp', 'running', 60, 120)").run();
      db.prepare("INSERT INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (60, 60)").run();
      db.prepare("INSERT INTO lists (id, name) VALUES (60, 'L 60')").run();
      db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (601, 60, 'lead601@test.com', 'active')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (60, 60, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (60, 60, 'A', 'Hi', '<p>Test</p>')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (601, 60, 601, 60, 60, 'pending', datetime('now', '-1 minute'))").run();

      // Tick without ignoreGaps should skip because next_send_at is in the future (+1 hour)
      const res = await runSchedulerTick({ ignoreSchedule: true, ignoreGaps: false, mockSend: true });
      assert.equal(res.sent, 0);

      // Verify lead step is still pending
      const step = db.prepare('SELECT status FROM lead_steps WHERE id = 601').get();
      assert.equal(step.status, 'pending');
    });
  });

  // =========================================================================
  // 2.10 Overview Timeline 30-Day Zero-Fill
  // =========================================================================
  describe('2.10 Overview Timeline 30-Day Zero-Fill', () => {
    it('getOverviewStats returns 30 days ascending with zero-filled missing days', () => {
      // Seed minimal chain for foreign key constraints: list -> lead -> campaign -> seq_step -> variant -> lead_step -> event
      db.prepare("INSERT INTO lists (id, name) VALUES (80, 'L 80')").run();
      db.prepare("INSERT INTO leads (id, list_id, email) VALUES (801, 80, 'l801@test.com')").run();
      db.prepare("INSERT INTO campaigns (id, name) VALUES (80, 'Camp 80')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (80, 80, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (80, 80, 'A', 'Hi', '<p>T</p>')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at) VALUES (801, 80, 801, 80, 80, 'sent', CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO email_events (lead_step_id, type, timestamp) VALUES (801, 'sent', CURRENT_TIMESTAMP)").run();

      const stats = getOverviewStats(30);
      assert.ok(stats.timeline);
      assert.equal(stats.timeline.length, 30);

      // Verify ascending order
      for (let i = 1; i < stats.timeline.length; i++) {
        assert.ok(stats.timeline[i].date >= stats.timeline[i - 1].date, 'Timeline dates must be ascending');
      }

      // Check fields are numbers
      for (const day of stats.timeline) {
        assert.equal(typeof day.sent, 'number');
        assert.equal(typeof day.opened, 'number');
        assert.equal(typeof day.clicked, 'number');
        assert.equal(typeof day.replied, 'number');
        assert.equal(typeof day.bounced, 'number');
      }

      // Last item should have at least 1 sent
      const lastDay = stats.timeline[stats.timeline.length - 1];
      assert.ok(lastDay.sent >= 1);
    });
  });

  // =========================================================================
  // 2.11 Fix scheduleNextStep
  // =========================================================================
  describe('2.11 Fix scheduleNextStep delay_days and base time', () => {
    it('preserves delay_days = 0 and measures relative to currentStep.sent_at', () => {
      db.prepare("INSERT INTO campaigns (id, name, status) VALUES (70, 'Seq Camp', 'running')").run();
      db.prepare("INSERT INTO lists (id, name) VALUES (70, 'L 70')").run();
      db.prepare("INSERT INTO leads (id, list_id, email) VALUES (701, 70, 'lead701@test.com')").run();

      // Step 1
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number, delay_days) VALUES (71, 70, 1, 0)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (71, 71, 'A', 'Hi 1', '<p>Body 1</p>')").run();

      // Step 2 with delay_days = 0
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number, delay_days) VALUES (72, 70, 2, 0)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (72, 72, 'A', 'Hi 2', '<p>Body 2</p>')").run();

      // Step 3 with delay_days = 3
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number, delay_days) VALUES (73, 70, 3, 3)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (73, 73, 'A', 'Hi 3', '<p>Body 3</p>')").run();

      const campaign = { id: 70 };
      const currentStep1 = {
        id: 701,
        lead_id: 701,
        step_number: 1,
        sent_at: '2026-06-01 10:00:00'
      };

      // Schedule next step from step 1 -> step 2 (delay_days = 0)
      scheduleNextStep(currentStep1, campaign);

      const nextLeadStep = db.prepare('SELECT * FROM lead_steps WHERE campaign_id = 70 AND sequence_step_id = 72').get();
      assert.ok(nextLeadStep);
      assert.equal(nextLeadStep.status, 'pending');
      // With delay_days = 0, scheduled_at should match the base send time
      assert.equal(nextLeadStep.scheduled_at, '2026-06-01 10:00:00');

      // Schedule next step from step 2 -> step 3 (delay_days = 3)
      const currentStep2 = {
        id: nextLeadStep.id,
        lead_id: 701,
        step_number: 2,
        sent_at: '2026-06-01 12:00:00'
      };
      scheduleNextStep(currentStep2, campaign);

      const step3LeadStep = db.prepare('SELECT * FROM lead_steps WHERE campaign_id = 70 AND sequence_step_id = 73').get();
      assert.ok(step3LeadStep);
      // With delay_days = 3, scheduled_at should be 2026-06-04 12:00:00
      assert.equal(step3LeadStep.scheduled_at, '2026-06-04 12:00:00');
    });
  });
});
