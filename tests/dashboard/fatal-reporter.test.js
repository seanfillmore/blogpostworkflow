// tests/dashboard/fatal-reporter.test.js
//
// agents/dashboard/lib/fatal-reporter.js is the process-level last-resort net for
// unhandledRejection / uncaughtException — the thing that runs when Layers 1 and 2
// (dispatch()'s guard, readJsonBody) already failed to contain a route.
//
// THE DEFECT THIS FILE GUARDS AGAINST: `notify` (lib/notify.js) is declared `async`, so
// any failure inside it — including a rejected fetch to Resend on the very first line —
// surfaces as a rejected Promise, never a synchronous throw. The first cut of this
// reporter called `notify(...)` unawaited inside a bare `try/catch`, which cannot see a
// rejected promise. So a notify() failure (Resend unreachable, bad key, an ordinary
// network blip — all routine for an `immediate: true` send) became a FRESH
// unhandledRejection, which re-entered the reporter, which called notify() again, which
// could reject again: an infinite loop making a live network call on every iteration.
// The net built to prevent an outage became one.
//
// These tests exercise createFatalReporter() directly with a stub notify — no real
// process spawned, no real network call, no import of agents/dashboard/index.js (which
// boots the whole dashboard as a side effect of import). The technique for proving "no
// unhandled rejection reached the process" is the same one
// tests/dashboard/json-body-hardening.test.js uses: register a real
// process.on('unhandledRejection') listener, drain the microtask/macrotask queue, and
// assert nothing arrived.

import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { createFatalReporter } from '../../agents/dashboard/lib/fatal-reporter.js';

function makeLogger() {
  const calls = [];
  return { calls, error: (...args) => calls.push(args) };
}

const rejections = [];
const onUnhandled = (reason) => { rejections.push(reason); };
before(() => { process.on('unhandledRejection', onUnhandled); });
after(() => { process.off('unhandledRejection', onUnhandled); });

/** Let any unawaited promise chain settle and any rejection surface to the process. */
async function drain() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test('a notify() that rejects does not produce an unhandled rejection', async () => {
  rejections.length = 0;
  const logger = makeLogger();
  const notify = async () => { throw new Error('Resend unreachable'); };
  const reportFatal = createFatalReporter({ notify, logger });

  reportFatal('unhandledRejection', new Error('original failure'));
  await drain();

  assert.deepEqual(rejections, [], 'the rejected notify() call must not escape to the process');
  // Both the original fatal and the notify failure were logged.
  assert.ok(logger.calls.some((c) => String(c[0]).includes('unhandledRejection')), 'the original fatal was logged');
  assert.ok(logger.calls.some((c) => String(c[0]).includes('notify failed while reporting a fatal')), 'the notify() failure was logged');
});

test('a notify() that throws synchronously is also contained', async () => {
  rejections.length = 0;
  const logger = makeLogger();
  // A notify() that throws before returning a promise at all (e.g. a non-async stub, or
  // an async function whose synchronous throw Node converts to a rejection for us) —
  // either way, nothing should escape.
  const notify = () => { throw new Error('boom before any await'); };
  const reportFatal = createFatalReporter({ notify, logger });

  reportFatal('uncaughtException', new Error('original failure'));
  await drain();

  assert.deepEqual(rejections, [], 'a synchronous throw from notify() must not escape either');
  assert.ok(logger.calls.some((c) => String(c[0]).includes('notify failed while reporting a fatal')));
});

test('constructing the notify() call arguments throwing synchronously is also contained', async () => {
  rejections.length = 0;
  const logger = makeLogger();
  const notify = async () => {};
  const reportFatal = createFatalReporter({ notify, logger });

  // A hostile err object whose .stack getter throws — this fires while building the
  // notify() call's arguments, before notify() is ever entered.
  const hostileErr = {
    get stack() { throw new Error('getter blew up'); },
  };

  reportFatal('uncaughtException', hostileErr);
  await drain();

  assert.deepEqual(rejections, [], 'a throw while building notify() arguments must not escape');
});

test('the re-entrancy guard prevents recursion while a report is in flight', async () => {
  rejections.length = 0;
  const logger = makeLogger();
  let notifyCalls = 0;
  let resolveFirst;
  const notify = () => {
    notifyCalls += 1;
    // The first call hangs until we resolve it by hand, simulating a slow/in-flight
    // network request. A second fatal arriving in that window must not trigger a
    // second notify() call.
    return new Promise((resolve) => { resolveFirst = resolve; });
  };
  const reportFatal = createFatalReporter({ notify, logger });

  reportFatal('unhandledRejection', new Error('first'));
  // Fire a second fatal synchronously, before the first notify() promise has settled.
  reportFatal('unhandledRejection', new Error('second, while first is in flight'));
  await drain();

  assert.equal(notifyCalls, 1, 'only the first fatal should have called notify() — the second was suppressed');
  assert.ok(
    logger.calls.some((c) => String(c[0]).includes('while already reporting a fatal (suppressed)')),
    'the suppressed second fatal should still be logged'
  );

  // Let the in-flight notify() resolve and confirm the guard resets: a third, later
  // fatal is reported in full rather than staying suppressed forever.
  resolveFirst();
  await drain();

  reportFatal('unhandledRejection', new Error('third, after the first settled'));
  await drain();

  assert.equal(notifyCalls, 2, 'a fatal arriving after the guard resets should call notify() again');
  assert.deepEqual(rejections, []);
});

test('reportFatal never calls process.exit and always returns normally', async () => {
  rejections.length = 0;
  const logger = makeLogger();
  const notify = async () => { throw new Error('still failing'); };
  const reportFatal = createFatalReporter({ notify, logger });

  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = () => { exitCalled = true; };
  try {
    const result = reportFatal('uncaughtException', new Error('boom'));
    assert.equal(result, undefined, 'reportFatal returns normally, synchronously');
    await drain();
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exitCalled, false, 'reportFatal must never call process.exit');
  assert.ok(logger.calls.some((c) => String(c[0]).includes('uncaughtException')), 'the logger saw the event');
  assert.deepEqual(rejections, []);
});
