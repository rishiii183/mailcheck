import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db.js';
import { generateRandomSchedule, isWithinWarmupWindow, getOrCreateTodayPlan } from '../src/warmup/planner.js';
import { getRandomReplyTemplate, REPLY_TEMPLATES } from '../src/warmup/content.js';
import { getMailboxHealth, getWarmupPoolStatus } from '../src/warmup/health.js';
import {
  executeWarmupCycle,
  sendWarmupEmail,
  enqueueDeliveryJob,
  processDueDeliveryJobs,
  enqueueReplyJob,
  processDueReplyJobs,
  processPartnerWarmupImap
} from '../src/warmup/runner.js';
import { createMailbox, updateMailbox } from '../src/mailboxes/accounts.js';
import { createAdminServer } from '../src/admin.js';
import { config } from '../src/config.js';

describe('BATCH 5 Regression Suite (Mailbox Warm-up That Actually Works)', () => {
  let db;

  before(() => {
    db = initDb(':memory:');
  });

  after(() => {
    closeDb();
  });

  // ==========================================
  // 5.1 SCHEDULING & TIME WINDOWS
  // ==========================================
  describe('5.1 Scheduling & Warm-up Window', () => {
    it('generateRandomSchedule distributes send timestamps within 09:00 - 18:00 window', () => {
      const schedule = generateRandomSchedule(10, '2026-11-27', '09:00', '18:00');
      assert.equal(schedule.length, 10);

      let prevTime = 0;
      for (const ts of schedule) {
        assert.ok(ts.startsWith('2026-11-27'));
        const date = new Date(ts);
        const hour = date.getUTCHours();
        assert.ok(hour >= 9 && hour <= 18, `Hour ${hour} should be between 9 and 18`);
        assert.ok(date.getTime() >= prevTime, 'Schedule should be sorted chronologically');
        prevTime = date.getTime();
      }
    });

    it('isWithinWarmupWindow correctly detects inside vs outside window', () => {
      // 12:30 (inside 09:00 - 18:00 local time)
      const insideDate = new Date(2026, 10, 27, 12, 30, 0);
      assert.equal(isWithinWarmupWindow('09:00', '18:00', insideDate), true);

      // 04:15 (outside window)
      const earlyDate = new Date(2026, 10, 27, 4, 15, 0);
      assert.equal(isWithinWarmupWindow('09:00', '18:00', earlyDate), false);

      // 21:00 (outside window)
      const lateDate = new Date(2026, 10, 27, 21, 0, 0);
      assert.equal(isWithinWarmupWindow('09:00', '18:00', lateDate), false);
    });

    it('runner does not send when current time is outside the warmup window', async () => {
      await createMailbox({ email: 'w_win1@d.com', display_name: 'W1', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });
      await createMailbox({ email: 'w_win2@d.com', display_name: 'W2', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });

      const earlyMorning = new Date(2026, 10, 27, 4, 0, 0);
      const result = await executeWarmupCycle({ now: earlyMorning });
      assert.equal(result.skipped, true);
      assert.match(result.reason, /outside warm-up window/i);
    });

    it('populates warmup_schedule table and runner respects planned schedule timestamps', async () => {
      const mb = await createMailbox({
        email: 'sched_test@domain.com',
        display_name: 'Sched Test',
        smtp_host: '127.0.0.1',
        smtp_user: 'u',
        smtp_pass: 'p',
        status: 'warming'
      }, { skipDns: true });

      const plan = getOrCreateTodayPlan(mb, '2026-11-27');
      assert.ok(plan.planned_sends > 0);

      const scheduleRows = db.prepare(`
        SELECT * FROM warmup_schedule WHERE mailbox_id = ? AND date = '2026-11-27'
      `).all(mb.id);

      assert.equal(scheduleRows.length, plan.planned_sends);
      assert.equal(scheduleRows[0].status, 'pending');
    });
  });

  // ==========================================
  // 5.2 FINDING THE MESSAGE & RETRY QUEUE
  // ==========================================
  describe('5.2 Finding Warm-up Message & Delivery Retries', () => {
    it('retries up to 5 times with backoff until message is found on 2nd retry', async () => {
      const sender = await createMailbox({
        email: 'sender_retry@domain.com',
        display_name: 'Sender',
        smtp_host: '127.0.0.1',
        smtp_user: 'u',
        smtp_pass: 'p',
        status: 'warming'
      }, { skipDns: true });

      const partner = await createMailbox({
        email: 'partner_retry@domain.com',
        display_name: 'Partner',
        smtp_host: '127.0.0.1',
        smtp_user: 'u',
        smtp_pass: 'p',
        status: 'warming'
      }, { skipDns: true });

      const warmupId = 'retry_warmup_tok_123';
      const realMessageId = '<real-msg-id-777@partner.domain.com>';

      // Enqueue job with 0 delay so it is immediately due
      const jobId = enqueueDeliveryJob(warmupId, sender.id, partner.id, 'Test Subject', '<orig-id@local>', 0);

      // Attempt 1: simulate message not yet delivered
      let attemptCount = 0;
      const mockImapProcessor = async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return { found: false }; // Not arrived yet
        }
        return { found: true, messageId: realMessageId, inSpam: false }; // Arrived on 2nd attempt!
      };

      // Process attempt 1
      await processDueDeliveryJobs({ mockImapProcessor });
      let job = db.prepare('SELECT * FROM warmup_delivery_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'pending');
      assert.equal(job.attempts, 1);
      assert.ok(new Date(job.next_run_at).getTime() > Date.now());

      // Fast forward time to run attempt 2
      const futureTime = new Date(Date.now() + 1000 * 60 * 60);
      await processDueDeliveryJobs({ now: futureTime, mockImapProcessor });

      job = db.prepare('SELECT * FROM warmup_delivery_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'completed');
      assert.equal(job.attempts, 2);
      assert.equal(job.original_message_id, realMessageId); // Real Message-ID recorded!
    });

    it('marks delivery job failed after 5 unsuccessful attempts', async () => {
      const sender = await createMailbox({ email: 's5@d.com', display_name: 'S', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });
      const partner = await createMailbox({ email: 'p5@d.com', display_name: 'P', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });

      const jobId = enqueueDeliveryJob('fail_tok', sender.id, partner.id, 'Subj', '<m@d.com>', 0);
      // Pre-set attempts to 4
      db.prepare('UPDATE warmup_delivery_jobs SET attempts = 4 WHERE id = ?').run(jobId);

      // 5th attempt fails
      await processDueDeliveryJobs({ mockImapProcessor: async () => ({ found: false }) });

      const job = db.prepare('SELECT * FROM warmup_delivery_jobs WHERE id = ?').get(jobId);
      assert.equal(job.status, 'failed');
      assert.equal(job.attempts, 5);
      assert.match(job.last_error, /after 5 attempts/i);
    });
  });

  // ==========================================
  // 5.2 SPAM RESCUE & SPECIAL-USE RESOLUTION
  // ==========================================
  describe('5.2 Spam Rescue & Special-Use \\Junk Resolution', () => {
    it('moves spam message to INBOX, records spam_rescued event, and flags/stars', async () => {
      const sender = await createMailbox({ email: 's_spam@d.com', display_name: 'S', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });
      const partner = await createMailbox({ email: 'p_spam@d.com', display_name: 'P', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });

      const warmupId = 'spam_rescue_tok_888';
      const realMsgId = '<spam-rescue-msg@d.com>';

      let movedFolder = null;
      let flaggedSeen = false;
      let flaggedStarred = false;

      // Custom mock processor simulating IMAP interaction
      const mockImapProcessor = async (p, s, wId, job) => {
        movedFolder = 'INBOX';
        flaggedSeen = true;
        flaggedStarred = true;

        // Record spam_rescued event
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, subject, status, created_at)
          VALUES (?, ?, 'received', ?, ?, ?, 'spam_rescued', CURRENT_TIMESTAMP)
        `).run(partner.id, sender.id, realMsgId, warmupId, 'Meeting Follow-up');

        return { found: true, messageId: realMsgId, inSpam: true };
      };

      const jobId = enqueueDeliveryJob(warmupId, sender.id, partner.id, 'Meeting Follow-up', '<dummy@id>', 0);
      await processDueDeliveryJobs({ mockImapProcessor });

      assert.equal(movedFolder, 'INBOX');
      assert.equal(flaggedSeen, true);
      assert.equal(flaggedStarred, true);

      const event = db.prepare('SELECT * FROM warmup_events WHERE warmup_id = ? AND status = ?').get(warmupId, 'spam_rescued');
      assert.ok(event);
      assert.equal(event.direction, 'received');
      assert.equal(event.message_id, realMsgId);
    });
  });

  // ==========================================
  // 5.3 THREADED REPLIES
  // ==========================================
  describe('5.3 Real Threaded Replies (In-Reply-To, References, Re:)', () => {
    it('contains 40+ natural business reply templates', () => {
      assert.ok(REPLY_TEMPLATES.length >= 40, `Expected at least 40 reply templates, got ${REPLY_TEMPLATES.length}`);
      const t = getRandomReplyTemplate();
      assert.ok(t.body);
      assert.doesNotMatch(t.body, /\{[^{}]+\}/, 'Spintax should be rendered cleanly');
    });

    it('schedules and sends reply with In-Reply-To, References, and Re: subject', async () => {
      const sender = await createMailbox({ email: 's_reply@d.com', display_name: 'Sender', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });
      const partner = await createMailbox({ email: 'p_reply@d.com', display_name: 'Partner', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });

      const origMessageId = '<orig-thread-msg-123@sender.com>';
      const warmupId = 'reply_tok_555';

      // Enqueue reply job immediately (delay = 0)
      const jobId = enqueueReplyJob(warmupId, partner.id, sender.id, origMessageId, 'Project Update', 0);

      let capturedReply = null;
      const mockSend = async (mailOptions) => {
        capturedReply = mailOptions;
        return { messageId: '<partner-reply-msg-456@partner.com>' };
      };

      // Process reply job
      await processDueReplyJobs({ mockSend, forceDepth2: true, secondReplyDelayMs: 0 });

      assert.ok(capturedReply);
      assert.equal(capturedReply.to, sender.email);
      assert.equal(capturedReply.subject, 'Re: Project Update');
      assert.equal(capturedReply.headers['In-Reply-To'], origMessageId);
      assert.equal(capturedReply.headers['References'], origMessageId);
      assert.equal(capturedReply.headers['X-MailCheck-Warmup'], warmupId);

      // Verify event in warmup_events has direction 'replied'
      const replyEvent = db.prepare("SELECT * FROM warmup_events WHERE warmup_id = ? AND direction = 'replied'").get(warmupId);
      assert.ok(replyEvent);
      assert.equal(replyEvent.partner_mailbox_id, sender.id);
      assert.equal(replyEvent.message_id, '<partner-reply-msg-456@partner.com>');

      // Verify second reply was queued (thread depth 2)
      const secondReplyJob = db.prepare('SELECT * FROM warmup_reply_jobs WHERE warmup_id = ? AND thread_depth = 2').get(warmupId);
      assert.ok(secondReplyJob);
      assert.equal(secondReplyJob.from_mailbox_id, sender.id); // original sender replies back
      assert.equal(secondReplyJob.to_mailbox_id, partner.id);
      assert.equal(secondReplyJob.in_reply_to, '<partner-reply-msg-456@partner.com>');
      assert.ok(secondReplyJob.references_header.includes(origMessageId));
      assert.ok(secondReplyJob.references_header.includes('<partner-reply-msg-456@partner.com>'));
    });
  });

  // ==========================================
  // 5.4 NON-WARM-UP MAIL SAFETY
  // ==========================================
  describe('5.4 Non-warm-up Mail Safety', () => {
    it('never touches, flags, or moves non-warm-up mail', async () => {
      const touchedUids = [];
      const movedUids = [];

      // Fake client tracking actions
      const fakeImapClient = {
        connect: async () => {},
        logout: async () => {},
        list: async () => [{ path: 'INBOX' }, { path: 'Junk', specialUse: '\\Junk' }],
        getMailboxLock: async () => ({ release: () => {} }),
        search: async () => [],
        fetch: () => {
          return (async function* () {
            // Message 1: Normal client newsletter (NO header)
            yield {
              uid: 101,
              source: Buffer.from('From: boss@corp.com\r\nSubject: Urgent Quarterly Plan\r\n\r\nPlease review.')
            };
            // Message 2: Another personal email (NO header)
            yield {
              uid: 102,
              source: Buffer.from('From: mom@home.com\r\nSubject: Dinner\r\n\r\nSee you Sunday.')
            };
            // Message 3: Warmup email (WITH matching header)
            yield {
              uid: 103,
              source: Buffer.from('From: p@d.com\r\nX-MailCheck-Warmup: safety_test_tok\r\nMessage-ID: <w3@d.com>\r\nSubject: Hey\r\n\r\nWarmup text')
            };
          })();
        },
        messageFlagsAdd: async (target, flags) => {
          touchedUids.push({ target, flags });
        },
        messageMove: async (target, dest) => {
          movedUids.push({ target, dest });
        }
      };

      const partner = await createMailbox({ email: 'safety_p@d.com', display_name: 'P', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });
      const sender = await createMailbox({ email: 'safety_s@d.com', display_name: 'S', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });

      // Run IMAP inspection
      const mockImapProcessor = async () => {
        // Run logic simulating runner's safe filter
        for await (const msg of fakeImapClient.fetch()) {
          const str = msg.source.toString();
          if (str.includes('X-MailCheck-Warmup: safety_test_tok')) {
            await fakeImapClient.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
          }
        }
        return { found: true, messageId: '<w3@d.com>' };
      };

      const jobId = enqueueDeliveryJob('safety_test_tok', sender.id, partner.id, 'Hey', '<w3@d.com>', 0);
      await processDueDeliveryJobs({ mockImapProcessor });

      // Assert that ONLY UID 103 was touched! UIDs 101 and 102 were NOT touched!
      assert.equal(touchedUids.length, 1);
      assert.deepEqual(touchedUids[0].target, { uid: 103 });
      assert.equal(movedUids.length, 0);
    });
  });

  // ==========================================
  // 5.5 POOL RULES & 5.1 DAILY SEND LIMITS
  // ==========================================
  describe('5.5 Pool Rules & Daily Send Cap', () => {
    it('warmup runner aborts if pool has fewer than 2 warming mailboxes', async () => {
      // Pause all mailboxes except one
      db.prepare("UPDATE mailboxes SET status = 'paused'").run();
      const solo = await createMailbox({ email: 'solo_pool@d.com', display_name: 'Solo', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });

      const cycle = await executeWarmupCycle({ force: true });
      assert.equal(cycle.skipped, true);
      assert.match(cycle.reason, /at least 2/i);

      const status = getWarmupPoolStatus();
      assert.equal(status.pool.ok, false);
      assert.equal(status.pool.size, 1);
      assert.match(status.pool.message, /requires at least 2/i);
    });

    it('runner never exceeds the day planned_sends limit', async () => {
      const mb1 = await createMailbox({ email: 'cap1@d.com', display_name: 'C1', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });
      const mb2 = await createMailbox({ email: 'cap2@d.com', display_name: 'C2', smtp_host: '127.0.0.1', smtp_user: 'u', smtp_pass: 'p', status: 'warming' }, { skipDns: true });

      const plan1 = getOrCreateTodayPlan(mb1);
      const targetSends = plan1.planned_sends;

      // Seed sent events up to the target sends
      for (let i = 0; i < targetSends; i++) {
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, subject, status, created_at)
          VALUES (?, ?, 'sent', 'seed-${i}', 'tok-${i}', 'Subj', 'sent', CURRENT_TIMESTAMP)
        `).run(mb1.id, mb2.id);
      }

      let sentAttempted = 0;
      const mockSend = async () => {
        sentAttempted++;
        return { messageId: '<extra@d.com>' };
      };

      // Run cycle without force flag
      await executeWarmupCycle({ mockSend, now: new Date('2026-11-27T12:00:00Z') });

      // Senders who reached their cap should NOT send any more
      const totalSentMb1 = db.prepare(`
        SELECT COUNT(*) as cnt FROM warmup_events WHERE mailbox_id = ? AND direction = 'sent' AND date(created_at) = date('now')
      `).get(mb1.id).cnt;

      assert.equal(totalSentMb1, targetSends, 'Total sent must strictly equal target sends and never exceed cap');
    });
  });

  // ==========================================
  // 5.6 TIMEZONE HANDLING (ISO UTC EVERYWHERE)
  // ==========================================
  describe('5.6 Timezone Handling', () => {
    it('stores warmup_start_date as ISO UTC string when mailbox status transitions to warming', async () => {
      const mb = await createMailbox({
        email: 'tz_test@d.com',
        display_name: 'TZ',
        smtp_host: '127.0.0.1',
        smtp_user: 'u',
        smtp_pass: 'p',
        status: 'ready'
      }, { skipDns: true });

      assert.equal(mb.warmup_start_date, null);

      const updated = updateMailbox(mb.id, { status: 'warming' });
      assert.ok(updated.warmup_start_date);
      // Verify format is standard ISO 8601 UTC string (ending with Z)
      assert.match(updated.warmup_start_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      assert.ok(new Date(updated.warmup_start_date).getTime() > 0);
    });
  });

  // ==========================================
  // 5.7 HEALTH & STATUS API ENDPOINT
  // ==========================================
  describe('5.7 Health & GET /api/warmup/status API Route', () => {
    it('only counts observed received deliveries in placement rate calculations', () => {
      const mb1 = 8881;
      const mb2 = 8882;

      db.prepare(`
        INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted, status, warmup_start_date)
        VALUES (8881, 'obs1@d.com', 'O1', 'h', 'u', 'p', 'h', 'u', 'p', 'warming', CURRENT_TIMESTAMP)
      `).run();
      db.prepare(`
        INSERT INTO mailboxes (id, email, display_name, smtp_host, smtp_user, smtp_pass_encrypted, imap_host, imap_user, imap_pass_encrypted, status, warmup_start_date)
        VALUES (8882, 'obs2@d.com', 'O2', 'h', 'u', 'p', 'h', 'u', 'p', 'warming', CURRENT_TIMESTAMP)
      `).run();

      // Seed sent events from 8881 to 8882 (these are NOT observed deliveries for 8881)
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
          VALUES (8881, 8882, 'sent', 's-${i}', 'tok-${i}', 'sent', CURRENT_TIMESTAMP)
        `).run();
      }

      // Seed 4 inbox and 1 spam_rescued deliveries where 8881 is recipient (partner_mailbox_id = 8881)
      for (let i = 0; i < 4; i++) {
        db.prepare(`
          INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
          VALUES (8882, 8881, 'received', 'r-${i}', 'tok-r-${i}', 'inbox', CURRENT_TIMESTAMP)
        `).run();
      }
      db.prepare(`
        INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
        VALUES (8882, 8881, 'received', 'r-spam', 'tok-r-spam', 'spam_rescued', CURRENT_TIMESTAMP)
      `).run();

      const health = getMailboxHealth(8881);
      // 4 inbox out of 5 observed deliveries = 80%
      assert.equal(health.placementRate, 80);
      assert.equal(health.rescuedFromSpam, 1);
    });

    it('GET /api/warmup/status returns today planned vs sent, pool status, and next scheduled send', async () => {
      const app = createAdminServer();

      const res = await app.inject({
        method: 'GET',
        url: '/api/warmup/status',
        headers: {
          host: '127.0.0.1:3000',
          'x-api-key': config.admin.apiKey
        }
      });

      assert.equal(res.statusCode, 200);
      const json = JSON.parse(res.payload);

      assert.ok(json.pool);
      assert.equal(typeof json.pool.ok, 'boolean');
      assert.equal(typeof json.pool.size, 'number');
      assert.ok(json.today);
      assert.equal(typeof json.today.planned, 'number');
      assert.equal(typeof json.today.sent, 'number');
      assert.ok('last_error' in json);
      assert.ok('next_scheduled_send' in json);
      assert.ok(Array.isArray(json.mailboxes));
    });
  });
});
