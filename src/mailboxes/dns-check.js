import dns from 'dns/promises';
import { getDb } from '../db.js';

const COMMON_DKIM_SELECTORS = ['default', 'google', 'k1', 's1', 's2', 'mail', 'selector1', 'smtp', 'dkim'];

/**
 * Perform comprehensive DNS health check for a domain / mailbox
 * @param {string} domain 
 * @param {number} [mailboxId] 
 * @param {Object} [dnsClient] injected for testing
 */
export async function checkMailboxDns(domain, mailboxId = null, dnsClient = dns) {
  const cleanDomain = (domain || '').toLowerCase().trim();
  const result = {
    domain: cleanDomain,
    spf: { status: 'fail', record: null, detail: '' },
    dkim: { status: 'warn', selector: null, record: null, detail: '' },
    dmarc: { status: 'warn', record: null, detail: '' },
    mx: { status: 'fail', records: [], detail: '' },
    canSendCampaign: false,
    checkedAt: new Date().toISOString()
  };

  // 1. Check SPF
  try {
    const txtRecords = await dnsClient.resolveTxt(cleanDomain);
    const flatRecords = txtRecords.map(r => (Array.isArray(r) ? r.join('') : String(r)));
    const spfRecord = flatRecords.find(r => r.startsWith('v=spf1'));

    if (spfRecord) {
      result.spf.record = spfRecord;
      if (spfRecord.includes('~all') || spfRecord.includes('-all') || spfRecord.includes('?all') || spfRecord.includes('+all')) {
        result.spf.status = 'pass';
        result.spf.detail = 'Valid SPF record detected with qualifier';
      } else {
        result.spf.status = 'warn';
        result.spf.detail = 'SPF record detected but missing proper all-qualifier (~all or -all)';
      }
    } else {
      result.spf.status = 'fail';
      result.spf.detail = `Missing SPF record. Add TXT for "${cleanDomain}": "v=spf1 include:_spf.google.com ~all" (adjust for your host)`;
    }
  } catch (err) {
    result.spf.status = 'fail';
    result.spf.detail = `Failed to query SPF TXT records: ${err.message}`;
  }

  // 2. Check DKIM (6.1: If dkim_selector set on mailbox, check only that selector first)
  let customSelector = null;
  if (mailboxId) {
    try {
      const db = getDb();
      const mb = db.prepare('SELECT dkim_selector FROM mailboxes WHERE id = ?').get(mailboxId);
      if (mb && mb.dkim_selector && mb.dkim_selector.trim()) {
        customSelector = mb.dkim_selector.trim();
      }
    } catch {}
  }

  const selectorsToCheck = customSelector
    ? [customSelector, ...COMMON_DKIM_SELECTORS.filter(s => s !== customSelector)]
    : COMMON_DKIM_SELECTORS;

  let dkimFound = false;
  for (const selector of selectorsToCheck) {
    try {
      const dkimHost = `${selector}._domainkey.${cleanDomain}`;
      const dkimTxt = await dnsClient.resolveTxt(dkimHost);
      const flatDkim = dkimTxt.map(r => (Array.isArray(r) ? r.join('') : String(r)));
      const foundRecord = flatDkim.find(r => r.includes('v=DKIM1') || r.includes('p='));

      if (foundRecord) {
        result.dkim.status = 'pass';
        result.dkim.selector = selector;
        result.dkim.record = foundRecord;
        result.dkim.detail = `DKIM record verified on selector "${selector}"`;
        dkimFound = true;
        break;
      }
    } catch {
      // Continue checking other selectors
    }
  }

  if (!dkimFound) {
    result.dkim.status = 'fail';
    result.dkim.detail = `No DKIM public key found on selectors (${selectorsToCheck.slice(0, 5).join(', ')}). Configure DKIM in your email provider.`;
  }

  // 3. Check DMARC
  try {
    const dmarcHost = `_dmarc.${cleanDomain}`;
    const dmarcTxt = await dnsClient.resolveTxt(dmarcHost);
    const flatDmarc = dmarcTxt.map(r => (Array.isArray(r) ? r.join('') : String(r)));
    const dmarcRecord = flatDmarc.find(r => r.startsWith('v=DMARC1'));

    if (dmarcRecord) {
      result.dmarc.record = dmarcRecord;
      result.dmarc.status = 'pass';
      result.dmarc.detail = 'Valid DMARC policy detected';
    } else {
      result.dmarc.status = 'warn';
      result.dmarc.detail = `Missing DMARC policy. Add TXT for "_dmarc.${cleanDomain}": "v=DMARC1; p=none; rua=mailto:dmarc@${cleanDomain}"`;
    }
  } catch {
    result.dmarc.status = 'warn';
    result.dmarc.detail = `No DMARC record found at _dmarc.${cleanDomain}. Recommended to protect sender reputation.`;
  }

  // 4. Check MX
  try {
    const mxRecords = await dnsClient.resolveMx(cleanDomain);
    if (Array.isArray(mxRecords) && mxRecords.length > 0) {
      result.mx.status = 'pass';
      result.mx.records = mxRecords;
      result.mx.detail = `${mxRecords.length} active MX server(s) configured`;
    } else {
      result.mx.status = 'fail';
      result.mx.detail = `No MX records found for domain "${cleanDomain}"`;
    }
  } catch (err) {
    result.mx.status = 'fail';
    result.mx.detail = `Failed to query MX records: ${err.message}`;
  }

  // Rule: Do not allow campaigns from a mailbox whose SPF or DKIM fails! Warn on missing DMARC.
  result.canSendCampaign = result.spf.status !== 'fail' && result.dkim.status !== 'fail';

  // Persist check if mailboxId is provided
  if (mailboxId) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO mailbox_dns_checks (
          mailbox_id, domain, spf_status, spf_record, spf_detail,
          dkim_status, dkim_selector, dkim_record, dkim_detail,
          dmarc_status, dmarc_record, dmarc_detail,
          mx_status, mx_records_json, mx_detail, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        mailboxId,
        cleanDomain,
        result.spf.status,
        result.spf.record,
        result.spf.detail,
        result.dkim.status,
        result.dkim.selector,
        result.dkim.record,
        result.dkim.detail,
        result.dmarc.status,
        result.dmarc.record,
        result.dmarc.detail,
        result.mx.status,
        JSON.stringify(result.mx.records),
        result.mx.detail
      );
    } catch (err) {
      console.error('Error saving mailbox DNS check:', err.message);
    }
  }

  return result;
}

/**
 * Check whether a mailbox has passing DNS records (SPF & DKIM must not fail)
 * @param {number} mailboxId 
 * @returns {{ canSend: boolean, spf: string|null, dkim: string|null }}
 */
export function canMailboxSend(mailboxId) {
  try {
    const db = getDb();
    // 6.1 Rule: Per-mailbox override "Allow sending despite DKIM/SPF failure"
    const mb = db.prepare('SELECT allow_failed_dns FROM mailboxes WHERE id = ?').get(mailboxId);
    if (mb && mb.allow_failed_dns) {
      return { canSend: true, override: true, spf: 'override', dkim: 'override' };
    }

    const row = db.prepare(`
      SELECT spf_status, dkim_status, dmarc_status, mx_status
      FROM mailbox_dns_checks
      WHERE mailbox_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(mailboxId);

    if (!row) {
      // Default to allowed if not yet checked
      return { canSend: true, spf: 'pass', dkim: 'pass' };
    }

    const canSend = row.spf_status !== 'fail' && row.dkim_status !== 'fail';
    return {
      canSend,
      spf: row.spf_status,
      dkim: row.dkim_status,
      dmarc: row.dmarc_status
    };
  } catch {
    return { canSend: true, spf: 'pass', dkim: 'pass' };
  }
}

