import { validateSyntax } from './syntax.js';
import { detectTypo } from './typo.js';
import { isDisposableDomain } from './disposable.js';
import { isRoleAccount } from './role.js';
import { lookupMx } from './mx.js';
import { probeSmtp, getPort25Status } from './smtp.js';
import { getCachedCatchAll, setCachedCatchAll } from './catchall.js';
import { PENALTIES, VERDICTS, calculateVerdict } from './score.js';
import { getDb } from '../db.js';
import { config } from '../config.js';

export { PENALTIES, VERDICTS };

// In-process result cache for single session (avoids repeat verification of same address)
const resultCache = new Map();
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute in-process cache

/**
 * Verify a single email address following the 9-step pipeline (optimized).
 * Key optimizations:
 *  1. In-process cache: skip full pipeline if recently verified (<5 min)
 *  2. Steps 2–4 (typo, disposable, role) run in parallel via Promise.all
 *  3. SMTP timeout reduced from 12s → 7s (configurable via SMTP_TIMEOUT_MS)
 *  4. MX lookup uses a 10-min in-process DNS cache (see mx.js)
 *  5. A/AAAA fallback lookups are now parallel (Promise.allSettled)
 *  6. Known hidden-provider domains (Outlook/Yahoo/iCloud) skip SMTP probe fast
 *  7. Catch-all step is skipped when domain result is already in SQLite cache
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
    return saveAndReturnResult({ email: (rawEmail || '').trim().toLowerCase(), verdict: VERDICTS.UNDELIVERABLE, score: 0, reason: `Syntax error: ${syntax.error}`, checks, suggestion: null, transcript, checkedAt }, options.skipDb);
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

  // ── Steps 2–4: Run typo + disposable + role + MX in parallel ───────────────
  // Typo, disposable, and role are pure synchronous lookups — they can't block.
  // MX is the first real I/O call; run it simultaneously with the sync checks.
  const [typo, dispResult, roleResult, mxResult] = await Promise.all([
    Promise.resolve(detectTypo(local, domain)),
    Promise.resolve(isDisposableDomain(domain)),
    Promise.resolve(isRoleAccount(local)),
    options.mockMx ? Promise.resolve(options.mockMx) : lookupMx(domain)
  ]);

  // ── 2. Typo Detection ───────────────────────────────────────────────────────
  if (typo.hasTypo) {
    suggestion = typo.suggestion;
    checks.push({ name: 'typo', status: 'warn', detail: `Possible typo detected for domain "${domain}". Did you mean "${typo.suggestion}"?`, penalty: PENALTIES.TYPO });
  } else {
    checks.push({ name: 'typo', status: 'pass', detail: 'No common domain typo detected' });
  }

  // ── 3. Disposable Domain (early-exit) ──────────────────────────────────────
  if (dispResult) {
    checks.push({ name: 'disposable', status: 'fail', detail: `Domain "${domain}" is a known temporary/disposable email provider`, penalty: PENALTIES.DISPOSABLE });
    return saveAndReturnResult({ email, verdict: VERDICTS.UNDELIVERABLE, score: 0, reason: 'Disposable email address detected', checks, suggestion, transcript, checkedAt }, options.skipDb);
  }
  checks.push({ name: 'disposable', status: 'pass', detail: 'Not a disposable email domain' });

  // ── 4. Role Account ─────────────────────────────────────────────────────────
  if (roleResult.isRole) {
    checks.push({ name: 'role', status: 'warn', detail: `Generic role or department address ("${roleResult.role}")`, penalty: PENALTIES.ROLE_ACCOUNT });
  } else {
    checks.push({ name: 'role', status: 'pass', detail: 'Personal or individual mailbox' });
  }

  // ── 5. MX Lookup ────────────────────────────────────────────────────────────
  if (mxResult.isDead || !mxResult.records || mxResult.records.length === 0) {
    checks.push({ name: 'mx', status: 'fail', detail: `Domain "${domain}" has no MX or A/AAAA records`, penalty: PENALTIES.DEAD_DOMAIN });
    return saveAndReturnResult({ email, verdict: VERDICTS.UNDELIVERABLE, score: 0, reason: 'Dead domain (no mail servers configured)', checks, suggestion, transcript, checkedAt }, options.skipDb);
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
    // Even when port 25 is blocked, check the domain-level cache (catch-all, provider)
    // so we can give a richer verdict instead of a flat UNKNOWN 50/100.
    const cachedDomain = getCachedCatchAll(domain);
    const isCatchallCached = cachedDomain === true;

    checks.push({
      name: 'smtp',
      status: 'unknown',
      detail: 'Outbound port 25 is blocked — SMTP mailbox probe skipped',
      penalty: PENALTIES.UNKNOWN_SMTP
    });

    if (isCatchallCached) {
      checks.push({ name: 'catchall', status: 'warn', detail: 'Domain is catch-all (cached from prior probe)', penalty: PENALTIES.CATCHALL });
    } else if (cachedDomain === false) {
      checks.push({ name: 'catchall', status: 'pass', detail: 'Domain is not catch-all (cached from prior probe)' });
    } else {
      checks.push({ name: 'catchall', status: 'unknown', detail: 'Catch-all status unknown (port 25 blocked; no prior cache)' });
    }

    // Build a real score from what we DO know (syntax ✓ disposable ✓ MX ✓ role ✓)
    // rather than always returning the flat 50 / UNKNOWN default.
    let totalPenalty = PENALTIES.UNKNOWN_SMTP; // 30 pts for no SMTP confirmation
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
    // With only UNKNOWN_SMTP penalty: 70/100 (much better than flat 50)
    // With catchall too: 50/100 — matches competitor's 55/100 range
    const verdict = isCatchallCached ? VERDICTS.RISKY : VERDICTS.UNKNOWN;
    const reason = reasons.join('; ');

    return saveAndReturnResult({
      email, verdict, score, reason, checks, suggestion,
      transcript: ['[Port 25 blocked: SMTP probe skipped; score based on DNS checks]'],
      checkedAt
    }, options.skipDb);
  }

  // ── Fast-path: Known hidden-provider — mark risky immediately without probing ──
  // Outlook/Yahoo/iCloud always return 250 so a live SMTP probe wastes time and
  // yields a misleading result. Skip straight to verdict.
  const isHiddenProvider = ['outlook', 'yahoo', 'icloud'].includes(mxResult.provider);
  if (isHiddenProvider && !options.mockSmtp) {
    checks.push({ name: 'smtp', status: 'warn', detail: `Provider (${mxResult.provider}) accepts all RCPT commands; true mailbox status is concealed`, penalty: PENALTIES.HIDDEN_MAILBOX_PROVIDER });
    checks.push({ name: 'catchall', status: 'warn', detail: 'Catch-all detection skipped for privacy-masking provider', penalty: PENALTIES.CATCHALL });
    checks.push({ name: 'provider_policy', status: 'warn', detail: `Provider (${mxResult.provider}) conceals recipient status; accepts all RCPT commands indiscriminately`, penalty: PENALTIES.HIDDEN_MAILBOX_PROVIDER });
    transcript.push(`[SMTP probe skipped: ${mxResult.provider} is a known hidden-status provider]`);
    const { score, verdict, reason } = calculateVerdict(checks, { providerHiddenStatus: true, isCatchall: false, isGreylisted: false });
    return saveAndReturnResult({ email, verdict, score, reason, checks, suggestion, transcript, checkedAt }, options.skipDb);
  }

  // ── 7. Catch-all Cache ──────────────────────────────────────────────────────
  let cachedCatchall = getCachedCatchAll(domain);
  let isCatchall = cachedCatchall === true;

  // ── 8. SMTP Probe ───────────────────────────────────────────────────────────
  const smtpProbeResult = options.mockSmtp
    ? await options.mockSmtp(email, domain, mxResult.records)
    : await probeSmtp(email, domain, mxResult.records, {
        port: options.smtpPort || 25,
        timeoutMs: options.timeoutMs || config.verifier.smtpTimeoutMs,
        checkCatchall: cachedCatchall === null
      });

  transcript.push(...(smtpProbeResult.transcript || []));

  let isGreylisted = false;

  if (smtpProbeResult.success) {
    if (smtpProbeResult.isRejected) {
      checks.push({ name: 'smtp', status: 'fail', detail: smtpProbeResult.detail || 'Mailbox does not exist (5xx reject)', penalty: PENALTIES.SMTP_REJECT });
      return saveAndReturnResult({ email, verdict: VERDICTS.UNDELIVERABLE, score: 0, reason: `SMTP rejected: ${smtpProbeResult.detail}`, checks, suggestion, transcript, checkedAt }, options.skipDb);
    } else if (smtpProbeResult.isGreylisted) {
      isGreylisted = true;
      checks.push({ name: 'smtp', status: 'warn', detail: `Server greylisted recipient (${smtpProbeResult.detail})`, penalty: PENALTIES.GREYLISTED });
    } else if (smtpProbeResult.isTargetAccepted) {
      checks.push({ name: 'smtp', status: 'pass', detail: 'Mailbox accepted by mail server (250 OK)' });
      if (cachedCatchall === null && smtpProbeResult.isCatchall !== undefined) {
        isCatchall = smtpProbeResult.isCatchall;
        setCachedCatchAll(domain, isCatchall, mxResult.provider);
      }
    }
  } else {
    checks.push({ name: 'smtp', status: 'unknown', detail: smtpProbeResult.detail || 'SMTP probe could not connect to MX', penalty: PENALTIES.UNKNOWN_SMTP });
  }

  // ── Catch-all evaluation ────────────────────────────────────────────────────
  if (isCatchall) {
    checks.push({ name: 'catchall', status: 'warn', detail: 'Domain is catch-all (accepts emails to any address)', penalty: PENALTIES.CATCHALL });
  } else {
    checks.push({ name: 'catchall', status: 'pass', detail: 'Domain is not catch-all' });
  }

  // ── 9. Provider Policy Check (non-hidden providers) ─────────────────────────
  if (isHiddenProvider && smtpProbeResult.isTargetAccepted) {
    checks.push({ name: 'provider_policy', status: 'warn', detail: `Provider (${mxResult.provider}) conceals recipient status; accepts all RCPT commands indiscriminately`, penalty: PENALTIES.HIDDEN_MAILBOX_PROVIDER });
  }

  const { score, verdict, reason } = calculateVerdict(checks, {
    providerHiddenStatus: isHiddenProvider && smtpProbeResult.isTargetAccepted,
    isCatchall,
    isGreylisted
  });

  return saveAndReturnResult({ email, verdict, score, reason, checks, suggestion, transcript, checkedAt }, options.skipDb);
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
      console.error('Error caching verification result:', err.message);
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

  // Deduplicate case-insensitively
  const uniqueEmails = Array.from(new Set(emailList.map(e => e.trim().toLowerCase())));
  const total = uniqueEmails.length;
  const results = new Array(total);

  // Run in batches to maintain back-pressure while still parallelizing
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
