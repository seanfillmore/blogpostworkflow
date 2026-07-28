import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  capturePreState, writePreState, appendAction, preStatePath, actionLogPath,
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
