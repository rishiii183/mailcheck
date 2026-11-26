import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db.js';
import { createMailbox, getMailboxById, listMailboxes, updateMailbox, deleteMailbox } from '../src/mailboxes/accounts.js';
import { checkMailboxDns } from '../src/mailboxes/dns-check.js';
import { getMailboxLimits } from '../src/mailboxes/limits.js';

describe('Mailboxes & DNS Health Module (Step 3)', () => {
  let db;

  before(() => {
    db = initDb(':memory:');
  });

  after(() => {
    closeDb();
  });

  describe('1. Mailbox CRUD & Encrypted Credentials', () => {
    it('creates a mailbox with credentials encrypted at rest and masks them on retrieval', async () => {
      const mb = await createMailbox({
        email: 'sender@mycompany.com',
        display_name: 'Sales Rep',
        smtp_host: 'smtp.mycompany.com',
        smtp_port: 587,
        smtp_user: 'sender@mycompany.com',
        smtp_pass: 'SecretSmtpPass123!',
        imap_host: 'imap.mycompany.com',
        imap_port: 993,
        imap_user: 'sender@mycompany.com',
        imap_pass: 'SecretImapPass123!',
        status: 'ready',
        campaign_daily_cap: 100
      }, { skipDns: true });

      assert.ok(mb.id);
      assert.equal(mb.email, 'sender@mycompany.com');
      // Passwords must not be exposed in default retrieval
      assert.equal(mb.smtp_pass, undefined);
      assert.equal(mb.smtp_pass_encrypted, undefined);

      // Verify DB row contains encrypted string, never plaintext
      const rawDbRow = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mb.id);
      assert.notEqual(rawDbRow.smtp_pass_encrypted, 'SecretSmtpPass123!');
      assert.match(rawDbRow.smtp_pass_encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

      // Verify decrypted fetch for internal engine use
      const withDecrypted = getMailboxById(mb.id, true);
      assert.equal(withDecrypted.smtp_pass, 'SecretSmtpPass123!');
      assert.equal(withDecrypted.imap_pass, 'SecretImapPass123!');
    });

    it('lists mailboxes and updates fields properly', async () => {
      const list = listMailboxes();
      assert.equal(list.length, 1);

      const updated = updateMailbox(list[0].id, {
        campaign_daily_cap: 150,
        status: 'warming'
      });

      assert.equal(updated.campaign_daily_cap, 150);
      assert.equal(updated.status, 'warming');
      assert.ok(updated.warmup_start_date);
    });
  });

  describe('2. DNS Health Check Logic', () => {
    it('evaluates SPF, DKIM, DMARC, MX correctly and allows sending when valid', async () => {
      const mockDns = {
        async resolveTxt(host) {
          if (host === 'verified.com') {
            return [['v=spf1 include:_spf.google.com ~all']];
          }
          if (host === 'google._domainkey.verified.com') {
            return [['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ...']];
          }
          if (host === '_dmarc.verified.com') {
            return [['v=DMARC1; p=quarantine; rua=mailto:dmarc@verified.com']];
          }
          throw new Error('NXDOMAIN');
        },
        async resolveMx(host) {
          if (host === 'verified.com') {
            return [{ exchange: 'aspmx.l.google.com', priority: 1 }];
          }
          throw new Error('NXDOMAIN');
        }
      };

      const res = await checkMailboxDns('verified.com', null, mockDns);
      assert.equal(res.spf.status, 'pass');
      assert.equal(res.dkim.status, 'pass');
      assert.equal(res.dkim.selector, 'google');
      assert.equal(res.dmarc.status, 'pass');
      assert.equal(res.mx.status, 'pass');
      assert.equal(res.canSendCampaign, true);
    });

    it('disallows sending when SPF or DKIM fails, warns on missing DMARC', async () => {
      const mockDnsFailingSpf = {
        async resolveTxt(host) {
          if (host === 'google._domainkey.badspf.com') {
            return [['v=DKIM1; p=MIGf...']];
          }
          return []; // No SPF
        },
        async resolveMx() {
          return [{ exchange: 'mx.badspf.com', priority: 10 }];
        }
      };

      const res1 = await checkMailboxDns('badspf.com', null, mockDnsFailingSpf);
      assert.equal(res1.spf.status, 'fail');
      assert.equal(res1.canSendCampaign, false); // Blocked!

      const mockDnsMissingDmarc = {
        async resolveTxt(host) {
          if (host === 'nodmarc.com') {
            return [['v=spf1 -all']];
          }
          if (host === 'default._domainkey.nodmarc.com') {
            return [['v=DKIM1; p=ABC...']];
          }
          throw new Error('NXDOMAIN'); // Missing DMARC
        },
        async resolveMx() {
          return [{ exchange: 'mx.nodmarc.com', priority: 10 }];
        }
      };

      const res2 = await checkMailboxDns('nodmarc.com', null, mockDnsMissingDmarc);
      assert.equal(res2.spf.status, 'pass');
      assert.equal(res2.dkim.status, 'pass');
      assert.equal(res2.dmarc.status, 'warn');
      assert.equal(res2.canSendCampaign, true); // Allowed with warning
    });
  });

  describe('3. Sending Limits & Warm-up Ramp Math', () => {
    it('restricts new warming mailbox according to ramp stage', () => {
      const baseDate = new Date('2026-01-01T00:00:00Z');

      // Day 3 of warmup -> Day 1-7 cap must be 0
      const mbDay3 = {
        id: 99,
        status: 'warming',
        campaign_daily_cap: 50,
        warmup_start_date: '2026-01-01T00:00:00Z'
      };
      const limitsDay3 = getMailboxLimits(mbDay3, new Date('2026-01-03T12:00:00Z'));
      assert.equal(limitsDay3.effectiveCap, 0);
      assert.equal(limitsDay3.canSend, false);

      // Day 10 of warmup -> Week 2 (days 8-14) cap is 10
      const limitsDay10 = getMailboxLimits(mbDay3, new Date('2026-01-10T12:00:00Z'));
      assert.equal(limitsDay10.effectiveCap, 10);
      assert.equal(limitsDay10.canSend, true);

      // Day 18 of warmup -> Week 3 (days 15-21) cap is 25
      const limitsDay18 = getMailboxLimits(mbDay3, new Date('2026-01-18T12:00:00Z'));
      assert.equal(limitsDay18.effectiveCap, 25);
      assert.equal(limitsDay18.canSend, true);

      // Day 30 of warmup -> Full configured cap (50)
      const limitsDay30 = getMailboxLimits(mbDay3, new Date('2026-01-30T12:00:00Z'));
      assert.equal(limitsDay30.effectiveCap, 50);
      assert.equal(limitsDay30.canSend, true);
    });

    it('enforces ready status full capacity and paused/error zero capacity', () => {
      const mbReady = { id: 101, status: 'ready', campaign_daily_cap: 100 };
      const limitsReady = getMailboxLimits(mbReady);
      assert.equal(limitsReady.effectiveCap, 100);
      assert.equal(limitsReady.canSend, true);

      const mbPaused = { id: 102, status: 'paused', campaign_daily_cap: 100 };
      assert.equal(getMailboxLimits(mbPaused).canSend, false);

      const mbError = { id: 103, status: 'error', campaign_daily_cap: 100 };
      assert.equal(getMailboxLimits(mbError).canSend, false);
    });
  });
});
