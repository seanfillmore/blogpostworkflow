// tests/lib/puppeteer-launch-args.test.js
//
// EVERY `puppeteer.launch` IN THIS REPO MUST PASS `--no-sandbox`, BECAUSE THE
// PRODUCTION BOX RUNS AS ROOT AND CHROME REFUSES TO START THERE WITHOUT IT.
//
//   Failed to launch the browser process:  Code: 1
//   [ERROR:zygote_host_impl_linux.cc:101] Running as root without
//   --no-sandbox is not supported. See https://crbug.com/638180.
//
// This is not a hypothetical. On 2026-08-31 the production suite reported
// 3847 pass / 7 fail where the local suite reported 3854 / 0 — all seven
// failures were one puppeteer test that cannot launch Chrome on the server.
//
// WHY THAT MATTERS MORE THAN SEVEN TESTS. CLAUDE.md's standing habit is "run
// the suite ON THE SERVER before believing it", because the committed mirrors
// are older than the box's and local green has repeatedly meant nothing. A
// permanently-red server suite destroys that signal: once `npm test` on the box
// always fails, nobody can tell a new regression from the standing failure, and
// the check quietly stops being run. A test that cannot pass in the environment
// it is meant to gate is worse than no test, because it looks like coverage.
//
// THE CONVENTION ALREADY EXISTED — this only closes the two sites that missed
// it. Measured across the repo when this test was written, 8 of 10 launch sites
// already passed the flag (`capture-console-errors`, `generate-analysis-pdf`,
// `render-frame`, `check-variant-picker`, `verify-ga4-collect`,
// `theme-seo-auditor`, and both in `competitor-intelligence`, several of which
// additionally pass `--disable-setuid-sandbox`). The two that did not were
// `tests/theme/giveaway-survey-shift.test.js` and
// `scripts/build-digital-assets.mjs`. So this is a scan that pins an existing
// rule, not a new policy.
//
// The `build-digital-assets.mjs` half had not fired yet only because that
// script is run by hand from a laptop; it renders the bundle PDFs and would
// have failed the same way the first time anyone ran it on the box.
//
// ON THE SANDBOX ITSELF: disabling it is the documented answer for a trusted
// root container, and every input here is first-party — our own theme CSS and
// markup served from 127.0.0.1, our own asset HTML. Nothing renders untrusted
// third-party pages under root. (`competitor-intelligence` does fetch external
// sites, and it already passed both flags before this change.)
//
// A source scan rather than a behavioural test: launching Chrome to assert how
// Chrome is launched would be circular, and would itself fail on the box.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEARCH_DIRS = ['agents', 'lib', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'coverage']);

/** Every .js/.mjs file under the searched trees. */
function sourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, acc);
    else if (/\.(mjs|js)$/.test(e.name) && statSync(full).isFile()) acc.push(full);
  }
  return acc;
}

/**
 * Every `puppeteer.launch(...)` call, with its argument text.
 *
 * Braces are balanced rather than regex-matched to the first `)`, because the
 * options object legitimately contains nested objects and parentheses, and a
 * lazy match would truncate the args and report a false failure.
 */
function launchCalls(src) {
  const calls = [];
  const re = /puppeteer\s*\.\s*launch\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    calls.push(src.slice(re.lastIndex, i - 1));
  }
  return calls;
}

// This file quotes `puppeteer.launch(...)` in its own failure message and in
// the comment above, so it matches its own scan. A rule that fires on the text
// explaining the rule forces the explanation to be deleted — the same reason
// `tests/agents/schema-injector-dead-types.test.js` strips comments before
// scanning. Excluding the scanner itself is narrower and does not weaken it:
// no other file is exempt.
const SELF = fileURLToPath(import.meta.url);

const FILES = SEARCH_DIRS.flatMap((d) => sourceFiles(join(ROOT, d))).filter((f) => f !== SELF);

test('every puppeteer.launch passes --no-sandbox', () => {
  const offenders = [];
  let checked = 0;

  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('puppeteer')) continue;
    for (const args of launchCalls(src)) {
      checked += 1;
      if (!args.includes('--no-sandbox')) {
        offenders.push(`${relative(ROOT, file)} → puppeteer.launch(${args.replace(/\s+/g, ' ').trim()})`);
      }
    }
  }

  // The scan is worthless if it silently matches nothing — a refactor that
  // renames the import would make this test pass by finding no calls at all.
  assert.ok(checked > 0, 'found no puppeteer.launch calls — the scan is not matching anything');

  assert.deepEqual(
    offenders,
    [],
    'Chrome refuses to start as root without --no-sandbox, and the production box runs as root.\n'
      + 'These launch sites would fail there:\n  ' + offenders.join('\n  '),
  );
});
