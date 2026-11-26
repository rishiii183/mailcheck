/**
 * Popular domains list to check for typos
 */
const POPULAR_DOMAINS = [
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
 * Compute Levenshtein distance between two strings
 * @param {string} a 
 * @param {string} b 
 * @returns {number}
 */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Detect typos against popular domain names
 * @param {string} local 
 * @param {string} domain 
 * @returns {{ hasTypo: boolean, suggestion: string | null }}
 */
export function detectTypo(local, domain) {
  if (!domain) return { hasTypo: false, suggestion: null };
  const cleanDomain = domain.toLowerCase().trim();

  // If already exact match to a popular domain, no typo
  if (POPULAR_DOMAINS.includes(cleanDomain)) {
    return { hasTypo: false, suggestion: null };
  }

  let minDistance = Infinity;
  let bestMatch = null;

  for (const popular of POPULAR_DOMAINS) {
    const dist = levenshteinDistance(cleanDomain, popular);
    if (dist <= 2 && dist < minDistance) {
      minDistance = dist;
      bestMatch = popular;
    }
  }

  if (bestMatch && minDistance <= 2) {
    return {
      hasTypo: true,
      suggestion: `${local}@${bestMatch}`
    };
  }

  return { hasTypo: false, suggestion: null };
}
