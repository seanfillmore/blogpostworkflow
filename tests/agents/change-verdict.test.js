import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

test('change-verdict agent exists at the expected path', () => {
  assert.ok(existsSync('agents/change-verdict/index.js'));
});

test('change-verdict agent imports the expected libs', () => {
  const src = readFileSync('agents/change-verdict/index.js', 'utf8');
  assert.ok(src.includes('lib/change-log.js'), 'must import lib/change-log.js');
  assert.ok(src.includes('lib/change-log/snapshots.js'), 'must import snapshots');
  assert.ok(src.includes('lib/change-log/verdict.js'), 'must import verdict');
  assert.ok(src.includes('lib/notify.js'), 'must import notify');
});

test('change-verdict agent supports --dry-run flag', () => {
  const src = readFileSync('agents/change-verdict/index.js', 'utf8');
  assert.ok(src.includes('--dry-run') || src.includes("'dry-run'"));
});
