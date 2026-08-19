import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeCTRDelta, metafieldResource } from '../../agents/meta-ab-tracker/index.js';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents', 'meta-ab-tracker', 'index.js');

// Shopify splits collections into custom_collections and smart_collections, and a
// smart collection 404s on the custom_collections metafields path. 6 of the 9 live
// A/B tests target smart collections, so every one of their reverts died — which is
// why titles sat on losing variants past their conclude date. The generic
// /collections/<id>/metafields.json path serves BOTH types (verified against the
// live store for 3 custom and 2 smart collections), so no type lookup is needed.
test('collection metafields resolve to the type-agnostic collections path', () => {
  assert.equal(metafieldResource('collection'), 'collections');
  assert.notEqual(metafieldResource('collection'), 'custom_collections');
});

test('other resource types keep their own endpoints', () => {
  assert.equal(metafieldResource('product'), 'products');
  assert.equal(metafieldResource('page'), 'pages');
  assert.equal(metafieldResource('nonsense'), null);
});

// Importing this module used to execute main() — it ran production code, wrote to
// Shopify, and killed the test process with exit(1) when the API errored. A unit
// test for a pure function must not be able to mutate the live store.
test('importing the module does not execute the agent', () => {
  const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(AGENT)}).then(() => console.log('IMPORTED_CLEANLY'))`], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.match(out, /IMPORTED_CLEANLY/, 'the import resolves');
  assert.ok(!/Meta A\/B Tracker/.test(out), `the agent banner must not print on import — got: ${out.slice(0, 300)}`);
});

test('computes positive delta when test CTR is higher', () => {
  const delta = computeCTRDelta(0.05, 0.04);
  assert.ok(delta > 0);
  assert.ok(Math.abs(delta - 0.01) < 0.0001);
});

test('computes negative delta when test CTR is lower', () => {
  const delta = computeCTRDelta(0.03, 0.05);
  assert.ok(delta < 0);
  assert.ok(Math.abs(delta - (-0.02)) < 0.0001);
});

test('returns null when either value is null', () => {
  assert.equal(computeCTRDelta(null, 0.04), null);
  assert.equal(computeCTRDelta(0.04, null), null);
  assert.equal(computeCTRDelta(null, null), null);
});

// The article revert was DEAD CODE and nobody noticed. It took a separate path — a
// raw POST to /blogs/{blogId}/articles/{id}/metafields.json authenticated with
// SHOPIFY_ACCESS_TOKEN + SHOPIFY_STORE_DOMAIN — and neither variable is in .env, so
// every run hit `if (!token || !store) { warn; return; }` and skipped. It failed as a
// console.warn, not an error, so an operator reading the log saw a line go by and the
// title stayed on the losing variant forever.
//
// Both branches now share the OAuth client via upsertMetafield. This test pins the
// mapping so a future edit cannot quietly drop `article` back onto a bespoke path.
test('article resolves through the shared metafield path, not a bespoke one', () => {
  assert.equal(metafieldResource('article'), 'articles');
});

test('every A/B resource type maps to a plural REST collection', () => {
  // Guards the whole map: a null here means revertMetafield warns and skips, which is
  // exactly how the article case stayed broken without anyone seeing an error.
  for (const t of ['product', 'collection', 'page', 'article']) {
    const r = metafieldResource(t);
    assert.ok(r, `${t} must resolve to a resource path, got ${r}`);
    assert.ok(r.endsWith('s'), `${t} -> ${r} should be a plural REST collection`);
  }
});
