import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateSyntax } from '../src/verifier/syntax.js';
import { detectTypo } from '../src/verifier/typo.js';
import { isDisposableDomain, loadDisposableDomains } from '../src/verifier/disposable.js';
import { isRoleAccount } from '../src/verifier/role.js';
import { calculateVerdict, PENALTIES, VERDICTS } from '../src/verifier/score.js';
import { verifyEmail, verifyBulk } from '../src/verifier/index.js';
import { initDb, closeDb } from '../src/db.js';

describe('Email Verifier Pipeline (Step 2)', () => {
  before(() => {
    initDb(':memory:');
    loadDisposableDomains();
  });

  after(() => {
    closeDb();
  });

  describe('1. Syntax Validation (RFC 5322)', () => {
    it('accepts valid email formats', () => {
      const valid = ['user@example.com', 'first.last+tag@sub.domain.co', 'a@b.cd'];
      for (const email of valid) {
        const res = validateSyntax(email);
        assert.equal(res.valid, true, `Should accept: ${email}`);
      }
    });

    it('rejects invalid email formats', () => {
      const invalid = [
        '',
        'no-at-sign.com',
        'double@@domain.com',
        'user..name@domain.com',
        '.user@domain.com',
        'user.@domain.com',
        'user@domain..com',
        'user@' + 'a'.repeat(250) + '.com', // total > 254
        'a'.repeat(65) + '@domain.com', // local > 64
        'user@domain.c' // TLD too short
      ];
      for (const email of invalid) {
        const res = validateSyntax(email);
        assert.equal(res.valid, false, `Should reject: ${email}`);
      }
    });
  });

  describe('2. Typo Detection', () => {
    it('detects common typos and gives recommendations', () => {
      const typo1 = detectTypo('john', 'gmial.com');
      assert.equal(typo1.hasTypo, true);
      assert.equal(typo1.suggestion, 'john@gmail.com');

      const typo2 = detectTypo('alice', 'hotmial.com');
      assert.equal(typo2.hasTypo, true);
      assert.equal(typo2.suggestion, 'alice@hotmail.com');

      const typo3 = detectTypo('bob', 'outlok.com');
      assert.equal(typo3.hasTypo, true);
      assert.equal(typo3.suggestion, 'bob@outlook.com');
    });

    it('ignores genuine domains without typo', () => {
      const ok = detectTypo('john', 'gmail.com');
      assert.equal(ok.hasTypo, false);
      assert.equal(ok.suggestion, null);

      const customDomain = detectTypo('john', 'companycorp123.org');
      assert.equal(customDomain.hasTypo, false);
    });
  });

  describe('3. Disposable Domains', () => {
    it('flags known disposable email domains', () => {
      assert.equal(isDisposableDomain('mailinator.com'), true);
      assert.equal(isDisposableDomain('yopmail.com'), true);
      assert.equal(isDisposableDomain('tempmail.com'), true);
      assert.equal(isDisposableDomain('gmail.com'), false);
      assert.equal(isDisposableDomain('company.com'), false);
    });
  });

  describe('4. Role Accounts', () => {
    it('flags department and role mailboxes', () => {
      assert.equal(isRoleAccount('admin').isRole, true);
      assert.equal(isRoleAccount('support').isRole, true);
      assert.equal(isRoleAccount('sales').isRole, true);
      assert.equal(isRoleAccount('info').isRole, true);
      assert.equal(isRoleAccount('billing').isRole, true);
      assert.equal(isRoleAccount('john.doe').isRole, false);
    });
  });

  describe('5. Scoring & Verdict Calculation', () => {
    it('computes 100 for clean individual deliverable mailbox', () => {
      const checks = [
        { name: 'syntax', status: 'pass' },
        { name: 'disposable', status: 'pass' },
        { name: 'role', status: 'pass' },
        { name: 'mx', status: 'pass' },
        { name: 'smtp', status: 'pass' }
      ];
      const res = calculateVerdict(checks, {});
      assert.equal(res.score, 100);
      assert.equal(res.verdict, VERDICTS.DELIVERABLE);
    });

    it('assigns 0 and undeliverable for hard fails (syntax, disposable, dead domain, 5xx reject)', () => {
      const syntaxFail = [{ name: 'syntax', status: 'fail', detail: 'bad format' }];
      assert.equal(calculateVerdict(syntaxFail).verdict, VERDICTS.UNDELIVERABLE);

      const dispFail = [
        { name: 'syntax', status: 'pass' },
        { name: 'disposable', status: 'fail' }
      ];
      assert.equal(calculateVerdict(dispFail).verdict, VERDICTS.UNDELIVERABLE);

      const deadMx = [
        { name: 'syntax', status: 'pass' },
        { name: 'mx', status: 'fail' }
      ];
      assert.equal(calculateVerdict(deadMx).verdict, VERDICTS.UNDELIVERABLE);

      const smtpReject = [
        { name: 'syntax', status: 'pass' },
        { name: 'smtp', status: 'fail', detail: '550 User unknown' }
      ];
      assert.equal(calculateVerdict(smtpReject).verdict, VERDICTS.UNDELIVERABLE);
    });

    it('marks risky when provider conceals true mailbox existence (Outlook/Yahoo)', () => {
      const checks = [
        { name: 'syntax', status: 'pass' },
        { name: 'disposable', status: 'pass' },
        { name: 'role', status: 'pass' },
        { name: 'mx', status: 'pass' },
        { name: 'smtp', status: 'pass' }
      ];
      const res = calculateVerdict(checks, { providerHiddenStatus: true });
      assert.equal(res.verdict, VERDICTS.RISKY);
      assert.equal(res.score, 100 - PENALTIES.HIDDEN_MAILBOX_PROVIDER);
    });

    it('marks unknown when port 25 is blocked', () => {
      const checks = [
        { name: 'syntax', status: 'pass' },
        { name: 'disposable', status: 'pass' },
        { name: 'mx', status: 'pass' },
        { name: 'smtp', status: 'unknown' }
      ];
      const res = calculateVerdict(checks, { port25Blocked: true });
      assert.equal(res.verdict, VERDICTS.UNKNOWN);
    });
  });

  describe('6. End-to-End Pipeline & Mock Probing', () => {
    it('stops early on syntax failure without performing DNS or SMTP checks', async () => {
      const res = await verifyEmail('bad..syntax@nowhere.com');
      assert.equal(res.verdict, VERDICTS.UNDELIVERABLE);
      assert.equal(res.score, 0);
      assert.equal(res.checks.length, 1);
      assert.equal(res.checks[0].name, 'syntax');
    });

    it('stops early on disposable domain', async () => {
      const res = await verifyEmail('test@mailinator.com');
      assert.equal(res.verdict, VERDICTS.UNDELIVERABLE);
      assert.equal(res.score, 0);
      const dispCheck = res.checks.find(c => c.name === 'disposable');
      assert.ok(dispCheck);
      assert.equal(dispCheck.status, 'fail');
    });

    it('handles simulated port 25 block by returning unknown instead of failing', async () => {
      const res = await verifyEmail('valid.person@gmail.com', {
        simulatePort25Blocked: true,
        mockMx: { records: [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }], isDead: false, provider: 'google', fallback: false }
      });
      assert.equal(res.verdict, VERDICTS.UNKNOWN);
      assert.ok(res.checks.some(c => c.name === 'smtp' && c.status === 'unknown'));
    });

    it('successfully processes full probe with mock SMTP server response', async () => {
      const mockMx = {
        records: [{ exchange: 'mail.mycompany.com', priority: 10 }],
        isDead: false,
        provider: 'generic',
        fallback: false
      };

      const mockSmtp = async (email, domain) => {
        return {
          success: true,
          targetCode: 250,
          isTargetAccepted: true,
          isGreylisted: false,
          isRejected: false,
          isCatchall: false,
          detail: '250 2.1.5 Recipient OK',
          transcript: ['< 220 banner', '> EHLO mailcheck.local', '< 250 OK', '> RCPT TO', '< 250 OK']
        };
      };

      const res = await verifyEmail('sarah@mycompany.com', { mockMx, mockSmtp });
      assert.equal(res.verdict, VERDICTS.DELIVERABLE);
      assert.equal(res.score, 100);
      assert.ok(res.transcript.length > 0);
    });

    it('deduplicates and processes bulk verification with progress callback', async () => {
      const input = `
        alice@example.com
        bob@example.com, alice@example.com
        "Charlie Doe" <charlie@example.com>
      `;

      const progressEvents = [];
      const mockMx = { records: [{ exchange: 'mx.example.com', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
      const mockSmtp = async () => ({
        success: true,
        targetCode: 250,
        isTargetAccepted: true,
        isGreylisted: false,
        isRejected: false,
        isCatchall: false,
        detail: '250 OK'
      });

      const bulkResult = await verifyBulk(input, (p) => progressEvents.push(p), { mockMx, mockSmtp });
      
      // Alice, Bob, Charlie = 3 unique
      assert.equal(bulkResult.total, 3);
      assert.equal(progressEvents.length, 3);
      assert.equal(progressEvents[2].percent, 100);
      assert.equal(bulkResult.summary.deliverable, 3);
    });
  });
});
