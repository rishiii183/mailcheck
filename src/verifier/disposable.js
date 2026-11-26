import fs from 'fs';
import { config } from '../config.js';

let disposableDomains = null;

export function loadDisposableDomains(filePath = config.verifier.disposableFile) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const domains = content
        .split(/\r?\n/)
        .map(line => line.trim().toLowerCase())
        .filter(line => line.length > 0 && !line.startsWith('#'));
      disposableDomains = new Set(domains);
    } else {
      disposableDomains = new Set();
    }
  } catch (err) {
    console.error('Failed to load disposable domains:', err.message);
    disposableDomains = new Set();
  }
  return disposableDomains;
}

export function isDisposableDomain(domain) {
  if (!disposableDomains) {
    loadDisposableDomains();
  }
  if (!domain) return false;
  return disposableDomains.has(domain.toLowerCase().trim());
}
