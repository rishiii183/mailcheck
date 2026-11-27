import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { createPublicServer, isProbableBot } from '../src/public.js';
import { isSuppressed } from '../src/campaigns/suppression.js';

describe('Tracking & Public Server (Step 5)', () => {
  let db;
  let server;

  before(async () => {
    db = initDb(':memory:');
    server = createPublicServer();
    await server.ready();

    // Seed test campaign, lead, lead_step, tracking link
    db.prepare("INSERT INTO lists (name) VALUES ('Test List')").run();
    db.prepare("INSERT INTO leads (id, list_id, email, status) VALUES (1, 1, 'target@example.com', 'active')").run();
    db.prepare("INSERT INTO campaigns (id, name, status) VALUES (1, 'Launch Promo', 'running')").run();
    db.prepare("INSERT INTO sequence_steps (id, campaign_id, step_number) VALUES (1, 1, 1)").run();
    db.prepare(`
      INSERT INTO lead_steps (id, campaign_id, lead_id, sequence_step_id, status, scheduled_at, sent_at, open_token)
      VALUES (1, 1, 1, 1, 'sent', datetime('now', '-1 minute'), datetime('now', '-1 minute'), 'test_open_token_128')
    `).run();

    db.prepare(`
      INSERT INTO tracking_links (id, lead_step_id, token, original_url)
      VALUES (1, 1, 'click_token_xyz', 'https://example.com/signup')
    `).run();
  });

  after(async () => {
    await server.close();
    closeDb();
  });

  describe('1. Bot Open Detection Logic', () => {
    it('flags GoogleImageProxy as probable bot open', () => {
      const isBot = isProbableBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) GoogleImageProxy', null);
      assert.equal(isBot, true);
    });

    it('flags hits within 5 seconds of send time as machine open', () => {
      const now = new Date();
      const justSent = new Date(now.getTime() - 2000); // 2s ago
      const isBot = isProbableBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', justSent.toISOString(), now);
      assert.equal(isBot, true);
    });

    it('considers normal browser open after 1 minute as human open', () => {
      const now = new Date();
      const sentOneMinuteAgo = new Date(now.getTime() - 60000);
      const isBot = isProbableBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', sentOneMinuteAgo.toISOString(), now);
      assert.equal(isBot, false);
    });
  });

  describe('2. Open Pixel Route /t/o/:token.gif', () => {
    it('serves 1x1 gif and logs open event with ip hash', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/t/o/test_open_token_128.gif',
        headers: {
          'user-agent': 'Chrome/120.0 Safari/537.36',
          'x-forwarded-for': '203.0.113.195'
        }
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'image/gif');
      assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, private, max-age=0');
      assert.ok(res.rawPayload.length >= 35); // Valid 1x1 GIF binary

      // Check DB recorded open
      const event = db.prepare("SELECT * FROM email_events WHERE type = 'open' AND lead_step_id = 1").get();
      assert.ok(event);
      const meta = JSON.parse(event.meta_json);
      assert.ok(meta.ip_hash);
      assert.equal(meta.is_probable_bot, 0);
    });
  });

  describe('3. Click Redirect Route /t/c/:token', () => {
    it('records click event and redirects with 302 to destination', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/t/c/click_token_xyz',
        headers: {
          'user-agent': 'Mozilla/5.0 Safari',
          'x-forwarded-for': '203.0.113.50'
        }
      });

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, 'https://example.com/signup');

      // Check DB recorded click
      const event = db.prepare("SELECT * FROM email_events WHERE type = 'click' AND lead_step_id = 1").get();
      assert.ok(event);
      const meta = JSON.parse(event.meta_json);
      assert.equal(meta.url, 'https://example.com/signup');
    });

    it('returns 404 for unknown click tokens', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/t/c/non_existent_token'
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('4. Unsubscribe Route /u/:token', () => {
    it('GET /u/:token serves HTML confirmation form and leaves suppression untouched', async () => {
      assert.equal(isSuppressed('target@example.com'), false);

      const res = await server.inject({
        method: 'GET',
        url: '/u/test_open_token_128'
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(res.body.includes('Unsubscribe Confirmation'));
      assert.ok(res.body.includes('target@example.com'));

      // Verify email is NOT suppressed on GET
      assert.equal(isSuppressed('target@example.com'), false);

      // Verify NO event was logged on GET
      const unsubs = db.prepare("SELECT * FROM email_events WHERE type = 'unsubscribe' AND lead_step_id = 1").all();
      assert.equal(unsubs.length, 0);
    });

    it('POST /u/:token handles RFC 8058 one-click unsubscribe and suppresses lead', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/u/test_open_token_128',
        headers: {
          'list-unsubscribe-post': 'List-Unsubscribe=One-Click'
        }
      });

      assert.equal(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.equal(json.success, true);

      // Verify email is now globally suppressed
      assert.equal(isSuppressed('target@example.com'), true);

      // Verify event was logged exactly once
      const unsubs = db.prepare("SELECT * FROM email_events WHERE type = 'unsubscribe' AND lead_step_id = 1").all();
      assert.equal(unsubs.length, 1);
    });
  });
});
