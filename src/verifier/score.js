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
 * Calculates score and determines verdict based on pipeline checks
 * @param {Array<{name: string, status: string, detail: string, penalty?: number}>} checks 
 * @param {Object} context 
 * @returns {{ score: number, verdict: string, reason: string }}
 */
export function calculateScoreAndVerdict(checks, context = {}) {
  // Check for unknown status first (e.g., port 25 blocked or connection failure)
  const isPort25Blocked = context.port25Blocked || checks.some(c => c.name === 'smtp' && c.status === 'unknown');
  
  // Hard failure checks that make an email immediately undeliverable
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

  // If port 25 could not complete probe and no hard failure earlier
  if (isPort25Blocked && (!smtpCheck || smtpCheck.status === 'unknown')) {
    return {
      score: 50,
      verdict: VERDICTS.UNKNOWN,
      reason: 'Port 25 outbound blocked or SMTP probe could not complete'
    };
  }

  // Calculate penalties from secondary risk factors
  let totalPenalty = 0;
  const reasons = [];

  for (const check of checks) {
    if (check.status === 'warn' && check.penalty) {
      totalPenalty += check.penalty;
      reasons.push(check.detail);
    }
  }

  // Provider hiding mailbox status (Outlook, Hotmail, Yahoo, iCloud)
  if (context.providerHiddenStatus) {
    totalPenalty += PENALTIES.HIDDEN_MAILBOX_PROVIDER;
    reasons.push('Provider conceals true recipient status (accepts all RCPT commands)');
  }

  const score = Math.max(0, Math.min(100, 100 - totalPenalty));

  // Determine verdict based on score and conditions
  let verdict = VERDICTS.DELIVERABLE;
  let finalReason = 'Email is valid and deliverable';

  if (context.providerHiddenStatus || context.isCatchall || context.isGreylisted || score < 80) {
    verdict = VERDICTS.RISKY;
    finalReason = reasons.length > 0 ? reasons.join('; ') : 'Mailbox marked risky due to provider policies or potential delivery constraints';
  }

  return { score, verdict, reason: finalReason };
}

export const calculateVerdict = calculateScoreAndVerdict;
