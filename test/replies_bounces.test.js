import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { isAutoReply, processIncomingEmail, labelReply, markReplyHandled } from '../src/campaigns/replies.js';
import { classifyBounceCode, isBounceMessage, parseBounce, processBounce } from '../src/campaigns/bounces.js';
import { isSuppressed } from '../src/campaigns/suppression.js';

describe('Replies, Bounces & Suppression Module (Step 6)', () => {
  let db;

  before(() => {
    db = initDb(':memory:');

    // Create test campaign, sequence steps, leads, lead_steps
    // Seed mailbox 1
    db.prepare(`
      INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted)
      VALUES (1, 'sender@testcorp.com', 'Sender', 'smtp.testcorp.com', 'sender', 'enc', 'imap.testcorp.com', 'sender', 'enc')
    `).run();

    db.prepare("INSERT INTO lists (name) VALUES ('Test List')").run();
    db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (1, 1, 'prospect@acme.com', 'active')").run();
    db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (2, 1, 'baduser@acme.com', 'active')").run();
    db.prepare("INSERT INTO campaigns (id, name, status) VALUES (1, 'Outreach 2026', 'running')").run();
    db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number, condition) VALUES (1, 1, 1, 'always')").run();
    db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number, condition) VALUES (2, 1, 2, 'if_no_reply')").run();

    // Prospect step 1 sent, step 2 pending
    db.prepare(`
      INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, status, scheduled_at, message_id)
      VALUES (1, 1, 1, 1, 'sent', datetime('now', '-2 days'), '<msg-orig-1@testcorp.com>')
    `).run();
    db.prepare(`
      INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, status, scheduled_at)
      VALUES (2, 1, 1, 2, 'pending', datetime('now', '+1 day'))
    `).run();

    // Baduser step 1 sent
    db.prepare(`
      INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, status, scheduled_at, message_id)
      VALUES (3, 1, 2, 1, 'sent', datetime('now', '-1 day'), '<msg-bad-user@testcorp.com>')
    `).run();
  });

  after(() => {
    closeDb();
  });

  describe('1. Auto-Reply Detection', () => {
    it('detects RFC 3834 Auto-Submitted header', () => {
      const res = isAutoReply({ 'auto-submitted': 'auto-replied' });
      assert.equal(res, true);
    });

    it('detects Out of Office subject patterns', () => {
      const res = isAutoReply({}, 'Automatic reply: Out of office until next Monday', '');
      assert.equal(res, true);
    });

    it('detects Out of Office body keywords', () => {
      const res = isAutoReply({}, 'Re: Quick Question', 'I am currently out of the office with limited access to email.');
      assert.equal(res, true);
    });

    it('recognizes authentic human replies', () => {
      const res = isAutoReply(
        {},
        'Re: Your proposal',
        'Hi, thanks for reaching out. Yes, we would be interested in seeing a demo on Thursday.'
      );
      assert.equal(res, false);
    });
  });

  describe('2. Bounce Classification & DSN Handling', () => {
    it('classifies 5.x.x status code as hard bounce', () => {
      assert.equal(classifyBounceCode('Remote host said: 550 5.1.1 User unknown'), 'hard');
      assert.equal(classifyBounceCode('Diagnostic-Code: smtp; 554 5.7.1 Service unavailable'), 'hard');
    });

    it('classifies 4.x.x status code or quota exceeded as soft bounce', () => {
      assert.equal(classifyBounceCode('Remote host said: 452 4.2.2 Mailbox full, quota exceeded'), 'soft');
      assert.equal(classifyBounceCode('451 4.3.0 Temporary system failure, try again later'), 'soft');
    });

    it('identifies bounce message senders and subjects', () => {
      const bounceEmail = {
        from: { text: 'MAILER-DAEMON@mail.google.com' },
        subject: 'Delivery Status Notification (Failure)',
        headers: new Map([['content-type', 'multipart/report; report-type=delivery-status']])
      };
      assert.equal(isBounceMessage(bounceEmail), true);
    });

    it('processes hard bounce: marks lead bounced, logs event, and suppresses email', () => {
      const fakeBounce = {
        from: { text: 'postmaster@acme.com' },
        subject: 'Undelivered Mail Returned to Sender',
        text: 'This is an error report.\nFinal-Recipient: rfc822; baduser@acme.com\nStatus: 5.1.1 (User does not exist)\nMessage-ID: <msg-bad-user@testcorp.com>',
        headers: new Map()
      };

      const bounceInfo = parseBounce(fakeBounce);
      assert.equal(bounceInfo.isBounce, true);
      assert.equal(bounceInfo.type, 'hard');
      assert.equal(bounceInfo.recipientEmail, 'baduser@acme.com');

      const proc = processBounce(bounceInfo);
      assert.equal(proc.processed, true);

      // Verify lead is marked bounced
      const lead = db.prepare('SELECT status FROM leads WHERE id = 2').get();
      assert.equal(lead.status, 'bounced');

      // Verify email event logged
      const evt = db.prepare("SELECT * FROM email_events WHERE type = 'bounce_hard' AND lead_step_id = 3").get();
      assert.ok(evt);

      // Verify email is globally suppressed
      assert.equal(isSuppressed('baduser@acme.com'), true);
    });
  });

  describe('3. Incoming Reply Processing & Sequence Control', () => {
    it('processes genuine human reply: logs reply event and stops future sequence steps', () => {
      // Step 2 for prospect is currently 'pending'
      const step2Before = db.prepare('SELECT status FROM lead_steps WHERE id = 2').get();
      assert.equal(step2Before.status, 'pending');

      const parsedReply = {
        from: { value: [{ address: 'prospect@acme.com' }], text: 'Prospect <prospect@acme.com>' },
        subject: 'Re: Quick Question',
        text: 'Hello! I am definitely interested. Can you send over your calendar link?',
        inReplyTo: '<msg-orig-1@testcorp.com>',
        headers: {}
      };

      const result = processIncomingEmail(parsedReply, 1);
      assert.ok(result.replyId);
      assert.equal(result.isAutoReply, false);
      assert.equal(result.matched, true);

      // Verify reply event logged
      const evt = db.prepare("SELECT * FROM email_events WHERE type = 'reply' AND lead_step_id = 1").get();
      assert.ok(evt);

      // Verify step 2 was skipped because lead replied!
      const step2After = db.prepare('SELECT status, last_error FROM lead_steps WHERE id = 2').get();
      assert.equal(step2After.status, 'skipped');
      assert.ok(step2After.last_error.includes('Sequence stopped'));

      // Test reply labeling & handled status
      const labeled = labelReply(result.replyId, 'interested');
      assert.equal(labeled.label, 'interested');

      const handled = markReplyHandled(result.replyId, 1);
      assert.equal(handled.handled, 1);
    });

    it('does not stop sequence when incoming email is an automated auto-reply', () => {
      // Create another test lead and pending step
      db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (3, 1, 'oof@acme.com', 'active')").run();
      db.prepare(`
        INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, status, scheduled_at, message_id)
        VALUES (4, 1, 3, 1, 'sent', datetime('now', '-1 day'), '<msg-oof-1@testcorp.com>')
      `).run();
      db.prepare(`
        INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, status, scheduled_at)
        VALUES (5, 1, 3, 2, 'pending', datetime('now', '+2 days'))
      `).run();

      const parsedOof = {
        from: { value: [{ address: 'oof@acme.com' }] },
        subject: 'Automatic reply: Out of office',
        text: 'I will be out of office until next week.',
        inReplyTo: '<msg-oof-1@testcorp.com>',
        headers: { 'auto-submitted': 'auto-replied' }
      };

      const result = processIncomingEmail(parsedOof, 1);
      assert.equal(result.isAutoReply, true);

      // Step 5 should still be 'pending' (NOT skipped!)
      const step5 = db.prepare('SELECT status FROM lead_steps WHERE id = 5').get();
      assert.equal(step5.status, 'pending');

      // No human 'reply' event recorded
      const evt = db.prepare("SELECT * FROM email_events WHERE type = 'reply' AND lead_step_id = 4").get();
      assert.equal(evt, undefined);
    });
  });
});
