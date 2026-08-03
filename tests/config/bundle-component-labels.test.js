// tests/config/bundle-component-labels.test.js
//
// The lander's value-stack rows are derived from config/bundles.json components,
// so every component product a bundle ships must have a display label. Without
// one, scripts/build-variant-value-stacks.mjs bails at runtime — and it is the
// only thing standing between a new component and a lander row reading
// "undefined". Catching it here means the failure lands on whoever adds the
// component, not on whoever next reprices a bundle.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
const script = readFileSync(join(ROOT, 'scripts', 'build-variant-value-stacks.mjs'), 'utf8');

/** The LABEL map, read out of the script so the test cannot drift from it. */
const labelled = new Set([...script.matchAll(/^\s*'([a-z0-9-]+)':\s*'[^']+',$/gm)].map((m) => m[1]));

test('the LABEL map was parsed out of the script at all', () => {
  // Guards the test itself: a refactor that renames or reformats the map would
  // otherwise leave this file asserting nothing while still passing.
  assert.ok(labelled.size >= 5, `parsed only ${labelled.size} labels — the regex has drifted from the script`);
  assert.ok(labelled.has('coconut-lotion'));
});

test('every component of every bundle-landing bundle has a display label', () => {
  const LANDERS = ['90-day-clean-swap', 'head-to-toe', 'clean-swap', 'gift-box', '99-coconut-reset-digital'];
  const missing = [];
  for (const handle of LANDERS) {
    const b = bundles.find((x) => x.handle === handle);
    assert.ok(b, `config/bundles.json has no bundle "${handle}"`);
    for (const v of b.variants) {
      for (const c of v.components) {
        if (!labelled.has(c.product)) missing.push(`${handle}/${Object.values(v.options)[0]}: ${c.product}`);
      }
    }
  }
  assert.deepEqual(missing, [], `components with no display label:\n  ${missing.join('\n  ')}`);
});

test('every variant of a lander bundle names a scent for each component', () => {
  // The merged panel shows the scent per row. A blank one renders an empty line
  // under the label rather than failing, which is the quiet kind of wrong.
  const LANDERS = ['90-day-clean-swap', 'head-to-toe', 'clean-swap', 'gift-box', '99-coconut-reset-digital'];
  for (const handle of LANDERS) {
    for (const v of bundles.find((x) => x.handle === handle).variants) {
      for (const c of v.components) {
        assert.ok(typeof c.variant === 'string' && c.variant.trim().length > 0,
          `${handle}/${Object.values(v.options)[0]}: component ${c.product} has no variant/scent`);
        assert.ok(Number.isInteger(c.qty) && c.qty > 0,
          `${handle}/${Object.values(v.options)[0]}: component ${c.product} has a bad qty (${c.qty})`);
      }
    }
  }
});

console.log('✓ bundle-component-label tests pass');
