import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { getDb } from './db.js';
import { hashIp } from './crypto.js';
import { addSuppression } from './campaigns/suppression.js';

// 1x1 Transparent GIF buffer
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Escape HTML characters to prevent XSS injection
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Detect probable automated/bot opens (Apple MPP, GoogleImageProxy, or instant hits <= 5s)
 */
export function isProbableBot(userAgent, sentAt, requestTime = new Date()) {
  const ua = (userAgent || '').toLowerCase();

  // Known proxy & crawler user-agents
  if (
    ua.includes('googleimageproxy') ||
    ua.includes('applemailprivacy') ||
    ua.includes('bingpreview') ||
    ua.includes('yahoo! slurp') ||
    ua.includes('facebookexternalhit') ||
    ua.includes('spider') ||
    ua.includes('bot')
  ) {
    return true;
  }

  // Apple Mail Privacy Protection often uses generic Mac OS X User-Agent pattern with no browser sub-version
  if (ua.includes('macintosh') && !ua.includes('chrome') && !ua.includes('firefox') && !ua.includes('version/')) {
    return true;
  }

  // Request within 5 seconds of email sent time
  if (sentAt) {
    const sentTime = new Date(sentAt).getTime();
    const reqTime = requestTime.getTime();
    const diffMs = reqTime - sentTime;
    if (diffMs >= 0 && diffMs <= 5000) {
      return true;
    }
  }

  return false;
}

/**
 * Creates the Public Fastify Server.
 * Exposes ONLY:
 * 1. GET  /t/o/:token.gif (open pixel)
 * 2. GET  /t/c/:token     (click redirect)
 * 3. GET  /u/:token       (unsubscribe confirmation page)
 * 4. POST /u/:token       (one-click unsubscribe handler)
 */
export function createPublicServer(options = {}) {
  const fastify = Fastify({
    logger: options.logger ?? false,
    trustProxy: true
  });

  // Global rate limiter on tracking & unsubscribe routes: 120 req/min per IP
  fastify.register(fastifyRateLimit, {
    max: 120,
    timeWindow: '1 minute'
  });

  fastify.register(async (scope) => {
    // 1. Open tracking pixel
    scope.get('/t/o/:token.gif', async (request, reply) => {
      const { token } = request.params;
      const userAgent = request.headers['user-agent'] || '';
      const ip = request.ip || request.headers['x-forwarded-for'] || '';
      const ipHashed = hashIp(ip);

      try {
        const db = getDb();
        const step = db.prepare('SELECT id, sent_at FROM lead_steps WHERE open_token = ?').get(token);

        if (step) {
          const bot = isProbableBot(userAgent, step.sent_at);
          const meta = JSON.stringify({
            user_agent: userAgent,
            ip_hash: ipHashed,
            is_probable_bot: bot ? 1 : 0
          });

          db.prepare(`
            INSERT INTO email_events (lead_step_id, type, token, timestamp, meta_json)
            VALUES (?, 'open', ?, CURRENT_TIMESTAMP, ?)
          `).run(step.id, token, meta);
        }
      } catch (err) {
        // Do not fail pixel response on tracking record errors
      }

      reply
        .header('Content-Type', 'image/gif')
        .header('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0')
        .header('Pragma', 'no-cache')
        .header('Expires', '0')
        .send(PIXEL_GIF);
    });

    // 2. Click redirect
    scope.get('/t/c/:token', async (request, reply) => {
      const { token } = request.params;
      const userAgent = request.headers['user-agent'] || '';
      const ip = request.ip || request.headers['x-forwarded-for'] || '';
      const ipHashed = hashIp(ip);

      try {
        const db = getDb();
        const link = db.prepare('SELECT * FROM tracking_links WHERE token = ?').get(token);

        if (!link) {
          return reply.status(404).send('Link not found or expired');
        }

        const step = db.prepare('SELECT id, sent_at FROM lead_steps WHERE id = ?').get(link.lead_step_id);
        const bot = isProbableBot(userAgent, step ? step.sent_at : null);

        const meta = JSON.stringify({
          user_agent: userAgent,
          ip_hash: ipHashed,
          url: link.original_url,
          is_probable_bot: bot ? 1 : 0
        });

        db.prepare(`
          INSERT INTO email_events (lead_step_id, type, token, timestamp, meta_json)
          VALUES (?, 'click', ?, CURRENT_TIMESTAMP, ?)
        `).run(link.lead_step_id, token, meta);

        return reply.redirect(link.original_url, 302);
      } catch (err) {
        return reply.status(500).send('Internal server error');
      }
    });

    // 3. Unsubscribe confirmation page (GET - NO DATABASE CHANGE)
    scope.get('/u/:token', async (request, reply) => {
      const { token } = request.params;
      const db = getDb();

      const step = db.prepare(`
        SELECT ls.id, l.email, c.name as campaign_name
        FROM lead_steps ls
        JOIN leads l ON l.id = ls.lead_id
        JOIN campaigns c ON c.id = ls.campaign_id
        WHERE ls.open_token = ?
      `).get(token);

      if (!step) {
        reply.type('text/html').status(404).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Unsubscribe</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
          <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc;">
            <div style="background: white; padding: 32px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 420px;">
              <h2 style="color: #e53e3e; margin-top: 0;">Link Expired</h2>
              <p style="color: #4a5568;">This unsubscribe link could not be found or has expired.</p>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // NO database changes on GET - simply render confirmation form
      const escapedEmail = escapeHtml(step.email);
      const escapedCampaign = escapeHtml(step.campaign_name);
      const escapedToken = escapeHtml(token);

      reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Confirm Unsubscribe</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .card { background: #111827; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
            .icon { width: 56px; height: 56px; background: rgba(239, 68, 68, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: #ef4444; font-size: 24px; }
            h1 { font-size: 22px; color: #f8fafc; margin: 0 0 12px; }
            p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 24px; }
            .email-badge { background: #1e293b; padding: 4px 10px; border-radius: 6px; font-weight: 500; color: #38bdf8; font-family: monospace; }
            .btn-unsub { background: #ef4444; color: #ffffff; border: none; padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
            .btn-unsub:hover { background: #dc2626; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">&times;</div>
            <h1>Unsubscribe Confirmation</h1>
            <p>
              Are you sure you want to unsubscribe <span class="email-badge">${escapedEmail}</span> from 
              <strong>${escapedCampaign}</strong> and all future outreach?
            </p>
            <form method="POST" action="/u/${escapedToken}">
              <button type="submit" class="btn-unsub">Unsubscribe</button>
            </form>
          </div>
        </body>
        </html>
      `);
    });

    // 4. One-click & Form Unsubscribe handler (POST)
    scope.post('/u/:token', async (request, reply) => {
      const { token } = request.params;
      const db = getDb();

      const step = db.prepare(`
        SELECT ls.id, l.email, c.name as campaign_name
        FROM lead_steps ls
        JOIN leads l ON l.id = ls.lead_id
        JOIN campaigns c ON c.id = ls.campaign_id
        WHERE ls.open_token = ?
      `).get(token);

      if (!step) {
        if (request.headers.accept?.includes('application/json') || request.body?.['List-Unsubscribe'] === 'One-Click') {
          return reply.status(404).send({ error: 'Link expired or invalid' });
        }
        return reply.type('text/html').status(404).send('<!DOCTYPE html><html><body><h1>Link Expired</h1></body></html>');
      }

      // Add to global suppression
      addSuppression(step.email, 'unsubscribe');

      // Update lead status in leads table
      db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE email = ?").run(step.email);

      // Record only ONE 'unsubscribe' event per lead_step (ignore duplicate POSTs)
      const existing = db.prepare("SELECT id FROM email_events WHERE lead_step_id = ? AND type = 'unsubscribe'").get(step.id);
      if (!existing) {
        const isRfc8058 = request.headers['list-unsubscribe'] === 'One-Click' ||
                          request.headers['list-unsubscribe-post'] === 'List-Unsubscribe=One-Click' ||
                          request.body?.['List-Unsubscribe'] === 'One-Click';

        db.prepare(`
          INSERT INTO email_events (lead_step_id, type, token, timestamp, meta_json)
          VALUES (?, 'unsubscribe', ?, CURRENT_TIMESTAMP, ?)
        `).run(step.id, token, JSON.stringify({ rfc8058: Boolean(isRfc8058) }));
      }

      // If requested as JSON or via RFC 8058 client:
      if (request.headers.accept?.includes('application/json') || request.headers['list-unsubscribe-post']) {
        return reply.status(200).send({
          success: true,
          message: 'Unsubscribed successfully'
        });
      }

      // Otherwise render confirmation HTML page
      const escapedEmail = escapeHtml(step.email);
      const escapedCampaign = escapeHtml(step.campaign_name);

      reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Unsubscribed Successfully</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .card { background: #111827; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
            .icon { width: 56px; height: 56px; background: rgba(16, 185, 129, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: #10b981; font-size: 28px; }
            h1 { font-size: 22px; color: #f8fafc; margin: 0 0 12px; }
            p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 24px; }
            .email-badge { background: #1e293b; padding: 6px 12px; border-radius: 6px; font-weight: 500; color: #38bdf8; font-size: 14px; font-family: monospace; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">&#10003;</div>
            <h1>You have been unsubscribed</h1>
            <p>
              The address <span class="email-badge">${escapedEmail}</span> has been removed from 
              <strong>${escapedCampaign}</strong> and all future outreach.
            </p>
            <p style="font-size: 13px; color: #64748b; margin: 0;">You can safely close this window.</p>
          </div>
        </body>
        </html>
      `);
    });
  });

  return fastify;
}

// Runnable entrypoint
if (process.argv[1] && process.argv[1].endsWith('public.js')) {
  const server = createPublicServer({ logger: true });
  server.listen({ host: config.public.host, port: config.public.port }, (err, address) => {
    if (err) {
      console.error('Failed to start public server:', err);
      process.exit(1);
    }
    console.log(`MailCheck Public Server listening on ${address}`);
  });
}
