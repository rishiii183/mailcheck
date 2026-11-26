/**
 * RFC 5322 practical syntax validation
 * - Normalize to lowercase
 * - Local part <= 64 characters
 * - Total length <= 254 characters
 * - No consecutive dots
 * - No leading/trailing dots in local or domain
 */
export function validateSyntax(email) {
  if (typeof email !== 'string') {
    return { valid: false, error: 'Email must be a string' };
  }

  const normalized = email.trim().toLowerCase();

  if (normalized.length === 0) {
    return { valid: false, error: 'Email cannot be empty' };
  }

  if (normalized.length > 254) {
    return { valid: false, error: 'Email exceeds maximum length of 254 characters' };
  }

  const atIndex = normalized.indexOf('@');
  if (atIndex === -1 || atIndex !== normalized.lastIndexOf('@')) {
    return { valid: false, error: 'Email must contain exactly one @ symbol' };
  }

  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  if (local.length === 0) {
    return { valid: false, error: 'Local part cannot be empty' };
  }

  if (local.length > 64) {
    return { valid: false, error: 'Local part exceeds 64 characters' };
  }

  if (domain.length === 0) {
    return { valid: false, error: 'Domain cannot be empty' };
  }

  // Check for consecutive dots
  if (local.includes('..') || domain.includes('..')) {
    return { valid: false, error: 'Email contains consecutive dots' };
  }

  // Leading or trailing dots
  if (local.startsWith('.') || local.endsWith('.')) {
    return { valid: false, error: 'Local part cannot start or end with a dot' };
  }

  if (domain.startsWith('.') || domain.endsWith('.')) {
    return { valid: false, error: 'Domain cannot start or end with a dot' };
  }

  // Local part character regex (RFC 5322 unquoted printable ASCII)
  const localRegex = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
  if (!localRegex.test(local)) {
    return { valid: false, error: 'Local part contains invalid characters' };
  }

  // Domain structure validation
  const domainParts = domain.split('.');
  if (domainParts.length < 2) {
    return { valid: false, error: 'Domain must contain at least one dot' };
  }

  const domainLabelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const label of domainParts) {
    if (!domainLabelRegex.test(label)) {
      return { valid: false, error: `Invalid domain label "${label}"` };
    }
  }

  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld)) {
    return { valid: false, error: 'TLD must be at least 2 alphabetic characters' };
  }

  return {
    valid: true,
    email: normalized,
    local,
    domain
  };
}
