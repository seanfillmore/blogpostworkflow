import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, emptyState, MAX_FIX_ATTEMPTS } from '../../lib/recap-reviewer-state.js';

const dir = () => mkdtempSync(join(tmpdir(), 'rr-state-'));

test('missing state file -> empty state with every map', () => {
  const s = loadState(join(dir(), 'state.json'));
  assert.deepEqual(s, emptyState());
  for (const k of ['firstSeen', 'fixAttempts', 'regenerated', 'remediated', 'closed']) assert.deepEqual(s[k], {});
});

test('save then load round-trips and fills missing maps', () => {
  const p = join(dir(), 'nested', 'state.json');
  saveState({ firstSeen: { a: '2026-11-10' }, fixAttempts: { a: 2 } }, p);
  const s = loadState(p);
  assert.equal(s.firstSeen.a, '2026-11-10');
  assert.equal(s.fixAttempts.a, 2);
  assert.deepEqual(s.regenerated, {});
  assert.ok(readFileSync(p, 'utf8').endsWith('\n'));
});

test('unreadable state is flagged, never thrown', () => {
  const p = join(dir(), 'state.json');
  writeFileSync(p, '{not json');
  const s = loadState(p);
  assert.equal(s.unreadable, true);
  assert.deepEqual(s.fixAttempts, {});
});

test('fix sessions stop after three attempts', () => {
  assert.equal(MAX_FIX_ATTEMPTS, 3);
});
