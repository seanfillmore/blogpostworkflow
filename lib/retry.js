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
const BASE_DELAY_MS = 2000;

export async function withRetry(fn, { maxRetries = MAX_RETRIES, label = '' } = {}) {
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
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        const tag = label ? `[${label}] ` : '';
        console.warn(`  ${tag}Retry ${attempt + 1}/${maxRetries} after ${delay}ms (${err.message ?? status ?? 'network error'})`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
