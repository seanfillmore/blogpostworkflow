// lib/stream-deadline.js
//
// A wall-clock deadline for one streaming Anthropic request.
//
// WHY THIS EXISTS AT ALL. On 2026-08-23 a consolidation call sat for 71 minutes having
// burned 3.84 seconds of CPU with its socket still open — a stream that was not arriving.
// Nothing caught it, and nothing could have: withRetry cannot fire on a promise that never
// settles, and the SDK's own timeout does not cover a stream body. That last part is now
// measured rather than assumed. In @anthropic-ai/sdk 0.78.0, `fetchWithTimeout`
// (client.js:334-365) clears its timer in a `finally` the moment `fetch()` resolves — which
// is when response HEADERS arrive, not when the body finishes:
//
//   non-streaming, max_tokens 8000 : headers 171,394ms  body 171,402ms  (gap:       8ms)
//   streaming,     max_tokens 8000 : headers   7,456ms  body 224,586ms  (gap: 217,130ms)
//
// Non-streaming is therefore bounded by the SDK's 10-minute default — the API withholds
// headers until generation completes, so the timer is armed the whole way. Streaming is not
// bounded at all: 217 seconds unguarded on a HEALTHY stream, and forever on a wedged one.
// This module is only needed for streams. Do not add it to messages.create() call sites.
//
// TWO THINGS IT HAS TO GET RIGHT
//
// 1. AbortController + setTimeout, NOT AbortSignal.timeout(). The latter's timer is unref'd
//    and does not hold the event loop open — on Node 22 that is exactly what let a
//    stubbed-fetch test exit before its timeout fired and report `cancelled` alongside
//    `# fail 0`, a dead test that reads like a pass. The timer must also be cleared on the
//    happy path, or a finished run holds the loop open until the deadline elapses.
//
// 2. The abort must reach withRetry as TERMINAL, and that is the half that bites. withRetry
//    does 4 attempts, then waits 30 MINUTES and restarts the cycle, up to 10 times — so a
//    retried 25-minute deadline converts one 71-minute hang into a multi-hour retry storm
//    holding the cron slot, strictly worse than the hang it replaced.
//
//    The original fix marked the abort terminal by calling `controller.abort(err)` with
//    `err.status = 408`, which withRetry already treats as terminal. Against the real SDK
//    that does not work: the SDK DISCARDS `signal.reason` and throws its own
//    `APIUserAbortError`, whose `status` is undefined and whose `name` is the inherited
//    'Error' — so withRetry saw a status-less error and retried it anyway. Measured:
//
//      aborted mid-stream -> { constructor: 'APIUserAbortError', name: 'Error',
//                              status: undefined, message: 'Request was aborted.' }
//
//    The stubbed test could not see this, because the stub rejects with `signal.reason` —
//    it re-asserted the assumption instead of testing it. So the reason is still attached
//    (harmless, and stubs that surface it keep working), but correctness now rests on
//    `toTerminal()` at the catch site, which does not depend on the SDK preserving anything.

/** withRetry treats 4xx-except-429 as terminal; 408 Request Timeout is the honest code. */
export const DEADLINE_STATUS = 408;

function deadlineError(ms, label, cause) {
  const err = new Error(
    `${label} produced no completion within ${Math.round(ms / 1000)}s — aborting a stalled stream.`
  );
  err.status = DEADLINE_STATUS;
  if (cause) err.cause = cause;
  return err;
}

/**
 * Arm a wall-clock deadline for one streaming request.
 *
 * Returns `{ signal, fired, clear(), toTerminal(err) }`. Pass `signal` to the SDK call,
 * call `clear()` in a `finally`, and pass any thrown error through `toTerminal()` so a
 * deadline abort reaches withRetry as terminal rather than as a retryable network blip.
 */
export function streamDeadline(ms, label = 'stream') {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(deadlineError(ms, label));
  }, ms);

  return {
    signal: controller.signal,
    get fired() {
      return fired;
    },
    clear: () => clearTimeout(timer),
    /**
     * Translate whatever the SDK threw back into the terminal deadline error, but ONLY if
     * this deadline is what fired. A genuine 429 or 500 that happens to surface while the
     * timer is still armed must stay retryable — converting it would turn a recoverable
     * blip into a failed run.
     */
    toTerminal(err) {
      return fired ? deadlineError(ms, label, err) : err;
    },
  };
}

/** Run one streaming call under a wall-clock deadline, clearing the timer either way. */
export async function streamWithDeadline(client, params, { ms, label }) {
  const dl = streamDeadline(ms, label);
  try {
    return await client.messages.stream(params, { signal: dl.signal }).finalMessage();
  } catch (err) {
    throw dl.toTerminal(err);
  } finally {
    dl.clear();
  }
}
