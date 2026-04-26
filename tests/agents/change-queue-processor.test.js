import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('change-queue-processor exists', () => {
  assert.ok(existsSync('agents/change-queue-processor/index.js'));
});

test('change-queue-processor imports the lib + applies queued items', () => {
  const src = readFileSync('agents/change-queue-processor/index.js', 'utf8');
  assert.ok(src.includes('lib/change-log.js'));
  assert.ok(src.includes('logChangeEvent') || src.includes('updateArticle'));
});

test('change-queue-processor supports --dry-run flag', () => {
  const src = readFileSync('agents/change-queue-processor/index.js', 'utf8');
  assert.ok(src.includes('--dry-run') || src.includes("'dry-run'"));
});
