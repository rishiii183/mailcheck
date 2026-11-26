import { generateToken, hashIp } from '../crypto.js';
import { getDb, getSetting } from '../db.js';
import { config } from '../config.js';

export function getPublicBaseUrl() {
  const dbUrl = getSetting('public_base_url');
  if (dbUrl && dbUrl.trim()) {
    return dbUrl.trim().replace(/\/+$/, '');
  }
  return config.public.baseUrl || 'http://localhost:3001';
}

/**
 * Register a click tracking token for a given lead_step
 */
export function registerTrackingLink(leadStepId, originalUrl) {
  const db = getDb();
  const token = generateToken();
  db.prepare(`
    INSERT INTO tracking_links (lead_step_id, token, original_url, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(leadStepId, token, originalUrl);
  return token;
}

/**
 * Build tracking URLs and RFC 8058 compliant unsubscribe headers
 */
export function prepareTracking(leadStepId, mailboxEmail, existingOpenToken = null) {
  const publicBaseUrl = getPublicBaseUrl();
  const openToken = existingOpenToken || generateToken();

  const unsubscribeUrl = `${publicBaseUrl}/u/${openToken}`;

  const headers = {
    'List-Unsubscribe': `<mailto:${mailboxEmail}?subject=unsubscribe>, <${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'X-MailCheck-LeadStep': String(leadStepId)
  };

  return {
    openToken,
    unsubscribeUrl,
    publicBaseUrl,
    headers,
    registerLink: (url) => registerTrackingLink(leadStepId, url)
  };
}

/**
 * Heuristics to detect automated machine/bot opens:
 * - GoogleImageProxy
 * - Apple Mail Privacy Protection (AMPP)
 * - Hits occurring within 5 seconds of send
 */
export function detectProbableBotOpen(userAgent = '', sentAt = null, requestTime = new Date()) {
  const ua = (userAgent || '').toLowerCase();

  // 1. Google Image Proxy
  if (ua.includes('googleimageproxy')) {
    return { isBot: true, reason: 'GoogleImageProxy automated prefetch' };
  }

  // 2. Apple Mail Privacy Protection (MPP) patterns
  if (
    ua.includes('applewebkit') &&
    (ua.includes('mozilla/5.0') && !ua.includes('chrome') && !ua.includes('firefox')) &&
    (ua.includes('cfnetwork') || ua.includes('safari') && !ua.includes('version/'))
  ) {
    return { isBot: true, reason: 'Apple Mail Privacy Protection (MPP) prefetch' };
  }

  // 3. Other known webmail and antivirus scanner proxies
  if (ua.includes('yahoo! slurp') || ua.includes('barracuda') || ua.includes('mimecast') || ua.includes('proofpoint')) {
    return { isBot: true, reason: 'Security scanner or image proxy' };
  }

  // 4. Hit within 5 seconds of send timestamp
  if (sentAt) {
    const sentTime = new Date(sentAt).getTime();
    const currTime = requestTime.getTime();
    const diffSec = (currTime - sentTime) / 1000;
    if (diffSec >= 0 && diffSec < 5) {
      return { isBot: true, reason: `Fast hit within 5 seconds of send (${diffSec.toFixed(1)}s)` };
    }
  }

  return { isBot: false, reason: null };
}
