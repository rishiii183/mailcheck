import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { getDb } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { checkMailboxDns } from './dns-check.js';
import { getMailboxLimits } from './limits.js';

/**
 * Test SMTP and IMAP connections with provided or stored credentials
 */
export async function testMailboxConnection(params) {
  const result = {
    smtp: { ok: false, error: null },
    imap: { ok: false, error: null }
  };

  // 1. Test SMTP with nodemailer
  try {
    const transporter = nodemailer.createTransport({
      host: params.smtp_host,
      port: parseInt(params.smtp_port, 10),
      secure: Boolean(params.smtp_secure),
      auth: {
        user: params.smtp_user,
        pass: params.smtp_pass
      },
      connectionTimeout: 10000,
      tls: params.allow_self_signed ? { rejectUnauthorized: false } : undefined
    });

    await transporter.verify();
    result.smtp.ok = true;
  } catch (err) {
    result.smtp.error = err.message;
  }

  // 2. Test IMAP with imapflow
  try {
    const client = new ImapFlow({
      host: params.imap_host,
      port: parseInt(params.imap_port, 10),
      secure: Boolean(params.imap_secure),
      auth: {
        user: params.imap_user,
        pass: params.imap_pass
      },
      logger: false,
      tls: params.allow_self_signed ? { rejectUnauthorized: false } : undefined
    });

    await client.connect();
    result.imap.ok = true;
    await client.logout();
  } catch (err) {
    result.imap.error = err.message;
  }

  return result;
}

/**
 * Create a new mailbox with encrypted credentials and initial DNS check
 */
export async function createMailbox(data, options = {}) {
  const db = getDb();
  
  if (!data.email || !data.smtp_host || !data.smtp_user || !data.smtp_pass) {
    throw new Error('Email, SMTP host, SMTP user, and SMTP password are required');
  }

  const cleanEmail = data.email.toLowerCase().trim();
  const domain = cleanEmail.split('@')[1];

  // Test connection if requested
  if (options.testFirst) {
    const testResult = await testMailboxConnection(data);
    if (!testResult.smtp.ok || !testResult.imap.ok) {
      const errs = [];
      if (!testResult.smtp.ok) errs.push(`SMTP error: ${testResult.smtp.error}`);
      if (!testResult.imap.ok) errs.push(`IMAP error: ${testResult.imap.error}`);
      throw new Error(`Connection test failed: ${errs.join('; ')}`);
    }
  }

  const encryptedSmtpPass = encrypt(data.smtp_pass);
  const encryptedImapPass = data.imap_pass ? encrypt(data.imap_pass) : encrypt(data.smtp_pass);

  const stmt = db.prepare(`
    INSERT INTO mailboxes (
      email, display_name,
      smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_encrypted,
      imap_host, imap_port, imap_secure, imap_user, imap_pass_encrypted,
      status, daily_warmup_target, warmup_start_date, campaign_daily_cap,
      allow_self_signed
    ) VALUES (
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?
    )
  `);

  const initialStatus = data.status || 'ready';
  const warmupStartDate = initialStatus === 'warming' ? (data.warmup_start_date || new Date().toISOString()) : null;

  const res = stmt.run(
    cleanEmail,
    data.display_name || cleanEmail.split('@')[0],
    data.smtp_host,
    data.smtp_port || 587,
    data.smtp_secure ? 1 : 0,
    data.smtp_user,
    encryptedSmtpPass,
    data.imap_host || data.smtp_host,
    data.imap_port || 993,
    data.imap_secure !== undefined ? (data.imap_secure ? 1 : 0) : 1,
    data.imap_user || data.smtp_user,
    encryptedImapPass,
    initialStatus,
    data.daily_warmup_target || 40,
    warmupStartDate,
    data.campaign_daily_cap || 50,
    data.allow_self_signed ? 1 : 0
  );

  const mailboxId = Number(res.lastInsertRowid);

  // Run initial DNS health check asynchronously or in background
  if (!options.skipDns) {
    try {
      await checkMailboxDns(domain, mailboxId);
    } catch (err) {
      console.warn(`Initial DNS check failed for ${cleanEmail}: ${err.message}`);
    }
  }

  return getMailboxById(mailboxId);
}

/**
 * Fetch mailbox by ID (masks passwords by default)
 */
export function getMailboxById(id, includeDecrypted = false) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
  if (!row) return null;

  const result = { ...row };

  if (includeDecrypted) {
    result.smtp_pass = decrypt(row.smtp_pass_encrypted);
    result.imap_pass = decrypt(row.imap_pass_encrypted);
  }

  // Remove encrypted hashes from default output
  delete result.smtp_pass_encrypted;
  delete result.imap_pass_encrypted;

  // Attach limits
  result.limits = getMailboxLimits(row);

  return result;
}

/**
 * List all mailboxes with their latest DNS status and current send capacity
 */
export function listMailboxes() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM mailboxes ORDER BY id DESC').all();

  return rows.map(row => {
    const item = { ...row };
    delete item.smtp_pass_encrypted;
    delete item.imap_pass_encrypted;

    // Attach latest DNS check
    const dnsRow = db.prepare(`
      SELECT spf_status, dkim_status, dmarc_status, mx_status, checked_at
      FROM mailbox_dns_checks
      WHERE mailbox_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(row.id);

    item.dns = dnsRow || null;
    item.canSend = dnsRow ? (dnsRow.spf_status !== 'fail' && dnsRow.dkim_status !== 'fail') : true;
    item.limits = getMailboxLimits(row);

    return item;
  });
}

/**
 * Update mailbox details
 */
export function updateMailbox(id, updates) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
  if (!existing) throw new Error('Mailbox not found');

  const fields = [];
  const values = [];

  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.smtp_host !== undefined) {
    fields.push('smtp_host = ?');
    values.push(updates.smtp_host);
  }
  if (updates.smtp_port !== undefined) {
    fields.push('smtp_port = ?');
    values.push(parseInt(updates.smtp_port, 10));
  }
  if (updates.smtp_secure !== undefined) {
    fields.push('smtp_secure = ?');
    values.push(updates.smtp_secure ? 1 : 0);
  }
  if (updates.smtp_user !== undefined) {
    fields.push('smtp_user = ?');
    values.push(updates.smtp_user);
  }
  if (updates.smtp_pass) {
    fields.push('smtp_pass_encrypted = ?');
    values.push(encrypt(updates.smtp_pass));
  }
  if (updates.imap_host !== undefined) {
    fields.push('imap_host = ?');
    values.push(updates.imap_host);
  }
  if (updates.imap_port !== undefined) {
    fields.push('imap_port = ?');
    values.push(parseInt(updates.imap_port, 10));
  }
  if (updates.imap_secure !== undefined) {
    fields.push('imap_secure = ?');
    values.push(updates.imap_secure ? 1 : 0);
  }
  if (updates.imap_user !== undefined) {
    fields.push('imap_user = ?');
    values.push(updates.imap_user);
  }
  if (updates.imap_pass) {
    fields.push('imap_pass_encrypted = ?');
    values.push(encrypt(updates.imap_pass));
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
    if (updates.status === 'warming' && !existing.warmup_start_date) {
      fields.push('warmup_start_date = ?');
      values.push(new Date().toISOString());
    }
  }
  if (updates.daily_warmup_target !== undefined) {
    fields.push('daily_warmup_target = ?');
    values.push(parseInt(updates.daily_warmup_target, 10));
  }
  if (updates.campaign_daily_cap !== undefined) {
    fields.push('campaign_daily_cap = ?');
    values.push(parseInt(updates.campaign_daily_cap, 10));
  }
  if (updates.allow_self_signed !== undefined) {
    fields.push('allow_self_signed = ?');
    values.push(updates.allow_self_signed ? 1 : 0);
  }

  if (fields.length === 0) return getMailboxById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  db.prepare(`UPDATE mailboxes SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  return getMailboxById(id);
}

/**
 * Delete a mailbox, safely nullifying lead_steps references so history is preserved
 */
export function deleteMailbox(id) {
  const db = getDb();
  db.prepare('UPDATE lead_steps SET mailbox_id = NULL WHERE mailbox_id = ?').run(id);
  db.prepare('DELETE FROM campaign_mailboxes WHERE mailbox_id = ?').run(id);
  db.prepare('DELETE FROM mailbox_sync WHERE mailbox_id = ?').run(id);
  return db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id);
}
