import Database from 'better-sqlite3';
import { config } from './config.js';
import path from 'path';
import fs from 'fs';

let dbInstance = null;

export function initDb(dbPath = config.db.path) {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);

  // High performance & concurrency SQLite pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  dbInstance = db;

  return db;
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = initDb();
  }
  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function migrate(db) {
  db.exec(`
    -- Settings table for global configuration
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Mailboxes for sending and warm-up
    CREATE TABLE IF NOT EXISTS mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL DEFAULT 587,
      smtp_secure INTEGER NOT NULL DEFAULT 0,
      smtp_user TEXT NOT NULL,
      smtp_pass_encrypted TEXT NOT NULL,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL DEFAULT 993,
      imap_secure INTEGER NOT NULL DEFAULT 1,
      imap_user TEXT NOT NULL,
      imap_pass_encrypted TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready', -- 'warming', 'ready', 'paused', 'error'
      error_reason TEXT,
      allow_self_signed INTEGER DEFAULT 0,
      daily_warmup_target INTEGER DEFAULT 40,
      warmup_start_date TEXT,
      campaign_daily_cap INTEGER DEFAULT 50,
      next_send_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Mailbox DNS health checks
    CREATE TABLE IF NOT EXISTS mailbox_dns_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      spf_status TEXT, -- 'pass', 'warn', 'fail'
      spf_record TEXT,
      spf_detail TEXT,
      dkim_status TEXT,
      dkim_selector TEXT,
      dkim_record TEXT,
      dkim_detail TEXT,
      dmarc_status TEXT,
      dmarc_record TEXT,
      dmarc_detail TEXT,
      mx_status TEXT,
      mx_records_json TEXT,
      mx_detail TEXT,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Warmup plans per mailbox
    CREATE TABLE IF NOT EXISTS warmup_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      day_number INTEGER NOT NULL,
      planned_sends INTEGER NOT NULL,
      target_date TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- 'pending', 'in_progress', 'completed'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Warmup email events
    CREATE TABLE IF NOT EXISTS warmup_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      partner_mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
      direction TEXT NOT NULL, -- 'sent', 'received', 'replied'
      message_id TEXT NOT NULL,
      thread_id TEXT,
      warmup_id TEXT NOT NULL,
      subject TEXT,
      status TEXT, -- 'sent', 'inbox', 'spam_rescued', 'read', 'starred', 'replied', 'bounced'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Warmup Schedule (5.1)
    CREATE TABLE IF NOT EXISTS warmup_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      send_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'claimed', 'sent', 'failed'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_warmup_sched_status_send ON warmup_schedule(status, send_at);
    CREATE INDEX IF NOT EXISTS idx_warmup_sched_box_date ON warmup_schedule(mailbox_id, date);

    -- Warmup Delivery Processing Jobs (5.2)
    CREATE TABLE IF NOT EXISTS warmup_delivery_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warmup_id TEXT NOT NULL,
      sender_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      partner_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      original_subject TEXT,
      original_message_id TEXT,
      attempts INTEGER DEFAULT 0,
      next_run_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'failed'
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_warmup_delivery_status_next ON warmup_delivery_jobs(status, next_run_at);

    -- Warmup Threaded Reply Jobs (5.3)
    CREATE TABLE IF NOT EXISTS warmup_reply_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warmup_id TEXT NOT NULL,
      from_mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      to_mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      in_reply_to TEXT NOT NULL,
      references_header TEXT NOT NULL,
      subject TEXT NOT NULL,
      thread_depth INTEGER DEFAULT 1,
      scheduled_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'sent', 'failed'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_warmup_reply_status_sched ON warmup_reply_jobs(status, scheduled_at);

    -- Lists of leads
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Leads
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      company TEXT,
      custom_fields_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'active', -- 'active', 'unsubscribed', 'bounced', 'stopped'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Verification results cache
    CREATE TABLE IF NOT EXISTS verification_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      verdict TEXT NOT NULL, -- 'deliverable', 'risky', 'undeliverable', 'unknown'
      score INTEGER NOT NULL, -- 0 to 100
      reason TEXT,
      checks_json TEXT NOT NULL,
      suggestion TEXT,
      transcript_json TEXT NOT NULL,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Domain level cache (catch-all, MX, provider)
    CREATE TABLE IF NOT EXISTS domain_cache (
      domain TEXT PRIMARY KEY,
      is_catchall INTEGER,
      mx_records_json TEXT,
      provider TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Campaigns
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'draft', -- 'draft', 'scheduled', 'running', 'paused', 'completed'
      list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
      send_policy TEXT DEFAULT 'deliverable_only', -- 'deliverable_only', 'deliverable_and_risky'
      timezone TEXT DEFAULT 'UTC',
      send_days_json TEXT DEFAULT '[1,2,3,4,5]', -- 1=Monday..7=Sunday
      window_start TEXT DEFAULT '09:00',
      window_end TEXT DEFAULT '17:00',
      min_gap_seconds INTEGER DEFAULT 90,
      max_gap_seconds INTEGER DEFAULT 240,
      daily_cap_per_mailbox INTEGER DEFAULT 50,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Campaign Mailboxes association
    CREATE TABLE IF NOT EXISTS campaign_mailboxes (
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      PRIMARY KEY (campaign_id, mailbox_id)
    );

    -- Sequence Steps
    CREATE TABLE IF NOT EXISTS sequence_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL,
      delay_days INTEGER NOT NULL DEFAULT 0,
      condition TEXT DEFAULT 'if_no_reply', -- 'always', 'if_no_reply'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Step Variants for A/B testing
    CREATE TABLE IF NOT EXISTS step_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_step_id INTEGER NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
      variant_letter TEXT NOT NULL DEFAULT 'A',
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT,
      weight INTEGER DEFAULT 1
    );

    -- Lead Steps tracking individual deliveries
    CREATE TABLE IF NOT EXISTS lead_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      sequence_step_id INTEGER NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
      variant_id INTEGER REFERENCES step_variants(id),
      mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'claimed', 'sent', 'retrying', 'skipped', 'failed'
      scheduled_at DATETIME NOT NULL,
      sent_at DATETIME,
      message_id TEXT,
      thread_message_id TEXT,
      open_token TEXT UNIQUE,
      retry_count INTEGER DEFAULT 0,
      next_retry_at DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(lead_id, sequence_step_id)
    );

    -- Email Events
    CREATE TABLE IF NOT EXISTS email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_step_id INTEGER NOT NULL REFERENCES lead_steps(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'sent', 'open', 'click', 'reply', 'auto_reply', 'bounce_hard', 'bounce_soft', 'unsubscribe'
      token TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      meta_json TEXT DEFAULT '{}'
    );

    -- Direct tracking links registry
    CREATE TABLE IF NOT EXISTS tracking_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_step_id INTEGER NOT NULL REFERENCES lead_steps(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      original_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Replies
    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_step_id INTEGER REFERENCES lead_steps(id) ON DELETE SET NULL,
      mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      from_email TEXT NOT NULL,
      subject TEXT,
      snippet TEXT,
      body_text TEXT,
      is_auto_reply INTEGER DEFAULT 0,
      label TEXT DEFAULT 'neutral', -- 'interested', 'not_interested', 'neutral'
      handled INTEGER DEFAULT 0,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Global Suppression List
    CREATE TABLE IF NOT EXISTS suppression (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL, -- 'unsubscribe', 'hard_bounce', 'manual', 'import'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Mailbox IMAP sync tracking
    CREATE TABLE IF NOT EXISTS mailbox_sync (
      mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      folder TEXT NOT NULL DEFAULT 'INBOX',
      last_uid INTEGER NOT NULL DEFAULT 0,
      uidvalidity TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (mailbox_id, folder)
    );

    -- Verification Greylist Retries (4.8)
    CREATE TABLE IF NOT EXISTS verification_retries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      attempt INTEGER DEFAULT 1,
      next_retry_at DATETIME NOT NULL,
      status TEXT DEFAULT 'pending', -- 'pending', 'completed', 'failed'
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_verification_retries_status ON verification_retries(status, next_retry_at);

    -- Performance & safety indexes
    CREATE INDEX IF NOT EXISTS idx_lead_steps_status_sched ON lead_steps(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_email_events_lead_step_type ON email_events(lead_step_id, type);
    CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
    CREATE INDEX IF NOT EXISTS idx_warmup_events_warmup_id ON warmup_events(warmup_id);
    CREATE INDEX IF NOT EXISTS idx_warmup_events_mailbox ON warmup_events(mailbox_id, created_at);
  `);

  // Migration for mailboxes table columns
  try {
    db.exec('ALTER TABLE mailboxes ADD COLUMN allow_self_signed INTEGER DEFAULT 0');
  } catch (err) {}
  try {
    db.exec('ALTER TABLE mailboxes ADD COLUMN next_send_at DATETIME');
  } catch (err) {}

  // Migration for duplicate leads removal and unique index on (list_id, email)
  try {
    db.exec(`
      DELETE FROM leads
      WHERE id NOT IN (
        SELECT MIN(id) FROM leads GROUP BY list_id, email
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_list_email ON leads(list_id, email);
    `);
  } catch (err) {}

  // Initialize default settings if not existing
  const initSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);

  const defaultSettings = [
    ['postal_address', ''],
    ['timezone', 'UTC'],
    ['public_base_url', config.public.baseUrl || ''],
    ['default_daily_cap', '50'],
    ['default_min_gap_sec', '90'],
    ['default_max_gap_sec', '240']
  ];

  for (const [k, v] of defaultSettings) {
    initSetting.run(k, v);
  }
}

export function getSetting(key, defaultValue = '') {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

export function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

export function getAllSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
