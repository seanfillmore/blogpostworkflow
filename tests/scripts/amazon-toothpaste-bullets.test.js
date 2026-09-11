import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN, SHARED_BULLETS, MAX_BULLET_CHARS, decideListing, buildPatch, patchPath, submissionSucceeded, main,
} from '../../scripts/amazon/remediate-toothpaste-bullets.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8')).toothpaste;
const OILS = ['peppermint', 'spearmint', 'cinnamon', 'clove'];

test('covers exactly the three toothpaste variants, one main SKU each', () => {
  assert.deepEqual(PLAN.map((e) => e.variant).sort(), CONFIG.variations.map((v) => v.id).sort());
  for (const e of PLAN) assert.doesNotMatch(e.sku, /FBM/);
});

test('each B1 names exactly the essential oils config/ingredients.json lists for that variant', () => {
  for (const e of PLAN) {
    const want = CONFIG.variations.find((v) => v.id === e.variant).essential_oils
      .map((o) => o.replace('organic essential oil of ', '')).sort();
    const got = OILS.filter((o) => e.after[0].toLowerCase().includes(o)).sort();
    assert.deepEqual(got, want, `${e.variant} oils`);
  }
});

test('Cinnamon Spice no longer claims mint oils it does not contain', () => {
  const ci = PLAN.find((e) => e.variant === 'cinnamon-spice');
  assert.ok(ci.before.join(' ').includes('peppermint'), 'the defect is real in the recorded BEFORE');
  assert.doesNotMatch(ci.after.join(' '), /peppermint|spearmint/i);
});

test('each B1 is a labelled ingredient list carrying every base ingredient', () => {
  for (const e of PLAN) {
    assert.match(e.after[0], /Ingredients: /);
    for (const i of CONFIG.base_ingredients) assert.ok(e.after[0].includes(i), `${e.variant} B1 missing "${i}"`);
  }
});

test('five bullets each, B2-B5 identical across variants, within Amazon\'s length limit', () => {
  for (const e of PLAN) {
    assert.equal(e.after.length, 5);
    assert.deepEqual(e.after.slice(1), SHARED_BULLETS);
    for (const b of e.after) assert.ok(b.length <= MAX_BULLET_CHARS, `${e.variant}: ${b.length} chars`);
  }
});

test('every bullet clears the commercial health gate and names no ruled ingredient word', () => {
  for (const e of PLAN) {
    e.after.forEach((b, i) => {
      const g = checkSeoCopyFields({ [`B${i + 1}`]: b });
      assert.equal(g.ok, true, `${e.variant} B${i + 1}: ${JSON.stringify(g.blocking)}`);
      assert.doesNotMatch(b, /mineral oil|petrolatum|dimethicone/i);
    });
  }
});

test('the Fresh Mint drug-adjacent wording is gone', () => {
  const mi = PLAN.find((e) => e.variant === 'fresh-mint');
  assert.match(mi.before.join(' '), /antimicrobial|anti-inflammatory|inflamed/);
  assert.doesNotMatch(mi.after.join(' '), /antimicrobial|anti-inflammatory|inflamed/i);
});

test('decideListing: apply on BEFORE, already-applied on AFTER, skip on anything else', () => {
  const e = PLAN[0];
  assert.equal(decideListing(e, e.before).action, 'apply');
  assert.equal(decideListing(e, e.after).action, 'already-applied');
  assert.equal(decideListing(e, [...e.before.slice(0, 4), 'somebody edited this']).action, 'skip');
  assert.equal(decideListing(e, null).action, 'skip');
});

test('the patch replaces bullet_point with all five en_US values', () => {
  const p = buildPatch(PLAN[1], { productType: 'TOOTH_CLEANING_AGENT', marketplaceId: 'M1' });
  assert.equal(p.productType, 'TOOTH_CLEANING_AGENT');
  assert.equal(p.patches[0].op, 'replace');
  assert.equal(p.patches[0].path, '/attributes/bullet_point');
  assert.equal(p.patches[0].value.length, 5);
  assert.deepEqual(Object.keys(p.patches[0].value[0]).sort(), ['language_tag', 'marketplace_id', 'value']);
});

test('without --apply the PATCH always carries mode=VALIDATION_PREVIEW', () => {
  assert.match(patchPath({ sellerId: 'S', sku: 'RSC-TP-CI-08', marketplaceId: 'M', apply: false }), /mode=VALIDATION_PREVIEW/);
  assert.doesNotMatch(patchPath({ sellerId: 'S', sku: 'RSC-TP-CI-08', marketplaceId: 'M', apply: true }), /mode=/);
});

test('DRY RUN sends only validation-preview PATCHes', async () => {
  const calls = [];
  const spapi = {
    getClient: async () => ({}),
    getMarketplaceId: () => 'M',
    request: async (_c, method, path) => {
      calls.push([method, path]);
      if (method === 'GET') {
        const sku = decodeURIComponent(path.split('/').pop());
        const e = PLAN.find((x) => x.sku === sku);
        return { summaries: [{ productType: 'TOOTH_CLEANING_AGENT' }], attributes: { bullet_point: e.before.map((value) => ({ value, language_tag: 'en_US', marketplace_id: 'M' })) } };
      }
      // What a real validation preview returns — verified against the live API 2026-09-11.
      return { status: 'VALID', issues: [] };
    },
  };
  const r = await main({ spapi, argv: ['node', 's'], sellerId: 'S' });
  const patches = calls.filter(([m]) => m === 'PATCH');
  assert.equal(patches.length, 3);
  for (const [, path] of patches) assert.match(path, /mode=VALIDATION_PREVIEW/);
  assert.equal(r.failed, 0);
});

test('success status depends on mode: VALID for a preview, ACCEPTED for a submission', () => {
  assert.equal(submissionSucceeded({ status: 'VALID' }, { apply: false }), true);
  assert.equal(submissionSucceeded({ status: 'ACCEPTED' }, { apply: true }), true);
  assert.equal(submissionSucceeded({ status: 'VALID' }, { apply: true }), false);
  assert.equal(submissionSucceeded({ status: 'INVALID' }, { apply: false }), false);
});
