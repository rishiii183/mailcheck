import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getDb, getSetting, setSetting, getAllSettings } from './db.js';
import { verifyEmail, verifyBulk, VERDICTS } from './verifier/index.js';
import { getPort25Status } from './verifier/smtp.js';
import { createMailbox, getMailboxById, listMailboxes, updateMailbox, deleteMailbox, testMailboxConnection } from './mailboxes/accounts.js';
import { checkMailboxDns } from './mailboxes/dns-check.js';
import { getMailboxHealth, getWarmupPlan } from './warmup/health.js';
import { createCampaign, getCampaign, listCampaigns, updateCampaign, launchCampaign, getLaunchStatus, pauseCampaign, resumeCampaign, duplicateCampaign, deleteCampaign, previewStep } from './campaigns/sequence.js';
import { getOverviewStats, getCampaignStats, getCampaignLeads, getLeadTimeline } from './stats/queries.js';
import { listReplies, labelReply, markReplyHandled } from './campaigns/replies.js';
import { listSuppression, addSuppression, removeSuppression, importSuppression } from './campaigns/suppression.js';
import { startEngine, stopEngine, runSchedulerTick } from './campaigns/engine.js';
import { startReplyPoller, stopReplyPoller } from './campaigns/replies.js';
import { startWarmupRunner, stopWarmupRunner } from './warmup/runner.js';
import { importLeads, parseCsv } from './campaigns/leads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

export function createAdminServer(options = {}) {
  const fastify = Fastify({
    logger: options.logger ?? false
  });

  fastify.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB CSV/TXT upload
  });

  fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/'
  });

  // Global Error Handler - returns JSON { error }
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal Server Error';
    return reply.status(statusCode).send({ error: message });
  });

  // 1.5 Security: Host check (DNS rebinding), Origin check (CSRF), Mandatory API_KEY
  fastify.addHook('preHandler', async (request, reply) => {
    // 1. Host header validation
    const rawHost = request.headers.host || '';
    const host = rawHost.split(':')[0].toLowerCase();
    const allowedHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
    if (!host || !allowedHosts.includes(host)) {
      return reply.status(403).send({ error: 'Forbidden: Invalid Host header' });
    }

    // 2. CSRF defense: verify Origin for non-GET requests if present
    if (request.method !== 'GET' && request.headers.origin) {
      try {
        const originUrl = new URL(request.headers.origin);
        if (!allowedHosts.includes(originUrl.hostname.toLowerCase())) {
          return reply.status(403).send({ error: 'Forbidden: Cross-origin request blocked' });
        }
      } catch {
        return reply.status(403).send({ error: 'Forbidden: Invalid Origin header' });
      }
    }

    // 3. Mandatory API_KEY authentication for all /api/* routes
    if (request.url.startsWith('/api/')) {
      const apiKey = config.admin.apiKey;
      const authHeader = request.headers.authorization;
      const xApiKey = request.headers['x-api-key'];
      const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;

      if (!token || token !== apiKey) {
        return reply.status(401).send({ error: 'Unauthorized: Invalid or missing API key' });
      }
    }
  });

  // ==========================================
  // SYSTEM & SETTINGS APIS
  // ==========================================
  fastify.get('/api/system/status', async (request, reply) => {
    const port25 = getPort25Status();
    const publicBaseUrl = getSetting('public_base_url') || config.public.baseUrl || '';
    const postalAddress = getSetting('postal_address') || '';

    // Check if public url is configured
    const publicUrlConfigured = Boolean(publicBaseUrl && publicBaseUrl.trim());

    return reply.send({
      port25: {
        available: port25.available,
        checkedAt: port25.checkedAt,
        message: port25.available ? 'Outbound port 25 is open' : 'Outbound port 25 appears blocked by ISP/firewall. Verification will mark SMTP checks as unknown.'
      },
      publicServer: {
        baseUrl: publicBaseUrl,
        configured: publicUrlConfigured,
        warning: !publicUrlConfigured ? 'PUBLIC_BASE_URL is unset. Tracking links and unsubscribe links will use fallback localhost.' : null
      },
      compliance: {
        hasPostalAddress: Boolean(postalAddress.trim()),
        warning: !postalAddress.trim() ? 'Physical postal address is missing in Settings. Campaigns cannot be launched until added.' : null
      }
    });
  });

  fastify.get('/api/settings', async (request, reply) => {
    return reply.send(getAllSettings());
  });

  fastify.post('/api/settings', async (request, reply) => {
    const body = request.body || {};
    for (const [k, v] of Object.entries(body)) {
      setSetting(k, v);
    }
    return reply.send({ success: true, settings: getAllSettings() });
  });

  // ==========================================
  // MODULE 1: EMAIL VERIFIER APIS
  // ==========================================
  fastify.post('/api/verify', async (request, reply) => {
    const { email } = request.body || {};
    if (!email) return reply.status(400).send({ error: 'Email is required' });

    const result = await verifyEmail(email);
    return reply.send(result);
  });

  // SSE Bulk verification stream
  fastify.get('/api/verify/bulk/progress', (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    // Client will connect and then POST data or pass session id
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
    });
  });

  fastify.post('/api/verify/bulk', async (request, reply) => {
    const { emails, listId } = request.body || {};
    if (!emails) return reply.status(400).send({ error: 'Emails input is required' });

    const results = await verifyBulk(emails);

    // Optionally save to an existing list
    if (listId) {
      const db = getDb();
      for (const res of results.results) {
        db.prepare("INSERT OR IGNORE INTO leads (list_id, email, status) VALUES (?, ?, 'active')").run(listId, res.email);
      }
    }

    return reply.send(results);
  });

  // Lists & Leads CRUD
  fastify.get('/api/lists', async (request, reply) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT l.*, COUNT(ld.id) as lead_count
      FROM lists l
      LEFT JOIN leads ld ON ld.list_id = l.id
      GROUP BY l.id
      ORDER BY l.id DESC
    `).all();
    return reply.send(rows);
  });

  fastify.post('/api/lists', async (request, reply) => {
    const { name, description } = request.body || {};
    if (!name) return reply.status(400).send({ error: 'List name is required' });

    const db = getDb();
    const res = db.prepare('INSERT INTO lists (name, description) VALUES (?, ?)').run(name.trim(), description || '');
    return reply.send({ id: Number(res.lastInsertRowid), name, description });
  });

  fastify.get('/api/lists/:id/leads', async (request, reply) => {
    const db = getDb();
    const leads = db.prepare(`
      SELECT l.*, vr.verdict, vr.score
      FROM leads l
      LEFT JOIN verification_results vr ON vr.email = l.email
      WHERE l.list_id = ?
      ORDER BY l.id DESC
    `).all(request.params.id);
    return reply.send(leads);
  });

  fastify.post('/api/lists/:id/leads/import', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      let rows = [];
      if (request.isMultipart()) {
        const file = await request.file();
        if (!file) {
          return reply.status(400).send({ error: 'No file uploaded' });
        }
        const buf = await file.toBuffer();
        rows = parseCsv(buf.toString('utf-8'));
      } else if (request.body) {
        if (Array.isArray(request.body.rows)) {
          rows = request.body.rows;
        } else if (typeof request.body.csv === 'string') {
          rows = parseCsv(request.body.csv);
        } else if (typeof request.body === 'string') {
          rows = parseCsv(request.body);
        } else {
          return reply.status(400).send({ error: 'Invalid body: expected rows array or csv string' });
        }
      } else {
        return reply.status(400).send({ error: 'Body or multipart file required' });
      }

      const result = importLeads(Number(request.params.id), rows);
      return reply.send({ success: true, ...result });
    } catch (err) {
      const status = err.message && err.message.includes('not found') ? 404 : 400;
      return reply.status(status).send({ error: err.message });
    }
  });

  fastify.delete('/api/lists/:id', async (request, reply) => {
    const db = getDb();
    db.prepare('DELETE FROM lists WHERE id = ?').run(request.params.id);
    return reply.send({ success: true });
  });

  fastify.get('/api/lists/:id/export', async (request, reply) => {
    const db = getDb();
    const leads = db.prepare(`
      SELECT l.email, l.first_name, l.last_name, l.company, vr.verdict, vr.score, vr.reason
      FROM leads l
      LEFT JOIN verification_results vr ON vr.email = l.email
      WHERE l.list_id = ?
    `).all(request.params.id);

    const headers = ['Email', 'First Name', 'Last Name', 'Company', 'Verdict', 'Score', 'Reason'];
    const rows = leads.map(l => [l.email, l.first_name || '', l.last_name || '', l.company || '', l.verdict || '', l.score || '', l.reason || '']);
    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="list-${request.params.id}-export.csv"`);
    return reply.send(csv);
  });

  // ==========================================
  // MODULE 2: MAILBOXES & DNS HEALTH APIS
  // ==========================================
  fastify.get('/api/mailboxes', async (request, reply) => {
    return reply.send(listMailboxes());
  });

  fastify.post('/api/mailboxes', async (request, reply) => {
    try {
      const mb = await createMailbox(request.body);
      return reply.send(mb);
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/mailboxes/:id', async (request, reply) => {
    const mb = getMailboxById(request.params.id);
    if (!mb) return reply.status(404).send({ error: 'Mailbox not found' });
    return reply.send(mb);
  });

  fastify.put('/api/mailboxes/:id', async (request, reply) => {
    try {
      const updated = updateMailbox(request.params.id, request.body);
      return reply.send(updated);
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.delete('/api/mailboxes/:id', async (request, reply) => {
    deleteMailbox(request.params.id);
    return reply.send({ success: true });
  });

  fastify.post('/api/mailboxes/:id/test', async (request, reply) => {
    const mb = getMailboxById(request.params.id, true);
    if (!mb) return reply.status(404).send({ error: 'Mailbox not found' });
    const result = await testMailboxConnection(mb);
    return reply.send(result);
  });

  fastify.get('/api/mailboxes/:id/dns-check', async (request, reply) => {
    const mb = getMailboxById(request.params.id);
    if (!mb) return reply.status(404).send({ error: 'Mailbox not found' });
    const domain = mb.email.split('@')[1];
    const dnsResult = await checkMailboxDns(domain, mb.id);
    return reply.send(dnsResult);
  });

  fastify.get('/api/mailboxes/:id/health', async (request, reply) => {
    const mb = getMailboxById(request.params.id);
    if (!mb) return reply.status(404).send({ error: 'Mailbox not found' });
    const health = getMailboxHealth(mb.id);
    const plan = getWarmupPlan(mb.id);
    return reply.send({ health, plan, mailbox: mb });
  });

  fastify.post('/api/mailboxes/:id/warmup/:action', async (request, reply) => {
    const { id, action } = request.params;
    let newStatus = 'warming';
    if (action === 'pause') newStatus = 'paused';
    if (action === 'resume' || action === 'start') newStatus = 'warming';

    const updated = updateMailbox(id, { status: newStatus });
    return reply.send(updated);
  });

  // ==========================================
  // MODULE 3: CAMPAIGNS & SEQUENCES APIS
  // ==========================================
  fastify.get('/api/campaigns', async (request, reply) => {
    return reply.send(listCampaigns());
  });

  fastify.post('/api/campaigns', async (request, reply) => {
    try {
      const camp = createCampaign(request.body);
      return reply.send(camp);
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/campaigns/:id', async (request, reply) => {
    const camp = getCampaign(request.params.id);
    if (!camp) return reply.status(404).send({ error: 'Campaign not found' });
    return reply.send(camp);
  });

  fastify.put('/api/campaigns/:id', async (request, reply) => {
    try {
      const camp = updateCampaign(request.params.id, request.body);
      return reply.send(camp);
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.delete('/api/campaigns/:id', async (request, reply) => {
    deleteCampaign(request.params.id);
    return reply.send({ success: true });
  });

  fastify.post('/api/campaigns/:id/launch', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const res = await launchCampaign(request.params.id, { async: true });
      return reply.send(res);
    } catch (err) {
      const status = err.message && err.message.includes('not found') ? 404 : 400;
      return reply.status(status).send({ error: err.message });
    }
  });

  fastify.get('/api/campaigns/:id/launch-status', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const status = getLaunchStatus(request.params.id);
      if (!status || status.status === 'not_found') {
        return reply.status(404).send({ error: 'Campaign not found' });
      }
      return reply.send(status);
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post('/api/campaigns/:id/pause', async (request, reply) => {
    return reply.send(pauseCampaign(request.params.id));
  });

  fastify.post('/api/campaigns/:id/resume', async (request, reply) => {
    return reply.send(resumeCampaign(request.params.id));
  });

  fastify.post('/api/campaigns/:id/duplicate', async (request, reply) => {
    return reply.send(duplicateCampaign(request.params.id));
  });

  fastify.post('/api/campaigns/:id/preview', async (request, reply) => {
    try {
      const { stepId, sampleLead } = request.body || {};
      const res = previewStep(stepId, sampleLead);
      return reply.send(res);
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/campaigns/:id/stats', async (request, reply) => {
    const stats = getCampaignStats(request.params.id);
    if (!stats) return reply.status(404).send({ error: 'Campaign not found' });
    return reply.send(stats);
  });

  fastify.get('/api/campaigns/:id/leads', async (request, reply) => {
    const { filter = 'all', limit = 50, offset = 0 } = request.query;
    const leads = getCampaignLeads(request.params.id, filter, parseInt(limit, 10), parseInt(offset, 10));
    return reply.send(leads);
  });

  fastify.get('/api/campaigns/:id/leads/:leadId/timeline', {
    schema: {
      params: {
        type: 'object',
        required: ['id', 'leadId'],
        properties: {
          id: { type: 'string' },
          leadId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const timeline = getLeadTimeline(request.params.leadId, request.params.id);
      return reply.send(timeline);
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.get('/api/campaigns/:id/export', async (request, reply) => {
    const { filter = 'all' } = request.query;
    const leads = getCampaignLeads(request.params.id, filter, 10000, 0);

    const headers = ['Email', 'First Name', 'Last Name', 'Company', 'Status', 'Sent', 'Opened', 'Clicked', 'Replied'];
    const rows = leads.items.map(l => [
      l.email,
      l.first_name || '',
      l.last_name || '',
      l.company || '',
      l.status || '',
      l.sent_count || 0,
      l.opened_count || 0,
      l.clicked_count || 0,
      l.replied_count || 0
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="campaign-${request.params.id}-${filter}.csv"`);
    return reply.send(csv);
  });

  // Create new campaign from filtered segment (e.g., "opened_no_reply" or "never_opened")
  fastify.post('/api/campaigns/:id/create-from-segment', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['segment'],
        properties: {
          segment: { type: 'string' },
          name: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { segment, name } = request.body || {};
    const db = getDb();
    const origCampaign = getCampaign(request.params.id);
    if (!origCampaign) return reply.status(404).send({ error: 'Original campaign not found' });

    // Fetch leads matching segment
    const segmentLeads = getCampaignLeads(request.params.id, segment, 10000, 0);
    if (segmentLeads.items.length === 0) {
      return reply.status(400).send({ error: `No leads found in segment "${segment}"` });
    }

    // Create new list for this segment
    const listRes = db.prepare('INSERT INTO lists (name, description) VALUES (?, ?)').run(
      `Segment: ${segment} (${origCampaign.name})`,
      `Created from campaign ${origCampaign.name} (${segment}) on ${new Date().toISOString()}`
    );
    const newListId = Number(listRes.lastInsertRowid);

    // Copy leads into new list
    const insertLead = db.prepare("INSERT INTO leads (list_id, email, first_name, last_name, company, status) VALUES (?, ?, ?, ?, ?, 'active')");
    for (const lead of segmentLeads.items) {
      insertLead.run(newListId, lead.email, lead.first_name, lead.last_name, lead.company);
    }

    // Create new campaign
    const newCamp = createCampaign({
      name: name || `${origCampaign.name} - Retarget (${segment})`,
      list_id: newListId,
      mailbox_ids: origCampaign.mailboxes.map(m => m.id),
      send_policy: origCampaign.send_policy,
      timezone: origCampaign.timezone,
      window_start: origCampaign.window_start,
      window_end: origCampaign.window_end
    });

    return reply.send({ success: true, campaign: newCamp, leadCount: segmentLeads.items.length });
  });

  // ==========================================
  // MODULE 4: REPLIES INBOX APIS
  // ==========================================
  fastify.get('/api/replies', async (request, reply) => {
    const { label, handled, is_auto_reply, limit = 50, offset = 0 } = request.query;
    const handledBool = handled !== undefined ? handled === 'true' || handled === '1' : undefined;
    const autoReplyBool = is_auto_reply !== undefined ? is_auto_reply === 'true' || is_auto_reply === '1' : undefined;

    return reply.send(listReplies({
      label,
      handled: handledBool,
      isAutoReply: autoReplyBool,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    }));
  });

  fastify.patch('/api/replies/:id', async (request, reply) => {
    const { label, handled } = request.body || {};
    let item = null;
    if (label !== undefined) {
      item = labelReply(request.params.id, label);
    }
    if (handled !== undefined) {
      item = markReplyHandled(request.params.id, handled ? 1 : 0);
    }
    return reply.send(item || { success: true });
  });

  // ==========================================
  // MODULE 5: STATS OVERVIEW APIS
  // ==========================================
  fastify.get('/api/stats/overview', async (request, reply) => {
    const { from, to } = request.query;
    return reply.send(getOverviewStats(from, to));
  });

  // ==========================================
  // MODULE 6: GLOBAL SUPPRESSION APIS
  // ==========================================
  fastify.get('/api/suppression', async (request, reply) => {
    const { limit = 100, offset = 0 } = request.query;
    return reply.send(listSuppression(parseInt(limit, 10), parseInt(offset, 10)));
  });

  fastify.post('/api/suppression', async (request, reply) => {
    const { email, emails, reason = 'manual' } = request.body || {};
    if (emails) {
      const res = importSuppression(emails, reason);
      return reply.send(res);
    }
    if (!email) return reply.status(400).send({ error: 'Email is required' });
    addSuppression(email, reason);
    return reply.send({ success: true, email });
  });

  fastify.delete('/api/suppression/:email', async (request, reply) => {
    removeSuppression(request.params.email);
    return reply.send({ success: true });
  });

  return fastify;
}

// Runnable entrypoint
if (process.argv[1] && process.argv[1].endsWith('admin.js')) {
  const server = createAdminServer({ logger: true });

  // 1.4 Start background schedulers (engine, replies, warmup)
  startEngine(config.scheduler.intervalMs);
  startReplyPoller(120000);
  startWarmupRunner(300000);

  const shutdown = async () => {
    console.log('Shutting down MailCheck background services...');
    stopEngine();
    stopReplyPoller();
    stopWarmupRunner();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen({ host: config.admin.host, port: config.admin.port }, (err, address) => {
    if (err) {
      console.error('Failed to start Admin Server:', err);
      process.exit(1);
    }
    console.log(`MailCheck Admin Server running on ${address}`);
  });
}
