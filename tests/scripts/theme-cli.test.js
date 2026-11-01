import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guardArgs, targetedThemeIds, onlyPaths, LIVE_TARGETING_FLAGS, PARTIAL_MIRROR_REASON,
  comparePushed, verifyPushed, pushTarget,
} from '../../scripts/theme-cli.mjs';

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
const ONLY = ['--only', 'templates/product.x.json'];

test('a bare push is refused, because it reuses the last-used theme', () => {
  const r = guardArgs(['push'], LIVE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /last-used theme/);
});

test('push --unpublished with an --only list is allowed', () => {
  const r = guardArgs(['push', '--unpublished', ...ONLY], LIVE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['push', '--unpublished', ...ONLY]);
});

test('dev is allowed and needs no target', () => {
  assert.equal(guardArgs(['dev'], LIVE).ok, true);
  assert.equal(guardArgs(['list'], LIVE).ok, true);
});

test('every live-targeting flag is refused', () => {
  for (const flag of LIVE_TARGETING_FLAGS) {
    const r = guardArgs(['push', '--unpublished', ...ONLY, flag], LIVE);
    assert.equal(r.ok, false, `${flag} must be refused`);
    assert.match(r.reason, new RegExp(flag.replace(/-/g, '\\-')));
  }
});

test('--theme pointed at the live id is refused by id, not just by flag name', () => {
  const r = guardArgs(['push', '--theme', LIVE, ...ONLY], LIVE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /LIVE theme/);
});

test('--theme pointed at some other theme is allowed', () => {
  assert.equal(guardArgs(['push', '--theme', NOT_LIVE, ...ONLY], LIVE).ok, true);
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
    const r = guardArgs([...argv, ...ONLY], LIVE);
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
  const r = guardArgs(['push', '--theme', NOT_LIVE, ...ONLY], null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not resolve/);
});

test('an unresolved live id still allows the paths that cannot touch live', () => {
  // --unpublished creates a new theme, so it needs no live id to be safe.
  assert.equal(guardArgs(['push', '--unpublished', ...ONLY], null).ok, true);
  assert.equal(guardArgs(['dev'], null).ok, true);
  assert.equal(guardArgs(['list'], null).ok, true);
});

// ── The override ────────────────────────────────────────────────────────────

test('--allow-live-theme is the deliberate override, and is stripped before exec', () => {
  // Stripped because the Shopify CLI would reject it as unknown. The override
  // must be OUR vocabulary, not passed through to the tool.
  const r = guardArgs(['push', '--live', ...ONLY, '--allow-live-theme'], LIVE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['push', '--live', ...ONLY]);
  assert.ok(!r.argv.includes('--allow-live-theme'));
});

test('the override is required per-invocation and is not sticky', () => {
  // Nothing persists it: a second call without the flag is refused again.
  assert.equal(guardArgs(['push', '--live', ...ONLY, '--allow-live-theme'], LIVE).ok, true);
  assert.equal(guardArgs(['push', '--live', ...ONLY], LIVE).ok, false);
});

// ── The partial mirror (2026-09-11) ─────────────────────────────────────────

test('a push without --only is refused, because theme/ is a partial mirror', () => {
  for (const argv of [
    ['push', '--unpublished'],
    ['push', '--theme', NOT_LIVE],
    ['push', '--theme', NOT_LIVE, '--nodelete'],
  ]) {
    const r = guardArgs(argv, LIVE);
    assert.equal(r.ok, false, `${argv.join(' ')} must be refused`);
    assert.equal(r.reason, PARTIAL_MIRROR_REASON);
  }
});

test('the partial-mirror refusal holds even under --allow-live-theme', () => {
  // A full push to LIVE from a 19-file mirror is the most destructive command
  // this wrapper can issue; the live override must not also disarm this.
  const r = guardArgs(['push', '--live', '--allow-live-theme'], LIVE);
  assert.equal(r.ok, false);
  assert.equal(r.reason, PARTIAL_MIRROR_REASON);
});

test('--allow-full-push is the human override for the mirror guard, and is stripped', () => {
  const r = guardArgs(['push', '--theme', NOT_LIVE, '--allow-full-push'], LIVE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['push', '--theme', NOT_LIVE]);
});

test('onlyPaths reads every spelling of --only', () => {
  assert.deepEqual(onlyPaths(['push', '--only', 'a.json', '--only=b.json', '-o', 'c.json', '-o=d.json']),
    ['a.json', 'b.json', 'c.json', 'd.json']);
  assert.deepEqual(onlyPaths(['push', '--theme', '1']), []);
});

// ── Read-back verification (the 2026-09-10 false "pushed successfully") ────

test('comparePushed: JSON templates compare by value, ignoring the comment header and whitespace', () => {
  const local = '{"sections":{"a":{"type":"x"}}}';
  const remote = '/* auto-generated */\n{\n  "sections": { "a": { "type": "x" } }\n}';
  assert.equal(comparePushed(local, remote, 'templates/product.x.json'), null);
  assert.match(comparePushed(local, '{"sections":{}}', 'templates/product.x.json'), /differs/);
  assert.match(comparePushed(local, null, 'templates/product.x.json'), /missing/);
});

test('verifyPushed catches exactly the 2026-09-10 failure: CLI success, target still holds the old file', async () => {
  const failures = await verifyPushed({
    themeId: '1',
    keys: ['templates/product.x.json'],
    readLocal: async () => '{"new":true}',
    readRemote: async () => '{"new":false}',
    attempts: 2,
    sleep: async () => {},
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0].why, /differs/);
});

test('verifyPushed tolerates a stale first read that catches up', async () => {
  let reads = 0;
  const failures = await verifyPushed({
    themeId: '1',
    keys: ['templates/product.x.json'],
    readLocal: async () => '{"v":2}',
    readRemote: async () => (++reads < 3 ? '{"v":1}' : '{"v":2}'),
    attempts: 4,
    sleep: async () => {},
  });
  assert.deepEqual(failures, []);
  assert.equal(reads, 3);
});

test('verifyPushed refuses to call a glob verified', async () => {
  const failures = await verifyPushed({
    themeId: '1', keys: ['templates/*.json'], readLocal: async () => '', readRemote: async () => '', sleep: async () => {},
  });
  assert.match(failures[0].why, /glob/);
});

test('pushTarget knows the target only when it is unambiguous', () => {
  assert.equal(pushTarget(['push', '--theme', '123', ...ONLY], LIVE), '123');
  assert.equal(pushTarget(['push', '--live', ...ONLY], LIVE), LIVE);
  assert.equal(pushTarget(['push', '--unpublished', ...ONLY], LIVE), null, 'a new theme has no id to read back');
  assert.equal(pushTarget(['push', '--theme', 'My Preview', ...ONLY], LIVE), null, 'a theme NAME cannot be read back');
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
