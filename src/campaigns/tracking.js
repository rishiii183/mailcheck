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
 * Unified bot & proxy detection for opens and clicks.
 * Heuristics:
 * 1. Google Image Proxy (Gmail machine/proxy prefetch)
 * 2. Apple Mail Privacy Protection (AMPP / MPP)
 * 3. Known webmail crawlers and antivirus security scanner proxies
 * 4. Ultra-fast requests occurring within 5 seconds of send time
 *
 * @param {string} userAgent
 * @param {string|Date} [sentAt]
 * @param {Date} [requestTime=new Date()]
 * @returns {{ isBot: boolean, isGmailProxy: boolean, reason: string|null }}
 */
export function detectBot(userAgent = '', sentAt = null, requestTime = new Date()) {
  const ua = (userAgent || '').toLowerCase();

  // 1. Google Image Proxy (Gmail proxy prefetch)
  if (ua.includes('googleimageproxy')) {
    return { isBot: true, isGmailProxy: true, reason: 'GoogleImageProxy automated prefetch' };
  }

  // 2. Apple Mail Privacy Protection (AMPP / MPP)
  if (
    ua.includes('applemailprivacy') ||
    (ua.includes('applewebkit') &&
      ua.includes('mozilla/5.0') &&
      !ua.includes('chrome') &&
      !ua.includes('firefox') &&
      (ua.includes('cfnetwork') || (ua.includes('safari') && !ua.includes('version/')))) ||
    (ua.includes('macintosh') && !ua.includes('chrome') && !ua.includes('firefox') && !ua.includes('version/'))
  ) {
    return { isBot: true, isGmailProxy: false, reason: 'Apple Mail Privacy Protection prefetch' };
  }

  // 3. Known crawlers, webmail and antivirus scanner proxies
  if (
    ua.includes('bingpreview') ||
    ua.includes('yahoo! slurp') ||
    ua.includes('facebookexternalhit') ||
    ua.includes('spider') ||
    ua.includes('barracuda') ||
    ua.includes('mimecast') ||
    ua.includes('proofpoint') ||
    ua.includes('bot')
  ) {
    return { isBot: true, isGmailProxy: false, reason: 'Security scanner or proxy crawler' };
  }

  // 4. Hit within 5 seconds of send timestamp
  if (sentAt) {
    const sentTime = new Date(sentAt).getTime();
    const currTime = requestTime instanceof Date ? requestTime.getTime() : new Date(requestTime).getTime();
    const diffSec = (currTime - sentTime) / 1000;
    if (diffSec >= 0 && diffSec < 5) {
      return { isBot: true, isGmailProxy: false, reason: `Fast hit within 5 seconds of send (${diffSec.toFixed(1)}s)` };
    }
  }

  return { isBot: false, isGmailProxy: false, reason: null };
}

/**
 * Returns boolean whether user-agent or timing indicates probable bot/proxy
 */
export function isProbableBot(userAgent = '', sentAt = null, requestTime = new Date()) {
  return detectBot(userAgent, sentAt, requestTime).isBot;
}

/**
 * Check whether a user agent belongs to GoogleImageProxy
 */
export function isGmailProxy(userAgent = '') {
  return (userAgent || '').toLowerCase().includes('googleimageproxy');
}

/**
 * Backwards compatibility alias for detectBot
 */
export function detectProbableBotOpen(userAgent = '', sentAt = null, requestTime = new Date()) {
  return detectBot(userAgent, sentAt, requestTime);
}
