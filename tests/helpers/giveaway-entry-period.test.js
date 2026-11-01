import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { giveawayEntryPeriod, entriesClosedSkip, entryPeriodGate } from './giveaway-entry-period.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));

test('inside the Entry Period the suites RUN', () => {
  // The whole point of retiring rather than deleting: a future giveaway gets
  // its tests back with nobody remembering they existed.
  const mid = new Date((Date.parse(config.entryOpensAt) + Date.parse(config.entryClosesAt)) / 2);
  assert.equal(giveawayEntryPeriod(mid).open, true);
  assert.equal(entriesClosedSkip(mid), '');
  const gate = entryPeriodGate({ test: () => {}, before: () => {}, after: () => {} }, mid);
  assert.equal(gate.skip, '');
});

test('after the close they skip, and the reason names the date', () => {
  const after = new Date(Date.parse(config.entryClosesAt) + 1000);
  assert.equal(giveawayEntryPeriod(after).open, false);
  const reason = entriesClosedSkip(after);
  assert.match(reason, /closed/i);
  assert.ok(
    reason.includes(config.entryClosesAt),
    'a skip must say WHEN it started being a skip, or it reads as "broken, ignored"',
  );
});

test('before the open they also skip', () => {
  const early = new Date(Date.parse(config.entryOpensAt) - 1000);
  assert.equal(giveawayEntryPeriod(early).open, false);
  assert.match(entriesClosedSkip(early), /not opened/i);
});

test('the gate makes HOOKS no-ops too, not just tests', () => {
  // node:test runs a file's before/after even when every test is skipped, and
  // two of these suites launch a real browser there. Gating the tests alone
  // would still spend a browser launch to report nothing.
  const after = new Date(Date.parse(config.entryClosesAt) + 1000);
  let hookRan = false;
  let skipOpts = null;
  const gate = entryPeriodGate({
    test: (_name, opts) => { skipOpts = opts; },
    before: () => { hookRan = true; },
    after: () => { hookRan = true; },
  }, after);
  gate.before(() => { hookRan = true; });
  gate.after(() => { hookRan = true; });
  assert.equal(hookRan, false, 'hooks must not run while the period is closed');
  gate.test('anything', () => { throw new Error('must not run'); });
  assert.ok(skipOpts?.skip, 'the test must be registered as SKIPPED, not silently dropped');
});

test('an unreadable or unparseable config RUNS the suites rather than skipping', () => {
  // "Unreadable is not closed" — the same rule as a post lock or a title_tag.
  // Silently disabling a suite for a reason unrelated to the giveaway is the
  // quiet loss of capability this repo keeps guarding against.
  const bad = giveawayEntryPeriod.call(null, new Date('not a date'));
  // NaN now: both comparisons are false, so it falls through to open.
  assert.equal(bad.open, true);
});
