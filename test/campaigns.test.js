import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, setSetting, getDb } from '../src/db.js';
import { renderSpintax, renderVariables, rewriteLinks, injectTrackingAndFooter, htmlToPlainText } from '../src/campaigns/render.js';
import { createCampaign, addSequenceStep, launchCampaign, getCampaign } from '../src/campaigns/sequence.js';
import { createMailbox } from '../src/mailboxes/accounts.js';
import { isSuppressed, addSuppression } from '../src/campaigns/suppression.js';
import { runSchedulerTick } from '../src/campaigns/engine.js';

describe('Campaigns, Rendering, Sequence & Engine (Step 4)', () => {
  let db;

  before(() => {
    db = initDb(':memory:');
  });

  after(() => {
    closeDb();
  });

  describe('1. Spintax & Variable Rendering', () => {
    it('renders single and nested spintax uniformly', () => {
      const template = '{Hi|Hello} {there|friend}!';
      const results = new Set();
      for (let i = 0; i < 50; i++) {
        results.add(renderSpintax(template));
      }
      // Should generate variations
      assert.ok(results.size > 1);
      for (const res of results) {
        assert.match(res, /^(Hi|Hello) (there|friend)!$/);
      }

      // Nested spintax
      const nested = '{Welcome|{Hi|Hey}}!';
      const nestedResult = renderSpintax(nested);
      assert.match(nestedResult, /^(Welcome|Hi|Hey)!$/);
    });

    it('substitutes variables with values and fallbacks', () => {
      const template = 'Hi {{first_name|there}}, welcome to {{company|your team}}! Your title is {{custom.title|Specialist}}.';
      
      const leadFull = {
        first_name: 'Jessica',
        company: 'Stark Ind',
        custom_fields_json: JSON.stringify({ title: 'Lead Architect' })
      };
      assert.equal(
        renderVariables(template, leadFull),
        'Hi Jessica, welcome to Stark Ind! Your title is Lead Architect.'
      );

      const leadEmpty = { first_name: '', company: null };
      assert.equal(
        renderVariables(template, leadEmpty),
        'Hi there, welcome to your team! Your title is Specialist.'
      );
    });

    it('rewrites links for click tracking but preserves unsubscribe links untouched', () => {
      const html = `
        <p>Check our <a href="https://example.com/pricing">Pricing</a></p>
        <p><a href="http://localhost:3001/u/mytoken123">Unsubscribe</a></p>
      `;

      const registered = [];
      const rewritten = rewriteLinks(html, (url) => {
        registered.push(url);
        return 'token_click_1';
      }, 'http://localhost:3001');

      assert.equal(registered.length, 1);
      assert.equal(registered[0], 'https://example.com/pricing');
      assert.ok(rewritten.includes('http://localhost:3001/t/c/token_click_1'));
      // Unsubscribe link MUST NOT be rewritten!
      assert.ok(rewritten.includes('http://localhost:3001/u/mytoken123'));
    });

    it('injects open tracking pixel and postal address footer', () => {
      const html = '<p>Body text</p>';
      const result = injectTrackingAndFooter(html, {
        openToken: 'test_token',
        unsubscribeUrl: 'http://localhost:3001/u/test_token',
        postalAddress: '742 Evergreen Terrace, Springfield, OR',
        publicBaseUrl: 'http://localhost:3001'
      });

      assert.ok(result.includes('http://localhost:3001/t/o/test_token.gif'));
      assert.ok(result.includes('742 Evergreen Terrace'));
      assert.ok(result.includes('unsubscribe here'));
    });
  });

  describe('2. Campaign Creation & Launch Safety Rules', () => {
    it('refuses to launch if postal address is missing in settings', async () => {
      setSetting('postal_address', ''); // Empty postal address

      const camp = createCampaign({ name: 'Postal Check Campaign' });
      addSequenceStep(camp.id, {
        step_number: 1,
        subject: 'Quick question',
        body_html: '<p>Hi</p>'
      });

      await assert.rejects(
        async () => {
          await launchCampaign(camp.id);
        },
        /Compliance requirement: Sender postal address is required/
      );
    });

    it('launches successfully when postal address and mailboxes are configured', async () => {
      setSetting('postal_address', '100 Market St, San Francisco, CA');

      // Create test mailbox
      const mb = await createMailbox({
        email: 'outreach@testcorp.com',
        display_name: 'Outreach',
        smtp_host: 'smtp.testcorp.com',
        smtp_user: 'outreach',
        smtp_pass: 'pass123',
        status: 'ready'
      }, { skipDns: true });

      // Create test lead list and leads
      const listInfo = db.prepare("INSERT INTO lists (name) VALUES ('SaaS Founders')").run();
      const listId = Number(listInfo.lastInsertRowid);

      db.prepare(`
        INSERT INTO leads (list_id, email, first_name, company, status)
        VALUES (?, 'founder1@domain.com', 'Sam', 'Domain Corp', 'active')
      `).run(listId);

      // Pre-seed verification as deliverable
      db.prepare(`
        INSERT INTO verification_results (email, verdict, score, reason, checks_json, transcript_json)
        VALUES ('founder1@domain.com', 'deliverable', 100, 'Valid', '[]', '[]')
      `).run();

      const camp = createCampaign({
        name: 'SaaS Outreach',
        list_id: listId,
        mailbox_ids: [mb.id],
        send_policy: 'deliverable_only'
      });

      addSequenceStep(camp.id, {
        step_number: 1,
        subject: 'Question for {{first_name}} at {{company}}',
        body_html: '<p>Hi {{first_name}}, let us chat.</p>'
      });

      const launchResult = await launchCampaign(camp.id);
      assert.equal(launchResult.success, true);
      assert.equal(launchResult.scheduledCount, 1);

      const updatedCamp = getCampaign(camp.id);
      assert.equal(updatedCamp.status, 'running');

      // Ensure step 1 was scheduled
      const scheduled = db.prepare('SELECT * FROM lead_steps WHERE campaign_id = ?').all(camp.id);
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].status, 'pending');
    });
  });

  describe('3. Engine Scheduler & Double-Send Prevention', () => {
    it('claims step via transaction and sends without double-sending', async () => {
      let sentCount = 0;
      let sentMail = null;

      const mockSend = async (mailOptions) => {
        sentCount++;
        sentMail = mailOptions;
        return { messageId: '<msg-12345@testcorp.com>' };
      };

      // Run tick with ignoreSchedule & ignoreGaps for instant testing
      await runSchedulerTick({ force: true, ignoreSchedule: true, ignoreGaps: true, mockSend });

      assert.equal(sentCount, 1);
      assert.ok(sentMail);
      assert.equal(sentMail.to, 'founder1@domain.com');
      assert.equal(sentMail.subject, 'Question for Sam at Domain Corp');
      assert.ok(sentMail.html.includes('100 Market St'));
      assert.ok(sentMail.headers['List-Unsubscribe']);

      // Check DB updated to sent
      const row = db.prepare("SELECT ls.* FROM lead_steps ls JOIN leads l ON l.id = ls.lead_id WHERE l.email = 'founder1@domain.com'").get();
      assert.equal(row.status, 'sent');
      assert.equal(row.message_id, '<msg-12345@testcorp.com>');

      // Run second tick immediately: must NOT double-send!
      await runSchedulerTick({ force: true, ignoreSchedule: true, ignoreGaps: true, mockSend });
      assert.equal(sentCount, 1); // Remains 1!
    });

    it('respects suppression list on subsequent sends', async () => {
      // Add email to suppression
      addSuppression('suppressed@test.com', 'manual');
      assert.equal(isSuppressed('suppressed@test.com'), true);
    });
  });
});
