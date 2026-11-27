import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { initDb, closeDb, getDb, setSetting } from '../src/db.js';
import { createAdminServer } from '../src/admin.js';
import { createPublicServer } from '../src/public.js';
import { createMailbox } from '../src/mailboxes/accounts.js';
import { createCampaign, addSequenceStep, launchCampaign } from '../src/campaigns/sequence.js';
import { runSchedulerTick } from '../src/campaigns/engine.js';
import { processIncomingEmail } from '../src/campaigns/replies.js';
import { parseBounce, processBounce } from '../src/campaigns/bounces.js';
import { getOverviewStats, getCampaignStats } from '../src/stats/queries.js';
import { executeWarmupCycle } from '../src/warmup/runner.js';

describe('End-to-End Integration Suite (Step 9)', () => {
  let db;
  let adminServer;
  let publicServer;
  let fakeSmtpServer;
  let fakeSmtpPort;
  const receivedSmtpMessages = [];

  before(async () => {
    db = initDb(':memory:');
    adminServer = createAdminServer();
    publicServer = createPublicServer();
    await adminServer.ready();
    await publicServer.ready();

    // Start in-process fake SMTP server on random high port
    await new Promise((resolve) => {
      fakeSmtpServer = net.createServer((socket) => {
        socket.write('220 mailcheck-fake-smtp ESMTP\r\n');
        let dataBuffer = '';

        socket.on('data', (chunk) => {
          dataBuffer += chunk.toString();
          const lines = dataBuffer.split('\r\n');
          dataBuffer = lines.pop(); // keep last incomplete line

          for (const line of lines) {
            const upper = line.toUpperCase();
            if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
              socket.write('250-mailcheck-fake-smtp\r\n250 HELP\r\n');
            } else if (upper.startsWith('MAIL FROM:')) {
              socket.write('250 2.1.0 Ok\r\n');
            } else if (upper.startsWith('RCPT TO:')) {
              socket.write('250 2.1.5 Ok\r\n');
            } else if (upper === 'DATA') {
              socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            } else if (upper.startsWith('QUIT')) {
              socket.write('221 2.0.0 Bye\r\n');
              socket.end();
            }
          }

          if (chunk.toString().includes('\r\n.\r\n')) {
            receivedSmtpMessages.push(chunk.toString());
            socket.write('250 2.0.0 Ok: queued as fake12345\r\n');
          }
        });
      });

      fakeSmtpServer.listen(0, '127.0.0.1', () => {
        fakeSmtpPort = fakeSmtpServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (fakeSmtpServer) fakeSmtpServer.close();
    await adminServer.close();
    await publicServer.close();
    closeDb();
  });

  it('runs complete lifecycle: send campaign -> open -> click -> reply -> bounce and asserts stats', async () => {
    // 1. Settings setup (postal address + public url)
    setSetting('postal_address', '500 Howard St, San Francisco, CA 94105');
    setSetting('public_base_url', 'http://127.0.0.1:3001');

    // 2. Connect mailbox pointing to our in-process fake SMTP server
    const mb = await createMailbox({
      email: 'founder@startup.com',
      display_name: 'Founder',
      smtp_host: '127.0.0.1',
      smtp_port: fakeSmtpPort,
      smtp_secure: false,
      smtp_user: 'founder',
      smtp_pass: 'pass123',
      imap_host: '127.0.0.1',
      imap_port: 993,
      imap_user: 'founder',
      imap_pass: 'pass123',
      status: 'ready'
    }, { skipDns: true });

    // 3. Create leads list
    const listRes = db.prepare("INSERT INTO lists (name) VALUES ('Early Adopters')").run();
    const listId = Number(listRes.lastInsertRowid);

    // Seed 2 active leads
    db.prepare(`
      INSERT INTO leads (list_id, email, first_name, company, status)
      VALUES (?, 'lead_engaged@domain.com', 'Emma', 'FinTech Corp', 'active')
    `).run(listId);

    db.prepare(`
      INSERT INTO leads (list_id, email, first_name, company, status)
      VALUES (?, 'lead_bounce@domain.com', 'Bob', 'Ghost LLC', 'active')
    `).run(listId);

    // Pre-seed verification as deliverable
    db.prepare("INSERT INTO verification_results (email, verdict, score, reason, checks_json, transcript_json) VALUES ('lead_engaged@domain.com', 'deliverable', 100, 'OK', '[]', '[]')").run();
    db.prepare("INSERT INTO verification_results (email, verdict, score, reason, checks_json, transcript_json) VALUES ('lead_bounce@domain.com', 'deliverable', 100, 'OK', '[]', '[]')").run();

    // 4. Create campaign
    const camp = createCampaign({
      name: 'E2E Lifecycle Campaign',
      list_id: listId,
      mailbox_ids: [mb.id],
      send_policy: 'deliverable_only',
      min_gap_seconds: 0
    });

    addSequenceStep(camp.id, {
      step_number: 1,
      subject: 'Quick question for {{first_name}}',
      body_html: '<p>Hi {{first_name}}, check out our <a href="https://example.com/demo">demo</a>.</p>'
    });

    // 5. Launch campaign
    const launch = await launchCampaign(camp.id);
    assert.equal(launch.success, true);
    assert.equal(launch.scheduledCount, 2);

    // 6. Execute scheduler tick to send emails via in-process fake SMTP
    await runSchedulerTick({ force: true, ignoreSchedule: true, ignoreGaps: true });

    // Verify 2 emails sent
    const sentSteps = db.prepare("SELECT * FROM lead_steps WHERE campaign_id = ? AND status = 'sent'").all(camp.id);
    assert.equal(sentSteps.length, 2);

    const stepEngaged = sentSteps.find(s => {
      const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(s.lead_id);
      return lead.email === 'lead_engaged@domain.com';
    });
    assert.ok(stepEngaged);
    assert.ok(stepEngaged.open_token);

    // 7. Simulate Open Hit via Public Server
    const openRes = await publicServer.inject({
      method: 'GET',
      url: `/t/o/${stepEngaged.open_token}.gif`,
      headers: { 'user-agent': 'Chrome/124.0.0.0 Safari/537.36' }
    });
    assert.equal(openRes.statusCode, 200);

    // 8. Simulate Click Hit via Public Server
    // Find generated tracking link
    const linkRow = db.prepare('SELECT token FROM tracking_links WHERE lead_step_id = ?').get(stepEngaged.id);
    assert.ok(linkRow);
    const clickRes = await publicServer.inject({
      method: 'GET',
      url: `/t/c/${linkRow.token}`
    });
    assert.equal(clickRes.statusCode, 302);
    assert.equal(clickRes.headers.location, 'https://example.com/demo');

    // 9. Simulate Inbound Reply to stepEngaged
    const replyParsed = {
      from: { value: [{ address: 'lead_engaged@domain.com' }] },
      subject: 'Re: Quick question for Emma',
      text: 'Thanks, I looked at the demo and would love to chat.',
      inReplyTo: stepEngaged.message_id,
      headers: {}
    };
    const replyResult = processIncomingEmail(replyParsed, mb.id);
    assert.equal(replyResult.matched, true);
    assert.equal(replyResult.isAutoReply, false);

    // 10. Simulate Hard Bounce for lead_bounce
    const stepBounce = sentSteps.find(s => s.id !== stepEngaged.id);
    const bounceParsed = {
      from: { text: 'mailer-daemon@domain.com' },
      subject: 'Delivery Status Notification (Failure)',
      headers: { get: () => 'multipart/report' },
      text: `Status: 5.1.1\nFinal-Recipient: rfc822; lead_bounce@domain.com\nMessage-ID: ${stepBounce.message_id}`
    };
    const bounceInfo = parseBounce(bounceParsed);
    assert.equal(bounceInfo.isHard, true);
    processBounce(bounceInfo);

    // 11. Assert Global & Campaign Dashboard Stats
    const stats = getCampaignStats(camp.id);
    assert.equal(stats.totals.sent, 2);
    assert.equal(stats.totals.bounced, 1);
    assert.equal(stats.totals.delivered, 1); // 2 sent - 1 bounced = 1 delivered
    assert.equal(stats.totals.uniqueOpens, 1);
    assert.equal(stats.totals.clicked, 1);
    assert.equal(stats.totals.replied, 1);

    // 1 open / 2 contacted = 50% open rate
    assert.equal(stats.rates.openRate, 50);
    // 1 click / 2 contacted = 50% click rate
    assert.equal(stats.rates.clickRate, 50);
    // 1 reply / 2 contacted = 50% reply rate
    assert.equal(stats.rates.replyRate, 50);
    // 1 bounce / 2 contacted = 50% bounce rate
    assert.equal(stats.rates.bounceRate, 50);
  });

  it('guarantees crash mid-send does not double-send', async () => {
    // Ensure campaign is marked running
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = 1").run();

    // Seed a new lead to avoid UNIQUE(lead_id, sequence_step_id) collision
    const newLead = db.prepare(`
      INSERT INTO leads (list_id, email, first_name, status)
      VALUES (1, 'lead_crash@domain.com', 'CrashTest', 'active')
    `).run();
    const crashLeadId = Number(newLead.lastInsertRowid);

    // Pre-seed verification as deliverable
    db.prepare("INSERT INTO verification_results (email, verdict, score, reason, checks_json, transcript_json) VALUES ('lead_crash@domain.com', 'deliverable', 100, 'OK', '[]', '[]')").run();

    // Get sequence_step_id and variant_id for campaign 1
    const seqStep = db.prepare('SELECT id FROM sequence_steps WHERE campaign_id = 1 LIMIT 1').get();
    const stepVariant = db.prepare('SELECT id FROM step_variants WHERE sequence_step_id = ? LIMIT 1').get(seqStep.id);

    // Seed a pending step
    db.prepare(`
      INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at)
      VALUES (9001, 1, ?, ?, ?, 'pending', datetime('now', '-1 minute'))
    `).run(crashLeadId, seqStep.id, stepVariant.id);

    let attempts = 0;
    // Simulate crash on first try
    const failingSend = async () => {
      attempts++;
      throw new Error('Connection reset by peer mid-transmission (Simulated crash)');
    };

    await runSchedulerTick({ force: true, ignoreSchedule: true, ignoreGaps: true, mockSend: failingSend });
    assert.equal(attempts, 1);

    // Verify step was set to retrying with retry_count = 1
    const stepAfterCrash = db.prepare('SELECT status, retry_count FROM lead_steps WHERE id = 9001').get();
    assert.equal(stepAfterCrash.status, 'retrying');
    assert.equal(stepAfterCrash.retry_count, 1);

    // Now run second tick with mock send succeeding
    let successSends = 0;
    const succeedingSend = async () => {
      successSends++;
      return { messageId: '<msg-recovered-9001@startup.com>' };
    };

    // Fast-forward next_retry_at to now
    db.prepare("UPDATE lead_steps SET next_retry_at = datetime('now', '-1 minute') WHERE id = 9001").run();

    await runSchedulerTick({ force: true, ignoreSchedule: true, ignoreGaps: true, mockSend: succeedingSend });
    assert.equal(successSends, 1);

    const finalStep = db.prepare('SELECT status, message_id FROM lead_steps WHERE id = 9001').get();
    assert.equal(finalStep.status, 'sent');
    assert.equal(finalStep.message_id, '<msg-recovered-9001@startup.com>');
  });

  it('runs warm-up runner against fake environment', async () => {
    // Add second mailbox to meet pool requirement
    const mb2 = await createMailbox({
      email: 'warmup_peer@startup.com',
      display_name: 'Peer',
      smtp_host: '127.0.0.1',
      smtp_port: fakeSmtpPort,
      smtp_secure: false,
      smtp_user: 'peer',
      smtp_pass: 'pass',
      imap_host: '127.0.0.1',
      imap_user: 'peer',
      imap_pass: 'pass',
      status: 'warming'
    }, { skipDns: true });

    // Set first mailbox to warming too
    db.prepare("UPDATE mailboxes SET status = 'warming' WHERE id = 1").run();

    let warmupSent = 0;
    const mockSend = async () => {
      warmupSent++;
      return { messageId: '<warmup-fake@startup.com>' };
    };

    const mockImapProcessor = async (partner, sender, warmupId) => {
      // Simulate IMAP finding in Spam, rescuing, marking seen
      db.prepare(`
        INSERT INTO warmup_events (mailbox_id, partner_mailbox_id, direction, message_id, warmup_id, status, created_at)
        VALUES (?, ?, 'received', 'fake-uid-1', ?, 'spam_rescued', CURRENT_TIMESTAMP)
      `).run(partner.id, sender.id, warmupId);
    };

    await executeWarmupCycle({ force: true, mockSend, mockImapProcessor });
    assert.ok(warmupSent >= 1);

    const rescuedEvent = db.prepare("SELECT * FROM warmup_events WHERE status = 'spam_rescued'").get();
    assert.ok(rescuedEvent);
  });
});
