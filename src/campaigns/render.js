/**
 * Parse and render Spintax: {Option 1|Option 2|Option 3}
 * Supports nested spintax like {Hi|{Hello|Hey}}
 */
export function renderSpintax(text) {
  if (!text || typeof text !== 'string') return '';

  // Match {a|b} - must contain at least one pipe '|' and no nested braces
  const spintaxRegex = /\{([^{}]*\|[^{}]*)\}/g;
  let current = text;
  let safety = 0;

  while (spintaxRegex.test(current) && safety < 10) {
    current = current.replace(spintaxRegex, (match, content) => {
      const choices = content.split('|');
      const pick = choices[Math.floor(Math.random() * choices.length)];
      return pick;
    });
    safety++;
  }

  return current;
}

/**
 * 6.2 Rule: HTML escaping helper
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replace variables {{var}} or {{var|fallback}}
 * Supports lead fields (first_name, last_name, company, email) and custom fields (custom.x)
 * 6.2 Rule: Escapes lead fields to prevent HTML injection / XSS
 */
export function renderVariables(template, lead = {}) {
  if (!template || typeof template !== 'string') return '';

  const customFields = typeof lead.custom_fields_json === 'string'
    ? JSON.parse(lead.custom_fields_json || '{}')
    : (lead.custom_fields || {});

  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)(?:\|([^}]+))?\s*\}\}/g, (match, path, fallback = '') => {
    let value = null;

    if (path.startsWith('custom.')) {
      const key = path.slice(7);
      value = customFields[key];
    } else {
      value = lead[path];
    }

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return escapeHtml(String(value));
    }

    return escapeHtml(fallback);
  });
}

/**
 * Generate plain text counterpart from HTML
 */
export function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Rewrite HTML links for click tracking, leaving unsubscribe links untouched
 * @param {string} html 
 * @param {Function} registerLinkFn (originalUrl) => trackingToken
 * @param {string} publicBaseUrl 
 * @returns {string} rewritten HTML
 */
export function rewriteLinks(html, registerLinkFn, publicBaseUrl) {
  if (!html) return '';

  const linkRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1([^>]*)>/gi;

  return html.replace(linkRegex, (fullMatch, quote, originalUrl, rest) => {
    // Never rewrite unsubscribe links or mailto/tel anchors
    if (
      originalUrl.includes('/u/') ||
      originalUrl.startsWith('mailto:') ||
      originalUrl.startsWith('tel:') ||
      originalUrl.startsWith('#')
    ) {
      return fullMatch;
    }

    // Register link and get unique token
    const token = registerLinkFn(originalUrl);
    const trackingUrl = `${publicBaseUrl}/t/c/${token}`;

    return `<a href="${trackingUrl}"${rest}>`;
  });
}

/**
 * Inject open tracking pixel and mandatory postal address + unsubscribe footer
 */
export function injectTrackingAndFooter(html, { openToken, unsubscribeUrl, postalAddress, publicBaseUrl }) {
  let output = html || '';

  // Footer HTML with postal address and visible unsubscribe (6.2: escape postalAddress)
  const footerHtml = `
    <div class="mailcheck-footer" style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-family: sans-serif; font-size: 12px; color: #718096; line-height: 1.5;">
      ${postalAddress ? `<p style="margin: 0 0 8px 0;">${escapeHtml(postalAddress)}</p>` : ''}
      <p style="margin: 0;">
        If you no longer wish to receive these emails, you can 
        <a href="${unsubscribeUrl}" style="color: #4a5568; text-decoration: underline;">unsubscribe here</a>.
      </p>
    </div>
  `;

  // Open pixel HTML
  const openPixelUrl = `${publicBaseUrl}/t/o/${openToken}.gif`;
  const pixelHtml = `<img src="${openPixelUrl}" width="1" height="1" alt="" style="display:none; width:1px; height:1px; border:0;" />`;

  if (output.includes('</body>')) {
    output = output.replace('</body>', `${footerHtml}${pixelHtml}</body>`);
  } else {
    output = `${output}${footerHtml}${pixelHtml}`;
  }

  return output;
}
