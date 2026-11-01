import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { PLAN, ARTICLES, main } from '../../scripts/remediate-oral-care-post-claims-2026-10-10.mjs';
import { gateEntry } from '../../scripts/remediate-toothpaste-safety-claims.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ING = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
const quiet = () => {};

test('every entry targets a post in ARTICLES, ids unique, and no edit is a no-op', () => {
  assert.equal(new Set(PLAN.map((e) => e.id)).size, PLAN.length);
  for (const e of PLAN) {
    assert.ok(ARTICLES[e.handle], e.id);
    assert.notEqual(e.before, e.after);
    assert.ok(!e.after.includes(e.before), `${e.id}: AFTER contains BEFORE`);
  }
  assert.deepEqual(Object.keys(ARTICLES).sort(), [...new Set(PLAN.map((e) => e.handle))].sort());
});

test('every AFTER passes the editorial gate and drops the drug-property wording', () => {
  for (const e of PLAN) {
    assert.deepEqual(gateEntry(e), [], e.id);
    assert.doesNotMatch(e.after, /antibacterial|antimicrobial|plaque|gum health|active ingredient/i, e.id);
  }
});

test('new copy carries no em dash', () => {
  for (const e of PLAN) assert.doesNotMatch(e.after, /—/, e.id);
});

test('formula facts match config/ingredients.json', () => {
  const tpCounts = ING.toothpaste.variations.map((v) => ING.toothpaste.base_ingredients.length + v.essential_oils.length).sort((a, b) => a - b);
  assert.deepEqual([...new Set(tpCounts)], [8, 10], 'precondition: 8 or 10 ingredients by flavor');
  assert.match(PLAN.find((e) => e.id === 'charcoal-ingredient-count').after, /eight to ten/);
  const cinnamon = ING.toothpaste.variations.find((v) => v.name === 'Cinnamon Spice').essential_oils.join(' ');
  assert.doesNotMatch(cinnamon, /peppermint/, 'precondition: Cinnamon Spice has no mint');
  assert.match(PLAN.find((e) => e.id === 'recipes-note-peppermint').after, /in its mint flavors/);

  const deo = PLAN.find((e) => e.id === 'deodorant-eight-oils').after;
  for (const v of ING.deodorant.variations) {
    assert.ok(deo.includes(v.name), `deodorant copy names ${v.name}`);
    for (const o of v.essential_oils) assert.ok(deo.includes(o.replace('organic essential oil of ', '')), `${v.name}: ${o}`);
  }
  assert.ok(Math.max(...ING.deodorant.variations.map((v) => v.essential_oils.length)) < 8, 'precondition: no deodorant has eight oils');
});

test('dry run writes nothing; apply writes each post once and is idempotent', async () => {
  const bodies = {};
  for (const [h, a] of Object.entries(ARTICLES)) bodies[a.articleId] = PLAN.filter((e) => e.handle === h).map((e) => `<p>${e.before}</p>`).join('\n');
  const mk = () => {
    const calls = { update: 0 };
    return { calls, api: {
      getArticle: async (_b, id) => ({ body_html: bodies[id] }),
      updateArticle: async (_b, id, f) => { calls.update += 1; bodies[id] = f.body_html; return {}; },
    } };
  };
  const root = mkdtempSync(join(tmpdir(), 'oral-'));
  const dry = mk(); await main({ shopify: dry.api, argv: [], root, log: quiet });
  assert.equal(dry.calls.update, 0);
  const wet = mk(); await main({ shopify: wet.api, argv: ['--apply'], root, log: quiet });
  assert.equal(wet.calls.update, Object.keys(ARTICLES).length);
  for (const e of PLAN) assert.ok(bodies[ARTICLES[e.handle].articleId].includes(e.after), e.id);
  const again = mk(); await main({ shopify: again.api, argv: ['--apply'], root, log: quiet });
  assert.equal(again.calls.update, 0);
});
