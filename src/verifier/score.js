/**
 * Named penalty constants for email scoring (0 to 100)
 */
export const PENALTIES = {
  SYNTAX_INVALID: 100,
  DISPOSABLE: 100,
  DEAD_DOMAIN: 100,
  SMTP_REJECT: 100,
  TYPO: 30,
  GREYLISTED: 25,
  CATCHALL: 20,
  ROLE_ACCOUNT: 15,
  HIDDEN_MAILBOX_PROVIDER: 15,
  FALLBACK_MX: 20,
  UNKNOWN_SMTP: 30
};

export const VERDICTS = {
  DELIVERABLE: 'deliverable',
  RISKY: 'risky',
  UNDELIVERABLE: 'undeliverable',
  UNKNOWN: 'unknown'
};

/**
 * Calculates score and determines verdict based on pipeline checks.
 * Single source of truth for penalties and scoring.
 *
 * @param {Array<{name: string, status: string, detail: string, penalty?: number}>} checks 
 * @param {Object} context 
 * @returns {{ score: number, verdict: string, reason: string }}
 */
export function calculateScoreAndVerdict(checks, context = {}) {
  // 1. Hard failure checks that make an email immediately undeliverable (Score: 0)
  const syntaxCheck = checks.find(c => c.name === 'syntax');
  if (syntaxCheck && syntaxCheck.status === 'fail') {
    return {
      score: 0,
      verdict: VERDICTS.UNDELIVERABLE,
      reason: `Syntax error: ${syntaxCheck.detail}`
    };
  }

  const disposableCheck = checks.find(c => c.name === 'disposable');
  if (disposableCheck && disposableCheck.status === 'fail') {
    return {
      score: 0,
      verdict: VERDICTS.UNDELIVERABLE,
      reason: 'Disposable or temporary email address detected'
    };
  }

  const mxCheck = checks.find(c => c.name === 'mx');
  if (mxCheck && mxCheck.status === 'fail') {
    return {
      score: 0,
      verdict: VERDICTS.UNDELIVERABLE,
      reason: 'Dead domain: no MX or A/AAAA records exist'
    };
  }

  const smtpCheck = checks.find(c => c.name === 'smtp');
  if (smtpCheck && smtpCheck.status === 'fail') {
    return {
      score: 0,
      verdict: VERDICTS.UNDELIVERABLE,
      reason: `Mailbox does not exist (SMTP rejected: ${smtpCheck.detail})`
    };
  }

  // 2. Policy / Block signals (5.7.x or blocked probe) -> Verdict UNKNOWN
  const isProbeBlocked =
    context.blockedProbe ||
    (smtpCheck && smtpCheck.status === 'unknown' && /(blocked|blacklist|spamhaus|access denied|banned|reputation|policy)/i.test(smtpCheck.detail || ''));

  // 3. Calculate penalties from secondary risk factors (deduplicated per check name)
  let totalPenalty = 0;
  const reasons = [];
  const countedChecks = new Set();

  for (const check of checks) {
    if ((check.status === 'warn' || check.status === 'unknown') && check.penalty) {
      if (!countedChecks.has(check.name)) {
        countedChecks.add(check.name);
        totalPenalty += check.penalty;
        reasons.push(check.detail);
      }
    }
  }

  // Provider hiding mailbox status (Outlook, Hotmail, Yahoo, iCloud)
  // Deduplicate: only add if not already counted via 'provider_policy' check
  if (context.providerHiddenStatus && !countedChecks.has('provider_policy')) {
    countedChecks.add('provider_policy');
    totalPenalty += PENALTIES.HIDDEN_MAILBOX_PROVIDER;
    reasons.push('Provider conceals true recipient status (accepts all RCPT commands)');
  }

  const score = Math.max(0, Math.min(100, 100 - totalPenalty));

  // 4. Determine final verdict
  if (isProbeBlocked) {
    return {
      score,
      verdict: VERDICTS.UNKNOWN,
      reason: 'Mail server blocked our probe'
    };
  }

  if (context.isGreylisted) {
    return {
      score,
      verdict: VERDICTS.UNKNOWN,
      reason: reasons.length > 0 ? reasons.join('; ') : 'Server greylisted probe (retrying)'
    };
  }

  const isPort25Blocked = context.port25Blocked || (smtpCheck && smtpCheck.status === 'unknown');

  let verdict = VERDICTS.DELIVERABLE;
  let finalReason = 'Email is valid and deliverable';

  if (context.providerHiddenStatus || context.isCatchall || score < 80) {
    verdict = VERDICTS.RISKY;
    finalReason = reasons.length > 0 ? reasons.join('; ') : 'Mailbox marked risky due to provider policies or potential delivery constraints';
  }

  if (isPort25Blocked && verdict === VERDICTS.DELIVERABLE) {
    verdict = VERDICTS.UNKNOWN;
    finalReason = reasons.length > 0 ? reasons.join('; ') : 'SMTP mailbox existence cannot be confirmed (port 25 blocked)';
  }

  return { score, verdict, reason: finalReason };
}

export const calculateVerdict = calculateScoreAndVerdict;
