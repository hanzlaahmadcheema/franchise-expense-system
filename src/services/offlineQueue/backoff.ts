/**
 * Phase 12A: Exponential Backoff & Jitter Calculation
 *
 * Implements:
 * Delay = min(BaseDelay * 2^retries * (1 +/- Jitter), MaxDelay)
 *
 * Parameters:
 * - BaseDelay = 1500 ms (1.5s)
 * - MaxDelay = 60000 ms (60s)
 * - Jitter = +/- 15% (0.15)
 */

export const BASE_BACKOFF_DELAY_MS = 1500;
export const MAX_BACKOFF_DELAY_MS = 60000;
export const JITTER_RATIO = 0.15;

/**
 * Computes backoff delay in milliseconds for a given attempt count.
 * @param attemptCount Number of previous attempts (0-indexed or 1-indexed)
 * @param randomFn Optional deterministic random function for testing, returning [0, 1)
 */
export function computeBackoffDelay(
  attemptCount: number,
  randomFn: () => number = Math.random
): number {
  const safeAttempts = Math.max(0, attemptCount);
  // Exponential base: 1.5s * 2^attempts
  const exponential = BASE_BACKOFF_DELAY_MS * Math.pow(2, safeAttempts);
  
  // Apply +/- 15% jitter: multiplier in range [1 - 0.15, 1 + 0.15] -> [0.85, 1.15]
  const jitterFactor = (1 - JITTER_RATIO) + randomFn() * (2 * JITTER_RATIO);
  const withJitter = exponential * jitterFactor;

  // Cap at 60 seconds (also subject to max bounds)
  return Math.min(Math.round(withJitter), MAX_BACKOFF_DELAY_MS);
}

/**
 * Computes next retry timestamp in epoch milliseconds.
 */
export function computeNextRetryAt(
  attemptCount: number,
  now: number = Date.now(),
  randomFn?: () => number
): number {
  const delay = computeBackoffDelay(attemptCount, randomFn);
  return now + delay;
}
