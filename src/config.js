import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
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

export const config = {
  rootDir,
  dataDir,
  env: process.env.NODE_ENV || 'development',
  admin: {
    host: process.env.ADMIN_HOST || '127.0.0.1',
    port: parseInt(process.env.ADMIN_PORT || '3000', 10),
    apiKey: process.env.API_KEY || ''
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
    // 32-byte key hex string or raw string (fallback provided for development if unset)
    encryptionKey: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  },
  scheduler: {
    intervalMs: parseInt(process.env.SCHEDULER_INTERVAL_MS || '30000', 10)
  },
  verifier: {
    disposableFile: path.join(dataDir, 'disposable.txt'),
    smtpTimeoutMs: 12000
  }
};
