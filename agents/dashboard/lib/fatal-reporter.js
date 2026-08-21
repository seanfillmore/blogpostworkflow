/**
 * LAST RESORT, NOT THE FIX. lib/router.js's dispatch() guard and readJsonBody between
 * them are supposed to make process-level unhandledRejection / uncaughtException
 * unreachable — anything arriving here is a bug report, not a routine event, which is
 * why it notifies immediately rather than deferring to the 5 AM digest.
 *
 * KEEP SERVING, deliberately. Node terminates on an unhandled rejection by default since
 * v15, and that default is what took the whole dashboard down for every tab whenever one
 * request went wrong. The cost of surviving is that the one in-flight request hangs until
 * its client times out; the cost of exiting is an outage, which is the thing this whole
 * change exists to remove. Nothing in this module calls process.exit or restarts anything.
 *
 * TWO ESCAPE PATHS, both closed:
 *
 * 1. `notify` is declared `async`, so ANY failure inside it — including one on its very
 *    first line, before any `await` — surfaces as a rejected Promise, never a synchronous
 *    throw. Calling it unawaited inside a bare `try/catch` cannot see that: the catch only
 *    fires for an error thrown while constructing the arguments, before notify() is even
 *    entered. Building the call inside a `.then()` and chaining `.catch()` off it unifies
 *    both failure modes onto that one `.catch()` — a synchronous throw while building the
 *    notify() arguments rejects the `.then()`'s promise exactly like an async rejection
 *    from notify() itself would. That was the actual production defect this module fixes:
 *    without it, a `notify()` failure (Resend unreachable, bad key, network blip — all
 *    ordinary for an `immediate: true` send) became a fresh unhandledRejection, which
 *    re-entered this same reporter, which called notify() again, which could reject again
 *    — an infinite loop making a live network call on every iteration. The net built to
 *    prevent an outage became one.
 *
 * 2. `err` is arbitrary — whatever a route or a dependency threw or rejected with — so
 *    reading `err.stack` is not guaranteed safe (a hostile or unusual object can have a
 *    throwing `.stack` getter). That read used to happen directly in the synchronous log
 *    line BEFORE the `.then()` above even exists, so wrapping notify()'s own call could
 *    not help it: a throw there escapes reportFatal() synchronously, and a listener that
 *    throws synchronously out of 'uncaughtException' is fatal to the process by Node's own
 *    design — worse than the unhandledRejection this module exists to contain. `describe()`
 *    closes that path by never letting a read of `err` throw past it.
 *
 * The `reporting` flag is a plain re-entrancy guard, not rate limiting or dedupe: while a
 * report is in flight (i.e. its notify() call hasn't settled yet), any further fatal is
 * logged and dropped rather than recursing into another notify() call. It resets the
 * moment the in-flight report settles, so the next distinct fatal is reported in full.
 */
export function createFatalReporter({ notify, logger = console } = {}) {
  let reporting = false;

  function describe(value) {
    try {
      return value?.stack || String(value);
    } catch {
      return '[fatal-reporter] could not stringify the underlying error';
    }
  }

  return function reportFatal(kind, err) {
    const description = describe(err);

    if (reporting) {
      // A fatal arrived while the previous one was still being reported (most likely:
      // the notify() call below rejected, which is itself an unhandledRejection that
      // re-enters here). Log and stop — do not recurse into another notify() call.
      logger.error(`[dashboard] ${kind} while already reporting a fatal (suppressed):`, description);
      return;
    }

    reporting = true;
    logger.error(`[dashboard] ${kind}:`, description);

    Promise.resolve()
      .then(() => notify({
        status: 'error',
        immediate: true,
        category: 'dashboard',
        subject: `Dashboard ${kind}`,
        body: `${kind} in seo-dashboard — the router guard did not contain it, which means a route is doing work outside a guarded promise.\n\n${description}`,
      }))
      .catch((notifyErr) => {
        // A failing notify must never itself become the thing that kills the process.
        logger.error('[dashboard] notify failed while reporting a fatal:', describe(notifyErr));
      })
      .finally(() => { reporting = false; });
  };
}
