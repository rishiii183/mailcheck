import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, generateToken, hashIp } from '../src/crypto.js';
import { initDb } from '../src/db.js';

describe('Crypto & DB Module (Step 1)', () => {
  it('encrypts and decrypts text accurately with AES-256-GCM', () => {
    const secret = 'super-secret-smtp-password-1234!';
    const ciphertext = encrypt(secret);
    
    assert.notEqual(ciphertext, secret);
    assert.match(ciphertext, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    
    const decrypted = decrypt(ciphertext);
    assert.equal(decrypted, secret);
  });

  it('fails decryption gracefully on tampered ciphertext or auth tag', () => {
    const secret = 'my-password';
    const ciphertext = encrypt(secret);
    const parts = ciphertext.split(':');
    
    // Tamper with ciphertext
    const tamperedCipher = `${parts[0]}:${parts[1]}:deadbeef`;
    assert.throws(() => decrypt(tamperedCipher));

    // Tamper with tag
    const tamperedTag = `${parts[0]}:${'0'.repeat(32)}:${parts[2]}`;
    assert.throws(() => decrypt(tamperedTag));
  });

  it('generates 128-bit random tokens (32 hex characters)', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    assert.equal(t1.length, 32);
    assert.equal(t2.length, 32);
    assert.notEqual(t1, t2);
    assert.match(t1, /^[0-9a-f]{32}$/);
  });

  it('hashes IP addresses consistently with salt', () => {
    const h1 = hashIp('192.168.1.1');
    const h2 = hashIp('192.168.1.1');
    const h3 = hashIp('192.168.1.2');
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.equal(h1.length, 64); // SHA-256 hex
  });

  it('initializes in-memory database with schema, pragmas, and default settings', () => {
    const db = initDb(':memory:');
    
    // Check pragma WAL and foreign keys
    const fk = db.pragma('foreign_keys', { simple: true });
    assert.equal(fk, 1);

    // Verify default settings
    const settings = db.prepare('SELECT * FROM settings').all();
    const keys = settings.map(s => s.key);
    assert.ok(keys.includes('postal_address'));
    assert.ok(keys.includes('timezone'));
    assert.ok(keys.includes('public_base_url'));

    // Test unique constraint on lead_steps (lead_id, sequence_step_id)
    db.prepare("INSERT INTO lists (name) VALUES ('Test List')").run();
    db.prepare("INSERT INTO leads (list_id, email) VALUES (1, 'lead@example.com')").run();
    db.prepare("INSERT INTO campaigns (name) VALUES ('Test Camp')").run();
    db.prepare("INSERT INTO sequence_steps (campaign_id, step_number) VALUES (1, 1)").run();

    db.prepare(`
      INSERT INTO lead_steps (campaign_id, lead_id, sequence_step_id, status, scheduled_at)
      VALUES (1, 1, 1, 'pending', datetime('now'))
    `).run();

    // Trying to insert duplicate (lead_id, sequence_step_id) must fail
    assert.throws(() => {
      db.prepare(`
        INSERT INTO lead_steps (campaign_id, lead_id, sequence_step_id, status, scheduled_at)
        VALUES (1, 1, 1, 'pending', datetime('now'))
      `).run();
    });

    db.close();
  });
});
