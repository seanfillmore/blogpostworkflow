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
import { inspect } from 'node:util';
import { createFatalReporter } from '../../agents/dashboard/lib/fatal-reporter.js';

/** An object whose [util.inspect.custom] throws — the third hostile-error variant. */
function makeHostileFormatValue() {
  const value = {};
  Object.defineProperty(value, inspect.custom, {
    value() { throw new Error('custom inspect throws'); },
  });
  return value;
}

function makeLogger() {
  const calls = [];
  return { calls, error: (...args) => calls.push(args) };
}

/**
 * A logger whose `.error` formats non-string arguments the way the REAL `console.error`
 * does — via `util.inspect` — instead of storing them raw. `makeLogger()`'s stub does not
 * do this, so it cannot reproduce the util.inspect.custom hostile-format defect at all: it
 * happily "passes" a hostile `.stack` object straight through to `calls.push(args)` without
 * ever invoking the formatting step where the real crash happens. Use this one specifically
 * for the hostile-format tests below.
 */
function makeInspectingLogger() {
  const calls = [];
  return {
    calls,
    error: (...args) => {
      calls.push(args.map((a) => (typeof a === 'string' ? a : inspect(a))));
    },
  };
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

test('a truthy .stack that throws when formatted by util.inspect is also contained', async () => {
  // The third variant of the hostile-error class, distinct from the throwing-getter case
  // above: describe()'s try/catch guards the READ of `.stack`, but a first cut of the fix
  // returned a truthy `.stack` as-is instead of forcing String() on it. console.error
  // formats a non-string argument via util.inspect, which invokes
  // Symbol.for('nodejs.util.inspect.custom') if the value defines one — a throw from THAT
  // is not caught by Node's inspect internals, so it escaped reportFatal() synchronously at
  // the logger.error() call site, AFTER describe()'s own try/catch had already returned
  // successfully (the read itself never threw — only formatting it later did). Reproduced
  // and verified against this project's pinned Node 22.23.1. Uses makeInspectingLogger(),
  // not makeLogger() — a stub that stores raw args never invokes util.inspect at all, so it
  // cannot exercise this failure mode (confirmed: this exact test kept passing against the
  // unfixed describe() when first written against the plain stub, which is why the logger
  // choice matters here).
  rejections.length = 0;
  const logger = makeInspectingLogger();
  const notify = async () => {};
  const reportFatal = createFatalReporter({ notify, logger });
  const hostileErr = { stack: makeHostileFormatValue() };

  let thrown = null;
  try {
    reportFatal('uncaughtException', hostileErr);
  } catch (e) {
    thrown = e;
  }
  await drain();

  assert.equal(thrown, null, 'reportFatal must not throw synchronously for a hostile-to-format .stack');
  assert.deepEqual(rejections, [], 'nothing should escape as an unhandled rejection either');
});

test('a notifyErr whose .stack is hostile to format is also contained (the second describe() call site)', async () => {
  // Same variant as above, but through the OTHER describe() call site: the .catch() that
  // formats notify()'s own rejection reason. describe() is the same function for both call
  // sites, so this should already be closed — this test verifies that rather than assuming
  // it, using makeInspectingLogger() for the same reason as the previous test: the format
  // step only runs (and only crashes) when something actually calls util.inspect on the
  // value, which a plain args-storing stub never does. Unlike the previous test, the
  // logger.error() call this exercises happens inside the .catch() callback — asynchronous,
  // not a synchronous call from reportFatal() — so a throw there would surface as an
  // unhandled rejection of that .catch()'s own promise, not a synchronous throw out of
  // reportFatal() itself. The `rejections` assertion below is what actually proves it.
  rejections.length = 0;
  const logger = makeInspectingLogger();
  const notify = async () => {
    const err = new Error('notify failed');
    err.stack = makeHostileFormatValue();
    throw err;
  };
  const reportFatal = createFatalReporter({ notify, logger });

  let thrown = null;
  try {
    reportFatal('unhandledRejection', new Error('original failure'));
  } catch (e) {
    thrown = e;
  }
  await drain();

  assert.equal(thrown, null, 'reportFatal must not throw synchronously when notify()\'s own rejection has a hostile .stack');
  assert.deepEqual(rejections, [], 'nothing should escape as an unhandled rejection either');
});

test('a resolving notify() logs no failure and the guard resets for the next fatal', async () => {
  // Explicit happy-path coverage: no failure logged, and the re-entrancy guard is not
  // still held after a clean, successful notify() call. Test 4 covers the guard resetting
  // indirectly (via a failing notify()); this covers the ordinary case directly.
  rejections.length = 0;
  const logger = makeLogger();
  let notifyCalls = 0;
  const notify = async () => { notifyCalls += 1; };
  const reportFatal = createFatalReporter({ notify, logger });

  reportFatal('uncaughtException', new Error('handled cleanly'));
  await drain();

  assert.equal(notifyCalls, 1);
  assert.deepEqual(rejections, []);
  assert.ok(
    !logger.calls.some((c) => String(c[0]).includes('notify failed')),
    'nothing should be logged as a notify failure when notify() resolves'
  );

  // A second, independent fatal after the first resolved cleanly should still call notify()
  // — proving the guard is not stuck "in flight" after a success.
  reportFatal('uncaughtException', new Error('second, independent'));
  await drain();

  assert.equal(notifyCalls, 2, 'the guard must not remain held after the prior call resolved');
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
