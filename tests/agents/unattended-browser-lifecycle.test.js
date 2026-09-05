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

test('Lighthouse is GONE from the fleet — the whole hazard class, not just its timeout', () => {
  // Removed 2026-09-05. The 180s ceiling this test used to pin was the right
  // fix for a call that had to exist; measuring it showed it did not.
  // PERFORMANCE was duplicated by agents/pagespeed-monitor AND contradicted by
  // first-party RUM (lab 39 / LCP 6109ms vs RUM mobile LCP p75 1.33s green),
  // SEO scored 100/100 with sub-checks the DOM audits already cover, and
  // ACCESSIBILITY — the one unique number — had no consumer and had never been
  // read, because data/reports/theme-seo-audit/ has never existed on
  // production. Deleting the call deletes the hang, the ~334 MB of orphaned
  // Chrome and ~34 of the 36 seconds of a run.
  //
  // Bounding a call is a weaker guarantee than not making it. This asserts the
  // stronger property.
  assert.ok(
    !read('agents/theme-seo-auditor/index.js').match(/^\s*import .*['"]lighthouse['"]/m),
    'theme-seo-auditor must not import lighthouse — see the note above compileIssues for what was measured.',
  );

  // It was the only consumer in the repo, so the dependency goes too. A package
  // left in place is an invitation to re-add the import.
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    !pkg.dependencies?.lighthouse && !pkg.devDependencies?.lighthouse,
    'the lighthouse dependency must not return without a consumer that justifies it',
  );
});

test('the browser-close ceiling survives the Lighthouse removal', () => {
  // withTimeout stays, because browser.close() can itself hang on a wedged
  // Chrome — that guarantee is independent of what the browser was used for.
  const src = read('agents/theme-seo-auditor/index.js');
  const ms = Number(/const BROWSER_CLOSE_TIMEOUT_MS = ([\d_]+)/.exec(src)?.[1]?.replace(/_/g, ''));
  assert.ok(Number.isFinite(ms) && ms > 0, 'BROWSER_CLOSE_TIMEOUT_MS must remain a numeric literal');
  assert.match(src, /withTimeout\(browser\.close\(\)/, 'browser.close() must stay bounded');
  assert.match(src, /SIGKILL/, 'a close that times out must still fall back to killing the process');
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
