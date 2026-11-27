import dns from 'dns/promises';
import { config } from '../config.js';

// In-process DNS cache: domain → {result, expiresAt}
const mxDnsCache = new Map();
const MX_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Identify known major email service providers that conceal mailbox verification.
 * 4.5 Rule: pphosted.com / Proofpoint is NOT 'outlook'; only *.mail.protection.outlook.com,
 * hotmail/outlook/live MX hosts, *.yahoodns.net, and *.mail.me.com are mapped.
 */
export function identifyProvider(mxList) {
  if (!mxList || !Array.isArray(mxList)) return 'generic';

  for (const mx of mxList) {
    const host = (mx.exchange || '').toLowerCase().trim();

    if (
      host.includes('google.com') ||
      host.includes('googlemail.com') ||
      host.includes('aspmx.l.google.com')
    ) {
      return 'google';
    }

    // Explicitly exclude Proofpoint from being identified as Outlook
    if (host.includes('pphosted.com') || host.includes('proofpoint.com')) {
      return 'proofpoint';
    }

    if (
      host.endsWith('.mail.protection.outlook.com') ||
      host.includes('hotmail.') ||
      host.includes('outlook.') ||
      host.includes('live.')
    ) {
      return 'outlook';
    }

    if (host.includes('yahoodns.net') || host.endsWith('yahoodns.net')) {
      return 'yahoo';
    }

    if (host.includes('mail.me.com') || host.endsWith('mail.me.com')) {
      return 'icloud';
    }
  }

  return 'generic';
}

/**
 * Resolves MX records for a domain, falling back to A/AAAA if none present.
 * 4.6 Rule: Only ENOTFOUND/NXDOMAIN (and ENODATA for both MX and A/AAAA) means dead domain.
 * Timeouts, SERVFAIL, REFUSED are transient DNS failures that must NOT be marked dead
 * and must NOT be cached.
 */
export function lookupMx(domain) {
  return lookupMxInternal(domain, dns);
}

export async function lookupMxInternal(domain, dnsClient = dns) {
  if (!domain) {
    return { records: [], isDead: true, isTransientDnsError: false, provider: 'generic', fallback: false };
  }

  const cleanDomain = domain.toLowerCase().trim();

  // Check in-process memory cache first
  const cached = mxDnsCache.get(cleanDomain);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  const timeoutMs = config.verifier.mxTimeoutMs || 5000;

  function withTimeout(p) {
    return Promise.race([
      p,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          const err = new Error('DNS timeout');
          err.code = 'ETIMEOUT';
          reject(err);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      })
    ]);
  }

  function isTransientError(err) {
    if (!err) return false;
    const code = err.code || '';
    const msg = (err.message || '').toLowerCase();
    return (
      code === 'ETIMEOUT' ||
      code === 'ESERVFAIL' ||
      code === 'EREFUSED' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      msg.includes('timeout') ||
      msg.includes('servfail') ||
      msg.includes('refused')
    );
  }

  let mxError = null;

  // 1. Attempt MX lookup
  try {
    const mxRecords = await withTimeout(dnsClient.resolveMx(cleanDomain));
    if (Array.isArray(mxRecords) && mxRecords.length > 0) {
      const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
      const provider = identifyProvider(sorted);
      const result = { records: sorted, isDead: false, isTransientDnsError: false, provider, fallback: false };
      mxDnsCache.set(cleanDomain, { result, expiresAt: Date.now() + MX_CACHE_TTL_MS });
      return result;
    }
  } catch (err) {
    mxError = err;
  }

  // 2. Parallel A + AAAA fallback lookup
  let ipv4Result = null;
  let ipv6Result = null;

  try {
    [ipv4Result, ipv6Result] = await Promise.allSettled([
      withTimeout(dnsClient.resolve4(cleanDomain)),
      withTimeout(dnsClient.resolve6(cleanDomain))
    ]);

    const hasIp =
      (ipv4Result.status === 'fulfilled' && ipv4Result.value?.length > 0) ||
      (ipv6Result.status === 'fulfilled' && ipv6Result.value?.length > 0);

    if (hasIp) {
      const fallbackRecords = [{ exchange: cleanDomain, priority: 0, isFallback: true }];
      const result = { records: fallbackRecords, isDead: false, isTransientDnsError: false, provider: 'generic', fallback: true };
      mxDnsCache.set(cleanDomain, { result, expiresAt: Date.now() + MX_CACHE_TTL_MS });
      return result;
    }
  } catch (fallbackErr) {
    // If all failed
  }

  // Check if failure was transient (timeout, SERVFAIL, REFUSED)
  const isMxTransient = isTransientError(mxError);
  const isA4Transient = ipv4Result?.status === 'rejected' && isTransientError(ipv4Result.reason);
  const isA6Transient = ipv6Result?.status === 'rejected' && isTransientError(ipv6Result.reason);

  if (isMxTransient && (isA4Transient || isA6Transient || (!ipv4Result && !ipv6Result))) {
    const errCode = mxError?.code || (ipv4Result?.status === 'rejected' ? ipv4Result.reason?.code : 'ETIMEOUT') || 'DNS_TRANSIENT_FAILURE';
    return {
      records: [],
      isDead: false,
      isTransientDnsError: true,
      dnsError: errCode,
      provider: 'generic',
      fallback: false
    };
  }

  // Only ENOTFOUND, NXDOMAIN, or ENODATA across both MX and A/AAAA means dead domain
  const deadResult = { records: [], isDead: true, isTransientDnsError: false, provider: 'generic', fallback: false };
  mxDnsCache.set(cleanDomain, { result: deadResult, expiresAt: Date.now() + MX_CACHE_TTL_MS });
  return deadResult;
}

/** Clear the in-process MX DNS cache (useful for tests) */
export function clearMxCache() {
  mxDnsCache.clear();
}
