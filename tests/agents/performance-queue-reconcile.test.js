import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeItem, findBySlug, reconcileStaleInProgress, QUEUE_DIR } from '../../agents/performance-engine/lib/queue.js';

// Uses real QUEUE_DIR with __test- prefixed slugs and cleans them up.
const SLUGS = ['__test-recon-stale', '__test-recon-recent', '__test-recon-pending'];
const cleanup = () => SLUGS.forEach((s) => { try { unlinkSync(join(QUEUE_DIR, `${s}.json`)); } catch { /* ignore */ } });

test('reconcileStaleInProgress fails orphaned in_progress, leaves recent + non-in_progress', () => {
  const now = Date.now();
  try {
    writeItem({ slug: '__test-recon-stale', status: 'in_progress', triggered_at: new Date(now - 60 * 60 * 1000).toISOString() });
    writeItem({ slug: '__test-recon-recent', status: 'in_progress', triggered_at: new Date(now - 2 * 60 * 1000).toISOString() });
    writeItem({ slug: '__test-recon-pending', status: 'pending' });

    const reconciled = reconcileStaleInProgress({ now });

    assert.ok(reconciled.includes('__test-recon-stale'), 'stale orphan reconciled');
    assert.ok(!reconciled.includes('__test-recon-recent'), 'recent (<15m) left alone');
    assert.equal(findBySlug('__test-recon-stale').status, 'failed');
    assert.match(findBySlug('__test-recon-stale').error, /restarted/);
    assert.equal(findBySlug('__test-recon-recent').status, 'in_progress');
    assert.equal(findBySlug('__test-recon-pending').status, 'pending');
  } finally {
    cleanup();
  }
});
