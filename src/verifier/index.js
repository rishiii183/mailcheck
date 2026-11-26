import { validateSyntax } from './syntax.js';
import { detectTypo } from './typo.js';
import { isDisposableDomain } from './disposable.js';
import { isRoleAccount } from './role.js';
import { lookupMx } from './mx.js';
import { probeSmtp, getPort25Status } from './smtp.js';
import { getCachedCatchAll, setCachedCatchAll } from './catchall.js';
import { PENALTIES, VERDICTS, calculateVerdict } from './score.js';
import { getDb } from '../db.js';

export { PENALTIES, VERDICTS };

/**
 * Verify a single email address following the 9-step pipeline
 * @param {string} rawEmail 
 * @param {Object} [options] 
 * @returns {Promise<{
 *   email: string,
 *   verdict: string,
 *   score: number,
 *   reason: string,
 *   checks: Array<{name: string, status: string, detail: string, penalty?: number}>,
 *   suggestion: string | null,
 *   transcript: string[],
 *   checkedAt: string
 * }>}
 */
export async function verifyEmail(rawEmail, options = {}) {
  const checks = [];
  const transcript = [];
  const checkedAt = new Date().toISOString();
  let suggestion = null;

  // 1. Syntax Check (RFC 5322 practical)
  const syntax = validateSyntax(rawEmail);
  if (!syntax.valid) {
    checks.push({
      name: 'syntax',
      status: 'fail',
      detail: syntax.error || 'Invalid syntax',
      penalty: PENALTIES.SYNTAX_INVALID
    });
    return saveAndReturnResult({
      email: (rawEmail || '').trim().toLowerCase(),
      verdict: VERDICTS.UNDELIVERABLE,
      score: 0,
      reason: `Syntax error: ${syntax.error}`,
      checks,
      suggestion: null,
      transcript,
      checkedAt
    }, options.skipDb);
  }

  const { email, local, domain } = syntax;
  checks.push({
    name: 'syntax',
    status: 'pass',
    detail: 'RFC 5322 valid format'
  });

  // 2. Typo Detection
  const typo = detectTypo(local, domain);
  if (typo.hasTypo) {
    suggestion = typo.suggestion;
    checks.push({
      name: 'typo',
      status: 'warn',
      detail: `Possible typo detected for domain "${domain}". Did you mean "${typo.suggestion}"?`,
      penalty: PENALTIES.TYPO
    });
  } else {
    checks.push({
      name: 'typo',
      status: 'pass',
      detail: 'No common domain typo detected'
    });
  }

  // 3. Disposable Domain Check
  if (isDisposableDomain(domain)) {
    checks.push({
      name: 'disposable',
      status: 'fail',
      detail: `Domain "${domain}" is a known temporary/disposable email provider`,
      penalty: PENALTIES.DISPOSABLE
    });
    return saveAndReturnResult({
      email,
      verdict: VERDICTS.UNDELIVERABLE,
      score: 0,
      reason: 'Disposable email address detected',
      checks,
      suggestion,
      transcript,
      checkedAt
    }, options.skipDb);
  }
  checks.push({
    name: 'disposable',
    status: 'pass',
    detail: 'Not a disposable email domain'
  });

  // 4. Role Account Check
  const role = isRoleAccount(local);
  if (role.isRole) {
    checks.push({
      name: 'role',
      status: 'warn',
      detail: `Generic role or department address ("${role.role}")`,
      penalty: PENALTIES.ROLE_ACCOUNT
    });
  } else {
    checks.push({
      name: 'role',
      status: 'pass',
      detail: 'Personal or individual mailbox'
    });
  }

  // 5. MX Lookup (with A/AAAA fallback)
  const mxResult = options.mockMx ? options.mockMx : await lookupMx(domain);
  if (mxResult.isDead || !mxResult.records || mxResult.records.length === 0) {
    checks.push({
      name: 'mx',
      status: 'fail',
      detail: `Domain "${domain}" has no MX or A/AAAA records`,
      penalty: PENALTIES.DEAD_DOMAIN
    });
    return saveAndReturnResult({
      email,
      verdict: VERDICTS.UNDELIVERABLE,
      score: 0,
      reason: 'Dead domain (no mail servers configured)',
      checks,
      suggestion,
      transcript,
      checkedAt
    }, options.skipDb);
  }

  if (mxResult.fallback) {
    checks.push({
      name: 'mx',
      status: 'warn',
      detail: 'No MX record found; falling back to domain A/AAAA record',
      penalty: PENALTIES.FALLBACK_MX
    });
  } else {
    checks.push({
      name: 'mx',
      status: 'pass',
      detail: `Found ${mxResult.records.length} MX record(s). Primary: ${mxResult.records[0].exchange}`
    });
  }

  // 6. Check Port 25 Outbound Availability
  const port25 = getPort25Status();
  const isPort25Blocked = options.simulatePort25Blocked || (!options.mockSmtp && !options.smtpPort && port25.checked && !port25.available);
  if (isPort25Blocked) {
    checks.push({
      name: 'smtp',
      status: 'unknown',
      detail: 'Outbound port 25 is blocked or restricted by host/ISP',
      penalty: PENALTIES.UNKNOWN_SMTP
    });

    const { score, verdict, reason } = calculateVerdict(checks, {
      port25Blocked: true
    });

    return saveAndReturnResult({
      email,
      verdict,
      score,
      reason,
      checks,
      suggestion,
      transcript: ['[Port 25 blocked: SMTP probe skipped]'],
      checkedAt
    }, options.skipDb);
  }

  // 7. Check Cached Catch-All
  let cachedCatchall = getCachedCatchAll(domain);
  let isCatchall = cachedCatchall === true;

  // 8. SMTP Probe
  const smtpProbeResult = options.mockSmtp
    ? await options.mockSmtp(email, domain, mxResult.records)
    : await probeSmtp(email, domain, mxResult.records, {
        port: options.smtpPort || 25,
        timeoutMs: options.timeoutMs,
        checkCatchall: cachedCatchall === null
      });

  transcript.push(...(smtpProbeResult.transcript || []));

  let isGreylisted = false;

  if (smtpProbeResult.success) {
    if (smtpProbeResult.isRejected) {
      checks.push({
        name: 'smtp',
        status: 'fail',
        detail: smtpProbeResult.detail || 'Mailbox does not exist (5xx reject)',
        penalty: PENALTIES.SMTP_REJECT
      });
      return saveAndReturnResult({
        email,
        verdict: VERDICTS.UNDELIVERABLE,
        score: 0,
        reason: `SMTP rejected: ${smtpProbeResult.detail}`,
        checks,
        suggestion,
        transcript,
        checkedAt
      }, options.skipDb);
    } else if (smtpProbeResult.isGreylisted) {
      isGreylisted = true;
      checks.push({
        name: 'smtp',
        status: 'warn',
        detail: `Server greylisted recipient (${smtpProbeResult.detail})`,
        penalty: PENALTIES.GREYLISTED
      });
    } else if (smtpProbeResult.isTargetAccepted) {
      checks.push({
        name: 'smtp',
        status: 'pass',
        detail: 'Mailbox accepted by mail server (250 OK)'
      });

      if (cachedCatchall === null && smtpProbeResult.isCatchall !== undefined) {
        isCatchall = smtpProbeResult.isCatchall;
        setCachedCatchAll(domain, isCatchall, mxResult.provider);
      }
    }
  } else {
    // Probe could not complete
    checks.push({
      name: 'smtp',
      status: 'unknown',
      detail: smtpProbeResult.detail || 'SMTP probe could not connect to MX',
      penalty: PENALTIES.UNKNOWN_SMTP
    });
  }

  // Catch-all evaluation
  if (isCatchall) {
    checks.push({
      name: 'catchall',
      status: 'warn',
      detail: 'Domain is catch-all (accepts emails to any address)',
      penalty: PENALTIES.CATCHALL
    });
  } else {
    checks.push({
      name: 'catchall',
      status: 'pass',
      detail: 'Domain is not catch-all'
    });
  }

  // 9. Providers that conceal true mailbox existence (Outlook, Hotmail, Yahoo, iCloud)
  const isHiddenProvider = ['outlook', 'yahoo', 'icloud'].includes(mxResult.provider);
  if (isHiddenProvider && smtpProbeResult.isTargetAccepted) {
    checks.push({
      name: 'provider_policy',
      status: 'warn',
      detail: `Provider (${mxResult.provider}) conceals recipient status; accepts all RCPT commands indiscriminately`,
      penalty: PENALTIES.HIDDEN_MAILBOX_PROVIDER
    });
  }

  const { score, verdict, reason } = calculateVerdict(checks, {
    providerHiddenStatus: isHiddenProvider && smtpProbeResult.isTargetAccepted,
    isCatchall,
    isGreylisted
  });

  return saveAndReturnResult({
    email,
    verdict,
    score,
    reason,
    checks,
    suggestion,
    transcript,
    checkedAt
  }, options.skipDb);
}

function saveAndReturnResult(result, skipDb = false) {
  if (!skipDb) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO verification_results (
          email, verdict, score, reason, checks_json, suggestion, transcript_json, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(email) DO UPDATE SET
          verdict = excluded.verdict,
          score = excluded.score,
          reason = excluded.reason,
          checks_json = excluded.checks_json,
          suggestion = excluded.suggestion,
          transcript_json = excluded.transcript_json,
          checked_at = CURRENT_TIMESTAMP
      `).run(
        result.email,
        result.verdict,
        result.score,
        result.reason,
        JSON.stringify(result.checks),
        result.suggestion || null,
        JSON.stringify(result.transcript)
      );
    } catch (err) {
      console.error('Error caching verification result:', err.message);
    }
  }
  return result;
}

/**
 * Bulk verification processor with progress notifications
 * @param {string[] | string} input CSV/TXT or Array of emails
 * @param {Function} [onProgress] callback (processed, total, currentResult)
 * @param {Object} [options]
 */
export async function verifyBulk(input, onProgress, options = {}) {
  let emailList = [];

  if (Array.isArray(input)) {
    emailList = input;
  } else if (typeof input === 'string') {
    // Parse lines or comma separated values
    const lines = input.split(/[\r\n,;]+/);
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Extract email from line if formatted as "John Doe <john@example.com>"
      const match = trimmed.match(/<([^>]+)>/);
      const email = match ? match[1].trim() : trimmed;
      if (email.includes('@')) {
        emailList.push(email);
      }
    }
  }

  // Deduplicate case-insensitively
  const uniqueEmails = Array.from(new Set(emailList.map(e => e.trim().toLowerCase())));
  const total = uniqueEmails.length;
  const results = [];

  for (let i = 0; i < total; i++) {
    const email = uniqueEmails[i];
    const res = await verifyEmail(email, options);
    results.push(res);
    if (onProgress) {
      onProgress({
        processed: i + 1,
        total,
        current: res,
        percent: Math.round(((i + 1) / total) * 100)
      });
    }
  }

  return {
    total,
    results,
    summary: {
      deliverable: results.filter(r => r.verdict === VERDICTS.DELIVERABLE).length,
      risky: results.filter(r => r.verdict === VERDICTS.RISKY).length,
      undeliverable: results.filter(r => r.verdict === VERDICTS.UNDELIVERABLE).length,
      unknown: results.filter(r => r.verdict === VERDICTS.UNKNOWN).length
    }
  };
}
