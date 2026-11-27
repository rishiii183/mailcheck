/**
 * MailCheck Admin API Authentication Helper
 * Ensures all browser fetch requests to /api/* include the required x-api-key header.
 */
(function() {
  function getApiKey() {
    let key = sessionStorage.getItem('mailcheck_api_key');
    if (!key) {
      key = prompt('Enter MailCheck Admin API Key (found in data/.admin_key or your .env file):');
      if (key && key.trim()) {
        key = key.trim();
        sessionStorage.setItem('mailcheck_api_key', key);
      }
    }
    return key || '';
  }

  const originalFetch = window.fetch;
  window.fetch = async function(resource, init = {}) {
    if (typeof resource === 'string' && resource.startsWith('/api/')) {
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        if (!init.headers.has('x-api-key') && !init.headers.has('Authorization')) {
          init.headers.set('x-api-key', getApiKey());
        }
      } else if (Array.isArray(init.headers)) {
        init.headers.push(['x-api-key', getApiKey()]);
      } else {
        if (!init.headers['x-api-key'] && !init.headers['Authorization']) {
          init.headers['x-api-key'] = getApiKey();
        }
      }
    }

    const res = await originalFetch(resource, init);

    // If 401 Unauthorized, prompt user to re-enter key
    if (res.status === 401 && typeof resource === 'string' && resource.startsWith('/api/')) {
      sessionStorage.removeItem('mailcheck_api_key');
      const retryKey = prompt('Invalid API Key. Please re-enter your MailCheck Admin API Key:');
      if (retryKey && retryKey.trim()) {
        sessionStorage.setItem('mailcheck_api_key', retryKey.trim());
        if (init.headers instanceof Headers) {
          init.headers.set('x-api-key', retryKey.trim());
        } else if (Array.isArray(init.headers)) {
          init.headers.push(['x-api-key', retryKey.trim()]);
        } else {
          init.headers['x-api-key'] = retryKey.trim();
        }
        return originalFetch(resource, init);
      }
    }

    return res;
  };

  // 6.2 HTML escaping helper for dashboard templates
  window.escapeHtml = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
})();
