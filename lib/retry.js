/**
 * withRetry — wraps an async function with exponential backoff retry logic.
 *
 * Retries on transient errors: network timeouts, 429 rate limits, 500/502/503/529.
 * Throws immediately on non-retryable errors (400, 401, 403, 404).
 *
 * Usage:
 *   const result = await withRetry(() => client.messages.create(...));
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 60_000;          // 1 minute between retries
const RESTART_DELAY_MS = 30 * 60_000;   // 30 minutes before restarting retry cycle
const MAX_CYCLES = 10;                  // safety cap on restart cycles

export async function withRetry(fn, { maxRetries = MAX_RETRIES, label = '' } = {}) {
  const tag = label ? `[${label}] ` : '';

  for (let cycle = 0; cycle <= MAX_CYCLES; cycle++) {
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const status = err.status ?? err.statusCode ?? null;

        // Non-retryable: auth/client errors
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw err;
        }

        // Retryable: rate limit, server errors, or network failure
        if (attempt < maxRetries) {
          console.warn(`  ${tag}Retry ${attempt + 1}/${maxRetries} after ${RETRY_DELAY_MS / 1000}s (${err.message ?? status ?? 'network error'})`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    // All retries exhausted — wait 30 min and restart the cycle
    if (cycle < MAX_CYCLES) {
      console.warn(`  ${tag}All ${maxRetries} retries failed. Restarting in ${RESTART_DELAY_MS / 60_000} minutes... (cycle ${cycle + 1}/${MAX_CYCLES})`);
      await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));
    } else {
      throw lastErr;
    }
  }
}
