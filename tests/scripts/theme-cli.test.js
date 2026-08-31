import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardArgs, LIVE_THEME_ID, LIVE_TARGETING_FLAGS } from '../../scripts/theme-cli.mjs';

// The whole point: theme changes stop being tested in production. `shopify theme
// push` writes to whichever theme it was last pointed at, which on this store is
// the LIVE one, so the dangerous invocation is the SHORTEST one.

test('a bare push is refused, because it reuses the last-used theme', () => {
  const r = guardArgs(['push']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /last-used theme/);
});

test('push --unpublished is allowed — that is the preview path', () => {
  const r = guardArgs(['push', '--unpublished']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['push', '--unpublished']);
});

test('dev is allowed and needs no target', () => {
  assert.equal(guardArgs(['dev']).ok, true);
  assert.equal(guardArgs(['list']).ok, true);
});

test('every live-targeting flag is refused', () => {
  for (const flag of LIVE_TARGETING_FLAGS) {
    const r = guardArgs(['push', '--unpublished', flag]);
    assert.equal(r.ok, false, `${flag} must be refused`);
    assert.match(r.reason, new RegExp(flag.replace(/-/g, '\\-')));
  }
});

test('--theme pointed at the live id is refused by id, not just by flag name', () => {
  const r = guardArgs(['push', '--theme', LIVE_THEME_ID]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /LIVE theme/);
});

test('--theme pointed at some other theme is allowed', () => {
  const r = guardArgs(['push', '--theme', '145536778410']);
  assert.equal(r.ok, true);
});

test('--allow-live-theme is the deliberate override, and is stripped before exec', () => {
  // Stripped because the Shopify CLI would reject it as unknown. The override
  // must be OUR vocabulary, not passed through to the tool.
  const r = guardArgs(['push', '--live', '--allow-live-theme']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['push', '--live']);
  assert.ok(!r.argv.includes('--allow-live-theme'));
});

test('the override is required per-invocation and is not sticky', () => {
  // Nothing persists it: a second call without the flag is refused again.
  assert.equal(guardArgs(['push', '--live', '--allow-live-theme']).ok, true);
  assert.equal(guardArgs(['push', '--live']).ok, false);
});
