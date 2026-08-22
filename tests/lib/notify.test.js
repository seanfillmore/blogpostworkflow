// tests/lib/notify.test.js
//
// Fix 1 regression coverage. sendEmail() and sendHtmlEmail() must swallow every
// Resend transport failure — including the AbortError the 15s timeout produces —
// and must never throw out to the caller. notify() is called from success paths in
// unattended cron agents; an uncaught rejection there would abort real work that
// already succeeded (that's exactly what happened to agents/voice-of-customer's
// error-path notify() calls before this fix reached sendEmail/sendHtmlEmail
// themselves). Nothing here previously pinned that behaviour against regression.
//
// fetch is stubbed at the global boundary — no real network call. AbortSignal.timeout
// is also stubbed for the "pins the timeout value" cases below so no real timer is
// ever constructed: Node 22's AbortSignal.timeout() uses an unref'd timer, and CLAUDE.md
// records a test that let one actually run going `cancelled` rather than failing
// outright. Stubbing it out sidesteps that failure mode entirely instead of relying on
// a longer `--test-timeout`.
import { strict as assert } from 'node:assert';
import { test, beforeEach, afterEach } from 'node:test';

const realFetch = globalThis.fetch;
const realAbortSignalTimeout = AbortSignal.timeout;
const realConsoleError = console.error;

let consoleErrorCalls;

beforeEach(() => {
  consoleErrorCalls = [];
  console.error = (...args) => { consoleErrorCalls.push(args); };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realAbortSignalTimeout;
  console.error = realConsoleError;
});

function loggedSomething() {
  return consoleErrorCalls.some((args) =>
    args.some((a) => typeof a === 'string' && /resend|abort/i.test(a))
  );
}

// Table-driven over both Resend-calling functions — same shape, same claim applies
// to each, and the reviewer explicitly asked for the signal assertion on both.
const RESEND_FNS = [
  { name: 'sendEmail', call: async (mod) => mod.sendEmail('subject', 'body') },
  { name: 'sendHtmlEmail', call: async (mod) => mod.sendHtmlEmail('subject', '<p>body</p>') },
];

for (const { name, call } of RESEND_FNS) {
  test(`${name} resolves rather than throwing when fetch rejects with an AbortError`, async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    };
    const mod = await import('../../lib/notify.js');
    await assert.doesNotReject(() => call(mod), `${name} must not throw for a timeout/AbortError`);
    assert.ok(loggedSomething(), `${name} must log the failure rather than dropping it silently`);
  });

  test(`${name} resolves rather than throwing when fetch rejects with an ordinary network error`, async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed: ECONNRESET');
    };
    const mod = await import('../../lib/notify.js');
    await assert.doesNotReject(() => call(mod), `${name} must not throw for a plain network failure`);
    assert.ok(loggedSomething(), `${name} must log the failure rather than dropping it silently`);
  });

  test(`${name} passes the exact AbortSignal it constructed with a 15000ms timeout to fetch`, async () => {
    // Stub AbortSignal.timeout itself so the assertion pins BOTH the duration passed
    // to it AND that the signal handed to fetch is that exact return value — not
    // just "truthy" or "some AbortSignal" — while never constructing a real timer.
    const ac = new AbortController();
    const sentinelSignal = ac.signal; // a genuine AbortSignal instance, no timer attached
    const timeoutCalls = [];
    AbortSignal.timeout = (ms) => { timeoutCalls.push(ms); return sentinelSignal; };

    let capturedOpts;
    globalThis.fetch = async (url, opts) => {
      capturedOpts = opts;
      return { ok: true, text: async () => '' };
    };

    const mod = await import('../../lib/notify.js');
    await call(mod);

    assert.deepEqual(timeoutCalls, [15000], `${name} must request exactly a 15000ms timeout — a future edit that drops or changes it should fail this test`);
    assert.ok(capturedOpts.signal instanceof AbortSignal, `${name} must pass an AbortSignal to fetch`);
    assert.equal(capturedOpts.signal, sentinelSignal, `${name} must pass the signal it actually constructed, not a different one`);
  });
}

test('notify({ immediate: true }) resolves rather than throwing when the underlying send fails', async () => {
  // This is the exact call shape agents/dashboard/lib/fatal-reporter.js and several
  // cron agents' success/error paths use. notify()'s immediate branch has no
  // try/catch of its own — it relies entirely on sendEmail() never throwing.
  globalThis.fetch = async () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    throw err;
  };
  const { notify } = await import('../../lib/notify.js');
  await assert.doesNotReject(() => notify({
    subject: 'test',
    body: 'body',
    status: 'error',
    immediate: true,
  }));
});
