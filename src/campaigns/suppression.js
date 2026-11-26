import { getDb } from '../db.js';

/**
 * Check if an email is globally suppressed
 * @param {string} email 
 * @returns {boolean}
 */
export function isSuppressed(email) {
  if (!email) return false;
  const db = getDb();
  const row = db.prepare('SELECT id FROM suppression WHERE email = ?').get(email.toLowerCase().trim());
  return Boolean(row);
}

/**
 * Add an email to global suppression
 * @param {string} email 
 * @param {'unsubscribe'|'hard_bounce'|'manual'|'import'} reason 
 */
export function addSuppression(email, reason = 'manual') {
  if (!email) return;
  const db = getDb();
  const cleanEmail = email.toLowerCase().trim();

  db.prepare(`
    INSERT INTO suppression (email, reason, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET reason = excluded.reason
  `).run(cleanEmail, reason);

  // Also update any matching lead to 'unsubscribed' or 'bounced'
  const leadStatus = reason === 'hard_bounce' ? 'bounced' : 'unsubscribed';
  db.prepare('UPDATE leads SET status = ? WHERE email = ?').run(leadStatus, cleanEmail);

  // Stop any pending lead_steps for this email
  db.prepare(`
    UPDATE lead_steps
    SET status = 'skipped', last_error = ?
    WHERE lead_id IN (SELECT id FROM leads WHERE email = ?)
      AND status IN ('pending', 'retrying')
  `).run(`Suppressed: ${reason}`, cleanEmail);
}

/**
 * Remove an email from suppression
 * @param {string} email 
 */
export function removeSuppression(email) {
  if (!email) return;
  const db = getDb();
  db.prepare('DELETE FROM suppression WHERE email = ?').run(email.toLowerCase().trim());
}

/**
 * List suppression entries
 */
export function listSuppression(limit = 100, offset = 0) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM suppression ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM suppression').get().count;
  return { items: rows, total };
}

/**
 * Import list of emails to suppression
 * @param {string[]|string} input 
 * @param {string} reason 
 */
export function importSuppression(input, reason = 'import') {
  const emails = Array.isArray(input) ? input : input.split(/[\r\n,;]+/);
  let count = 0;
  for (const raw of emails) {
    const clean = raw.trim().toLowerCase();
    if (clean && clean.includes('@')) {
      addSuppression(clean, reason);
      count++;
    }
  }
  return { imported: count };
}
