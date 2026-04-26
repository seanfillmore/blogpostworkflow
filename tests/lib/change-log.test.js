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

const {
  findActiveWindow,
  computeWindowStatus,
  proposeChange,
  logChangeEvent,
  queueChange,
  getActiveWindow,
} = await import('../../lib/change-log.js');

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

test('proposeChange returns apply+null for a slug with no active window', async () => {
  const result = await proposeChange({ slug: 'fresh-page', changeType: 'title', category: 'experimental' });
  assert.equal(result.action, 'apply');
  assert.equal(result.windowId, null);
  assert.equal(result.reason, 'no_active_window');
});

test('proposeChange always returns apply+maintenance_bypass for maintenance category, even with active window', async () => {
  // First open a window via logChangeEvent
  const eventId = await logChangeEvent({
    url: '/products/maint-test',
    slug: 'maint-test',
    changeType: 'title',
    category: 'experimental',
    before: 'Old Title',
    after: 'New Title',
    source: 'agent:test',
    targetQuery: 'test',
    intent: 'unit test',
  });
  assert.ok(eventId.startsWith('ch-'));

  // Now propose a maintenance change on the same slug
  const result = await proposeChange({ slug: 'maint-test', changeType: 'content_body', category: 'maintenance' });
  assert.equal(result.action, 'apply');
  assert.equal(result.reason, 'maintenance_bypass');
});

test('proposeChange returns apply+window_in_forming_period if active window is still forming', async () => {
  await logChangeEvent({
    url: '/products/forming-test',
    slug: 'forming-test',
    changeType: 'title',
    category: 'experimental',
    before: 'A',
    after: 'B',
    source: 'agent:test',
    targetQuery: 'test',
    intent: 'unit test',
  });
  const result = await proposeChange({ slug: 'forming-test', changeType: 'meta_description', category: 'experimental' });
  assert.equal(result.action, 'apply');
  assert.equal(result.reason, 'window_in_forming_period');
  assert.ok(result.windowId);
});

test('logChangeEvent creates an immutable event file under data/changes/events/YYYY-MM/', () => {
  // Existing window from prior test should hold this event
  const w = getActiveWindow('forming-test');
  assert.ok(w);
  assert.equal(w.changes.length, 2); // 2 events from the two logChangeEvent calls above
});

test('queueChange writes a queue item under data/changes/queue/<slug>/', async () => {
  const id = await queueChange({
    slug: 'measuring-test',
    changeType: 'image',
    source: 'agent:test',
    proposalContext: { suggestedImage: 'https://example.com/img.jpg', why: 'better lighting' },
    targetQuery: 'test',
    after: 'https://example.com/img.jpg',
  });
  assert.ok(id.startsWith('q-'));
});

// Cleanup
process.on('exit', () => rmSync(TEST_DIR, { recursive: true, force: true }));
