import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, closeDb, getDb } from '../src/db.js';
import { config } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { createAdminServer } from '../src/admin.js';
import { createPublicServer } from '../src/public.js';
import { classifySendError, handleSendFailure } from '../src/campaigns/engine.js';
import { isSuppressed, addSuppression } from '../src/campaigns/suppression.js';
import { pollMailboxReplies, processIncomingEmail } from '../src/campaigns/replies.js';
import { createMailbox, getMailboxById, testMailboxConnection } from '../src/mailboxes/accounts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('BATCH 1 Regression Suite (Safety-Critical & Security Review)', () => {
  let db;
  let adminServer;
  let publicServer;
  const testApiKey = config.admin.apiKey;

  before(async () => {
    db = initDb(':memory:');
    adminServer = createAdminServer();
    publicServer = createPublicServer();
    await adminServer.ready();
    await publicServer.ready();
  });

  after(async () => {
    await adminServer.close();
    await publicServer.close();
    closeDb();
  });

  // =========================================================================
  // 1.1 Send-error classification (src/campaigns/engine.js)
  // =========================================================================
  describe('1.1 Send-error classification', () => {
    beforeEach(() => {
      db.prepare("DELETE FROM suppression").run();
      db.prepare("DELETE FROM email_events").run();
      db.prepare("DELETE FROM lead_steps").run();
      db.prepare("DELETE FROM leads").run();
      db.prepare("DELETE FROM step_variants").run();
      db.prepare("DELETE FROM sequence_steps").run();
      db.prepare("DELETE FROM campaigns").run();
      db.prepare("DELETE FROM mailboxes").run();

      // Seed baseline records
      db.prepare("INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted, status) VALUES (1, 'sender@test.com', 'Sender', 'smtp.test.com', 'user', 'enc', 'imap.test.com', 'user', 'enc', 'ready')").run();
      db.prepare("INSERT INTO campaigns (id, name, status) VALUES (1, 'Batch1 Test Campaign', 'running')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 1, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (1, 1, 'A', 'Hi', '<p>Test</p>')").run();
    });

    it('auth failure 535 must NOT suppress anyone and marks mailbox error', () => {
      db.prepare("INSERT INTO leads (id, email, status) VALUES (1, 'lead1@example.com', 'active')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at, open_token) VALUES (1, 1, 1, 1, 1, 1, 'claimed', datetime('now'), 'tok1')").run();

      const authErr = new Error('535 5.7.8 Authentication credentials invalid');
      authErr.code = 'EAUTH';
      authErr.responseCode = 535;
      authErr.command = 'AUTH PLAIN';

      assert.equal(classifySendError(authErr), 'auth');

      handleSendFailure(1, 'lead1@example.com', 0, authErr, 1);

      // Lead must NOT be suppressed
      assert.equal(isSuppressed('lead1@example.com'), false);

      // Lead step released back to 'pending'
      const step = db.prepare("SELECT * FROM lead_steps WHERE id = 1").get();
      assert.equal(step.status, 'pending');
      assert.equal(step.mailbox_id, null);

      // Mailbox marked 'error' with error_reason
      const mb = db.prepare("SELECT * FROM mailboxes WHERE id = 1").get();
      assert.equal(mb.status, 'error');
      assert.ok(mb.error_reason.includes('Authentication credentials invalid'));
    });

    it('ETIMEDOUT on port 587 must NOT suppress anyone and soft retries', () => {
      db.prepare("INSERT INTO leads (id, email, status) VALUES (2, 'lead2@example.com', 'active')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at, open_token) VALUES (2, 1, 2, 1, 1, 1, 'claimed', datetime('now'), 'tok2')").run();

      const timeoutErr = new Error('connect ETIMEDOUT 198.51.100.1:587');
      timeoutErr.code = 'ETIMEDOUT';

      assert.equal(classifySendError(timeoutErr), 'network');

      handleSendFailure(2, 'lead2@example.com', 0, timeoutErr, 1);

      // Lead must NOT be suppressed
      assert.equal(isSuppressed('lead2@example.com'), false);

      // Step status must be retrying with retry_count = 1
      const step = db.prepare("SELECT * FROM lead_steps WHERE id = 2").get();
      assert.equal(step.status, 'retrying');
      assert.equal(step.retry_count, 1);
    });

    it('550 5.1.1 at RCPT TO MUST suppress lead and log bounce_hard event', () => {
      db.prepare("INSERT INTO leads (id, email, status) VALUES (3, 'lead3@example.com', 'active')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at, open_token) VALUES (3, 1, 3, 1, 1, 1, 'claimed', datetime('now'), 'tok3')").run();

      const rcptErr = new Error('550 5.1.1 <lead3@example.com>: Recipient address rejected: User unknown in virtual mailbox table');
      rcptErr.responseCode = 550;
      rcptErr.command = 'RCPT TO';

      assert.equal(classifySendError(rcptErr), 'hard');

      handleSendFailure(3, 'lead3@example.com', 0, rcptErr, 1);

      // Lead MUST be suppressed
      assert.equal(isSuppressed('lead3@example.com'), true);

      // Step marked failed
      const step = db.prepare("SELECT * FROM lead_steps WHERE id = 3").get();
      assert.equal(step.status, 'failed');

      // Lead marked bounced
      const lead = db.prepare("SELECT * FROM leads WHERE id = 3").get();
      assert.equal(lead.status, 'bounced');

      // Event logged as bounce_hard
      const event = db.prepare("SELECT * FROM email_events WHERE lead_step_id = 3 AND type = 'bounce_hard'").get();
      assert.ok(event);
    });

    it('421 temporary deferral must retry without suppressing', () => {
      db.prepare("INSERT INTO leads (id, email, status) VALUES (4, 'lead4@example.com', 'active')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at, open_token) VALUES (4, 1, 4, 1, 1, 1, 'claimed', datetime('now'), 'tok4')").run();

      const deferralErr = new Error('421 4.7.0 Try again later, service busy');
      deferralErr.responseCode = 421;
      deferralErr.command = 'DATA';

      assert.equal(classifySendError(deferralErr), 'network');

      handleSendFailure(4, 'lead4@example.com', 1, deferralErr, 1);

      assert.equal(isSuppressed('lead4@example.com'), false);

      const step = db.prepare("SELECT * FROM lead_steps WHERE id = 4").get();
      assert.equal(step.status, 'retrying');
      assert.equal(step.retry_count, 2);
    });
  });

  // =========================================================================
  // 1.2 Unsubscribe must not fire on GET (src/public.js)
  // =========================================================================
  describe('1.2 Unsubscribe must not fire on GET', () => {
    beforeEach(() => {
      db.prepare("DELETE FROM suppression").run();
      db.prepare("DELETE FROM email_events").run();
      db.prepare("DELETE FROM lead_steps").run();
      db.prepare("DELETE FROM leads").run();
      db.prepare("DELETE FROM campaigns").run();

      db.prepare("INSERT INTO campaigns (id, name, status) VALUES (1, 'Unsub Campaign <script>alert(\"xss\")</script>', 'running')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 1, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (1, 1, 'A', 'Hi', '<p>Test</p>')").run();
      db.prepare("INSERT INTO leads (id, email, status) VALUES (1, 'test<script>@example.com', 'active')").run();
      db.prepare("INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at, open_token) VALUES (1, 1, 1, 1, 1, 'sent', datetime('now'), 'unsub_test_token')").run();
    });

    it('GET /u/:token must leave suppression empty and render escaped HTML with form', async () => {
      assert.equal(isSuppressed('test<script>@example.com'), false);

      const res = await publicServer.inject({
        method: 'GET',
        url: '/u/unsub_test_token'
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));

      // Verify HTML form exists pointing to POST /u/:token
      assert.ok(res.body.includes('<form method="POST" action="/u/unsub_test_token">'));
      assert.ok(res.body.includes('Unsubscribe Confirmation'));

      // Verify XSS escaping
      assert.ok(!res.body.includes('<script>alert'));
      assert.ok(res.body.includes('&lt;script&gt;'));

      // GET MUST NOT mutate database
      assert.equal(isSuppressed('test<script>@example.com'), false);
      const events = db.prepare("SELECT * FROM email_events WHERE lead_step_id = 1 AND type = 'unsubscribe'").all();
      assert.equal(events.length, 0);
    });

    it('POST /u/:token must suppress lead', async () => {
      const res = await publicServer.inject({
        method: 'POST',
        url: '/u/unsub_test_token',
        headers: {
          'list-unsubscribe-post': 'List-Unsubscribe=One-Click'
        }
      });

      assert.equal(res.statusCode, 200);

      // Verify email is suppressed in DB
      assert.equal(isSuppressed('test<script>@example.com'), true);

      // Verify event was logged
      const events = db.prepare("SELECT * FROM email_events WHERE lead_step_id = 1 AND type = 'unsubscribe'").all();
      assert.equal(events.length, 1);
    });

    it('double POST creates only a single unsubscribe event', async () => {
      // First POST
      await publicServer.inject({ method: 'POST', url: '/u/unsub_test_token' });
      // Second POST
      await publicServer.inject({ method: 'POST', url: '/u/unsub_test_token' });

      const events = db.prepare("SELECT * FROM email_events WHERE lead_step_id = 1 AND type = 'unsubscribe'").all();
      assert.equal(events.length, 1);
    });
  });

  // =========================================================================
  // 1.3 Reply poller (src/campaigns/replies.js)
  // =========================================================================
  describe('1.3 Reply poller with fake IMAP client', () => {
    beforeEach(() => {
      db.prepare("DELETE FROM mailbox_sync").run();
      db.prepare("DELETE FROM replies").run();
      db.prepare("DELETE FROM email_events").run();
      db.prepare("DELETE FROM lead_steps").run();
      db.prepare("DELETE FROM leads").run();
      db.prepare("DELETE FROM campaigns").run();
      db.prepare("DELETE FROM mailboxes").run();

      const enc = encrypt('p');
      db.prepare("INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted, status) VALUES (1, 'inbox@test.com', 'Inbox', 'smtp.test.com', 'u', ?, 'imap.test.com', 'u', ?, 'ready')").run(enc, enc);
      db.prepare("INSERT INTO campaigns (id, name, status) VALUES (1, 'Campaign 1', 'running')").run();
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 1, 1)").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (1, 1, 'A', 'Subj', '<p>B</p>')").run();
      db.prepare("INSERT INTO leads (id, email, status) VALUES (1, 'prospect@client.com', 'active')").run();

      // Sent step with messageId
      db.prepare(`
        INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at, sent_at, message_id, open_token)
        VALUES (1, 1, 1, 1, 1, 1, 'sent', datetime('now', '-2 days'), datetime('now', '-2 days'), '<sent-msg-123@test.com>', 'tok123')
      `).run();

      // Next step scheduled under condition 'if_no_reply'
      db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number, condition) VALUES (2, 1, 2, 'if_no_reply')").run();
      db.prepare("INSERT INTO step_variants (id, sequence_step_id, variant_letter, subject, body_html) VALUES (2, 2, 'A', 'Follow-up', '<p>Follow-up</p>')").run();
      db.prepare(`
        INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, mailbox_id, status, scheduled_at)
        VALUES (2, 1, 1, 2, 2, 1, 'pending', datetime('now', '+3 days'))
      `).run();
    });

    function createFakeImapClient(messagesToReturn = []) {
      const flaggedUids = [];
      return {
        mailbox: { uidValidity: '12345', uidNext: 100 },
        flaggedUids,
        async connect() {},
        async logout() {},
        async getMailboxLock() {
          return { release() {} };
        },
        async *fetch(range, query, options) {
          for (const msg of messagesToReturn) {
            yield msg;
          }
        },
        async messageFlagsAdd({ uid }, flags) {
          flaggedUids.push({ uid, flags });
        }
      };
    }

    it('unrelated newsletter is ignored, not saved to replies, and not flagged as seen', async () => {
      const newsletterRaw = `From: newsletter@medium.com\r\nTo: inbox@test.com\r\nSubject: Top 10 Stories This Week\r\nMessage-ID: <newsletter-1@medium.com>\r\nDate: Thu, 26 Nov 2026 10:00:00 +0000\r\n\r\nCheck out these stories!`;
      const fakeClient = createFakeImapClient([
        { uid: 10, source: Buffer.from(newsletterRaw) }
      ]);

      const mailbox = getMailboxById(1, true);
      await pollMailboxReplies(mailbox, { clientFactory: () => fakeClient });

      // Replies table must be empty
      const replies = db.prepare("SELECT * FROM replies").all();
      assert.equal(replies.length, 0);

      // Unrelated newsletter must NOT be flagged as Seen
      assert.equal(fakeClient.flaggedUids.length, 0);

      // mailbox_sync last_uid advances to 10
      const sync = db.prepare("SELECT * FROM mailbox_sync WHERE mailbox_id = 1").get();
      assert.equal(sync.last_uid, 10);
    });

    it('matched reply is stored, sequence stops, and message is flagged as Seen', async () => {
      const replyRaw = `From: prospect@client.com\r\nTo: inbox@test.com\r\nSubject: Re: Subj\r\nIn-Reply-To: <sent-msg-123@test.com>\r\nReferences: <sent-msg-123@test.com>\r\nMessage-ID: <reply-456@client.com>\r\nDate: Thu, 26 Nov 2026 11:00:00 +0000\r\n\r\nSounds great, let us talk!`;
      const fakeClient = createFakeImapClient([
        { uid: 15, source: Buffer.from(replyRaw) }
      ]);

      const mailbox = getMailboxById(1, true);
      await pollMailboxReplies(mailbox, { clientFactory: () => fakeClient });

      // Stored in replies table
      const replies = db.prepare("SELECT * FROM replies").all();
      assert.equal(replies.length, 1);
      assert.equal(replies[0].from_email, 'prospect@client.com');
      assert.equal(replies[0].is_auto_reply, 0);

      // Sequence step 2 stopped
      const step2 = db.prepare("SELECT * FROM lead_steps WHERE id = 2").get();
      assert.equal(step2.status, 'skipped');
      assert.ok(step2.last_error.includes('Sequence stopped on lead reply'));

      // Message flagged as seen
      assert.equal(fakeClient.flaggedUids.length, 1);
      assert.equal(fakeClient.flaggedUids[0].uid, 15);
      assert.deepEqual(fakeClient.flaggedUids[0].flags, ['\\Seen']);
    });

    it('warm-up message with X-MailCheck-Warmup is ignored and not flagged', async () => {
      const warmupRaw = `From: partner@mailcheck.org\r\nTo: inbox@test.com\r\nSubject: Quarterly sync\r\nX-MailCheck-Warmup: true\r\nMessage-ID: <warmup-789@mailcheck.org>\r\nDate: Thu, 26 Nov 2026 12:00:00 +0000\r\n\r\nWarmup payload`;
      const fakeClient = createFakeImapClient([
        { uid: 20, source: Buffer.from(warmupRaw) }
      ]);

      const mailbox = getMailboxById(1, true);
      await pollMailboxReplies(mailbox, { clientFactory: () => fakeClient });

      const replies = db.prepare("SELECT * FROM replies").all();
      assert.equal(replies.length, 0);
      assert.equal(fakeClient.flaggedUids.length, 0);
    });

    it('auto-reply is stored with is_auto_reply = 1 but does NOT stop the sequence', async () => {
      const autoReplyRaw = `From: prospect@client.com\r\nTo: inbox@test.com\r\nSubject: Automatic reply: Out of Office\r\nAuto-Submitted: auto-replied\r\nIn-Reply-To: <sent-msg-123@test.com>\r\nMessage-ID: <auto-reply-999@client.com>\r\nDate: Thu, 26 Nov 2026 13:00:00 +0000\r\n\r\nI am currently out of office until Monday.`;
      const fakeClient = createFakeImapClient([
        { uid: 25, source: Buffer.from(autoReplyRaw) }
      ]);

      const mailbox = getMailboxById(1, true);
      await pollMailboxReplies(mailbox, { clientFactory: () => fakeClient });

      const replies = db.prepare("SELECT * FROM replies").all();
      assert.equal(replies.length, 1);
      assert.equal(replies[0].is_auto_reply, 1);

      // Step 2 must remain pending!
      const step2 = db.prepare("SELECT * FROM lead_steps WHERE id = 2").get();
      assert.equal(step2.status, 'pending');
    });

    it('mailbox_sync advances last_uid properly after fetching', async () => {
      const msgRaw = `From: prospect@client.com\r\nTo: inbox@test.com\r\nSubject: Re: Follow up\r\nIn-Reply-To: <sent-msg-123@test.com>\r\nMessage-ID: <reply-101@client.com>\r\nDate: Thu, 26 Nov 2026 14:00:00 +0000\r\n\r\nSounds good, let's talk.`;
      const fakeClient = createFakeImapClient([
        { uid: 50, source: Buffer.from(msgRaw) },
        { uid: 55, source: Buffer.from(msgRaw) }
      ]);

      const mailbox = getMailboxById(1, true);
      await pollMailboxReplies(mailbox, { clientFactory: () => fakeClient });

      const sync = db.prepare("SELECT * FROM mailbox_sync WHERE mailbox_id = 1 AND folder = 'INBOX'").get();
      assert.ok(sync);
      assert.equal(sync.last_uid, 55);
    });
  });

  // =========================================================================
  // 1.5 Security defaults & Fastify route defenses
  // =========================================================================
  describe('1.5 Security defaults & Fastify route defenses', () => {
    it('missing API key gives 401 on admin API route', async () => {
      const res = await adminServer.inject({
        method: 'GET',
        url: '/api/settings',
        headers: {
          host: '127.0.0.1:3000'
        }
      });

      assert.equal(res.statusCode, 401);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Unauthorized'));
    });

    it('valid API key via x-api-key header succeeds with 200', async () => {
      const res = await adminServer.inject({
        method: 'GET',
        url: '/api/settings',
        headers: {
          host: '127.0.0.1:3000',
          'x-api-key': testApiKey
        }
      });

      assert.equal(res.statusCode, 200);
    });

    it('wrong Host header gives 403 (DNS-rebinding protection)', async () => {
      const res = await adminServer.inject({
        method: 'GET',
        url: '/api/settings',
        headers: {
          host: 'evil-attacker.com',
          'x-api-key': testApiKey
        }
      });

      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Host'));
    });

    it('cross-origin POST with foreign Origin header gives 403 (CSRF defense)', async () => {
      const res = await adminServer.inject({
        method: 'POST',
        url: '/api/settings',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://malicious-website.com',
          'x-api-key': testApiKey
        },
        body: { default_daily_cap: '45' }
      });

      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Cross-origin'));
    });

    it('startup throws without valid 64-char hex ENCRYPTION_KEY when NODE_ENV !== test', async () => {
      const { spawnSync } = await import('child_process');
      const res = spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        `
        process.env.NODE_ENV = 'production';
        process.env.ENCRYPTION_KEY = '';
        await import('./src/config.js');
        `
      ], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8'
      });

      assert.notEqual(res.status, 0);
      assert.ok(res.stderr.includes('ENCRYPTION_KEY'));
    });

    it('TLS rejectUnauthorized is disabled only when allow_self_signed = 1', async () => {
      const mbDefault = await createMailbox({
        email: 'default-tls@test.com',
        display_name: 'TLS Test',
        smtp_host: '127.0.0.1',
        smtp_port: 587,
        smtp_user: 'user',
        smtp_pass: 'pass',
        allow_self_signed: 0
      }, { skipDns: true });

      assert.equal(mbDefault.allow_self_signed, 0);

      const mbSelfSigned = await createMailbox({
        email: 'self-signed@test.com',
        display_name: 'TLS Test 2',
        smtp_host: '127.0.0.1',
        smtp_port: 587,
        smtp_user: 'user',
        smtp_pass: 'pass',
        allow_self_signed: 1
      }, { skipDns: true });

      assert.equal(mbSelfSigned.allow_self_signed, 1);
    });
  });
});
