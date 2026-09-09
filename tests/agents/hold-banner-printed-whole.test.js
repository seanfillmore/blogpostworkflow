// holdBanner() returns a STRING. `for (const line of holdBanner(hold))` iterates
// CHARACTERS, so the $0-cluster gate's banner printed one letter per line —
// found in agents/cannibalization-resolver on 2026-09-09, in a live --apply run.
//
// That banner is how a DISARMED gate announces itself ("⚠ The $0-cluster gate is
// OFF this run: <why>"). CLAUDE.md's rule is that a gate which quietly stopped
// gating must never render like a clean run; a banner shredded into a column of
// single characters is worse than that — it is unreadable while still technically
// present. Nine agents call holdBanner and only this one got it wrong.
//
// A source scan, because importing any of these agents RUNS it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { holdBanner } from '../../lib/cluster-hold.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('holdBanner returns a string — the premise the scan below rests on', () => {
  // If this ever becomes an array, the for...of pattern is CORRECT and this
  // whole test must be revisited rather than the callers "fixed".
  assert.equal(typeof holdBanner(null), 'string');
  assert.equal(typeof holdBanner({ stale: true, freshness: {} }), 'string');
});

test('no agent iterates holdBanner() with for...of', () => {
  const agentsDir = join(ROOT, 'agents');
  const offenders = [];
  for (const name of readdirSync(agentsDir)) {
    const file = join(agentsDir, name, 'index.js');
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    // Match an iteration over the call, or over a variable holding it.
    if (/for\s*\(\s*const\s+\w+\s+of\s+holdBanner\s*\(/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    'iterating a string yields characters — assign it and console.log it whole');
});

test('the resolver prints its banner whole', () => {
  const src = readFileSync(join(ROOT, 'agents/cannibalization-resolver/index.js'), 'utf8');
  assert.match(src, /const banner = holdBanner\(hold\)/);
  assert.match(src, /if \(banner\) console\.log\(banner\)/);
});
