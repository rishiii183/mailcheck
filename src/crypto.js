import crypto from 'crypto';
import { config } from './config.js';

function getKeyBuffer(customKey) {
  const key = customKey || config.security.encryptionKey;
  if (!key) {
    throw new Error('ENCRYPTION_KEY is required for crypto operations');
  }
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, 'hex');
  }
  // Otherwise derive 32 bytes via sha256
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypt a string using AES-256-GCM
 * @param {string} text 
 * @param {string} [customKey] 
 * @returns {string} iv:authTag:ciphertext (all in hex)
 */
export function encrypt(text, customKey) {
  if (text === null || text === undefined) return '';
  const key = getKeyBuffer(customKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a string using AES-256-GCM
 * @param {string} encryptedPayload iv:authTag:ciphertext
 * @param {string} [customKey] 
 * @returns {string}
 */
export function decrypt(encryptedPayload, customKey) {
  if (!encryptedPayload) return '';
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getKeyBuffer(customKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Generate a 128-bit random token (32 hex characters)
 * @returns {string}
 */
export function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Hash an IP address for privacy-preserving tracking
 * @param {string} ip 
 * @returns {string}
 */
export function hashIp(ip) {
  if (!ip) return '';
  const salt = config.security.encryptionKey.slice(0, 16);
  return crypto.createHash('sha256').update(`${ip}:${salt}`).digest('hex');
}
