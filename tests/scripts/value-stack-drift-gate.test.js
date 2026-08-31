import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_ARGS, classifyValueStackGateExit,
} from '../../scripts/check-bundle-value-stack-drift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_SRC = readFileSync(join(ROOT, 'scripts', 'check-bundle-value-stack-drift.mjs'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// This gate exists because the $180-vs-$174 split on the Coconut Reset lander
// went unnoticed for months, and when it was finally checked the SAME defect
// turned out to be live on two more bundles. Nothing anywhere reported it.
// ─────────────────────────────────────────────────────────────────────────────

test('GATE_ARGS is frozen and empty — a scheduled run cannot acquire a flag', () => {
  assert.deepEqual(GATE_ARGS, []);
  assert.ok(Object.isFrozen(GATE_ARGS));
});

test('a consistent run is routine, not a failure row', () => {
  const v = classifyValueStackGateExit(0);
  assert.equal(v.status, 'success');
  assert.equal(v.needsHuman, false);
});

test('a diverging bundle needs a human, because a live page is stating two prices', () => {
  const v = classifyValueStackGateExit(1);
  assert.equal(v.status, 'error');
  assert.equal(v.needsHuman, true);
  assert.match(v.headline, /compare-at|two different|value/i);
});

test('an unreachable Shopify is an error, not a silent pass', () => {
  // The dangerous failure is a check that cannot read anything and reports clean.
  const v = classifyValueStackGateExit(2);
  assert.equal(v.status, 'error');
  assert.equal(v.needsHuman, true);
});

test('nothing this gate emits is ever immediate', () => {
  for (const code of [0, 1, 2, 64, 99]) {
    assert.equal(classifyValueStackGateExit(code).immediate, false, `exit ${code}`);
  }
});

test('an unexpected exit code is itself the finding', () => {
  const v = classifyValueStackGateExit(99);
  assert.equal(v.status, 'error');
  assert.match(v.headline, /99/);
});

test('the gate spawns exactly one child, and it is the read-only check', () => {
  // Counted rather than string-matched: the checker IS named in the digest body,
  // so scanning for the name would pass even if the gate started running it.
  const spawns = GATE_SRC.match(/spawnSync\(/g) || [];
  assert.equal(spawns.length, 1, 'exactly one spawnSync');
  assert.ok(GATE_SRC.includes('check-bundle-value-stacks.mjs'), 'spawns the checker');
  assert.ok(!/spawnSync\([^)]*reconcile/s.test(GATE_SRC), 'never spawns a reconciler');
});

test('the gate refuses a write flag rather than passing it through', () => {
  assert.ok(/--apply/.test(GATE_SRC), 'names --apply so it can refuse it');
  assert.ok(/return 64/.test(GATE_SRC), 'refuses with exit 64');
});

test('the underlying check has no apply path and cannot mutate', () => {
  // Belt and braces: the gate refuses the flag, and the checker has no such flag
  // to accept. Asserted against CODE, not raw source — both files discuss
  // `--apply` at length in their headers precisely to explain that neither
  // accepts one, so a naive string scan fails on the documentation of the
  // property it is checking.
  const CHECK = readFileSync(join(ROOT, 'scripts', 'check-bundle-value-stacks.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/--apply/.test(CHECK), 'the checker must never grow an --apply flag');
  assert.ok(!/metafieldsSet|productUpdate|productVariantsBulkUpdate/.test(CHECK), 'the checker must never mutate');
});

// Cron assertions read only VARIABLE DEFINITIONS, never the file's prose. This
// file explains at length that a TZ= prefix schedules nothing here, so scanning
// raw source would fail on its own explanation.
const CRON = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');

// NOTE the escaped-quote alternation. The sibling test in
// tests/scripts/post-meta-drift-gate.test.js uses `"([^"]*)"`, which cannot match
// any line containing `\"$PROJECT_DIR\"` — that is nearly every job in this file,
// so its TZ= assertion silently examines almost nothing. This pattern accepts
// backslash escapes, so the checks below actually cover the whole crontab.
const cronDefs = () => [...CRON.matchAll(/^[A-Z0-9_]+="((?:[^"\\]|\\.)*)"$/gm)].map((m) => m[1]);

test('the cron-definition matcher actually matches the crontab', () => {
  // Guards the assertions below from going vacuous the way the sibling did.
  const defs = cronDefs();
  assert.ok(defs.length >= 30, `expected the bulk of the crontab, matched ${defs.length}`);
  assert.ok(defs.some((l) => l.includes('$PROJECT_DIR')), 'escaped-quote lines must be matched, not skipped');
});

test('no cron line carries a TZ= prefix — this host schedules in UTC only', () => {
  // `cron 3.0pl1` supports neither CRON_TZ nor a TZ crontab variable, and an
  // inline `TZ=x cd … && node` is a shell assignment scoped to `cd`. Five such
  // prefixes were inert twice over and were stripped on 2026-08-23.
  for (const line of cronDefs()) {
    assert.ok(!/\bTZ=/.test(line), `a TZ= prefix schedules nothing here: ${line.slice(0, 80)}`);
  }
});

test('the gate is scheduled at 12:30 UTC and carries no write flag', () => {
  const line = cronDefs().find((l) => l.includes('check-bundle-value-stack-drift.mjs'));
  assert.ok(line, 'installed in setup-cron.sh');
  // 12:20 content-mirror, 12:40 post-meta, 13:00 daily-summary. This takes 12:30
  // so all three land in the SAME morning's digest without sharing a slot.
  assert.match(line, /^30 12 \* \* \* /, 'runs at 12:30 UTC');
  assert.ok(!/--apply|--fix|--write/.test(line), 'the cron line must never carry a write flag');
});
