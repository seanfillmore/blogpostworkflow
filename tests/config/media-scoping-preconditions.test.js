// tests/config/media-scoping-preconditions.test.js
//
// The theme gates ALL variant-scoping on `main-product.hide_variants == false`.
// Where it is true the '#' suffix is never read, so scoping is inert and silent:
// every image shows for every variant and nothing reports a problem. That is
// exactly what happened to the Hand Soap Set — eight suffixes written against
// the default PDP, where the setting is true, putting a $72 frame in front of a
// $44 buyer.
//
// scripts/set-media-variant-scope.mjs now refuses in that case. These assertions
// guard the refusal itself, because a check that is deleted is worse than one
// that never existed.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = readFileSync(join(ROOT, 'scripts', 'set-media-variant-scope.mjs'), 'utf8');

test('the scope script still enforces hide_variants, not just documents it', () => {
  assert.match(script, /hide_variants\s*!==\s*false/,
    'the hide_variants refusal is gone — scoping can silently no-op again');
  assert.match(script, /templateSuffix/,
    'the check must follow the product\'s own templateSuffix; settings are per template');
  assert.match(script, /process\.exit\(1\)/, 'the check must refuse, not warn');
});

test('the scope script still enforces unscoped-before-scoped ordering', () => {
  // gang_exist is assigned once before the media loop and only ever set true, so
  // an unscoped media after a scoped one is hidden for every variant.
  assert.match(script, /stranded/, 'the sticky-gang_exist ordering guard is gone');
});

test('the two-option scope form is still supported', () => {
  // The Hand Soap Set carries the count and the scent on different frames,
  // scoped to different options. One file must describe every scoped media —
  // a media absent from `scope` has its suffix stripped.
  assert.match(script, /function resolveEntry/, 'per-entry option resolution is gone');
  const cfg = JSON.parse(readFileSync(join(ROOT, 'data', 'brand', 'bundle-images', 'hand-soap-set.scope.json'), 'utf8'));
  const opts = new Set(Object.values(cfg.scope).map((v) => (typeof v === 'string' ? '(default)' : v.option)));
  assert.deepEqual([...opts].sort(), ['Configuration', 'Scent'],
    'the Hand Soap Set scope file must scope on both options');
  // No fragment may be a substring of another: matching is filename.includes().
  const frags = Object.keys(cfg.scope);
  for (const a of frags) for (const b of frags) {
    if (a !== b) assert.ok(!b.includes(a), `scope fragment "${a}" is a substring of "${b}"`);
  }
});

console.log('✓ media-scoping precondition tests pass');
