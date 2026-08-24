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

/**
 * Errors that are terminal despite carrying NO HTTP status.
 *
 * The status check below is the whole classifier, so anything status-less falls through to
 * "retry it". For a genuine connection failure that is right. For an ABORT or a TIMEOUT it
 * is badly wrong, and it was silently defeating the one guard written to prevent exactly
 * this. Measured against @anthropic-ai/sdk 0.78.0 on 2026-08-23:
 *
 *   aborted mid-stream -> { constructor: 'APIUserAbortError', name: 'Error',
 *                           status: undefined, message: 'Request was aborted.' }
 *
 * Three things about that shape matter. The SDK DISCARDS `signal.reason`, so a caller that
 * aborts with a marked error (lib/stream-deadline.js used to rely on `status = 408`
 * surviving) gets none of it back. The SDK sets no `name`, so `err.name` is the inherited
 * 'Error' and cannot be matched on. And `status` is undefined, so the 4xx test below never
 * fires. Net effect before this change: a deadline abort was classified RETRYABLE, and
 * withRetry answered a stalled stream with 4 attempts, a 30-minute wait, and up to 10
 * cycles — the multi-hour retry storm the deadline exists to prevent.
 *
 * `APIConnectionTimeoutError` is terminal for a different reason: the SDK raises it only
 * after exhausting its OWN internal retries (maxRetries defaults to 2), so by the time one
 * reaches here the request has already been tried three times. Retrying is grinding.
 *
 * Plain `APIConnectionError` is deliberately ABSENT — a connection that failed to establish
 * is the transient case withRetry is for, and it must stay retryable.
 *
 * Matched on `constructor.name` rather than `instanceof` so this module keeps no dependency
 * on the Anthropic SDK (it wraps non-Anthropic calls too). tests/lib/retry.test.js asserts
 * against REAL instances imported from the SDK, so an upstream rename fails the test rather
 * than silently restoring the storm.
 */
const TERMINAL_ERROR_CONSTRUCTORS = new Set([
  'APIUserAbortError',
  'APIConnectionTimeoutError',
]);

export function isTerminalError(err) {
  const status = err?.status ?? err?.statusCode ?? null;
  if (status && status >= 400 && status < 500 && status !== 429) return true;

  // Native fetch/undici and AbortSignal.timeout() DO set a name.
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;

  return TERMINAL_ERROR_CONSTRUCTORS.has(err?.constructor?.name);
}
const RETRY_DELAY_MS = 60_000;          // 1 minute between retries
const RESTART_DELAY_MS = 30 * 60_000;   // 30 minutes before restarting retry cycle
const MAX_CYCLES = 10;                  // safety cap on restart cycles

// `delayMs` is overridable so tests can exercise the retry path without waiting a
// real minute per attempt. Production callers omit it and get the 60s backoff.
export async function withRetry(fn, { maxRetries = MAX_RETRIES, label = '', delayMs = RETRY_DELAY_MS } = {}) {
  const tag = label ? `[${label}] ` : '';

  for (let cycle = 0; cycle <= MAX_CYCLES; cycle++) {
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const status = err.status ?? err.statusCode ?? null;

        // Non-retryable: auth/client errors, plus status-less aborts and timeouts —
        // see TERMINAL_ERROR_CONSTRUCTORS above for why those need naming explicitly.
        if (isTerminalError(err)) {
          throw err;
        }

        // Retryable: rate limit, server errors, or network failure
        if (attempt < maxRetries) {
          console.warn(`  ${tag}Retry ${attempt + 1}/${maxRetries} after ${delayMs / 1000}s (${err.message ?? status ?? 'network error'})`);
          await new Promise((r) => setTimeout(r, delayMs));
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
