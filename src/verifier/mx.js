import dns from 'dns/promises';

/**
 * Identify known major email service providers that may conceal mailbox verification
 */
export function identifyProvider(mxList) {
  for (const mx of mxList) {
    const host = (mx.exchange || '').toLowerCase();
    if (host.includes('google.com') || host.includes('googlemail.com') || host.includes('aspmx.l.google.com')) {
      return 'google';
    }
    if (host.includes('protection.outlook.com') || host.includes('hotmail.com') || host.includes('office365.com') || host.includes('pphosted.com')) {
      return 'outlook';
    }
    if (host.includes('yahoodns.net') || host.includes('yahoo.com')) {
      return 'yahoo';
    }
    if (host.includes('mail.me.com') || host.includes('icloud.com')) {
      return 'icloud';
    }
  }
  return 'generic';
}

/**
 * Resolves MX records for a domain, falling back to A/AAAA if none present
 * @param {string} domain 
 * @returns {Promise<{ records: Array<{exchange: string, priority: number, isFallback?: boolean}>, isDead: boolean, provider: string, fallback: boolean }>}
 */
export function lookupMx(domain) {
  return lookupMxInternal(domain, dns);
}

export async function lookupMxInternal(domain, dnsClient = dns) {
  if (!domain) {
    return { records: [], isDead: true, provider: 'generic', fallback: false };
  }

  const cleanDomain = domain.toLowerCase().trim();

  // 1. Attempt MX lookup
  try {
    const mxRecords = await dnsClient.resolveMx(cleanDomain);
    if (Array.isArray(mxRecords) && mxRecords.length > 0) {
      const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
      const provider = identifyProvider(sorted);
      return {
        records: sorted,
        isDead: false,
        provider,
        fallback: false
      };
    }
  } catch (err) {
    // If not ENODATA or ENOTFOUND, log error but proceed to fallback
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
      // transient or specific DNS failure
    }
  }

  // 2. Fallback to A / AAAA lookup (RFC 5321 implicit MX)
  try {
    let hasIp = false;
    try {
      const ipv4 = await dnsClient.resolve4(cleanDomain);
      if (ipv4 && ipv4.length > 0) hasIp = true;
    } catch {}

    if (!hasIp) {
      try {
        const ipv6 = await dnsClient.resolve6(cleanDomain);
        if (ipv6 && ipv6.length > 0) hasIp = true;
      } catch {}
    }

    if (hasIp) {
      const fallbackRecords = [{ exchange: cleanDomain, priority: 0, isFallback: true }];
      return {
        records: fallbackRecords,
        isDead: false,
        provider: 'generic',
        fallback: true
      };
    }
  } catch {}

  // No MX and no A/AAAA -> dead domain
  return {
    records: [],
    isDead: true,
    provider: 'generic',
    fallback: false
  };
}
