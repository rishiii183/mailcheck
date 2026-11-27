/**
 * Popular domains list to check for typos
 */
export const POPULAR_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
  'mail.com',
  'protonmail.com',
  'proton.me',
  'zoho.com',
  'live.com',
  'msn.com',
  'yandex.com',
  'gmx.com',
  'googlemail.com',
  'comcast.net',
  'sbcglobal.net'
];

/**
 * Legitimate regional and alternative domains near popular domains.
 * These domains must never be flagged as typos.
 */
export const TYPO_ALLOWLIST = new Set([
  'ymail.com',
  'googlemail.com',
  'rocketmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.it',
  'hotmail.es',
  'live.co.uk',
  'live.fr',
  'live.de',
  'live.com.au',
  'outlook.in',
  'outlook.fr',
  'outlook.de',
  'outlook.es',
  'outlook.it',
  'yahoo.co.in',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.it',
  'yahoo.es',
  'yahoo.in',
  'yahoo.ca',
  'yahoo.com.au',
  'yahoo.com.br'
]);

/**
 * Compute Damerau-Levenshtein distance between two strings
 * (supports insertion, deletion, substitution, and adjacent transposition)
 * @param {string} a 
 * @param {string} b 
 * @returns {number}
 */
export function damerauLevenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;

  const al = a.length;
  const bl = b.length;
  const d = [];

  for (let i = 0; i <= al; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= bl; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // deletion
        d[i][j - 1] + 1,       // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }

  return d[al][bl];
}

// Export classic alias
export const levenshteinDistance = damerauLevenshteinDistance;

/**
 * Detect typos against popular domain names.
 * 4.7 Rule: Legitimate regional domains in TYPO_ALLOWLIST are never flagged.
 * Flag ONLY when:
 *  - Distance is 1 from a popular domain (and domain is not in allowlist), OR
 *  - Distance is 2 AND domain has no MX records (options.hasMx === false).
 *
 * @param {string} local 
 * @param {string} domain 
 * @param {Object} [options]
 * @param {boolean} [options.hasMx]
 * @returns {{ hasTypo: boolean, suggestion: string | null }}
 */
export function detectTypo(local, domain, options = {}) {
  if (!domain) return { hasTypo: false, suggestion: null };
  const cleanDomain = domain.toLowerCase().trim();

  // If exact match to popular domain or in allowlist, never flag
  if (POPULAR_DOMAINS.includes(cleanDomain) || TYPO_ALLOWLIST.has(cleanDomain)) {
    return { hasTypo: false, suggestion: null };
  }

  let minDistance = Infinity;
  let bestMatch = null;

  for (const popular of POPULAR_DOMAINS) {
    const dist = damerauLevenshteinDistance(cleanDomain, popular);
    if (dist < minDistance) {
      minDistance = dist;
      bestMatch = popular;
    }
  }

  // 1. Distance 1 from a popular domain AND not on allowlist
  if (minDistance === 1 && bestMatch) {
    return {
      hasTypo: true,
      suggestion: `${local}@${bestMatch}`
    };
  }

  // 2. Distance 2: flag when domain has no MX records (options.hasMx === false) or options not specified
  if (minDistance === 2 && bestMatch && options.hasMx !== true) {
    return {
      hasTypo: true,
      suggestion: `${local}@${bestMatch}`
    };
  }

  return { hasTypo: false, suggestion: null };
}
