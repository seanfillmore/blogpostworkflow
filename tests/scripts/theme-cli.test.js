import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardArgs, targetedThemeIds, LIVE_TARGETING_FLAGS } from '../../scripts/theme-cli.mjs';

// The whole point: theme changes stop being tested in production. `shopify theme
// push` writes to whichever theme it was last pointed at, which on this store is
// the LIVE one, so the dangerous invocation is the SHORTEST one.
//
// The live id is a FIXTURE here, not an import. It used to be a constant in the
// module (`LIVE_THEME_ID = '147480051882'`) and it went stale the moment the
// store was republished on 2026-09-01 — after which the guard protected a dead
// theme and waved through the real one. The id is now resolved from the API at
// call time and passed in, so these tests state the rule rather than the store's
// current configuration.
const LIVE = '148439367850';
const NOT_LIVE = '145536778410';

test('a bare push is refused, because it reuses the last-used theme', () => {
  const r = guardArgs(['push'], LIVE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /last-used theme/);
});

test('push --unpublished is allowed — that is the preview path', () => {
  const r = guardArgs(['push', '--unpublished'], LIVE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['push', '--unpublished']);
});

test('dev is allowed and needs no target', () => {
  assert.equal(guardArgs(['dev'], LIVE).ok, true);
  assert.equal(guardArgs(['list'], LIVE).ok, true);
});

test('every live-targeting flag is refused', () => {
  for (const flag of LIVE_TARGETING_FLAGS) {
    const r = guardArgs(['push', '--unpublished', flag], LIVE);
    assert.equal(r.ok, false, `${flag} must be refused`);
    assert.match(r.reason, new RegExp(flag.replace(/-/g, '\\-')));
  }
});

test('--theme pointed at the live id is refused by id, not just by flag name', () => {
  const r = guardArgs(['push', '--theme', LIVE], LIVE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /LIVE theme/);
});

test('--theme pointed at some other theme is allowed', () => {
  assert.equal(guardArgs(['push', '--theme', NOT_LIVE], LIVE).ok, true);
});

// ── The two holes that let a live push through on 2026-09-05 ────────────────

test('EVERY spelling of the target flag is recognised, not just `--theme <id>`', () => {
  // `indexOf('--theme')` never matched the equals form, so `--theme=<live id>`
  // sailed past the id check completely. That is the form a scripted caller
  // writes by default, which is how this was actually hit.
  for (const argv of [
    ['push', '--theme', LIVE],
    ['push', `--theme=${LIVE}`],
    ['push', '-t', LIVE],
    ['push', `-t=${LIVE}`],
  ]) {
    const r = guardArgs(argv, LIVE);
    assert.equal(r.ok, false, `${argv.join(' ')} must be refused`);
    assert.match(r.reason, /LIVE theme/);
  }
});

test('targetedThemeIds reads all four spellings and ignores everything else', () => {
  assert.deepEqual(targetedThemeIds(['push', '--theme', '111']), ['111']);
  assert.deepEqual(targetedThemeIds(['push', '--theme=222']), ['222']);
  assert.deepEqual(targetedThemeIds(['push', '-t', '333']), ['333']);
  assert.deepEqual(targetedThemeIds(['push', '-t=444']), ['444']);
  assert.deepEqual(targetedThemeIds(['push', '--unpublished', '--only=x.json']), []);
});

test('an UNRESOLVED live id refuses an explicit target rather than allowing it', () => {
  // The failure direction has to be "we declined to push", never "we pushed to
  // production because we could not check which theme production was".
  const r = guardArgs(['push', '--theme', NOT_LIVE], null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not resolve/);
});

test('an unresolved live id still allows the paths that cannot touch live', () => {
  // --unpublished creates a new theme, so it needs no live id to be safe.
  assert.equal(guardArgs(['push', '--unpublished'], null).ok, true);
  assert.equal(guardArgs(['dev'], null).ok, true);
  assert.equal(guardArgs(['list'], null).ok, true);
});

// ── The override ────────────────────────────────────────────────────────────

test('--allow-live-theme is the deliberate override, and is stripped before exec', () => {
  // Stripped because the Shopify CLI would reject it as unknown. The override
  // must be OUR vocabulary, not passed through to the tool.
  const r = guardArgs(['push', '--live', '--allow-live-theme'], LIVE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['push', '--live']);
  assert.ok(!r.argv.includes('--allow-live-theme'));
});

test('the override is required per-invocation and is not sticky', () => {
  // Nothing persists it: a second call without the flag is refused again.
  assert.equal(guardArgs(['push', '--live', '--allow-live-theme'], LIVE).ok, true);
  assert.equal(guardArgs(['push', '--live'], LIVE).ok, false);
});

test('NO script hardcodes a live theme id any more', async () => {
  // The regression this whole change exists to prevent: a constant that is
  // correct on the day it is written and silently wrong after the next Publish.
  // It went stale in TWO files at once, so the scan covers all three guards.
  const { readFileSync } = await import('node:fs');
  const files = [
    'theme-cli.mjs',
    'scale-theme-component-image.mjs',
    'scale-bundle-component-images.mjs',
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8');
    const assignments = src.match(/LIVE_THEME_ID\s*=\s*['"]\d+['"]/g) || [];
    assert.deepEqual(assignments, [], `${f} must resolve the live theme id, never hardcode it`);
  }
});
