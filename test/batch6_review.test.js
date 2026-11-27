import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../src/db.js';
import { config } from '../src/config.js';
import { createMailbox, updateMailbox, getMailboxById } from '../src/mailboxes/accounts.js';
import { checkMailboxDns, canMailboxSend } from '../src/mailboxes/dns-check.js';
import { escapeHtml, renderVariables, injectTrackingAndFooter } from '../src/campaigns/render.js';
import { processIncomingEmail } from '../src/campaigns/replies.js';
import { isWithinSendWindow } from '../src/mailboxes/limits.js';
import { createAdminServer } from '../src/admin.js';

describe('BATCH 6 Regression Suite (Remaining Architecture, Security & Edge Cases)', () => {
  let db;

  before(() => {
    db = initDb(':memory:');
  });

  after(() => {
    closeDb();
  });

  // ==========================================
  // 6.1 DKIM SELECTOR & DNS OVERRIDE
  // ==========================================
  describe('6.1 DKIM Selector & DNS Failure Override', () => {
    it('checkMailboxDns queries mailbox custom dkim_selector first', async () => {
      const mb = await createMailbox({
        email: 'sender@customdkim.com',
        display_name: 'Custom DKIM User',
        smtp_host: 'localhost',
        smtp_port: 587,
        smtp_secure: 0,
        smtp_user: 'user',
        smtp_pass: 'pass',
        imap_host: 'localhost',
        imap_port: 993,
        imap_secure: 1,
        imap_user: 'user',
        imap_pass: 'pass',
        status: 'ready',
        dkim_selector: 'myselector'
      }, { testFirst: false });

      const queriedSelectors = [];
      const mockDns = {
        async resolveTxt(host) {
          if (host.includes('._domainkey.')) {
            const selector = host.split('._domainkey.')[0];
            queriedSelectors.push(selector);
            if (selector === 'myselector') {
              return [['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ...']];
            }
          }
          if (host === 'customdkim.com') {
            return [['v=spf1 include:_spf.example.com ~all']];
          }
          throw new Error('Not found');
        },
        async resolveMx() {
          return [{ exchange: 'mx.customdkim.com', priority: 10 }];
        }
      };

      const result = await checkMailboxDns('customdkim.com', mb.id, mockDns);
      assert.equal(queriedSelectors[0], 'myselector', 'Custom selector must be queried first');
      assert.equal(result.dkim.status, 'pass');
      assert.equal(result.dkim.selector, 'myselector');
    });

    it('canMailboxSend respects allow_failed_dns override when DNS checks fail', async () => {
      const mb = await createMailbox({
        email: 'override@faildomain.com',
        display_name: 'Override User',
        smtp_host: 'localhost',
        smtp_port: 587,
        smtp_secure: 0,
        smtp_user: 'user',
        smtp_pass: 'pass',
        imap_host: 'localhost',
        imap_port: 993,
        imap_secure: 1,
        imap_user: 'user',
        imap_pass: 'pass',
        status: 'ready',
        allow_failed_dns: 1
      }, { testFirst: false });

      // Record a failing DNS check in mailbox_dns_checks
      db.prepare(`
        INSERT INTO mailbox_dns_checks (
          mailbox_id, domain, spf_status, dkim_status, dmarc_status, mx_status, checked_at
        ) VALUES (?, 'faildomain.com', 'fail', 'fail', 'fail', 'fail', CURRENT_TIMESTAMP)
      `).run(mb.id);

      const check = canMailboxSend(mb.id);
      assert.equal(check.canSend, true, 'Mailbox with allow_failed_dns=1 should be allowed to send');
      assert.equal(check.override, true);

      // Now disable allow_failed_dns
      updateMailbox(mb.id, { allow_failed_dns: 0 });
      const strictCheck = canMailboxSend(mb.id);
      assert.equal(strictCheck.canSend, false, 'Mailbox with allow_failed_dns=0 must block sending on DNS failure');
    });
  });

  // ==========================================
  // 6.2 HTML ESCAPING IN TEMPLATES & FOOTER
  // ==========================================
  describe('6.2 HTML Escaping & Injection Prevention', () => {
    it('renderVariables escapes lead properties and custom fields to prevent XSS', () => {
      const template = '<p>Hello {{first_name}}, welcome to {{custom.company}}! Fallback: {{missing|<script>bad()</script>}}</p>';
      const lead = {
        first_name: '<script>alert("xss")</script>',
        custom_fields_json: JSON.stringify({
          company: 'Acme <img src=x onerror=alert(1)>'
        })
      };

      const rendered = renderVariables(template, lead);
      assert.ok(!rendered.includes('<script>'), 'Script tag in lead field must be escaped');
      assert.ok(rendered.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
      assert.ok(!rendered.includes('<img src=x'), 'Img onerror in custom field must be escaped');
      assert.ok(rendered.includes('Acme &lt;img src=x onerror=alert(1)&gt;'));
      assert.ok(!rendered.includes('<script>bad()'), 'Fallback HTML must be escaped');
      assert.ok(rendered.includes('&lt;script&gt;bad()&lt;/script&gt;'));
    });

    it('injectTrackingAndFooter escapes postal address', () => {
      const html = '<html><body><p>Main content</p></body></html>';
      const output = injectTrackingAndFooter(html, {
        openToken: 'tok123',
        unsubscribeUrl: 'http://localhost/u/tok123',
        postalAddress: '123 Fake St <script>steal()</script> Suite 400',
        publicBaseUrl: 'http://localhost'
      });

      assert.ok(!output.includes('<script>steal()</script>'), 'Postal address script must be escaped');
      assert.ok(output.includes('123 Fake St &lt;script&gt;steal()&lt;/script&gt; Suite 400'));
      assert.ok(output.includes('http://localhost/u/tok123'));
    });
  });

  // ==========================================
  // 6.3 FASTIFY SCHEMA VALIDATION ON MAILBOX ROUTES
  // ==========================================
  describe('6.3 Mailbox Creation Validation & Action Routes', () => {
    let fastify;

    before(async () => {
      fastify = await createAdminServer();
    });

    after(async () => {
      await fastify.close();
    });

    it('POST /api/mailboxes rejects invalid status with 400', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/mailboxes',
        headers: {
          host: '127.0.0.1:3000',
          'x-api-key': config.admin.apiKey
        },
        payload: {
          email: 'valid@example.com',
          smtp_host: 'localhost',
          smtp_port: 587,
          smtp_user: 'u',
          smtp_pass: 'p',
          imap_host: 'localhost',
          imap_port: 993,
          imap_user: 'u',
          imap_pass: 'p',
          status: 'destroyed' // Invalid status enum
        }
      });

      assert.equal(res.statusCode, 400);
      const data = res.json();
      assert.ok(data.error);
    });

    it('POST /api/mailboxes performs connection test by default and returns 400 if unreachable', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/mailboxes',
        headers: {
          host: '127.0.0.1:3000',
          'x-api-key': config.admin.apiKey
        },
        payload: {
          email: 'testconn@example.com',
          smtp_host: '127.0.0.1',
          smtp_port: 65534, // unreachable port
          smtp_user: 'u',
          smtp_pass: 'p',
          imap_host: '127.0.0.1',
          imap_port: 65533,
          imap_user: 'u',
          imap_pass: 'p',
          status: 'ready'
        }
      });

      assert.equal(res.statusCode, 400);
      const data = res.json();
      assert.ok(data.error.includes('Connection test failed') || data.error.includes('ECONNREFUSED'));
    });

    it('POST /api/mailboxes/:id/warmup/:action accepts only start/pause/resume', async () => {
      const resInvalid = await fastify.inject({
        method: 'POST',
        url: '/api/mailboxes/1/warmup/destroy',
        headers: {
          host: '127.0.0.1:3000',
          'x-api-key': config.admin.apiKey
        }
      });
      assert.equal(resInvalid.statusCode, 400);
      const errData = resInvalid.json();
      assert.ok(errData.error);

      // 'pause' is valid action enum
      const resValid = await fastify.inject({
        method: 'POST',
        url: '/api/mailboxes/99999/warmup/pause',
        headers: {
          host: '127.0.0.1:3000',
          'x-api-key': config.admin.apiKey
        }
      });
      // 404 because mailbox 99999 does not exist, but NOT 400 invalid action!
      assert.equal(resValid.statusCode, 404);
    });
  });

  // ==========================================
  // 6.4 UNSUBSCRIBE BY EMAIL
  // ==========================================
  describe('6.4 Unsubscribe by Email Processing', () => {
    it('suppresses sender and updates lead status when incoming email subject contains "unsubscribe"', () => {
      // Create campaign, lead, and step
      db.prepare(`
        INSERT INTO campaigns (id, name, status, created_at)
        VALUES (960, 'Unsub Test Campaign', 'running', CURRENT_TIMESTAMP)
      `).run();

      const leadInfo = db.prepare(`
        INSERT INTO leads (email, first_name, status, created_at)
        VALUES ('unsublead@test.com', 'UnsubLead', 'contacted', CURRENT_TIMESTAMP)
      `).run();
      const leadId = Number(leadInfo.lastInsertRowid);

      const stepRow = db.prepare(`
        INSERT INTO sequence_steps (campaign_id, step_number)
        VALUES (960, 1)
      `).run();

      const stepInfo = db.prepare(`
        INSERT INTO lead_steps (lead_id, campaign_id, sequence_step_id, status, scheduled_at, sent_at)
        VALUES (?, 960, ?, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(leadId, stepRow.lastInsertRowid);

      const parsedEmail = {
        from: { value: [{ address: 'unsublead@test.com' }] },
        subject: 'Please Unsubscribe me immediately',
        text: 'Stop sending me emails.',
        headers: new Map()
      };

      const result = processIncomingEmail(parsedEmail, null);
      assert.equal(result.isUnsubscribe, true);
      assert.equal(result.suppressed, 'unsublead@test.com');

      // Verify suppression table
      const suppRow = db.prepare('SELECT * FROM suppression WHERE email = ?').get('unsublead@test.com');
      assert.ok(suppRow, 'Sender must be added to suppression table');
      assert.equal(suppRow.reason, 'email_unsubscribe');

      // Verify lead status
      const updatedLead = db.prepare('SELECT status FROM leads WHERE id = ?').get(leadId);
      assert.equal(updatedLead.status, 'unsubscribed');

      // Verify event was recorded
      const eventRow = db.prepare("SELECT * FROM email_events WHERE type = 'unsubscribe' AND lead_step_id = ?").get(stepInfo.lastInsertRowid);
      assert.ok(eventRow, 'Unsubscribe email_event must be recorded');
    });
  });

  // ==========================================
  // 6.5 DATABASE PATH RESOLUTION RELATIVE TO PROJECT ROOT
  // ==========================================
  describe('6.5 Database Path Resolution', () => {
    it('config.db.path resolves to an absolute path rooted at project root', () => {
      assert.ok(path.isAbsolute(config.db.path), 'config.db.path must be absolute');
      assert.ok(config.db.path.startsWith(config.rootDir), 'config.db.path must resolve inside rootDir');
    });
  });

  // ==========================================
  // 6.6 MIDNIGHT HOURCYCLE HANDLING
  // ==========================================
  describe('6.6 Send Window Midnight Quirk', () => {
    it('isWithinSendWindow evaluates cleanly around midnight using hourCycle h23', () => {
      const schedule = {
        timezone: 'UTC',
        send_days: [1, 2, 3, 4, 5, 6, 7],
        window_start: '00:00',
        window_end: '02:00'
      };

      // 00:30 UTC
      const dateMidnight = new Date('2026-11-27T00:30:00Z');
      const inside = isWithinSendWindow(schedule, dateMidnight);
      assert.equal(inside, true, '00:30 should be inside 00:00 - 02:00 window');

      // Overnight window (e.g. 22:00 to 03:00)
      const overnightSchedule = {
        timezone: 'UTC',
        send_days: [1, 2, 3, 4, 5, 6, 7],
        window_start: '22:00',
        window_end: '03:00'
      };

      // 01:15 UTC (inside overnight window)
      const insideOvernight = isWithinSendWindow(overnightSchedule, new Date('2026-11-27T01:15:00Z'));
      assert.equal(insideOvernight, true, '01:15 should be inside 22:00 - 03:00 window');

      // 12:00 UTC (outside overnight window)
      const outsideOvernight = isWithinSendWindow(overnightSchedule, new Date('2026-11-27T12:00:00Z'));
      assert.equal(outsideOvernight, false, '12:00 should be outside 22:00 - 03:00 window');
    });
  });

  // ==========================================
  // 6.7 OFFICIAL CHART.JS VENDOR ASSET
  // ==========================================
  describe('6.7 Official Chart.js Distribution', () => {
    it('verifies public/vendor/chart.js is the full official bundle (>150KB)', () => {
      const chartPath = path.resolve(config.rootDir, 'public/vendor/chart.js');
      assert.ok(fs.existsSync(chartPath), 'chart.js must exist in public/vendor');

      const stats = fs.statSync(chartPath);
      assert.ok(stats.size > 150000, `chart.js should be the full official library (>150KB), got ${stats.size} bytes`);

      const content = fs.readFileSync(chartPath, 'utf8');
      assert.ok(content.includes('Chart'), 'chart.js must contain Chart implementation');
    });
  });

  // ==========================================
  // 6.8 FIXTURE DATA CLEANUP
  // ==========================================
  describe('6.8 Database Fixture Cleanup', () => {
    it('verifies no test fixture rows (lead_steps 999 or audit_test@example.com) remain in database', () => {
      const fixtureStep = db.prepare('SELECT id FROM lead_steps WHERE id = 999').get();
      assert.equal(fixtureStep, undefined, 'lead_steps id 999 fixture row must not exist');

      const fixtureSupp = db.prepare("SELECT email FROM suppression WHERE email = 'audit_test@example.com'").get();
      assert.equal(fixtureSupp, undefined, 'audit_test@example.com suppression row must not exist');
    });
  });
});
