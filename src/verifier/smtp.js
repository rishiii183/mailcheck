import net from 'net';
import crypto from 'crypto';
import { config } from '../config.js';

let port25Status = {
  checked: false,
  available: false,
  error: null
};

export function getPort25Status() {
  return port25Status;
}

export function setPort25Status(available, error = null) {
  port25Status = { checked: true, available, error };
}

/**
 * Detects if outbound port 25 is open by attempting a test connection
 * to a known reliable public MX server (or returns cached status).
 */
export async function detectPort25Availability(testHost = 'aspmx.l.google.com', timeoutMs = 4000) {
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
      // If we received any data (like 220 banner), port 25 is definitely open
      isAvailable = true;
      socket.destroy();
    });

    socket.on('timeout', () => {
      errMessage = 'Connection timed out';
      socket.destroy();
    });

    socket.on('error', (err) => {
      errMessage = err.message;
      // Some networks send ECONNREFUSED immediately if port 25 is blocked
    });

    socket.on('close', () => {
      setPort25Status(isAvailable, isAvailable ? null : errMessage);
      resolve(port25Status);
    });

    socket.connect(25, testHost);
  });
}

/**
 * Probes MX servers using raw SMTP on port 25
 * @param {string} targetEmail 
 * @param {string} domain 
 * @param {Array<{exchange: string, priority: number}>} mxRecords 
 * @param {Object} [options] 
 * @returns {Promise<{
 *   success: boolean,
 *   isTargetAccepted: boolean,
 *   isRejected: boolean,
 *   isGreylisted: boolean,
 *   isCatchall?: boolean,
 *   detail: string,
 *   transcript: string[]
 * }>}
 */
export async function probeSmtp(targetEmail, domain, mxRecords, options = {}) {
  const timeoutMs = options.timeoutMs || config.verifier.smtpTimeoutMs;
  const port = options.port || 25;
  const checkCatchall = options.checkCatchall !== false;
  const transcript = [];

  if (!mxRecords || mxRecords.length === 0) {
    return {
      success: false,
      isTargetAccepted: false,
      isRejected: false,
      isGreylisted: false,
      detail: 'No MX servers available for domain',
      transcript
    };
  }

  // Try MX servers in priority order
  for (const mx of mxRecords) {
    const host = mx.exchange;
    transcript.push(`[Connecting to MX ${host}:${port}]`);
    
    try {
      const probeResult = await probeSingleMx(targetEmail, domain, host, port, timeoutMs, checkCatchall);
      transcript.push(...probeResult.transcript);

      // If we got a definitive SMTP answer (acceptance, rejection, or greylisting), return it
      if (probeResult.success) {
        return {
          ...probeResult,
          transcript
        };
      }
    } catch (err) {
      transcript.push(`[MX ${host} error: ${err.message}]`);
      // Try next MX if this one failed connection or timed out
    }
  }

  return {
    success: false,
    isTargetAccepted: false,
    isRejected: false,
    isGreylisted: false,
    detail: 'All MX servers failed to respond to SMTP probe',
    transcript
  };
}

function probeSingleMx(targetEmail, domain, host, port, timeoutMs, checkCatchall) {
  return new Promise((resolve) => {
    const transcript = [];
    let isTargetAccepted = false;
    let isRejected = false;
    let isGreylisted = false;
    let isCatchall = false;
    let detail = '';
    let settled = false;

    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    let buffer = '';
    let step = 'banner'; // 'banner' -> 'ehlo' -> 'mail_from' -> 'rcpt_target' -> 'rcpt_catchall' -> 'quit'

    function finish(result) {
      if (settled) return;
      settled = true;
      try {
        if (!socket.destroyed) {
          socket.write('QUIT\r\n');
          socket.end();
        }
      } catch {}
      resolve({ ...result, transcript });
    }

    socket.on('timeout', () => {
      transcript.push('[Socket timeout]');
      socket.destroy();
      finish({
        success: false,
        isTargetAccepted: false,
        isRejected: false,
        isGreylisted: false,
        detail: `Timeout after ${timeoutMs}ms waiting for MX response`
      });
    });

    socket.on('error', (err) => {
      transcript.push(`[Socket error: ${err.message}]`);
      finish({
        success: false,
        isTargetAccepted: false,
        isRejected: false,
        isGreylisted: false,
        detail: `Connection error: ${err.message}`
      });
    });

    socket.on('close', () => {
      if (!settled) {
        finish({
          success: isTargetAccepted || isRejected || isGreylisted,
          isTargetAccepted,
          isRejected,
          isGreylisted,
          isCatchall,
          detail: detail || 'Connection closed by remote host'
        });
      }
    });

    socket.on('data', (data) => {
      buffer += data.toString('utf8');

      // Check if we received full multi-line SMTP response
      const lines = buffer.split(/\r?\n/);
      // If the last line doesn't end with newline, keep it in buffer
      if (!buffer.endsWith('\n')) {
        buffer = lines.pop();
      } else {
        buffer = '';
      }

      for (const line of lines) {
        if (!line.trim()) continue;
        transcript.push(`< ${line}`);

        // A final reply line starts with 3 digits followed by a space (e.g. "250 ") or has length 3
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
              const cmd = 'EHLO mailcheck.local';
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            } else {
              detail = `Unexpected banner code: ${code}`;
              finish({ success: false, isTargetAccepted: false, isRejected: false, isGreylisted: false, detail });
            }
            break;

          case 'ehlo':
            if (code === 250) {
              step = 'mail_from';
              const cmd = 'MAIL FROM:<verify@mailcheck.local>';
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            } else {
              // Try HELO if EHLO rejected
              step = 'mail_from';
              const cmd = 'HELO mailcheck.local';
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            }
            break;

          case 'mail_from':
            if (code === 250) {
              step = 'rcpt_target';
              const cmd = `RCPT TO:<${targetEmail}>`;
              transcript.push(`> ${cmd}`);
              socket.write(`${cmd}\r\n`);
            } else {
              detail = `MAIL FROM rejected: ${code} ${replyText}`;
              finish({ success: false, isTargetAccepted: false, isRejected: false, isGreylisted: false, detail });
            }
            break;

          case 'rcpt_target':
            if (code === 250) {
              isTargetAccepted = true;
              detail = `250 OK: ${replyText}`;

              if (checkCatchall) {
                step = 'rcpt_catchall';
                const randomUser = `chk_${crypto.randomBytes(6).toString('hex')}`;
                const cmd = `RCPT TO:<${randomUser}@${domain}>`;
                transcript.push(`> ${cmd}`);
                socket.write(`${cmd}\r\n`);
              } else {
                finish({ success: true, isTargetAccepted: true, isRejected: false, isGreylisted: false, detail });
              }
            } else if (code >= 500 && code < 600) {
              isRejected = true;
              detail = `${code} ${replyText}`;
              finish({ success: true, isTargetAccepted: false, isRejected: true, isGreylisted: false, detail });
            } else if (code >= 400 && code < 500) {
              isGreylisted = true;
              detail = `Greylisted/Deferred: ${code} ${replyText}`;
              finish({ success: true, isTargetAccepted: false, isRejected: false, isGreylisted: true, detail });
            } else {
              detail = `Unknown RCPT response: ${code} ${replyText}`;
              finish({ success: false, isTargetAccepted: false, isRejected: false, isGreylisted: false, detail });
            }
            break;

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
