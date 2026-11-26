const ROLE_PREFIXES = new Set([
  'admin',
  'administrator',
  'info',
  'support',
  'sales',
  'contact',
  'help',
  'billing',
  'office',
  'enquiries',
  'inquiry',
  'jobs',
  'careers',
  'team',
  'postmaster',
  'hostmaster',
  'webmaster',
  'abuse',
  'security',
  'noreply',
  'no-reply',
  'marketing',
  'press',
  'media',
  'hr',
  'recruiting',
  'hello',
  'feedback',
  'legal',
  'compliance',
  'privacy',
  'operations',
  'devnull',
  'root',
  'mail',
  'mailer-daemon',
  'accounting',
  'finance',
  'orders',
  'invoices'
]);

/**
 * Checks if an email address is a generic role/group account
 * @param {string} local 
 * @returns {{ isRole: boolean, role: string | null }}
 */
export function isRoleAccount(local) {
  if (!local) return { isRole: false, role: null };
  const clean = local.toLowerCase().trim();

  // Direct match
  if (ROLE_PREFIXES.has(clean)) {
    return { isRole: true, role: clean };
  }

  // Handle formats like "support+123" or "support.team" or "sales-us"
  const stripped = clean.split(/[+._-]/)[0];
  if (ROLE_PREFIXES.has(stripped)) {
    return { isRole: true, role: stripped };
  }

  return { isRole: false, role: null };
}
