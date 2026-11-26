import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetPath = path.resolve(__dirname, '../data/disposable.txt');

const SOURCES = [
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf',
  'https://raw.githubusercontent.com/martenson/disposable-email-domains/master/disposable_email_blocklist.conf'
];

async function updateDisposableList() {
  console.log('Fetching latest open-source disposable email domains...');
  let content = null;

  for (const url of SOURCES) {
    try {
      console.log(`Trying source: ${url}`);
      const res = await fetch(url);
      if (res.ok) {
        content = await res.text();
        console.log(`Successfully fetched from ${url}`);
        break;
      }
    } catch (err) {
      console.warn(`Failed fetching from ${url}: ${err.message}`);
    }
  }

  if (!content) {
    console.error('Failed to fetch updated disposable domains from all sources.');
    process.exit(1);
  }

  // Parse, clean, deduplicate, and sort
  const domains = new Set();
  
  // Keep existing domains from local file if available
  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, 'utf8').split(/\r?\n/);
    for (const d of existing) {
      const clean = d.trim().toLowerCase();
      if (clean && !clean.startsWith('#')) {
        domains.add(clean);
      }
    }
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const clean = line.trim().toLowerCase();
    if (clean && !clean.startsWith('#')) {
      domains.add(clean);
    }
  }

  const sorted = Array.from(domains).sort();
  fs.writeFileSync(targetPath, sorted.join('\n') + '\n', 'utf8');
  console.log(`Updated ${targetPath} with ${sorted.length} unique disposable domains.`);
}

updateDisposableList().catch((err) => {
  console.error('Fatal error updating disposable domains:', err);
  process.exit(1);
});
