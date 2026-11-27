import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { initDb, closeDb, getDb } from '../src/db.js';
import { createAdminServer } from '../src/admin.js';
import { config } from '../src/config.js';
import { verifyEmail } from '../src/verifier/index.js';
import { classifySmtpReply, probeSmtp, setPort25Status, getPort25Status, clearMxUnreachableCache } from '../src/verifier/smtp.js';
import { lookupMxInternal, identifyProvider, clearMxCache } from '../src/verifier/mx.js';
import { detectTypo } from '../src/verifier/typo.js';
import { calculateVerdict, PENALTIES, VERDICTS } from '../src/verifier/score.js';
import { scheduleGreylistRetry, getGreylistRetryStatus, runGreylistRetryTick } from '../src/verifier/retries.js';

function createFakeSmtpServer(handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handler(socket);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise(res => server.close(res))
      });
    });
  });
}

describe('BATCH 4 Regression Suite (Verifier Accuracy & Robustness)', () => {
  let app;
  const apiKey = config.admin.apiKey;

  before(async () => {
    initDb(':memory:');
    app = createAdminServer({ logger: false });
    await app.ready();
  });

  after(async () => {
    await app.close();
    closeDb();
  });

  beforeEach(() => {
    clearMxCache();
    clearMxUnreachableCache();
    setPort25Status(true, null);
  });

  // =========================================================================
  // 4.1 SMTP Identity
  // =========================================================================
  describe('4.1 SMTP Identity & Configuration', () => {
    it('reads VERIFY_HELO_HOST and VERIFY_MAIL_FROM and reports identity in /api/system/status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/system/status',
        headers: { 'x-api-key': apiKey }
      });
      assert.equal(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.ok(json.smtpIdentity);
      assert.ok(typeof json.smtpIdentity.heloHost === 'string');
      assert.ok(typeof json.smtpIdentity.mailFrom === 'string');
    });

    it('probeSmtp uses custom HELO host and MAIL FROM in transcript', async () => {
      let receivedHelo = '';
      let receivedMailFrom = '';

      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 mail.custom.test ESMTP\r\n');
        socket.on('data', (data) => {
          const str = data.toString('utf8');
          if (str.startsWith('EHLO')) {
            receivedHelo = str.trim();
            socket.write('250-mail.custom.test\r\n250 HELP\r\n');
          } else if (str.startsWith('MAIL FROM:')) {
            receivedMailFrom = str.trim();
            socket.write('250 2.1.0 Sender OK\r\n');
          } else if (str.startsWith('RCPT TO:')) {
            if (str.includes('chk_')) {
              socket.write('550 5.1.1 No catch-all\r\n');
            } else {
              socket.write('250 2.1.5 Recipient OK\r\n');
            }
          } else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mxRecords = [{ exchange: '127.0.0.1', priority: 10 }];
        const res = await probeSmtp('test@custom.test', 'custom.test', mxRecords, {
          port: fakeSmtp.port,
          heloHost: 'custom-verifier.domain.com',
          mailFrom: 'probe@custom-verifier.domain.com',
          checkCatchall: false
        });

        assert.equal(res.isTargetAccepted, true);
        assert.ok(receivedHelo.includes('custom-verifier.domain.com'), `Expected custom HELO host, got: ${receivedHelo}`);
        assert.ok(receivedMailFrom.includes('probe@custom-verifier.domain.com'), `Expected custom MAIL FROM, got: ${receivedMailFrom}`);
      } finally {
        await fakeSmtp.close();
      }
    });
  });

  // =========================================================================
  // 4.2 & 4.9 SMTP Reply Classification & Fake SMTP Server Tests
  // =========================================================================
  describe('4.2 & 4.9 SMTP Reply Classification with Real In-Process Fake SMTP', () => {
    it('classifies 250 as accepted -> deliverable (100 score)', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 mail.example.com ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) socket.write('250-mail.example.com\r\n250 HELP\r\n');
          else if (str.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
          else if (str.startsWith('RCPT TO:')) {
            if (str.includes('chk_')) socket.write('550 5.1.1 No catch-all\r\n');
            else socket.write('250 2.1.5 Recipient OK\r\n');
          } else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = { records: [{ exchange: '127.0.0.1', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
        const res = await verifyEmail('user@testdeliverable.com', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        assert.equal(res.verdict, VERDICTS.DELIVERABLE);
        assert.equal(res.score, 100);
        const catchCheck = res.checks.find(c => c.name === 'catchall');
        assert.equal(catchCheck.status, 'pass');
      } finally {
        await fakeSmtp.close();
      }
    });

    it('classifies 550 5.1.1 unknown user as rejected -> undeliverable (0 score)', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 mail.example.com ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) socket.write('250 OK\r\n');
          else if (str.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
          else if (str.startsWith('RCPT TO:')) socket.write('550 5.1.1 <unknown@example.com>: Recipient address rejected: User unknown in virtual mailbox table\r\n');
          else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = { records: [{ exchange: '127.0.0.1', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
        const res = await verifyEmail('unknown@example.com', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        assert.equal(res.verdict, VERDICTS.UNDELIVERABLE);
        assert.equal(res.score, 0);
        assert.ok(res.reason.includes('SMTP rejected'));
      } finally {
        await fakeSmtp.close();
      }
    });

    it('classifies 550 5.7.1 policy block as blocked -> verdict unknown (not undeliverable)', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 mail.example.com ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) socket.write('250 OK\r\n');
          else if (str.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
          else if (str.startsWith('RCPT TO:')) socket.write('550 5.7.1 Service unavailable; Client host [1.2.3.4] blocked using Spamhaus\r\n');
          else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = { records: [{ exchange: '127.0.0.1', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
        const res = await verifyEmail('blockedtarget@example.com', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        // 4.2 Rule: Policy/block signals must return verdict 'unknown' with reason "Mail server blocked our probe"
        assert.equal(res.verdict, VERDICTS.UNKNOWN);
        assert.equal(res.reason, 'Mail server blocked our probe');
        assert.notEqual(res.score, 0); // Not marked 0 undeliverable
      } finally {
        await fakeSmtp.close();
      }
    });

    it('classifies 421 greylisted -> verdict unknown with status retrying', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 mail.example.com ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) socket.write('250 OK\r\n');
          else if (str.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
          else if (str.startsWith('RCPT TO:')) socket.write('421 4.7.1 Greylisted, please try again in 300 seconds\r\n');
          else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = { records: [{ exchange: '127.0.0.1', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
        const res = await verifyEmail('greylist@example.com', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        assert.equal(res.verdict, VERDICTS.UNKNOWN);
        assert.equal(res.status, 'retrying');
        assert.ok(res.checks.some(c => c.name === 'smtp' && c.status === 'warn'));
      } finally {
        await fakeSmtp.close();
      }
    });

    it('handles multi-line SMTP replies correctly without hanging', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220-smtp.multiline.org ESMTP Sendmail 8.15\r\n220 Ready\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) {
            socket.write('250-smtp.multiline.org Hello\r\n250-PIPELINING\r\n250-SIZE 52428800\r\n250 HELP\r\n');
          } else if (str.startsWith('MAIL FROM:')) {
            socket.write('250 2.1.0 Sender OK\r\n');
          } else if (str.startsWith('RCPT TO:')) {
            if (str.includes('chk_')) {
              socket.write('550 5.1.1 No catch-all\r\n');
            } else {
              socket.write('250 2.1.5 Recipient OK\r\n');
            }
          } else if (str.startsWith('QUIT')) {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = { records: [{ exchange: '127.0.0.1', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
        const res = await verifyEmail('multiline@multiline.org', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        assert.equal(res.verdict, VERDICTS.DELIVERABLE);
      } finally {
        await fakeSmtp.close();
      }
    });

    it('detects catch-all domains when random address probe also returns 250', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 mail.catchall.test ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) socket.write('250 OK\r\n');
          else if (str.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
          else if (str.startsWith('RCPT TO:')) socket.write('250 2.1.5 Recipient OK\r\n'); // Accepts ALL addresses
          else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = { records: [{ exchange: '127.0.0.1', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
        const res = await verifyEmail('anyone@catchall.test', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        assert.equal(res.verdict, VERDICTS.RISKY);
        const catchCheck = res.checks.find(c => c.name === 'catchall');
        assert.ok(catchCheck);
        assert.equal(catchCheck.status, 'warn');
        assert.ok(catchCheck.detail.includes('catch-all'));
      } finally {
        await fakeSmtp.close();
      }
    });
  });

  // =========================================================================
  // 4.3 EHLO Fallback Bug Fix
  // =========================================================================
  describe('4.3 EHLO Fallback Bug Fix', () => {
    it('when EHLO is rejected, sends HELO and waits for reply before sending MAIL FROM', async () => {
      let commandSequence = [];

      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 mail.oldserver.test ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8').trim();
          const verb = str.split(' ')[0];
          commandSequence.push(verb);

          if (str.startsWith('EHLO')) {
            // Reject EHLO
            socket.write('502 5.5.1 Command not recognized\r\n');
          } else if (str.startsWith('HELO')) {
            // Accept fallback HELO
            socket.write('250 mail.oldserver.test\r\n');
          } else if (str.startsWith('MAIL FROM:')) {
            socket.write('250 OK\r\n');
          } else if (str.startsWith('RCPT TO:')) {
            socket.write('250 Recipient OK\r\n');
          } else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = [{ exchange: '127.0.0.1', priority: 10 }];
        const res = await probeSmtp('user@oldserver.test', 'oldserver.test', mockMx, {
          port: fakeSmtp.port,
          checkCatchall: false
        });

        assert.equal(res.isTargetAccepted, true);
        assert.deepEqual(commandSequence.slice(0, 3), ['EHLO', 'HELO', 'MAIL']);
      } finally {
        await fakeSmtp.close();
      }
    });
  });

  // =========================================================================
  // 4.4 Port 25 Handling
  // =========================================================================
  describe('4.4 Port 25 Handling & MX Unreachable Caching', () => {
    it('skips SMTP immediately and returns verdict unknown with status skip on catchall when port 25 is blocked', async () => {
      setPort25Status(false, 'Port 25 blocked by ISP');

      const mockMx = { records: [{ exchange: 'mx.sample.com', priority: 10 }], isDead: false, provider: 'generic', fallback: false };
      const res = await verifyEmail('test@sample.com', {
        mockMx,
        noCache: true,
        skipDb: true
      });

      assert.equal(res.verdict, VERDICTS.UNKNOWN);
      const smtpCheck = res.checks.find(c => c.name === 'smtp');
      assert.equal(smtpCheck.status, 'unknown');
      assert.ok(smtpCheck.detail.includes('port 25 is blocked'));

      // 4.4 Rule: Never output a passing catchall check unless catchall probe ran. Otherwise status 'skip'.
      const catchCheck = res.checks.find(c => c.name === 'catchall');
      assert.equal(catchCheck.status, 'skip');
    });

    it('limits MX connect attempts to 2 when first MX times out and caches unreachable', async () => {
      // Connect to non-responsive port that drops connections to test timeout
      let connectionAttempts = 0;
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        connectionAttempts++;
        // Do not send banner -> causes timeout
      });

      try {
        const mxList = [
          { exchange: '127.0.0.1', priority: 10 },
          { exchange: '127.0.0.1', priority: 20 },
          { exchange: '127.0.0.1', priority: 30 },
          { exchange: '127.0.0.1', priority: 40 }
        ];

        const res = await probeSmtp('test@timeout.com', 'timeout.com', mxList, {
          port: fakeSmtp.port,
          timeoutMs: 100 // fast timeout for test
        });

        assert.equal(res.success, false);
        // 4.4 Rule: do not try more than 2 MX hosts when first times out
        assert.ok(connectionAttempts <= 2, `Expected at most 2 connect attempts, got: ${connectionAttempts}`);
      } finally {
        await fakeSmtp.close();
      }
    });
  });

  // =========================================================================
  // 4.5 Provider Handling & Penalty Deduplication
  // =========================================================================
  describe('4.5 Provider Handling (Outlook/Yahoo/Proofpoint)', () => {
    it('probes Outlook/Yahoo normally; returns risky with ONE penalty when 250 returned', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 outlook.com ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) socket.write('250 OK\r\n');
          else if (str.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
          else if (str.startsWith('RCPT TO:')) socket.write('250 2.1.5 Recipient OK\r\n');
          else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        // Outlook MX host (probed on local fake server)
        const mockMx = {
          records: [{ exchange: '127.0.0.1', priority: 0 }],
          isDead: false,
          provider: 'outlook',
          fallback: false
        };

        const res = await verifyEmail('ceo@company.com', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        assert.equal(res.verdict, VERDICTS.RISKY);
        assert.equal(res.score, 100 - PENALTIES.HIDDEN_MAILBOX_PROVIDER); // Exactly 85, no double penalty
        const providerCheck = res.checks.find(c => c.name === 'provider_policy');
        assert.ok(providerCheck);
      } finally {
        await fakeSmtp.close();
      }
    });

    it('probes Outlook normally and returns undeliverable when user-unknown is returned', async () => {
      const fakeSmtp = await createFakeSmtpServer((socket) => {
        socket.write('220 outlook.com ESMTP\r\n');
        socket.on('data', (d) => {
          const str = d.toString('utf8');
          if (str.startsWith('EHLO')) socket.write('250 OK\r\n');
          else if (str.startsWith('MAIL FROM:')) socket.write('250 OK\r\n');
          else if (str.startsWith('RCPT TO:')) socket.write('550 5.1.1 User unknown\r\n');
          else if (str.startsWith('QUIT')) {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        });
      });

      try {
        const mockMx = {
          records: [{ exchange: '127.0.0.1', priority: 0 }],
          isDead: false,
          provider: 'outlook',
          fallback: false
        };

        const res = await verifyEmail('fakeuser@company.com', {
          mockMx,
          smtpPort: fakeSmtp.port,
          noCache: true,
          skipDb: true
        });

        assert.equal(res.verdict, VERDICTS.UNDELIVERABLE);
        assert.equal(res.score, 0);
      } finally {
        await fakeSmtp.close();
      }
    });

    it('identifyProvider correctly distinguishes Proofpoint (pphosted.com) from Outlook', () => {
      const proofpointMx = [{ exchange: 'mx1-us1.pphosted.com', priority: 10 }];
      assert.equal(identifyProvider(proofpointMx), 'proofpoint');

      const outlookMx = [{ exchange: 'tenant.mail.protection.outlook.com', priority: 10 }];
      assert.equal(identifyProvider(outlookMx), 'outlook');

      const hotmailMx = [{ exchange: 'mx1.hotmail.com', priority: 10 }];
      assert.equal(identifyProvider(hotmailMx), 'outlook');

      const yahooMx = [{ exchange: 'mta5.am0.yahoodns.net', priority: 10 }];
      assert.equal(identifyProvider(yahooMx), 'yahoo');

      const icloudMx = [{ exchange: 'mx1.mail.me.com', priority: 10 }];
      assert.equal(identifyProvider(icloudMx), 'icloud');
    });
  });

  // =========================================================================
  // 4.6 DNS Failures (Transient vs Dead Domain)
  // =========================================================================
  describe('4.6 DNS Failures (ENOTFOUND vs Transient Timeouts)', () => {
    it('NXDOMAIN/ENOTFOUND across MX and A/AAAA marks domain as dead -> undeliverable', async () => {
      const fakeDns = {
        resolveMx: async () => {
          const err = new Error('getaddrinfo ENOTFOUND');
          err.code = 'ENOTFOUND';
          throw err;
        },
        resolve4: async () => {
          const err = new Error('getaddrinfo ENOTFOUND');
          err.code = 'ENOTFOUND';
          throw err;
        },
        resolve6: async () => {
          const err = new Error('getaddrinfo ENOTFOUND');
          err.code = 'ENOTFOUND';
          throw err;
        }
      };

      const res = await lookupMxInternal('completelynonexistentdomain12345.org', fakeDns);
      assert.equal(res.isDead, true);
      assert.equal(res.isTransientDnsError, false);
    });

    it('DNS timeout or SERVFAIL returns transient DNS error -> verdict unknown without saving as dead', async () => {
      const fakeDns = {
        resolveMx: async () => {
          const err = new Error('queryMx ETIMEOUT');
          err.code = 'ETIMEOUT';
          throw err;
        },
        resolve4: async () => {
          const err = new Error('queryA ESERVFAIL');
          err.code = 'ESERVFAIL';
          throw err;
        },
        resolve6: async () => {
          const err = new Error('queryAaaa ESERVFAIL');
          err.code = 'ESERVFAIL';
          throw err;
        }
      };

      const mxRes = await lookupMxInternal('flaky-dns-domain.com', fakeDns);
      assert.equal(mxRes.isTransientDnsError, true);
      assert.equal(mxRes.isDead, false);

      const res = await verifyEmail('user@flaky-dns-domain.com', {
        mockMx: mxRes,
        noCache: true
      });

      assert.equal(res.verdict, VERDICTS.UNKNOWN);
      assert.ok(res.reason.includes('DNS server failed to resolve'));
    });
  });

  // =========================================================================
  // 4.7 Typo Allowlist
  // =========================================================================
  describe('4.7 Typo Detection Allowlist', () => {
    it('does not flag legitimate near-popular regional domains in allowlist', () => {
      assert.equal(detectTypo('user', 'ymail.com').hasTypo, false);
      assert.equal(detectTypo('user', 'googlemail.com').hasTypo, false);
      assert.equal(detectTypo('user', 'rocketmail.com').hasTypo, false);
      assert.equal(detectTypo('user', 'hotmail.co.uk').hasTypo, false);
      assert.equal(detectTypo('user', 'live.co.uk').hasTypo, false);
      assert.equal(detectTypo('user', 'outlook.in').hasTypo, false);
      assert.equal(detectTypo('user', 'yahoo.co.in').hasTypo, false);
    });

    it('flags genuine typos like gmial.com or hotmial.com', () => {
      const t1 = detectTypo('user', 'gmial.com');
      assert.equal(t1.hasTypo, true);
      assert.equal(t1.suggestion, 'user@gmail.com');

      const t2 = detectTypo('user', 'hotmial.com');
      assert.equal(t2.hasTypo, true);
      assert.equal(t2.suggestion, 'user@hotmail.com');
    });
  });

  // =========================================================================
  // 4.8 Verification Greylist Retry Queue
  // =========================================================================
  describe('4.8 Verification Greylist Retry Queue', () => {
    it('schedules retry job and advances attempts on 4xx', async () => {
      const email = 'greylist-retry@example.com';
      scheduleGreylistRetry(email, 1, '421 Greylisted');

      const status = getGreylistRetryStatus(email);
      assert.equal(status.isRetrying, true);
      assert.equal(status.attempt, 1);
      assert.ok(status.nextRetryAt);

      // Verify endpoint /api/verify/retries returns pending retries
      const res = await app.inject({
        method: 'GET',
        url: '/api/verify/retries',
        headers: { 'x-api-key': apiKey }
      });

      assert.equal(res.statusCode, 200);
      const rows = JSON.parse(res.body);
      assert.ok(rows.some(r => r.email === email && r.status === 'pending'));
    });
  });

  // =========================================================================
  // Fastify Schema Validation on /api/verify
  // =========================================================================
  describe('Fastify Schema Validation on /api/verify', () => {
    it('rejects invalid or missing email with 400 Bad Request', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/verify',
        headers: { 'x-api-key': apiKey },
        payload: {}
      });
      assert.equal(res1.statusCode, 400);

      const res2 = await app.inject({
        method: 'POST',
        url: '/api/verify',
        headers: { 'x-api-key': apiKey },
        payload: { email: 'x' }
      });
      assert.equal(res2.statusCode, 400);
    });
  });
});
