import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('keyword-index-builder agent exists', () => {
  assert.ok(existsSync('agents/keyword-index-builder/index.js'));
});

test('agent imports the expected lib modules', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes("lib/keyword-index/normalize.js") || src.includes("./lib/keyword-index"), 'imports keyword-index lib');
  assert.ok(src.includes("lib/keyword-index/amazon-sqp"), 'imports SQP module');
  assert.ok(src.includes("lib/keyword-index/amazon-ba"), 'imports BA module');
  assert.ok(src.includes("lib/keyword-index/gsc-aggregator"), 'imports GSC aggregator');
  assert.ok(src.includes("lib/keyword-index/ga4-aggregator"), 'imports GA4 aggregator');
  assert.ok(src.includes("lib/keyword-index/merge"), 'imports merger');
  assert.ok(src.includes("lib/keyword-index/competitors"), 'imports competitors');
  assert.ok(src.includes("lib/keyword-index/dataforseo-enricher"), 'imports enricher');
  assert.ok(src.includes("lib/notify.js"), 'imports notify');
});

test('agent supports --dry-run and --force flags', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes('--dry-run'), 'has --dry-run flag handling');
  assert.ok(src.includes('--force'), 'has --force flag handling');
});

test('agent has self-pace check (skips if < 14 days since last build)', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(/built_at|last_built_at/.test(src), 'reads built_at from prior index');
  assert.ok(/14|REBUILD_DAYS/.test(src), 'has 14-day cadence threshold');
});

test('agent writes both output files atomically (temp-then-rename)', () => {
  const src = readFileSync('agents/keyword-index-builder/index.js', 'utf8');
  assert.ok(src.includes('keyword-index.json'), 'writes keyword-index.json');
  assert.ok(src.includes('category-competitors.json'), 'writes category-competitors.json');
  assert.ok(/\.tmp-|renameSync/.test(src), 'uses temp-then-rename for atomicity');
});
