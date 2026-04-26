import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// We need to override the CHANGES_ROOT during tests. The test injects via
// env var `CHANGE_LOG_ROOT_OVERRIDE`. The lib reads this at import time.
const TEST_DIR = mkdtempSync(join(tmpdir(), 'cl-'));
process.env.CHANGE_LOG_ROOT_OVERRIDE = join(TEST_DIR, 'data', 'changes');

const { findActiveWindow, computeWindowStatus } = await import('../../lib/change-log.js');

test('findActiveWindow returns null when no windows exist for slug', () => {
  const result = findActiveWindow('non-existent-slug');
  assert.equal(result, null);
});

test('computeWindowStatus is "forming" before bundle_locked_at', () => {
  const now = '2026-04-26T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: null,
  };
  assert.equal(computeWindowStatus(window, now), 'forming');
});

test('computeWindowStatus is "measuring" between bundle_locked_at and verdict_at', () => {
  const now = '2026-05-10T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: null,
  };
  assert.equal(computeWindowStatus(window, now), 'measuring');
});

test('computeWindowStatus is "verdict_pending" after verdict_at when verdict is null', () => {
  const now = '2026-05-27T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: null,
  };
  assert.equal(computeWindowStatus(window, now), 'verdict_pending');
});

test('computeWindowStatus is "verdict_landed" once verdict is filled in', () => {
  const now = '2026-05-27T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: { decided_at: '2026-05-26T12:35:00Z', outcome: 'improved' },
  };
  assert.equal(computeWindowStatus(window, now), 'verdict_landed');
});

// Cleanup
process.on('exit', () => rmSync(TEST_DIR, { recursive: true, force: true }));
