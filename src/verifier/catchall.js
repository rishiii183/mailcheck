import { getDb } from '../db.js';

/**
 * Get domain catchall and provider cache if valid within 24 hours
 */
export function getDomainCache(domain) {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT is_catchall, mx_records_json, provider, updated_at
      FROM domain_cache
      WHERE domain = ? AND updated_at > datetime('now', '-24 hours')
    `).get(domain.toLowerCase());

    if (row) {
      return {
        cached: true,
        isCatchall: row.is_catchall === 1,
        mxRecords: row.mx_records_json ? JSON.parse(row.mx_records_json) : null,
        provider: row.provider
      };
    }
  } catch (err) {
    // If DB not initialized or test environment
  }
  return { cached: false };
}

/**
 * Save or update domain cache for 24 hours
 */
export function setDomainCache(domain, { isCatchall, mxRecords, provider }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO domain_cache (domain, is_catchall, mx_records_json, provider, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(domain) DO UPDATE SET
        is_catchall = excluded.is_catchall,
        mx_records_json = excluded.mx_records_json,
        provider = excluded.provider,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      domain.toLowerCase(),
      isCatchall ? 1 : 0,
      mxRecords ? JSON.stringify(mxRecords) : null,
      provider || 'generic'
    );
  } catch (err) {
    // Ignore cache persistence errors
  }
}

export function getCachedCatchAll(domain) {
  const cache = getDomainCache(domain);
  if (cache.cached) {
    return cache.isCatchall;
  }
  return null;
}

export function setCachedCatchAll(domain, isCatchall, provider = 'generic') {
  setDomainCache(domain, { isCatchall, provider });
}

