import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  capturePreState, writePreState, appendAction, preStatePath, actionLogPath,
  preStateExists, assertPreStateCaptured,
} from '../../lib/consolidation-log.js';

test('preStatePath and actionLogPath are dated inside the collection-consolidation report dir', () => {
  const date = new Date('2026-07-27T12:00:00Z');
  assert.equal(preStatePath(date), 'data/reports/collection-consolidation/pre-state-2026-07-27.json');
  assert.equal(actionLogPath(date), 'data/reports/collection-consolidation/actions-2026-07-27.jsonl');
});

test('capturePreState gathers collections, menus, and survivor body_html from injected fetchers', async () => {
  const getCustomCollections = async () => [
    { id: 1, handle: 'foaming-hand-soap', published_at: '2019-10-22T00:00:00Z', body_html: '<p>soap</p>' },
  ];
  const getSmartCollections = async () => [
    { id: 2, handle: 'non-toxic-body-lotion', published_at: '2024-04-21T00:00:00Z', body_html: '<p>lotion</p>' },
    { id: 3, handle: 'vegan-deodorant', published_at: null, body_html: '' },
  ];
  const shopifyGraphQL = async () => ({ menus: { nodes: [{ id: 'gid://shopify/Menu/1', handle: 'main-menu', title: 'Main', items: [] }] } });

  const state = await capturePreState({
    getCustomCollections, getSmartCollections, shopifyGraphQL,
    survivorHandles: ['foaming-hand-soap', 'non-toxic-body-lotion'],
  });

  assert.equal(state.collections.length, 3);
  assert.deepEqual(state.collections.find((c) => c.handle === 'vegan-deodorant'), { id: 3, handle: 'vegan-deodorant', published_at: null });
  assert.equal(state.menus.length, 1);
  assert.equal(state.menus[0].handle, 'main-menu');
  assert.equal(state.survivors.length, 2);
  const lotion = state.survivors.find((s) => s.handle === 'non-toxic-body-lotion');
  assert.equal(lotion.body_html, '<p>lotion</p>');
  assert.ok(state.capturedAt);
});

test('writePreState writes pretty JSON to the given path, creating directories as needed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-log-'));
  try {
    const file = join(dir, 'sub/pre-state.json');
    const returned = writePreState({ a: 1 }, file);
    assert.equal(returned, file);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, { a: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendAction appends a JSONL line with a timestamp, creating directories as needed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-log-'));
  try {
    const file = join(dir, 'sub/actions.jsonl');
    appendAction({ action: 'unpublish', handle: 'rose-lotion' }, file);
    appendAction({ action: 'create_redirect', handle: 'rose-lotion' }, file);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.action, 'unpublish');
    assert.equal(first.handle, 'rose-lotion');
    assert.ok(first.ts, 'each entry gets a timestamp');
    const second = JSON.parse(lines[1]);
    assert.equal(second.action, 'create_redirect');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendAction on a fresh path creates exactly one file, not a directory collision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-log-'));
  try {
    const file = join(dir, 'actions.jsonl');
    assert.ok(!existsSync(file));
    appendAction({ action: 'test' }, file);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Blocker 2 regression: writePreState must be write-once per date-scoped
// path. A same-day re-run (exactly the pattern a Blocker-1-style mid-run
// crash forces) must never silently replace the true pre-mutation baseline
// with state captured after some mutations already landed.
test('writePreState refuses to overwrite an existing pre-state file, leaving the original intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-log-'));
  try {
    const file = join(dir, 'pre-state.json');
    writePreState({ capturedAt: 'first', collections: [] }, file);
    assert.throws(
      () => writePreState({ capturedAt: 'second (post-mutation)', collections: [] }, file),
      /[Rr]efusing to overwrite/,
    );
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.capturedAt, 'first', 'the true pre-mutation baseline must survive a same-day re-run attempt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePreState succeeds normally when no file exists yet at the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consolidation-log-'));
  try {
    const file = join(dir, 'pre-state.json');
    assert.doesNotThrow(() => writePreState({ a: 1 }, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Blocker 3 regression: consolidate-collections.mjs and
// update-navigation.mjs must hard-fail rather than mutate the store with no
// rollback record when no pre-state snapshot exists for the run.
test('preStateExists reflects whether a pre-state file exists for the given date', () => {
  const date = new Date('2026-07-27T12:00:00Z');
  assert.equal(preStateExists(date), existsSync(preStatePath(date)));
});

test('assertPreStateCaptured throws with actionable guidance when no pre-state file exists for the date', () => {
  // A date far enough in the future/past that no real run will ever have
  // captured pre-state for it.
  const date = new Date('2099-01-01T00:00:00Z');
  assert.throws(() => assertPreStateCaptured(date), /setup-survivor-collections\.mjs/);
});

test('assertPreStateCaptured returns the path without throwing once pre-state exists for the date', () => {
  // preStatePath is not parameterised on directory, so exercise the success
  // branch against the real repo-relative path it always resolves to for
  // this date — but never touch it if a genuine rollback record already
  // lives there, and always clean up what this test itself wrote.
  const date = new Date('2099-06-01T00:00:00Z');
  const p = preStatePath(date);
  assert.ok(!preStateExists(date), 'a future date must never already have a real snapshot');
  writePreState({ a: 1 }, p);
  try {
    assert.equal(assertPreStateCaptured(date), p);
  } finally {
    rmSync(p, { force: true });
  }
});
