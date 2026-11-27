import net from 'net';
import crypto from 'crypto';
import dns from 'dns/promises';
import { config } from '../config.js';

let port25Status = {
  checked: false,
  available: false,
  error: null,
  checkedAt: null
};

// In-process cache for unreachable MX hosts (10-minute TTL)
const mxUnreachableCache = new Map();
const MX_UNREACHABLE_TTL_MS = 10 * 60 * 1000;

export function getPort25Status() {
  return port25Status;
}

export function setPort25Status(available, error = null) {
  port25Status = {
    checked: true,
    available,
    error,
    checkedAt: new Date().toISOString()
  };
}

export function clearMxUnreachableCache() {
  mxUnreachableCache.clear();
}

/**
 * Classifies an SMTP reply code and text according to RFC 5321 and RFC 3463.
 * Undeliverable ONLY for user-unknown signals.
 * Policy/block signals return isBlocked: true (leads to verdict 'unknown').
 * 4xx returns isGreylisted: true.
 */
export function classifySmtpReply(code, replyText = '') {
  const text = replyText.toLowerCase();

  // 2xx: Accepted
  if (code >= 200 && code < 300) {
    return {
      type: 'accepted',
      isAccepted: true,
      isRejected: false,
      isBlocked: false,
      isGreylisted: false,
      detail: replyText || 'Accepted'
    };
  }

  // 4xx: Greylisted / Transient deferral
  if (code >= 400 && code < 500) {
    return {
      type: 'greylisted',
      isAccepted: false,
      isRejected: false,
      isBlocked: false,
      isGreylisted: true,
      detail: `Greylisted/Deferred: ${code} ${replyText}`
    };
  }

  // 5xx: Permanent failure
  if (code >= 500 && code < 600) {
    const enhancedMatch = text.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
    const enhancedCode = enhancedMatch ? enhancedMatch[1] : null;

    // 1. Policy/block signals (5.7.x, "blocked", "blacklist", "spamhaus", etc.)
    const isPolicyCode = enhancedCode && enhancedCode.startsWith('5.7.');
    const hasBlockKeywords = /(blocked|blacklist|spamhaus|access denied|banned|reputation|barracuda|spamcop|relay access denied|service unavailable|policy|prohibited|administrative)/i.test(text);

    if (isPolicyCode || hasBlockKeywords) {
      return {
        type: 'blocked',
        isAccepted: false,
        isRejected: false,
        isBlocked: true,
        isGreylisted: false,
        detail: `Mail server blocked our probe: ${code} ${replyText}`
      };
    }

    // 2. User-unknown signals (5.1.1, 5.1.2, 5.1.10, "user unknown", etc.)
    const isUnknownCode = enhancedCode && (enhancedCode === '5.1.1' || enhancedCode === '5.1.2' || enhancedCode === '5.1.10');
    const hasUnknownKeywords = /(user unknown|no such user|mailbox unavailable|does not exist|user not found|recipient address rejected|recipient rejected|invalid recipient|no mailbox)/i.test(text);

    if (isUnknownCode || hasUnknownKeywords) {
      return {
        type: 'rejected',
        isAccepted: false,
        isRejected: true,
        isBlocked: false,
        isGreylisted: false,
        detail: `Mailbox does not exist (${code} ${replyText})`
      };
    }

    // If 5xx without explicit user-unknown signals, treat as blocked/policy restriction
    return {
      type: 'blocked',
      isAccepted: false,
      isRejected: false,
      isBlocked: true,
      isGreylisted: false,
      detail: `Mail server blocked our probe: ${code} ${replyText}`
    };
  }

  return {
    type: 'unknown',
    isAccepted: false,
    isRejected: false,
    isBlocked: false,
    isGreylisted: false,
    detail: `Unknown SMTP response: ${code} ${replyText}`
  };
}

/**
 * Detects if outbound port 25 is open by resolving the test host to an IP-literal
 * and attempting a TCP connection to port 25.
 * Distinguishes DNS failure, connection timeout, and connection refusal.
 */
export async function detectPort25Availability(testHost = 'aspmx.l.google.com', timeoutMs = 4000) {
  // Resolve host to IP-literal first
  let resolvedIp = null;
  try {
    const ips = await dns.resolve4(testHost);
    if (ips && ips.length > 0) {
      resolvedIp = ips[0];
    }
  } catch (dnsErr) {
    try {
      const ip6s = await dns.resolve6(testHost);
      if (ip6s && ip6s.length > 0) {
        resolvedIp = ip6s[0];
      }
    } catch {
      // Both IPv4 and IPv6 resolution failed
      const msg = `DNS resolution failed for test host "${testHost}": ${dnsErr.message}`;
      setPort25Status(false, msg);
      return port25Status;
    }
  }

  if (!resolvedIp) {
    setPort25Status(false, `No IP addresses found for test host "${testHost}"`);
    return port25Status;
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isAvailable = false;
    let errMessage = null;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      isAvailable = true;
      socket.destroy();
    });

    socket.on('data', () => {
      // Banner received: port 25 is definitively open
      isAvailable = true;
      socket.destroy();
    });

    socket.on('timeout', () => {
      errMessage = 'Port 25 outbound connection timed out (likely filtered/blocked by ISP or firewall)';
      socket.destroy();
    });

    socket.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        errMessage = 'Port 25 outbound connection refused';
      } else {
        errMessage = err.message || 'Connection error';
      }
    });

    socket.on('close', () => {
      setPort25Status(isAvailable, isAvailable ? null : errMessage);
      resolve(port25Status);
    });

    socket.connect(25, resolvedIp);
  });
}

/**
 * Probes MX servers using raw SMTP on port 25.
 * @param {string} targetEmail 
 * @param {string} domain 
 * @param {Array<{exchange: string, priority: number}>} mxRecords 
 * @param {Object} [options] 
 */
export async function probeSmtp(targetEmail, domain, mxRecords, options = {}) {
  const timeoutMs = options.timeoutMs || config.verifier.smtpTimeoutMs;
  const port = options.port || 25;
  const checkCatchall = options.checkCatchall !== false;
  const heloHost = options.heloHost || config.verifier.heloHost || 'mailcheck.local';
  const mailFrom = options.mailFrom || config.verifier.mailFrom || 'verify@mailcheck.local';
  const transcript = [];

  if (!mxRecords || mxRecords.length === 0) {
    return {
      success: false,
      isTargetAccepted: false,
      isRejected: false,
      isBlocked: false,
      isGreylisted: false,
      detail: 'No MX servers available for domain',
      transcript
    };
  }

  // Filter out recently unreachable MX hosts
  const now = Date.now();
  const eligibleMx = mxRecords.filter((mx) => {
    const cached = mxUnreachableCache.get(mx.exchange);
    return !cached || now >= cached.expiresAt;
  });

  const recordsToTry = eligibleMx.length > 0 ? eligibleMx : mxRecords;
  let firstMxTimedOut = false;
  let mxAttemptCount = 0;

  for (const mx of recordsToTry) {
    const host = mx.exchange;
    mxAttemptCount++;

    // 4.4 Rule: If the FIRST MX times out on connect, do not try more than 2 MX hosts
    if (firstMxTimedOut && mxAttemptCount > 2) {
      transcript.push(`[Max MX attempts reached after initial timeout]`);
      break;
    }

    transcript.push(`[Connecting to MX ${host}:${port}]`);

    try {
      const probeResult = await probeSingleMx(targetEmail, domain, host, port, timeoutMs, checkCatchall, {
        heloHost,
        mailFrom
      });
      transcript.push(...probeResult.transcript);

      if (probeResult.connectTimedOut) {
        if (mxAttemptCount === 1) {
          firstMxTimedOut = true;
        }
        // Cache unreachable for 10 minutes
        mxUnreachableCache.set(host, { expiresAt: now + MX_UNREACHABLE_TTL_MS });
      }

      // If we got a definitive SMTP answer (acceptance, rejection, blocked, or greylisting), return it
      if (probeResult.success) {
        return {
          ...probeResult,
          transcript
        };
      }
    } catch (err) {
      transcript.push(`[MX ${host} error: ${err.message}]`);
    }
  }

  return {
    success: false,
    isTargetAccepted: false,
    isRejected: false,
    isBlocked: false,
    isGreylisted: false,
    detail: 'All MX servers failed to respond to SMTP probe',
    transcript
  };
}

function probeSingleMx(targetEmail, domain, host, port, timeoutMs, checkCatchall, identity = {}) {
  const heloHost = identity.heloHost || config.verifier.heloHost || 'mailcheck.local';
  const mailFrom = identity.mailFrom || config.verifier.mailFrom || 'verify@mailcheck.local';

  return new Promise((resolve) => {
    const transcript = [];
    let isTargetAccepted = false;
    let isRejected = false;
    let isBlocked = false;
    let isGreylisted = false;
    let isCatchall = undefined;
    let connectTimedOut = false;
    let detail = '';
    let settled = false;

    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    let buffer = '';
    let step = 'banner'; // 'banner' -> 'ehlo' -> ('helo' if ehlo rejected) -> 'mail_from' -> 'rcpt_target' -> 'rcpt_catchall'

    function finish(result) {
      if (settled) return;
      settled = true;
      try {
        if (!socket.destroyed) {
          socket.write('QUIT\r\n');
          socket.end();
        }
      } catch {}
      resolve({ ...result, transcript, connectTimedOut });
    }

    socket.on('timeout', () => {
      transcript.push('[Socket timeout]');
      if (step === 'banner') {
        connectTimedOut = true;
      }
      socket.destroy();
      finish({
        success: false,
        isTargetAccepted: false,
        isRejected: false,
        isBlocked: false,
        isGreylisted: false,
        detail: `Timeout after ${timeoutMs}ms waiting for MX response`
      });
    });

    socket.on('error', (err) => {
      transcript.push(`[Socket error: ${err.message}]`);
      if (step === 'banner') {
        connectTimedOut = true;
      }
      finish({
        success: false,
        isTargetAccepted: false,
        isRejected: false,
        isBlocked: false,
        isGreylisted: false,
        detail: `Connection error: ${err.message}`
      });
    });

    socket.on('close', () => {
      if (!settled) {
        finish({
          success: isTargetAccepted || isRejected || isBlocked || isGreylisted,
          isTargetAccepted,
          isRejected,
          isBlocked,
          isGreylisted,
          isCatchall,
          detail: detail || 'Connection closed by remote host'
        });
      }
    });

    socket.on('data', (data) => {
      buffer += data.toString('utf8');

      // Process multi-line SMTP responses
      const lines = buffer.split(/\r?\n/);
      if (!buffer.endsWith('\n')) {
        buffer = lines.pop();
      } else {
        buffer = '';
      }

      for (const line of lines) {
        if (!line.trim()) continue;
        transcript.push(`< ${line}`);

        // A final reply line starts with 3 digits followed by a space or end-of-line
        const match = line.match(/^(\d{3})(?: (.*))?$/);
        const isFinalLine = Boolean(match);

        if (!isFinalLine) {
          continue; // Multi-line continuation (e.g. "250-")
        }

        const code = parseInt(match[1], 10);
        const replyText = match[2] || '';

        switch (step) {
          case 'banner':
            if (code === 220) {
              step = 'ehlo';
              const cmd = `EHLO ${heloHost}`;
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            } else {
              detail = `Unexpected banner code: ${code}`;
              finish({ success: false, isTargetAccepted: false, isRejected: false, isBlocked: false, isGreylisted: false, detail });
            }
            break;

          case 'ehlo':
            if (code === 250) {
              step = 'mail_from';
              const cmd = `MAIL FROM:<${mailFrom}>`;
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            } else {
              // 4.3 Bug fix: when EHLO rejected, fallback to HELO and wait for response in 'helo' step
              step = 'helo';
              const cmd = `HELO ${heloHost}`;
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            }
            break;

          case 'helo':
            if (code === 250) {
              step = 'mail_from';
              const cmd = `MAIL FROM:<${mailFrom}>`;
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            } else {
              detail = `HELO rejected: ${code} ${replyText}`;
              finish({ success: false, isTargetAccepted: false, isRejected: false, isBlocked: false, isGreylisted: false, detail });
            }
            break;

          case 'mail_from':
            if (code === 250) {
              step = 'rcpt_target';
              const cmd = `RCPT TO:<${targetEmail}>`;
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            } else {
              const classified = classifySmtpReply(code, replyText);
              detail = `MAIL FROM rejected: ${code} ${replyText}`;
              finish({
                success: classified.isBlocked || classified.isGreylisted,
                isTargetAccepted: false,
                isRejected: false,
                isBlocked: classified.isBlocked,
                isGreylisted: classified.isGreylisted,
                detail
              });
            }
            break;

          case 'rcpt_target': {
            const classified = classifySmtpReply(code, replyText);

            if (classified.isAccepted) {
              isTargetAccepted = true;
              detail = `250 OK: ${replyText}`;

              if (checkCatchall) {
                step = 'rcpt_catchall';
                const randomUser = `chk_${crypto.randomBytes(6).toString('hex')}`;
                const cmd = `RCPT TO:<${randomUser}@${domain}>`;
                transcript.push(`> ${cmd}`);
                socket.write(`${cmd}\r\n`);
              } else {
                finish({
                  success: true,
                  isTargetAccepted: true,
                  isRejected: false,
                  isBlocked: false,
                  isGreylisted: false,
                  detail
                });
              }
            } else if (classified.isRejected) {
              isRejected = true;
              detail = classified.detail;
              finish({
                success: true,
                isTargetAccepted: false,
                isRejected: true,
                isBlocked: false,
                isGreylisted: false,
                detail
              });
            } else if (classified.isBlocked) {
              isBlocked = true;
              detail = classified.detail;
              finish({
                success: true,
                isTargetAccepted: false,
                isRejected: false,
                isBlocked: true,
                isGreylisted: false,
                detail
              });
            } else if (classified.isGreylisted) {
              isGreylisted = true;
              detail = classified.detail;
              finish({
                success: true,
                isTargetAccepted: false,
                isRejected: false,
                isBlocked: false,
                isGreylisted: true,
                detail
              });
            } else {
              detail = `Unknown RCPT response: ${code} ${replyText}`;
              finish({
                success: false,
                isTargetAccepted: false,
                isRejected: false,
                isBlocked: false,
                isGreylisted: false,
                detail
              });
            }
            break;
          }

          case 'rcpt_catchall':
            if (code === 250) {
              isCatchall = true;
            } else {
              isCatchall = false;
            }
            finish({
              success: true,
              isTargetAccepted: true,
              isRejected: false,
              isBlocked: false,
              isGreylisted: false,
              isCatchall,
              detail
            });
            break;
        }
      }
    });

    socket.connect(port, host);
  });
}
