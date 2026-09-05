// tests/agents/unattended-browser-lifecycle.test.js
//
// A CRON-DRIVEN AGENT THAT LAUNCHES CHROME MUST CLOSE IT IN A `finally`, AND
// `scheduler.js` MUST BOUND EVERY STEP IT SHELLS OUT TO.
//
// THE INCIDENT (2026-09-01 → 2026-09-05). `agents/theme-seo-auditor` is the
// FIRST job in the monthly block. It launched Chrome, called `lighthouse()`
// with no wall-clock ceiling, and stalled. Four days later the Sep 1 scheduler
// process was still sitting on that call:
//
//   279142  Tue Sep  1 15:00:01  node scheduler.js          <- still running
//   283466  Tue Sep  1 15:33:26  node theme-seo-auditor     <- 123 MB
//   283490  Tue Sep  1 15:33:33  chrome (+5 children)       <- ~210 MB
//
// On a 1 vCPU / 1 GB droplet with NO SWAP that ~334 MB of leaked garbage was
// enough to keep the box permanently against its memory ceiling, and the OOM
// killer took `seo-dashboard` instead — 642 restarts, and the dashboard served
// Cloudflare 502s. The leak was three independent defects stacked:
//
//   1. `lighthouse()` had no timeout, and A STALL IS NOT AN ERROR — the
//      existing try/catch around it could not see one.
//   2. `await browser.close()` sat after the loop with no `finally`, so any
//      throw (or any stall before it) orphaned the whole Chrome tree.
//   3. `execSync` in `scheduler.js` had no `timeout`, so ONE hung step wedged
//      the entire pipeline with no failure ever recorded — the monthly steps
//      after it (content-gap, device weights) silently never ran, and the 5 AM
//      digest said nothing, because the process never exited to report.
//
// Any one of the three would have bounded the damage. That is why all three are
// pinned here rather than just the one that stalled: the next agent to learn to
// hang will not be this one.
//
// A SOURCE SCAN rather than a behavioural test, for the same two reasons
// `tests/lib/puppeteer-launch-args.test.js` gives: importing `agents/*/index.js`
// runs the agent, and launching Chrome to assert how Chrome is shut down would
// be circular AND would fail on the server, which is worse than no test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Agents reached UNATTENDED (scheduler.js or crontab). A hand-run script that
// leaks Chrome is a nuisance you are present to notice; one of these is a leak
// nobody sees for four days. `scripts/*` are deliberately out of scope.
const UNATTENDED_BROWSER_AGENTS = [
  'agents/theme-seo-auditor/index.js',
  'agents/competitor-intelligence/index.js',
];

for (const rel of UNATTENDED_BROWSER_AGENTS) {
  test(`${rel}: every puppeteer.launch is matched by a close in a finally`, () => {
    const src = read(rel);
    const launches = (src.match(/puppeteer\.launch\(/g) || []).length;
    assert.ok(launches > 0, `${rel} should still launch a browser (test needs updating if not)`);

    // Every launch needs a close that a throw cannot skip. Count `finally`
    // blocks that close a browser, not bare `.close()` calls — a close on the
    // happy path only is exactly defect (2) above.
    const finallyCloses = (src.match(/finally\s*\{[^}]*(?:closeBrowser|browser\.close\(\))/gs) || []).length;
    assert.ok(
      finallyCloses >= launches,
      `${rel} has ${launches} puppeteer.launch call(s) but only ${finallyCloses} close(s) inside a finally. ` +
        'A browser closed only on the happy path is orphaned by any throw or stall — see the header.',
    );
  });
}

test('theme-seo-auditor bounds the Lighthouse call', () => {
  const src = read('agents/theme-seo-auditor/index.js');

  assert.match(
    src,
    /LIGHTHOUSE_TIMEOUT_MS/,
    'theme-seo-auditor must declare a Lighthouse wall-clock ceiling — a stall is not an error and its try/catch cannot see one.',
  );

  // The ceiling has to actually wrap the lighthouse() call, not merely exist.
  assert.match(
    src,
    /withTimeout\(\s*lighthouse\(/,
    'the LIGHTHOUSE_TIMEOUT_MS ceiling must wrap the lighthouse() call itself.',
  );

  const ms = Number(/const LIGHTHOUSE_TIMEOUT_MS = ([\d_]+)/.exec(src)?.[1]?.replace(/_/g, ''));
  assert.ok(Number.isFinite(ms), 'LIGHTHOUSE_TIMEOUT_MS must be a numeric literal');
  // Generous against the only healthy sample in 52 days of scheduler logs
  // (5.7s), but far inside the scheduler's own step ceiling so the agent
  // degrades its own report rather than being killed from outside.
  assert.ok(ms >= 60_000, `LIGHTHOUSE_TIMEOUT_MS ${ms}ms is too tight — a slow cold run on a 1-vCPU box would fail spuriously.`);
  assert.ok(ms <= 600_000, `LIGHTHOUSE_TIMEOUT_MS ${ms}ms is too loose to bound a hang usefully.`);
});

test('theme-seo-auditor exits explicitly on success', () => {
  const src = read('agents/theme-seo-auditor/index.js');
  // Lighthouse/Chrome can leave an open handle, and node will not exit while
  // one is pending — a run that finished its work could still sit forever
  // holding memory, which is what scheduler.js was blocked on.
  assert.match(
    src,
    /process\.exit\(0\)/,
    'theme-seo-auditor must exit explicitly on the success path; a lingering Chrome handle otherwise keeps the process (and its memory) alive indefinitely.',
  );
});

test('scheduler.js bounds every step it shells out to', () => {
  const src = read('scheduler.js');

  // The one execSync in runStep must carry a timeout. Without it a single hung
  // agent wedges the pipeline forever with no failure recorded anywhere.
  const execCalls = [...src.matchAll(/execSync\(([^;]*?)\);/gs)];
  assert.ok(execCalls.length > 0, 'scheduler.js should still shell out via execSync');
  for (const [whole] of execCalls) {
    assert.match(
      whole,
      /timeout/,
      `scheduler.js has an execSync with no timeout:\n${whole.slice(0, 200)}\n` +
        'An unbounded step can wedge the whole daily pipeline — see the header.',
    );
  }

  // Parsed as a product of integer literals rather than eval'd — the constant
  // is written `150 * 60 * 1000` for readability and this keeps the test from
  // executing repo source to read a number out of it.
  const expr = /const STEP_TIMEOUT_MS = ([\d_ *]+);/.exec(src)?.[1];
  assert.ok(expr, 'STEP_TIMEOUT_MS must be a product of plain integer literals');
  const ms = expr
    .split('*')
    .map((part) => Number(part.replace(/[_\s]/g, '')))
    .reduce((a, b) => a * b, 1);
  assert.ok(Number.isFinite(ms) && ms > 0, 'STEP_TIMEOUT_MS must be a positive numeric literal');

  // MEASURED FLOOR, and this is the assertion that matters most. Across 62 real
  // runs (2026-07-15 → 2026-09-05) the slowest step that COMPLETED NORMALLY was
  // `publish-due` at 5,205s. A ceiling at or under that kills healthy work on an
  // ordinary day — the 45-minute value guessed before measuring would have
  // killed both `publish-due` and `cannibalization-resolver` (3,679s).
  const SLOWEST_HEALTHY_STEP_MS = 5_205_000;
  assert.ok(
    ms > SLOWEST_HEALTHY_STEP_MS,
    `STEP_TIMEOUT_MS ${ms}ms is at or below the slowest step ever observed to complete normally ` +
      `(${SLOWEST_HEALTHY_STEP_MS}ms, publish-due). It would kill healthy work. Re-measure from ` +
      'data/reports/scheduler/scheduler.log before lowering this.',
  );
  // A day is the interval between runs; a ceiling past it stops bounding anything.
  assert.ok(ms < 24 * 60 * 60 * 1000, 'STEP_TIMEOUT_MS must be well under the 24h gap between runs');
});

test('scheduler.js reports a timed-out step as a timeout, not a phantom exit code', () => {
  const src = read('scheduler.js');
  // execSync surfaces a timeout as code ETIMEDOUT / status null / signal
  // SIGTERM (verified on Node 22 and 25). Keying off `code` distinguishes it
  // from an operator's SIGTERM, and stops the log reading "exit null".
  assert.match(
    src,
    /ETIMEDOUT/,
    'scheduler.js must recognise ETIMEDOUT so a timed-out step is logged as a timeout rather than "exit null".',
  );
});
