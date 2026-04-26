import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('change-diff-detector exists', () => {
  assert.ok(existsSync('agents/change-diff-detector/index.js'));
});

test('change-diff-detector imports the lib + reads shopify snapshots', () => {
  const src = readFileSync('agents/change-diff-detector/index.js', 'utf8');
  assert.ok(src.includes('lib/change-log.js'));
  assert.ok(src.includes('snapshots/shopify') || src.includes("'shopify'"));
  assert.ok(src.includes('logChangeEvent'));
});

test('change-diff-detector supports --dry-run flag', () => {
  const src = readFileSync('agents/change-diff-detector/index.js', 'utf8');
  assert.ok(src.includes('--dry-run') || src.includes("'dry-run'"));
});
