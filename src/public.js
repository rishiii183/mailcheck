import Fastify from 'fastify';
import { config } from './config.js';
import { getDb } from './db.js';
import { hashIp } from './crypto.js';
import { addSuppression } from './campaigns/suppression.js';

// 1x1 Transparent GIF buffer
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

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

  // 1. Open tracking pixel
  fastify.get('/t/o/:token.gif', async (request, reply) => {
    const { token } = request.params;
    const userAgent = request.headers['user-agent'] || '';
    const ip = request.ip || request.headers['x-forwarded-for'] || '';
    const ipHashed = hashIp(ip);

    try {
      const db = getDb();
      // Locate lead_step by open_token
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
  fastify.get('/t/c/:token', async (request, reply) => {
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

      // Check lead step
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

      // Redirect recipient to destination URL
      return reply.redirect(link.original_url, 302);
    } catch (err) {
      return reply.status(500).send('Internal server error');
    }
  });

  // 3. Unsubscribe page (GET)
  fastify.get('/u/:token', async (request, reply) => {
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
      reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
        <head><title>Unsubscribe</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f7fafc;">
          <div style="background: white; padding: 32px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 420px;">
            <h2 style="color: #e53e3e; margin-top: 0;">Link Expired</h2>
            <p style="color: #4a5568;">This unsubscribe link could not be found or has expired.</p>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Auto-unsubscribe on visit or display one-click confirm form
    addSuppression(step.email, 'unsubscribe');
    db.prepare(`
      INSERT INTO email_events (lead_step_id, type, token, timestamp, meta_json)
      VALUES (?, 'unsubscribe', ?, CURRENT_TIMESTAMP, '{}')
    `).run(step.id, token);

    reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Unsubscribed Successfully</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05); }
          .icon { width: 56px; height: 56px; background: #ecfdf5; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: #059669; font-size: 28px; }
          h1 { font-size: 22px; color: #0f172a; margin: 0 0 12px; }
          p { color: #64748b; font-size: 15px; line-height: 1.6; margin: 0 0 24px; }
          .email-badge { background: #f1f5f9; padding: 6px 12px; border-radius: 6px; font-weight: 500; color: #334155; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">&#10003;</div>
          <h1>You have been unsubscribed</h1>
          <p>
            The address <span class="email-badge">${step.email}</span> has been removed from 
            <strong>${step.campaign_name}</strong> and all future outreach.
          </p>
          <p style="font-size: 13px; color: #94a3b8; margin: 0;">You can close this window at any time.</p>
        </div>
      </body>
      </html>
    `);
  });

  // 4. One-click unsubscribe handler (POST RFC 8058)
  fastify.post('/u/:token', async (request, reply) => {
    const { token } = request.params;
    const db = getDb();

    const step = db.prepare(`
      SELECT ls.id, l.email
      FROM lead_steps ls
      JOIN leads l ON l.id = ls.lead_id
      WHERE ls.open_token = ?
    `).get(token);

    if (step) {
      addSuppression(step.email, 'unsubscribe');
      db.prepare(`
        INSERT INTO email_events (lead_step_id, type, token, timestamp, meta_json)
        VALUES (?, 'unsubscribe', ?, CURRENT_TIMESTAMP, ?)
      `).run(step.id, token, JSON.stringify({ rfc8058: true }));
    }

    return reply.status(200).send({
      success: true,
      message: 'Unsubscribed successfully'
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
