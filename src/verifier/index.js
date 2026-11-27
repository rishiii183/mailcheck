import { validateSyntax } from './syntax.js';
import { detectTypo } from './typo.js';
import { isDisposableDomain } from './disposable.js';
import { isRoleAccount } from './role.js';
import { lookupMx } from './mx.js';
import { probeSmtp, getPort25Status } from './smtp.js';
import { getCachedCatchAll, setCachedCatchAll } from './catchall.js';
import { PENALTIES, VERDICTS, calculateVerdict } from './score.js';
import { scheduleGreylistRetry, getGreylistRetryStatus } from './retries.js';
import { getDb } from '../db.js';
import { config } from '../config.js';

export { PENALTIES, VERDICTS };

// In-process result cache for single session (avoids repeat verification of same address)
const resultCache = new Map();
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute in-process cache

export function clearResultCache() {
  resultCache.clear();
}

/**
 * Verify a single email address following the 9-step pipeline.
 *
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
 *   checkedAt: string,
 *   status?: string
 * }>}
 */
export async function verifyEmail(rawEmail, options = {}) {
  const checks = [];
  const transcript = [];
  const checkedAt = new Date().toISOString();
  let suggestion = null;

  // ── 1. Syntax Check ────────────────────────────────────────────────────────
  const syntax = validateSyntax(rawEmail);
  if (!syntax.valid) {
    checks.push({ name: 'syntax', status: 'fail', detail: syntax.error || 'Invalid syntax', penalty: PENALTIES.SYNTAX_INVALID });
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
  checks.push({ name: 'syntax', status: 'pass', detail: 'RFC 5322 valid format' });

  // ── In-process cache check (skip full pipeline for recently verified addresses) ──
  if (!options.noCache) {
    const cached = resultCache.get(email);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }
  }

  // ── Steps 2–5: Run disposable + role + MX in parallel ──────────────────────
  const [dispResult, roleResult, mxResult] = await Promise.all([
    Promise.resolve(isDisposableDomain(domain)),
    Promise.resolve(isRoleAccount(local)),
    options.mockMx ? Promise.resolve(options.mockMx) : lookupMx(domain)
  ]);

  // ── 2. Typo Detection (with MX knowledge and allowlist) ─────────────────────
  const hasMxRecords = !mxResult.isDead && Boolean(mxResult.records && mxResult.records.length > 0);
  const typo = detectTypo(local, domain, { hasMx: hasMxRecords });

  if (typo.hasTypo) {
    suggestion = typo.suggestion;
    checks.push({
      name: 'typo',
      status: 'warn',
      detail: `Possible typo detected for domain "${domain}". Did you mean "${typo.suggestion}"?`,
      penalty: PENALTIES.TYPO
    });
  } else {
    checks.push({ name: 'typo', status: 'pass', detail: 'No common domain typo detected' });
  }

  // ── 3. Disposable Domain (early-exit) ──────────────────────────────────────
  if (dispResult) {
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
  checks.push({ name: 'disposable', status: 'pass', detail: 'Not a disposable email domain' });

  // ── 4. Role Account ─────────────────────────────────────────────────────────
  if (roleResult.isRole) {
    checks.push({
      name: 'role',
      status: 'warn',
      detail: `Generic role or department address ("${roleResult.role}")`,
      penalty: PENALTIES.ROLE_ACCOUNT
    });
  } else {
    checks.push({ name: 'role', status: 'pass', detail: 'Personal or individual mailbox' });
  }

  // ── 5. MX Lookup & DNS Failure Handling ────────────────────────────────────
  // 4.6 Rule: Timeouts, SERVFAIL, REFUSED -> verdict 'unknown' with reason, NOT undeliverable, NOT saved to DB
  if (mxResult.isTransientDnsError) {
    checks.push({
      name: 'mx',
      status: 'unknown',
      detail: `DNS lookup failed (${mxResult.dnsError})`
    });
    return saveAndReturnResult({
      email,
      verdict: VERDICTS.UNKNOWN,
      score: 50,
      reason: `DNS server failed to resolve domain: ${mxResult.dnsError}`,
      checks,
      suggestion,
      transcript,
      checkedAt
    }, true); // skipDb = true so transient DNS drops are never cached as undeliverable
  }

  // 4.6 Rule: Only ENOTFOUND/NXDOMAIN/ENODATA means dead domain
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
    checks.push({ name: 'mx', status: 'warn', detail: 'No MX record found; falling back to domain A/AAAA record', penalty: PENALTIES.FALLBACK_MX });
  } else {
    checks.push({ name: 'mx', status: 'pass', detail: `Found ${mxResult.records.length} MX record(s). Primary: ${mxResult.records[0].exchange}` });
  }

  // ── 6. Port 25 Outbound Check ───────────────────────────────────────────────
  const port25 = getPort25Status();
  const isPort25Blocked = options.simulatePort25Blocked || (!options.mockSmtp && !options.smtpPort && port25.checked && !port25.available);

  if (isPort25Blocked) {
    const cachedDomain = getCachedCatchAll(domain);
    const isCatchallCached = cachedDomain === true;

    checks.push({
      name: 'smtp',
      status: 'unknown',
      detail: 'Outbound port 25 is blocked — SMTP mailbox probe skipped',
      penalty: PENALTIES.UNKNOWN_SMTP
    });

    // 4.4 Rule: Never output a passing 'catchall' check unless probe ran. Otherwise status 'skip'.
    if (isCatchallCached) {
      checks.push({ name: 'catchall', status: 'warn', detail: 'Domain is catch-all (cached from prior probe)', penalty: PENALTIES.CATCHALL });
    } else {
      checks.push({ name: 'catchall', status: 'skip', detail: 'Catch-all check skipped (port 25 blocked; no prior probe)' });
    }

    let totalPenalty = PENALTIES.UNKNOWN_SMTP;
    const reasons = ['SMTP mailbox existence cannot be confirmed (port 25 blocked)'];

    if (isCatchallCached) {
      totalPenalty += PENALTIES.CATCHALL;
      reasons.push('Domain is catch-all (cached)');
    }
    if (roleResult.isRole) {
      totalPenalty += PENALTIES.ROLE_ACCOUNT;
      reasons.push(`Role/department address (${roleResult.role})`);
    }
    if (typo.hasTypo) {
      totalPenalty += PENALTIES.TYPO;
      reasons.push(`Possible domain typo (did you mean ${typo.suggestion}?)`);
    }
    if (mxResult.fallback) {
      totalPenalty += PENALTIES.FALLBACK_MX;
      reasons.push('No MX record — using A/AAAA fallback');
    }

    const score = Math.max(0, Math.min(100, 100 - totalPenalty));
    const verdict = isCatchallCached ? VERDICTS.RISKY : VERDICTS.UNKNOWN;
    const reason = reasons.join('; ');

    return saveAndReturnResult({
      email,
      verdict,
      score,
      reason,
      checks,
      suggestion,
      transcript: ['[Port 25 blocked: SMTP probe skipped; score based on DNS checks]'],
      checkedAt
    }, options.skipDb);
  }

  // ── 7. Catch-all Cache ──────────────────────────────────────────────────────
  const isHiddenProvider = ['outlook', 'yahoo', 'icloud'].includes(mxResult.provider);
  let cachedCatchall = getCachedCatchAll(domain);
  let isCatchall = cachedCatchall === true;
  const shouldCheckCatchall = !isHiddenProvider && (cachedCatchall === null);

  // ── 8. SMTP Probe (4.5: Probe Outlook/Yahoo/iCloud like everyone else!) ──────
  const smtpProbeResult = options.mockSmtp
    ? await options.mockSmtp(email, domain, mxResult.records)
    : await probeSmtp(email, domain, mxResult.records, {
        port: options.smtpPort || 25,
        timeoutMs: options.timeoutMs || config.verifier.smtpTimeoutMs,
        checkCatchall: shouldCheckCatchall,
        heloHost: options.heloHost,
        mailFrom: options.mailFrom
      });

  transcript.push(...(smtpProbeResult.transcript || []));

  let isGreylisted = false;
  let isBlocked = false;

  if (smtpProbeResult.success) {
    if (smtpProbeResult.isRejected) {
      // 4.2 Rule: Undeliverable ONLY for user-unknown signals
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
    } else if (smtpProbeResult.isBlocked) {
      // 4.2 Rule: Policy/block signals -> verdict 'unknown' with reason "Mail server blocked our probe"
      isBlocked = true;
      checks.push({
        name: 'smtp',
        status: 'unknown',
        detail: smtpProbeResult.detail || 'Mail server blocked our probe',
        penalty: PENALTIES.UNKNOWN_SMTP
      });
      checks.push({ name: 'catchall', status: 'skip', detail: 'Catch-all check skipped (probe blocked)' });

      const res = calculateVerdict(checks, { blockedProbe: true });
      return saveAndReturnResult({
        email,
        verdict: VERDICTS.UNKNOWN,
        score: res.score,
        reason: 'Mail server blocked our probe',
        checks,
        suggestion,
        transcript,
        checkedAt
      }, options.skipDb);
    } else if (smtpProbeResult.isGreylisted) {
      // 4.2 & 4.8 Rule: 4xx greylist -> store job to re-probe at +5, +15, +45 minutes
      isGreylisted = true;
      checks.push({
        name: 'smtp',
        status: 'warn',
        detail: `Server greylisted recipient (${smtpProbeResult.detail})`,
        penalty: PENALTIES.GREYLISTED
      });
      checks.push({ name: 'catchall', status: 'skip', detail: 'Catch-all check skipped (server greylisted probe)' });

      if (!options.isRetry) {
        scheduleGreylistRetry(email, 1, smtpProbeResult.detail);
      }

      const res = calculateVerdict(checks, { isGreylisted: true });
      return saveAndReturnResult({
        email,
        verdict: VERDICTS.UNKNOWN,
        score: res.score,
        reason: res.reason,
        checks,
        suggestion,
        transcript,
        checkedAt,
        status: 'retrying',
        isGreylisted: true
      }, options.skipDb);
    } else if (smtpProbeResult.isTargetAccepted) {
      checks.push({ name: 'smtp', status: 'pass', detail: 'Mailbox accepted by mail server (250 OK)' });

      if (cachedCatchall === null && smtpProbeResult.isCatchall !== undefined && !isHiddenProvider) {
        isCatchall = smtpProbeResult.isCatchall;
        setCachedCatchAll(domain, isCatchall, mxResult.provider);
      }
    }
  } else {
    checks.push({
      name: 'smtp',
      status: 'unknown',
      detail: smtpProbeResult.detail || 'SMTP probe could not connect to MX',
      penalty: PENALTIES.UNKNOWN_SMTP
    });
  }

  // ── 9. Catch-all evaluation ─────────────────────────────────────────────────
  // 4.4 & 4.5 Rule: No invented catch-all warning for hidden-status providers (Outlook/Yahoo/iCloud).
  // Never output a passing 'catchall' check unless the catch-all probe ran. Otherwise status 'skip'.
  if (isHiddenProvider) {
    checks.push({ name: 'catchall', status: 'skip', detail: `Catch-all detection skipped for privacy-masking provider (${mxResult.provider})` });
    isCatchall = false;
  } else if (isCatchall) {
    checks.push({ name: 'catchall', status: 'warn', detail: 'Domain is catch-all (accepts emails to any address)', penalty: PENALTIES.CATCHALL });
  } else if (smtpProbeResult.isCatchall === false || cachedCatchall === false) {
    checks.push({ name: 'catchall', status: 'pass', detail: 'Domain is not catch-all' });
  } else {
    checks.push({ name: 'catchall', status: 'skip', detail: 'Catch-all check skipped (SMTP probe not performed or not requested)' });
  }

  // ── 10. Provider Policy Check (4.5: Outlook/Yahoo/iCloud with 250 -> 'risky' with ONE penalty) ─
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
    isCatchall: !isHiddenProvider && isCatchall,
    isGreylisted,
    blockedProbe: isBlocked
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
  // Populate in-process result cache
  resultCache.set(result.email, { result, expiresAt: Date.now() + RESULT_CACHE_TTL_MS });

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
      // Ignore database logging errors in test or mock environments
    }
  }
  return result;
}

/**
 * Bulk verification processor with concurrent processing and progress notifications.
 * Runs up to `config.verifier.bulkConcurrency` (default 8) verifications in parallel.
 */
export async function verifyBulk(input, onProgress, options = {}) {
  let emailList = [];

  if (Array.isArray(input)) {
    emailList = input;
  } else if (typeof input === 'string') {
    const lines = input.split(/[\r\n,;]+/);
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/<([^>]+)>/);
      const email = match ? match[1].trim() : trimmed;
      if (email.includes('@')) emailList.push(email);
    }
  }

  const uniqueEmails = Array.from(new Set(emailList.map(e => e.trim().toLowerCase())));
  const total = uniqueEmails.length;
  const results = new Array(total);

  const concurrency = options.concurrency || config.verifier.bulkConcurrency || 8;
  let processed = 0;

  for (let batchStart = 0; batchStart < total; batchStart += concurrency) {
    const batch = uniqueEmails.slice(batchStart, batchStart + concurrency);

    const batchResults = await Promise.all(
      batch.map((email) => verifyEmail(email, options))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const idx = batchStart + j;
      results[idx] = batchResults[j];
      processed++;
      if (onProgress) {
        onProgress({
          processed,
          total,
          current: batchResults[j],
          percent: Math.round((processed / total) * 100)
        });
      }
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
