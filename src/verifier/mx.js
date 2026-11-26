import dns from 'dns/promises';
import { config } from '../config.js';

// In-process DNS cache: domain → {result, expiresAt}
const mxDnsCache = new Map();
const MX_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

  // Check in-process memory cache first (avoids repeated DNS round-trips)
  const cached = mxDnsCache.get(cleanDomain);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  const timeoutMs = config.verifier.mxTimeoutMs || 5000;

  // Helper: race a promise against a timeout
  function withTimeout(p) {
    return Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DNS timeout')), timeoutMs)
      )
    ]);
  }

  // 1. Attempt MX lookup
  try {
    const mxRecords = await withTimeout(dnsClient.resolveMx(cleanDomain));
    if (Array.isArray(mxRecords) && mxRecords.length > 0) {
      const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
      const provider = identifyProvider(sorted);
      const result = { records: sorted, isDead: false, provider, fallback: false };
      mxDnsCache.set(cleanDomain, { result, expiresAt: Date.now() + MX_CACHE_TTL_MS });
      return result;
    }
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
      // transient DNS failure — fall through to A/AAAA
    }
  }

  // 2. Parallel A + AAAA fallback lookup
  try {
    const [ipv4Result, ipv6Result] = await Promise.allSettled([
      withTimeout(dnsClient.resolve4(cleanDomain)),
      withTimeout(dnsClient.resolve6(cleanDomain))
    ]);

    const hasIp =
      (ipv4Result.status === 'fulfilled' && ipv4Result.value?.length > 0) ||
      (ipv6Result.status === 'fulfilled' && ipv6Result.value?.length > 0);

    if (hasIp) {
      const fallbackRecords = [{ exchange: cleanDomain, priority: 0, isFallback: true }];
      const result = { records: fallbackRecords, isDead: false, provider: 'generic', fallback: true };
      mxDnsCache.set(cleanDomain, { result, expiresAt: Date.now() + MX_CACHE_TTL_MS });
      return result;
    }
  } catch {}

  // No MX and no A/AAAA -> dead domain
  const deadResult = { records: [], isDead: true, provider: 'generic', fallback: false };
  mxDnsCache.set(cleanDomain, { result: deadResult, expiresAt: Date.now() + MX_CACHE_TTL_MS });
  return deadResult;
}

/** Clear the in-process MX DNS cache (useful for tests) */
export function clearMxCache() {
  mxDnsCache.clear();
}
