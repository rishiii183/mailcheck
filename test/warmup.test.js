import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { calculateWarmupTarget, generateRandomSchedule, getOrCreateTodayPlan } from '../src/warmup/planner.js';
import { WARMUP_TEMPLATES, getRandomTemplate } from '../src/warmup/content.js';
import { getMailboxHealth } from '../src/warmup/health.js';
import { executeWarmupCycle, sendWarmupEmail } from '../src/warmup/runner.js';
import { createMailbox } from '../src/mailboxes/accounts.js';

describe('Warm-up Module (Step 8)', () => {
  let db;

  before(() => {
    db = initDb(':memory:');
  });

  after(() => {
    closeDb();
  });

  describe('1. Ramp-Up Math & Planning (planner.js)', () => {
    it('calculates linear progression starting at 3/day and capping at 40/day', () => {
      // Day 1: 3
      assert.equal(calculateWarmupTarget(1), 3);
      // Day 2: 5 (+2)
      assert.equal(calculateWarmupTarget(2), 5);
      // Day 3: 7 (+2)
      assert.equal(calculateWarmupTarget(3), 7);
      // Day 10: 3 + 9*2 = 21
      assert.equal(calculateWarmupTarget(10), 21);
      // Day 20: 3 + 19*2 = 41 -> capped at 40
      assert.equal(calculateWarmupTarget(20), 40);
      // Day 30: capped at 40
      assert.equal(calculateWarmupTarget(30), 40);

      // Maintenance mode settling at 15
      assert.equal(calculateWarmupTarget(30, 40, true), 15);
    });

    it('generates random timestamps without fixed patterns within delivery window', () => {
      const schedule = generateRandomSchedule(5, '2026-03-01', '09:00', '18:00');
      assert.equal(schedule.length, 5);

      for (const ts of schedule) {
        assert.ok(ts.startsWith('2026-03-01'));
        const hour = new Date(ts).getUTCHours();
        assert.ok(hour >= 9 && hour <= 18);
      }
    });
  });

  describe('2. Content Repository (content.js)', () => {
    it('contains at least 200 distinct business templates with spintax', () => {
      assert.ok(WARMUP_TEMPLATES.length >= 200, `Expected at least 200 templates, got ${WARMUP_TEMPLATES.length}`);

      const sample = getRandomTemplate();
      assert.ok(sample.subject);
      assert.ok(sample.body);
      // Ensure spintax is rendered (no unrendered {a|b} left)
      assert.doesNotMatch(sample.subject, /\{[^{}]+\}/);
      assert.doesNotMatch(sample.body, /\{[^{}]+\}/);
    });
  });

  describe('3. Pool Execution & Runner (runner.js)', () => {
    it('requires at least 2 connected mailboxes in warmup pool', async () => {
      // With 0 mailboxes
      const res0 = await executeWarmupCycle({ force: true });
      assert.equal(res0.skipped, true);

      // With 1 mailbox
      await createMailbox({
        email: 'solo@domain.com',
        display_name: 'Solo',
        smtp_host: 'smtp.domain.com',
        smtp_user: 'solo',
        smtp_pass: 'pass',
        status: 'warming'
      }, { skipDns: true });

      const res1 = await executeWarmupCycle({ force: true });
      assert.equal(res1.skipped, true);
      assert.ok(res1.reason.includes('at least 2'));
    });

    it('attaches X-MailCheck-Warmup header and records sent event', async () => {
      // Add second mailbox to meet pool requirement
      const partner = await createMailbox({
        email: 'partner@domain.com',
        display_name: 'Partner',
        smtp_host: 'smtp.domain.com',
        smtp_user: 'partner',
        smtp_pass: 'pass',
        status: 'warming'
      }, { skipDns: true });

      const sender = await createMailbox({
        email: 'sender@domain.com',
        display_name: 'Sender',
        smtp_host: 'smtp.domain.com',
        smtp_user: 'sender',
        smtp_pass: 'pass',
        status: 'warming'
      }, { skipDns: true });

      let capturedOptions = null;
      const mockSend = async (mailOptions) => {
        capturedOptions = mailOptions;
        return { messageId: '<warmup-123@mailcheck.local>' };
      };

      const warmupRes = await sendWarmupEmail(
        sender,
        partner,
        { subject: 'Quarterly Sync', body: 'Hi Partner, sharing update.' },
        'warmup_tok_99',
        { mockSend }
      );

      assert.ok(capturedOptions);
      assert.equal(capturedOptions.headers['X-MailCheck-Warmup'], 'warmup_tok_99');
      assert.equal(capturedOptions.to, partner.email);

      // Verify DB event
      const event = db.prepare('SELECT * FROM warmup_events WHERE warmup_id = ?').get('warmup_tok_99');
      assert.ok(event);
      assert.equal(event.direction, 'sent');
      assert.equal(event.status, 'sent');
    });
  });

  describe('4. Health & Reputation Calculations (health.js)', () => {
    it('computes rolling 7-day placement rate and reputation score', () => {
      const mbId = 999;
      db.prepare(`
        INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted, status, warmup_start_date)
        VALUES (999, 'health@domain.com', 'Health', 'smtp.host', 'u', 'p', 'imap.host', 'u', 'p', 'warming', datetime('now', '-10 days'))
      `).run();

      // Seed 8 inbox events and 2 spam rescued events
      for (let i = 0; i < 8; i++) {
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
          VALUES (1, 999, 'received', 'msg-${i}', 'tok-${i}', 'inbox', datetime('now', '-2 days'))
        `).run();
      }
      for (let i = 0; i < 2; i++) {
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
          VALUES (1, 999, 'received', 'msg-spam-${i}', 'tok-s-${i}', 'spam_rescued', datetime('now', '-1 day'))
        `).run();
      }

      const health = getMailboxHealth(mbId);
      // 8 inbox out of 10 = 80% placement rate
      assert.equal(health.placementRate, 80);
      assert.equal(health.rescuedFromSpam, 2);
      assert.ok(health.reputationScore >= 70);
    });

    it('auto-pauses mailbox if placement rate drops below 70%', () => {
      const mbId = 998;
      db.prepare(`
        INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted, status, warmup_start_date)
        VALUES (998, 'lowplacement@domain.com', 'Low', 'smtp.host', 'u', 'p', 'imap.host', 'u', 'p', 'warming', datetime('now', '-5 days'))
      `).run();

      // Seed 2 inbox events and 8 spam events (20% placement rate)
      for (let i = 0; i < 2; i++) {
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
          VALUES (1, 998, 'received', 'msg-ok-${i}', 'tok-ok-${i}', 'inbox', datetime('now', '-2 days'))
        `).run();
      }
      for (let i = 0; i < 8; i++) {
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
          VALUES (1, 998, 'received', 'msg-bad-${i}', 'tok-bad-${i}', 'spam_rescued', datetime('now', '-1 day'))
        `).run();
      }

      const health = getMailboxHealth(mbId);
      assert.equal(health.autoPaused, true);
      assert.ok(health.reason.includes('below 70%'));

      // Verify mailbox status in DB was updated to 'paused'
      const mb = db.prepare('SELECT status, error_reason FROM mailboxes WHERE id = 998').get();
      assert.equal(mb.status, 'paused');
      assert.ok(mb.error_reason.includes('Auto-paused'));
    });
  });
});
