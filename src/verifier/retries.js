import { getDb } from '../db.js';

// Intervals for greylist retry re-probing: attempt 1 -> +5 min, attempt 2 -> +15 min, attempt 3 -> +45 min
export const GREYLIST_INTERVALS_MINUTES = [5, 15, 45];

/**
 * Stores or updates a greylist verification retry job.
 * @param {string} email
 * @param {number} [attempt=1]
 * @param {string} [lastError='']
 */
export function scheduleGreylistRetry(email, attempt = 1, lastError = '') {
  try {
    const db = getDb();
    const cleanEmail = email.toLowerCase().trim();
    const idx = Math.min(attempt - 1, GREYLIST_INTERVALS_MINUTES.length - 1);
    const delayMinutes = GREYLIST_INTERVALS_MINUTES[idx] || 5;

    db.prepare(`
      INSERT INTO verification_retries (email, attempt, next_retry_at, status, last_error, updated_at)
      VALUES (?, ?, datetime('now', '+' || ? || ' minutes'), 'pending', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(email) DO UPDATE SET
        attempt = excluded.attempt,
        next_retry_at = excluded.next_retry_at,
        status = 'pending',
        last_error = excluded.last_error,
        updated_at = CURRENT_TIMESTAMP
    `).run(cleanEmail, attempt, delayMinutes, lastError);
  } catch (err) {
    // If DB is closed or unavailable during tests, silently ignore
  }
}

/**
 * Checks if an email currently has a pending greylist retry.
 * @param {string} email
 * @returns {{ isRetrying: boolean, attempt: number, nextRetryAt: string | null } | null}
 */
export function getGreylistRetryStatus(email) {
  try {
    const db = getDb();
    const cleanEmail = email.toLowerCase().trim();
    const row = db.prepare(`
      SELECT attempt, next_retry_at, status
      FROM verification_retries
      WHERE email = ? AND status = 'pending'
    `).get(cleanEmail);

    if (row) {
      return {
        isRetrying: true,
        attempt: row.attempt,
        nextRetryAt: row.next_retry_at
      };
    }
  } catch {}
  return { isRetrying: false, attempt: 0, nextRetryAt: null };
}

/**
 * Marks a greylist retry job as resolved (completed or failed).
 * @param {string} email
 * @param {'completed' | 'failed'} status
 */
export function completeGreylistRetry(email, status = 'completed') {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE verification_retries
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE email = ?
    `).run(status, email.toLowerCase().trim());
  } catch {}
}

/**
 * Runs a single tick of the greylist retry queue.
 * @param {Function} verifyFn - The verifyEmail function injected to avoid circular dependency
 * @returns {Promise<number>} - Count of processed retries
 */
export async function runGreylistRetryTick(verifyFn) {
  let count = 0;
  try {
    const db = getDb();
    const dueJobs = db.prepare(`
      SELECT id, email, attempt
      FROM verification_retries
      WHERE status = 'pending' AND datetime(next_retry_at) <= datetime('now')
      LIMIT 10
    `).all();

    for (const job of dueJobs) {
      count++;
      try {
        const result = await verifyFn(job.email, { isRetry: true, noCache: true });
        if (result.isGreylisted) {
          if (job.attempt < 3) {
            scheduleGreylistRetry(job.email, job.attempt + 1, result.reason || 'Greylisted');
          } else {
            completeGreylistRetry(job.email, 'failed');
          }
        } else {
          completeGreylistRetry(job.email, 'completed');
        }
      } catch (err) {
        if (job.attempt < 3) {
          scheduleGreylistRetry(job.email, job.attempt + 1, err.message);
        } else {
          completeGreylistRetry(job.email, 'failed');
        }
      }
    }
  } catch {}
  return count;
}
