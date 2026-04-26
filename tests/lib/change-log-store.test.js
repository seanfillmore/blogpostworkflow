import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteJson, readJsonOrNull, eventPath, windowPath, queueItemPath } from '../../lib/change-log/store.js';

test('atomicWriteJson writes file with pretty JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const file = join(dir, 'sub/dir/data.json');
    atomicWriteJson(file, { hello: 'world', n: 1 });
    const text = readFileSync(file, 'utf8');
    assert.equal(text, '{\n  "hello": "world",\n  "n": 1\n}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteJson does not leave a temp file behind on success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const file = join(dir, 'data.json');
    atomicWriteJson(file, { a: 1 });
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['data.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonOrNull returns null for missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const result = readJsonOrNull(join(dir, 'missing.json'));
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonOrNull returns parsed content for present file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const file = join(dir, 'data.json');
    atomicWriteJson(file, { x: 42 });
    const result = readJsonOrNull(file);
    assert.deepEqual(result, { x: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eventPath returns YYYY-MM partitioned path', () => {
  const path = eventPath('ch-2026-04-25-foo-001', '2026-04-25T12:00:00Z');
  assert.equal(path.endsWith('data/changes/events/2026-04/ch-2026-04-25-foo-001.json'), true);
});

test('windowPath returns slug-partitioned path', () => {
  const path = windowPath('coconut-lotion', 'win-coconut-lotion-2026-04-25');
  assert.equal(path.endsWith('data/changes/windows/coconut-lotion/win-coconut-lotion-2026-04-25.json'), true);
});

test('queueItemPath returns slug-partitioned path', () => {
  const path = queueItemPath('coconut-lotion', 'q-2026-04-25-001');
  assert.equal(path.endsWith('data/changes/queue/coconut-lotion/q-2026-04-25-001.json'), true);
});
