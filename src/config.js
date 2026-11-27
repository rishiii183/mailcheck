import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load environment variables from root .env
dotenv.config({ path: path.join(rootDir, '.env') });

// Ensure data directory exists
const dataDir = path.resolve(rootDir, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const env = process.env.NODE_ENV || 'development';

// 1.5 Security default: ENCRYPTION_KEY validation
let encryptionKey = process.env.ENCRYPTION_KEY;
if (env === 'test') {
  if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  }
} else {
  if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error(
      'Missing or invalid ENCRYPTION_KEY. Must be a 64-character hex string (32 bytes).\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
}

// 1.5 Security default: Mandatory API_KEY
export function ensureAdminApiKey() {
  if (process.env.API_KEY && process.env.API_KEY.trim()) {
    return process.env.API_KEY.trim();
  }
  const keyFile = path.join(dataDir, '.admin_key');
  if (fs.existsSync(keyFile)) {
    try {
      const saved = fs.readFileSync(keyFile, 'utf8').trim();
      if (saved) return saved;
    } catch {}
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  } catch {
    fs.writeFileSync(keyFile, generated);
  }
  console.log(`[Security] Admin API Key generated and saved to data/.admin_key: ${generated}`);
  return generated;
}

const apiKey = ensureAdminApiKey();

export const config = {
  rootDir,
  dataDir,
  env,
  admin: {
    host: process.env.ADMIN_HOST || '127.0.0.1',
    port: parseInt(process.env.ADMIN_PORT || '3000', 10),
    apiKey: apiKey
  },
  public: {
    host: process.env.PUBLIC_HOST || '0.0.0.0',
    port: parseInt(process.env.PUBLIC_PORT || '3001', 10),
    baseUrl: process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : ''
  },
  db: {
    path: process.env.DB_PATH || path.join(dataDir, 'mailcheck.db')
  },
  security: {
    encryptionKey
  },
  scheduler: {
    intervalMs: parseInt(process.env.SCHEDULER_INTERVAL_MS || '30000', 10)
  },
  verifier: {
    disposableFile: path.join(dataDir, 'disposable.txt'),
    smtpTimeoutMs: parseInt(process.env.SMTP_TIMEOUT_MS || '7000', 10),
    mxTimeoutMs:   parseInt(process.env.MX_TIMEOUT_MS   || '5000', 10),
    bulkConcurrency: parseInt(process.env.BULK_CONCURRENCY || '8', 10),
    heloHost: process.env.VERIFY_HELO_HOST || 'mailcheck.local',
    mailFrom: process.env.VERIFY_MAIL_FROM || 'verify@mailcheck.local',
    identityConfigured: Boolean(process.env.VERIFY_HELO_HOST && process.env.VERIFY_MAIL_FROM)
  }
};

if (!config.verifier.identityConfigured && env !== 'test') {
  console.warn('[Warning] VERIFY_HELO_HOST or VERIFY_MAIL_FROM is unset in .env. Accuracy will be reduced.');
}
