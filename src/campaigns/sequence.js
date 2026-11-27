import { getDb, getSetting } from '../db.js';
import { isSuppressed } from './suppression.js';
import { canMailboxSend } from '../mailboxes/dns-check.js';
import { renderSpintax, renderVariables, htmlToPlainText, injectTrackingAndFooter } from './render.js';
import { prepareTracking } from './tracking.js';
import { verifyEmail } from '../verifier/index.js';
import { config } from '../config.js';
import PQueue from 'p-queue';

const launchJobs = new Map();

/**
 * Get background launch status and verification progress for a campaign
 */
export function getLaunchStatus(campaignId) {
  const idNum = Number(campaignId);
  const job = launchJobs.get(idNum);
  if (job) return job;

  const db = getDb();
  const c = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(idNum);
  return {
    campaignId: idNum,
    status: c ? c.status : 'not_found',
    total: 0,
    verified: 0,
    valid: 0,
    invalid: 0,
    progressPercent: (c?.status === 'running' || c?.status === 'completed') ? 100 : 0
  };
}

/**
 * Create a new campaign with schedule and sequence configuration
 */
export function createCampaign(data) {
  const db = getDb();
  if (!data.name || !data.name.trim()) {
    throw new Error('Campaign name is required');
  }

  const stmt = db.prepare(`
    INSERT INTO campaigns (
      name, list_id, send_policy, timezone, send_days_json,
      window_start, window_end, min_gap_seconds, max_gap_seconds,
      daily_cap_per_mailbox, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `);

  const sendDaysJson = JSON.stringify(data.send_days || [1, 2, 3, 4, 5]);
  const res = stmt.run(
    data.name.trim(),
    data.list_id || null,
    data.send_policy || 'deliverable_only',
    data.timezone || 'UTC',
    sendDaysJson,
    data.window_start || '09:00',
    data.window_end || '17:00',
    data.min_gap_seconds || 90,
    data.max_gap_seconds || 240,
    data.daily_cap_per_mailbox || 50
  );

  const campaignId = Number(res.lastInsertRowid);

  // Associate mailboxes
  if (Array.isArray(data.mailbox_ids)) {
    const mbStmt = db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)');
    for (const mbId of data.mailbox_ids) {
      mbStmt.run(campaignId, mbId);
    }
  }

  // Create initial sequence steps and variants
  if (Array.isArray(data.steps) && data.steps.length > 0) {
    for (let i = 0; i < data.steps.length; i++) {
      addSequenceStep(campaignId, { ...data.steps[i], step_number: i + 1 });
    }
  }

  return getCampaign(campaignId);
}

/**
 * Add a sequence step with optional A/B variants
 */
export function addSequenceStep(campaignId, stepData) {
  const db = getDb();
  const stepRes = db.prepare(`
    INSERT INTO sequence_steps (campaign_id, step_number, delay_days, condition)
    VALUES (?, ?, ?, ?)
  `).run(
    campaignId,
    stepData.step_number || 1,
    stepData.delay_days !== undefined ? stepData.delay_days : (stepData.step_number === 1 ? 0 : 3),
    stepData.condition || 'if_no_reply'
  );

  const stepId = Number(stepRes.lastInsertRowid);

  const variants = Array.isArray(stepData.variants) && stepData.variants.length > 0
    ? stepData.variants
    : [{
        variant_letter: 'A',
        subject: stepData.subject || 'Hello {{first_name|there}}',
        body_html: stepData.body_html || '<p>Hi {{first_name|there}},</p><p>Quick question about {{company|your team}}.</p>',
        body_text: stepData.body_text || null,
        weight: 1
      }];

  const variantStmt = db.prepare(`
    INSERT INTO step_variants (sequence_step_id, variant_letter, subject, body_html, body_text, weight)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const v of variants) {
    const bodyHtml = v.body_html || '';
    const bodyText = v.body_text || htmlToPlainText(bodyHtml);
    variantStmt.run(
      stepId,
      v.variant_letter || 'A',
      v.subject || 'Follow up',
      bodyHtml,
      bodyText,
      v.weight || 1
    );
  }

  return stepId;
}

/**
 * Retrieve campaign by ID with associated mailboxes, steps, and variants
 */
export function getCampaign(id) {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return null;

  campaign.send_days = JSON.parse(campaign.send_days_json || '[1,2,3,4,5]');

  // Associated mailboxes
  campaign.mailboxes = db.prepare(`
    SELECT m.id, m.email, m.display_name, m.status, m.campaign_daily_cap
    FROM mailboxes m
    JOIN campaign_mailboxes cm ON cm.mailbox_id = m.id
    WHERE cm.campaign_id = ?
  `).all(id);

  // Steps
  campaign.steps = db.prepare(`
    SELECT * FROM sequence_steps WHERE campaign_id = ? ORDER BY step_number ASC
  `).all(id);

  for (const step of campaign.steps) {
    step.variants = db.prepare(`
      SELECT * FROM step_variants WHERE sequence_step_id = ? ORDER BY variant_letter ASC
    `).all(step.id);
  }

  return campaign;
}

/**
 * List all campaigns
 */
export function listCampaigns() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  return rows.map(r => getCampaign(r.id));
}

/**
 * Update campaign properties
 */
export function updateCampaign(id, updates) {
  const db = getDb();
  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name.trim());
  }
  if (updates.list_id !== undefined) {
    fields.push('list_id = ?');
    values.push(updates.list_id);
  }
  if (updates.send_policy !== undefined) {
    fields.push('send_policy = ?');
    values.push(updates.send_policy);
  }
  if (updates.timezone !== undefined) {
    fields.push('timezone = ?');
    values.push(updates.timezone);
  }
  if (updates.send_days !== undefined) {
    fields.push('send_days_json = ?');
    values.push(JSON.stringify(updates.send_days));
  }
  if (updates.window_start !== undefined) {
    fields.push('window_start = ?');
    values.push(updates.window_start);
  }
  if (updates.window_end !== undefined) {
    fields.push('window_end = ?');
    values.push(updates.window_end);
  }
  if (updates.min_gap_seconds !== undefined) {
    fields.push('min_gap_seconds = ?');
    values.push(parseInt(updates.min_gap_seconds, 10));
  }
  if (updates.max_gap_seconds !== undefined) {
    fields.push('max_gap_seconds = ?');
    values.push(parseInt(updates.max_gap_seconds, 10));
  }
  if (updates.daily_cap_per_mailbox !== undefined) {
    fields.push('daily_cap_per_mailbox = ?');
    values.push(parseInt(updates.daily_cap_per_mailbox, 10));
  }

  if (fields.length > 0) {
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    db.prepare(`UPDATE campaigns SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  // Update associated mailboxes if supplied
  if (Array.isArray(updates.mailbox_ids)) {
    db.prepare('DELETE FROM campaign_mailboxes WHERE campaign_id = ?').run(id);
    const mbStmt = db.prepare('INSERT OR IGNORE INTO campaign_mailboxes (campaign_id, mailbox_id) VALUES (?, ?)');
    for (const mbId of updates.mailbox_ids) {
      mbStmt.run(id, mbId);
    }
  }

  return getCampaign(id);
}

/**
 * Launch campaign with all compliance and safety checks
 * When options.async is true, returns { status: 'preparing' } immediately and processes verification in background
 */
export async function launchCampaign(campaignId, options = {}) {
  const db = getDb();
  const campaign = getCampaign(campaignId);
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  // 1. Mandatory compliance check: postal address footer in Settings
  const postalAddress = getSetting('postal_address');
  if (!postalAddress || !postalAddress.trim()) {
    throw new Error('Compliance requirement: Sender postal address is required in Settings before launching any campaign.');
  }

  // 2. Mailbox check: must have at least one active, DNS-healthy mailbox
  if (!campaign.mailboxes || campaign.mailboxes.length === 0) {
    throw new Error('Campaign must have at least one sending mailbox attached.');
  }

  const validMailboxes = campaign.mailboxes.filter(m => {
    const dnsStatus = canMailboxSend(m.id);
    return dnsStatus.canSend;
  });

  if (validMailboxes.length === 0) {
    throw new Error('None of the assigned mailboxes have passing SPF and DKIM records.');
  }

  // 3. Sequence steps check
  if (!campaign.steps || campaign.steps.length === 0) {
    throw new Error('Campaign must have at least one sequence step.');
  }

  const firstStep = campaign.steps[0];
  if (!firstStep.variants || firstStep.variants.length === 0) {
    throw new Error('First sequence step must have at least one variant.');
  }

  // 4. Leads selection based on policy
  if (!campaign.list_id) {
    throw new Error('No lead list assigned to campaign.');
  }

  const rawLeads = db.prepare("SELECT * FROM leads WHERE list_id = ? AND status = 'active'").all(campaign.list_id);
  if (rawLeads.length === 0) {
    throw new Error('The selected list contains no active leads.');
  }

  // Set status to 'preparing'
  db.prepare("UPDATE campaigns SET status = 'preparing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaignId);

  const jobState = {
    campaignId: Number(campaignId),
    status: 'preparing',
    total: rawLeads.length,
    verified: 0,
    valid: 0,
    invalid: 0,
    progressPercent: 0,
    scheduledCount: 0,
    error: null
  };
  launchJobs.set(Number(campaignId), jobState);

  // If async requested (e.g. from HTTP route), start in background and return immediately
  if (options.async) {
    executeLaunchJob(campaign, rawLeads, firstStep, jobState).catch(err => {
      console.error(`Background launch failed for campaign ${campaignId}:`, err.message);
      jobState.status = 'error';
      jobState.error = err.message;
      try {
        db.prepare("UPDATE campaigns SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaignId);
      } catch {}
    });

    return {
      success: true,
      status: 'preparing',
      message: 'Campaign launch initiated'
    };
  }

  // Otherwise await synchronously for callers expecting direct execution
  return await executeLaunchJob(campaign, rawLeads, firstStep, jobState);
}

/**
 * Execute verification and scheduling job with bounded concurrency and 30-day cache check
 */
async function executeLaunchJob(campaign, rawLeads, firstStep, jobState) {
  const db = getDb();
  const queue = new PQueue({ concurrency: config.verifier?.bulkConcurrency || 8 });
  const seenEmails = new Set();
  const leadsToSchedule = [];

  for (const lead of rawLeads) {
    const email = lead.email.toLowerCase().trim();

    // 2.5 De-duplicate by email across the list
    if (seenEmails.has(email)) {
      jobState.invalid++;
      jobState.verified++;
      jobState.progressPercent = Math.round((jobState.verified / jobState.total) * 100);
      continue;
    }
    seenEmails.add(email);

    if (isSuppressed(email)) {
      jobState.invalid++;
      jobState.verified++;
      jobState.progressPercent = Math.round((jobState.verified / jobState.total) * 100);
      continue;
    }

    queue.add(async () => {
      // 2.6 Treat stored verification as valid ONLY if checked_at is within the last 30 days
      let vRow = db.prepare(`
        SELECT verdict FROM verification_results
        WHERE email = ? AND checked_at >= datetime('now', '-30 days')
      `).get(email);

      if (!vRow) {
        try {
          const vResult = await verifyEmail(email);
          vRow = { verdict: vResult.verdict };
        } catch {
          jobState.invalid++;
          jobState.verified++;
          jobState.progressPercent = Math.round((jobState.verified / jobState.total) * 100);
          return;
        }
      }

      jobState.verified++;
      jobState.progressPercent = Math.round((jobState.verified / jobState.total) * 100);

      // Policy check: "deliverable_only" (default) or "deliverable_and_risky"
      let isAllowed = false;
      if (campaign.send_policy === 'deliverable_only' && vRow.verdict === 'deliverable') {
        isAllowed = true;
      } else if (campaign.send_policy === 'deliverable_and_risky' && ['deliverable', 'risky'].includes(vRow.verdict)) {
        isAllowed = true;
      }

      if (isAllowed) {
        jobState.valid++;
        leadsToSchedule.push(lead);
      } else {
        jobState.invalid++;
      }
    });
  }

  await queue.onIdle();

  if (leadsToSchedule.length === 0) {
    jobState.status = 'error';
    jobState.error = 'No leads met the send policy criteria (deliverable/unsuppressed).';
    db.prepare("UPDATE campaigns SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);
    throw new Error('No leads met the send policy criteria (deliverable/unsuppressed).');
  }

  // Schedule step 1 in lead_steps table
  let scheduledCount = 0;
  const insertStep = db.prepare(`
    INSERT OR IGNORE INTO lead_steps (
      campaign_id, lead_id, sequence_step_id, variant_id, status, scheduled_at
    ) VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `);

  const tx = db.transaction((leads) => {
    for (const lead of leads) {
      const variant = selectVariantWeighted(firstStep.variants);
      const res = insertStep.run(campaign.id, lead.id, firstStep.id, variant.id);
      if (res.changes > 0) scheduledCount++;
    }
  });

  tx(leadsToSchedule);

  jobState.scheduledCount = scheduledCount;
  jobState.status = 'running';
  jobState.progressPercent = 100;

  db.prepare("UPDATE campaigns SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(campaign.id);

  return {
    success: true,
    scheduledCount,
    scheduledLeads: scheduledCount,
    status: 'running'
  };
}

/**
 * Select an A/B variant based on weights
 */
function selectVariantWeighted(variants) {
  if (variants.length === 1) return variants[0];
  const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 1), 0);
  let random = Math.random() * totalWeight;
  for (const v of variants) {
    random -= (v.weight || 1);
    if (random <= 0) return v;
  }
  return variants[0];
}

export function pauseCampaign(id) {
  const db = getDb();
  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return getCampaign(id);
}

export function resumeCampaign(id) {
  const db = getDb();
  db.prepare("UPDATE campaigns SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return getCampaign(id);
}

export function duplicateCampaign(id) {
  const original = getCampaign(id);
  if (!original) throw new Error('Campaign not found');

  const copyData = {
    name: `${original.name} (Copy)`,
    list_id: original.list_id,
    send_policy: original.send_policy,
    timezone: original.timezone,
    send_days: original.send_days,
    window_start: original.window_start,
    window_end: original.window_end,
    min_gap_seconds: original.min_gap_seconds,
    max_gap_seconds: original.max_gap_seconds,
    daily_cap_per_mailbox: original.daily_cap_per_mailbox,
    mailbox_ids: original.mailboxes.map(m => m.id),
    steps: original.steps.map(s => ({
      step_number: s.step_number,
      delay_days: s.delay_days,
      condition: s.condition,
      variants: s.variants.map(v => ({
        variant_letter: v.variant_letter,
        subject: v.subject,
        body_html: v.body_html,
        body_text: v.body_text,
        weight: v.weight
      }))
    }))
  };

  return createCampaign(copyData);
}

export function deleteCampaign(id) {
  const db = getDb();
  return db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
}

/**
 * Preview campaign step with spintax, variables, and footer
 */
export function previewCampaignStep(stepId, sampleLead = null) {
  const db = getDb();
  const step = db.prepare('SELECT * FROM sequence_steps WHERE id = ?').get(stepId);
  if (!step) throw new Error('Step not found');

  const variant = db.prepare('SELECT * FROM step_variants WHERE sequence_step_id = ? LIMIT 1').get(stepId);
  if (!variant) throw new Error('No variants found for step');

  const lead = sampleLead || {
    email: 'alex.smith@example.com',
    first_name: 'Alex',
    last_name: 'Smith',
    company: 'Acme Technologies',
    custom_fields: { role: 'VP Engineering' }
  };

  const subject = renderVariables(renderSpintax(variant.subject), lead);
  const rawHtml = renderVariables(renderSpintax(variant.body_html), lead);
  const postalAddress = getSetting('postal_address') || '123 Main Street, Suite 100, City, State, Country';
  const tracking = prepareTracking(0, 'sender@domain.com');

  const bodyHtml = injectTrackingAndFooter(rawHtml, {
    openToken: tracking.openToken,
    unsubscribeUrl: tracking.unsubscribeUrl,
    postalAddress,
    publicBaseUrl: tracking.publicBaseUrl
  });

  return {
    subject,
    body_html: bodyHtml,
    body_text: htmlToPlainText(bodyHtml),
    headers: tracking.headers
  };
}

export const previewStep = previewCampaignStep;
