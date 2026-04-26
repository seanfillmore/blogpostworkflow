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

test('change-verdict agent emits health stats every run (heartbeat)', () => {
  const src = readFileSync('agents/change-verdict/index.js', 'utf8');
  assert.ok(src.includes('summarizeHealthState'), 'must define summarizeHealthState helper');
  assert.ok(src.includes('Events logged total'), 'notify body must include event count');
  assert.ok(src.includes('windowsByStatus'), 'must count windows by status');
  // The early-return on due.length===0 should be gone — heartbeat runs every day.
  assert.ok(!/if \(due\.length === 0\)\s*\{\s*return;\s*\}/.test(src), 'must NOT early-return when no verdicts due');
});

test('change-verdict agent flags broken state when 0 events 7+ days post-deploy', () => {
  const src = readFileSync('agents/change-verdict/index.js', 'utf8');
  assert.ok(src.includes('daysSinceDeploy'), 'must compute days since deploy');
  assert.ok(src.includes('HEALTH ALERT'), 'must include alert text on broken state');
  assert.ok(/status\s*=\s*['"]error['"]/.test(src), 'must escalate notify status to error on broken state');
});
