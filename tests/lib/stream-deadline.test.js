// tests/lib/stream-deadline.test.js
//
// Covers lib/stream-deadline.js and the withRetry classification it depends on.
//
// The bug these tests exist for is subtle: the ORIGINAL deadline (PR #632) was asserted
// only against a stubbed fetch that rejected with `signal.reason`, which re-asserted the
// assumption instead of testing it. The real SDK discards the reason and throws its own
// APIUserAbortError with no status and no name — so the abort read as RETRYABLE and fed
// the exact retry storm the deadline was written to prevent. Where these tests can use a
// REAL SDK error instance instead of a fake, they do.

import assert from 'node:assert/strict';
import { streamDeadline, streamWithDeadline, DEADLINE_STATUS } from '../../lib/stream-deadline.js';
import { withRetry, isTerminalError } from '../../lib/retry.js';
import { APIUserAbortError, APIConnectionTimeoutError, APIConnectionError } from '@anthropic-ai/sdk';

// ── the timer must be REF'D, or the test is dead and reads like a pass ─────────────────
// AbortSignal.timeout() uses an unref'd timer: on Node 22 the process exits before it
// fires and `node --test` reports `cancelled` alongside `# fail 0`. Asserting the abort
// actually happens is the only way that distinction is visible.
{
  const dl = streamDeadline(30, 'probe');
  const fired = await new Promise((resolve) => {
    dl.signal.addEventListener('abort', () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 3000);
  });
  dl.clear();
  assert.equal(fired, true, "the deadline fires on its own — an unref'd timer would not");
  assert.equal(dl.fired, true, 'and reports that it fired');
}

// ...and a cleared deadline must not fire, or a finished run holds the event loop open
// until the full ceiling elapses.
{
  const dl = streamDeadline(50, 'probe');
  dl.clear();
  const fired = await new Promise((resolve) => {
    dl.signal.addEventListener('abort', () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 300);
  });
  assert.equal(fired, false, 'a cleared deadline does not fire');
  assert.equal(dl.fired, false, 'and reports that it did not');
}

// ── toTerminal(): the half that the real SDK broke ────────────────────────────────────
{
  const dl = streamDeadline(20, 'probe');
  await new Promise((r) => setTimeout(r, 120));
  dl.clear();

  // THE REGRESSION TEST. This is the exact object the real SDK throws — status undefined,
  // name 'Error', reason discarded. Before toTerminal() existed this went back to withRetry
  // as retryable.
  const sdkError = new APIUserAbortError();
  assert.equal(sdkError.status, undefined, 'precondition: the SDK abort error carries no status');

  const translated = dl.toTerminal(sdkError);
  assert.equal(translated.status, DEADLINE_STATUS,
    'a fired deadline converts the SDK abort into a terminal 408');
  assert.match(translated.message, /produced no completion/,
    'and says the stream stalled rather than "Request was aborted."');
  assert.equal(translated.cause, sdkError, 'keeping the SDK error as the cause');
  assert.equal(isTerminalError(translated), true, 'which withRetry then treats as terminal');
}

// A deadline that did NOT fire must not launder unrelated errors into terminal ones — a
// 429 mid-stream is still retryable, and converting it would turn a recoverable blip into
// a failed run.
{
  const dl = streamDeadline(60_000, 'probe');
  const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
  assert.equal(dl.toTerminal(rateLimited), rateLimited, 'an unfired deadline passes errors through');
  assert.equal(isTerminalError(rateLimited), false, 'and 429 stays retryable');
  dl.clear();
}

// ── withRetry classification, against REAL SDK error instances ────────────────────────
{
  assert.equal(isTerminalError(new APIUserAbortError()), true,
    'an SDK abort is terminal — retrying an aborted request is grinding');
  assert.equal(isTerminalError(new APIConnectionTimeoutError()), true,
    'an SDK connection timeout is terminal — the SDK already retried it internally');

  // The one that must stay RETRYABLE. APIConnectionTimeoutError extends this class, so an
  // instanceof-based classifier would catch both and silently stop retrying real network
  // blips — the failure mode in the opposite direction.
  assert.equal(isTerminalError(new APIConnectionError({ message: 'Connection error.' })), false,
    'a plain connection failure is the transient case withRetry exists for');

  assert.equal(isTerminalError(Object.assign(new Error('x'), { name: 'AbortError' })), true,
    'a native fetch AbortError is terminal');
  assert.equal(isTerminalError(Object.assign(new Error('x'), { status: 500 })), false,
    '5xx stays retryable');
  assert.equal(isTerminalError(Object.assign(new Error('x'), { status: 404 })), true,
    '4xx stays terminal');
  assert.equal(isTerminalError(new Error('plain')), false,
    'an unmarked error stays retryable — the default must not change');
}

// ── end to end: a wedged stream fails fast and is attempted ONCE ──────────────────────
// The stub deliberately throws what the REAL SDK throws (APIUserAbortError, reason
// discarded) rather than rejecting with signal.reason. Under the pre-fix code this test
// fails: attempts climbs past 1 and the call enters withRetry's restart cycle.
{
  let attempts = 0;
  const wedged = {
    messages: {
      stream: (_params, opts) => {
        attempts++;
        return {
          finalMessage: () => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => reject(new APIUserAbortError()), { once: true });
          }),
        };
      },
    },
  };

  const started = Date.now();
  const err = await withRetry(
    () => streamWithDeadline(wedged, { model: 'm', messages: [] }, { ms: 40, label: 'probe' }),
    { maxRetries: 3, delayMs: 1, label: 'probe' }
  ).then(() => null, (e) => e);

  assert.ok(err, 'a wedged stream rejects rather than hanging');
  assert.equal(err.status, DEADLINE_STATUS, 'with the terminal 408');
  assert.equal(attempts, 1, 'attempted ONCE — not retried into a multi-hour storm');
  assert.ok(Date.now() - started < 5000, 'and fails in seconds rather than entering a restart cycle');
}

// A stream that completes normally must not be affected, and must not leave a live timer
// holding the event loop open.
{
  const ok = {
    messages: {
      stream: () => ({ finalMessage: async () => ({ content: [{ text: 'done' }] }) }),
    },
  };
  const res = await streamWithDeadline(ok, {}, { ms: 60_000, label: 'probe' });
  assert.equal(res.content[0].text, 'done', 'the happy path returns the final message');
}

console.log('✓ stream-deadline tests pass');
