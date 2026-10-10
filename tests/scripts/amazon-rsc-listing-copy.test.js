import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN, LIMITS, TOOTHPASTE_B4_BEFORE, TOOTHPASTE_B4_AFTER, decideListing, buildPatch, liveValues, main,
} from '../../scripts/amazon/remediate-rsc-listing-copy.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
const strip = (s) => s.replace(/<br>/g, ' ');
const allText = (e) => [e.after.item_name, ...e.after.bullet_point, strip(e.after.product_description)].join(' ');

test('covers the eight in-stock RSC SKUs, main SKUs only, one per variant', () => {
  assert.equal(PLAN.length, 8);
  assert.equal(new Set(PLAN.map((e) => e.sku)).size, 8);
  for (const e of PLAN) assert.doesNotMatch(e.sku, /FBM/);
});

test('every ingredient list carries every base ingredient and exactly the config essential oils', () => {
  for (const e of PLAN) {
    const cfg = INGREDIENTS[e.product];
    const variation = cfg.variations.find((v) => v.name === e.variant);
    assert.ok(variation, `${e.variant} is a ${e.product} variation in config`);
    const desc = strip(e.after.product_description).toLowerCase();
    for (const base of cfg.base_ingredients) {
      const word = base.replace(/^organic /, '').replace(/ \(baking soda\)$/, '').replace(/^sodium bicarbonate$/, 'baking soda');
      const probe = base.startsWith('sodium bicarbonate') ? 'baking soda' : word;
      assert.ok(desc.includes(probe.toLowerCase()), `${e.sku} description missing base ingredient "${base}"`);
    }
    const oils = variation.essential_oils.map((o) => o.replace(/^organic essential oils? of /, '').replace(/\.$/, ''));
    for (const o of oils) assert.ok(desc.includes(o), `${e.sku} missing oil "${o}"`);
  }
});

test('no oil from another variant is named (Cinnamon Spice carries no mint, Lavender no frankincense)', () => {
  const ci = PLAN.find((e) => e.variant === 'Cinnamon Spice');
  assert.doesNotMatch(strip(ci.after.product_description), /peppermint|spearmint/i);
  const lav = PLAN.find((e) => e.variant === 'Calming Lavender');
  assert.doesNotMatch(allText(lav), /frankincense|cedarwood/i);
  const na = PLAN.find((e) => e.variant === 'All Natural');
  assert.doesNotMatch(strip(na.after.product_description), /Cinnamon Spice/);
});

test('ingredient counts are honest: Unscented lotion six, Coconut Breeze seven', () => {
  assert.match(PLAN.find((e) => e.variant === 'Pure Unscented').after.bullet_point[0], /^SIX INGREDIENTS/);
  assert.match(PLAN.find((e) => e.variant === 'Coconut Breeze').after.bullet_point[0], /^SEVEN INGREDIENTS/);
});

test('every title names its variant', () => {
  for (const e of PLAN) assert.ok(e.after.item_name.includes(e.variant === 'Pure Unscented' ? 'Unscented' : e.variant), e.sku);
});

test('within Amazon limits: title 200, bullets 500 x5, description 2000, keywords under 250 bytes', () => {
  for (const e of PLAN) {
    assert.ok(e.after.item_name.length <= LIMITS.item_name, `${e.sku} title ${e.after.item_name.length}`);
    assert.equal(e.after.bullet_point.length, 5);
    for (const b of e.after.bullet_point) assert.ok(b.length <= LIMITS.bullet, `${e.sku}: ${b.length}`);
    assert.ok(e.after.product_description.length <= LIMITS.product_description);
    if (e.after.generic_keyword) assert.ok(Buffer.byteLength(e.after.generic_keyword) <= LIMITS.generic_keyword_bytes);
  }
});

test('every field clears the commercial health gate', () => {
  for (const e of PLAN) {
    const fields = { title: e.after.item_name, description: strip(e.after.product_description) };
    e.after.bullet_point.forEach((b, i) => { fields[`B${i + 1}`] = b; });
    if (e.after.generic_keyword) fields.keywords = e.after.generic_keyword;
    const g = checkSeoCopyFields(fields);
    assert.equal(g.ok, true, `${e.sku}: ${JSON.stringify(g.blocking)}`);
  }
});

test('copy rules: no em/en dashes, no petroleum names, no sweat or treatment promises, no claim keywords', () => {
  for (const e of PLAN) {
    const t = allText(e) + ' ' + (e.after.generic_keyword ?? '');
    assert.doesNotMatch(t, /[—–]/, `${e.sku} dash`);
    assert.doesNotMatch(t, /mineral oil|petrolatum|petroleum/i, `${e.sku} petroleum`);
    assert.doesNotMatch(t, /wrinkle|fine lines|tighten|firming|repair|antimicrobial|antibacterial|anti-inflammatory|whitening|cavit|decay|sweat (and odors )?at bay|chemical-free/i, `${e.sku} claim`);
    assert.doesNotMatch(t, /[؀-ۿ]/, `${e.sku} non-Latin script`);
  }
});

test('deodorant copy calls it a deodorant and only mentions antiperspirant as the category it is not', () => {
  for (const e of PLAN.filter((x) => x.product === 'deodorant')) {
    for (const m of allText(e).matchAll(/[^.:]*antiperspirant[^.]*/gi)) {
      assert.match(m[0], /not an antiperspirant|Antiperspirants use|from an antiperspirant/i, `${e.sku}: "${m[0].trim()}"`);
    }
  }
});

test('toothpaste: only B4 changes, from "sensitive teeth" to "sensitive mouths"', () => {
  for (const e of PLAN.filter((x) => x.product === 'toothpaste')) {
    assert.equal(e.before.bullet_point[3], TOOTHPASTE_B4_BEFORE);
    assert.equal(e.after.bullet_point[3], TOOTHPASTE_B4_AFTER);
    [0, 1, 2, 4].forEach((i) => assert.equal(e.after.bullet_point[i], e.before.bullet_point[i]));
    assert.doesNotMatch(allText(e), /sensitive teeth/i);
  }
});

test('the recorded BEFORE carries the defects this change exists to fix', () => {
  const by = (sku) => PLAN.find((e) => e.sku === sku).before;
  assert.match(by('RSC-DE-WF-02').bullet_point[3], /[؀-ۿ]/);
  assert.match(by('RSC-TP-MI-08').product_description, /antimicrobial/);
  assert.match(by('RSC-TP-NA-08').product_description, /Cinnamon Spice/);
  assert.match(by('RSC-LO-CB-08-FBA-stickerless').item_name, /Wrinkles/);
});

const live = (e, which) => ({ ...Object.fromEntries(Object.keys(e.after).map((f) => [f, e[which][f] ?? null])) });

test('decideListing: BEFORE applies all fields, AFTER is a no-op, any third value skips the SKU', () => {
  const e = PLAN[0];
  assert.deepEqual(decideListing(e, live(e, 'before')).fields.sort(), Object.keys(e.after).sort());
  assert.equal(decideListing(e, live(e, 'after')).action, 'already-applied');
  const mixed = { ...live(e, 'after'), item_name: e.before.item_name };
  assert.deepEqual(decideListing(e, mixed), { action: 'apply', fields: ['item_name'], why: 'live matches BEFORE on item_name' });
  assert.equal(decideListing(e, { ...live(e, 'before'), item_name: 'somebody else edited this' }).action, 'skip');
});

test('liveValues keeps only en_US values for this marketplace', () => {
  const v = liveValues({
    item_name: [{ value: 'fr', language_tag: 'fr_CA', marketplace_id: 'M' }, { value: 'en', language_tag: 'en_US', marketplace_id: 'M' }],
    bullet_point: [{ value: 'a', marketplace_id: 'M' }, { value: 'x', marketplace_id: 'OTHER' }],
  }, 'M', ['item_name', 'bullet_point', 'generic_keyword']);
  assert.deepEqual(v, { item_name: 'en', bullet_point: ['a'], generic_keyword: null });
});

test('buildPatch replaces only the named fields, bullets as five values', () => {
  const p = buildPatch(PLAN[3], ['bullet_point', 'generic_keyword'], { productType: 'TOOTHPASTE', marketplaceId: 'M' });
  assert.deepEqual(p.patches.map((x) => x.path), ['/attributes/bullet_point', '/attributes/generic_keyword']);
  assert.equal(p.patches[0].value.length, 5);
  assert.equal(p.patches[1].value.length, 1);
});

test('main: previews by default, skips an edited SKU, PATCHes nothing in that case', async () => {
  const calls = [];
  const spapi = {
    getClient: async () => ({}),
    getMarketplaceId: () => 'M',
    request: async (_c, method, path, body) => {
      calls.push({ method, path });
      if (method === 'PATCH') return { status: 'VALID', issues: [] };
      const sku = decodeURIComponent(path.split('/').pop());
      const e = PLAN.find((x) => x.sku === sku);
      const src = sku === 'RSC-DE-CL-02' ? { ...e.before, item_name: 'edited by hand' } : e.before;
      const attrs = {};
      for (const [f, val] of Object.entries(src)) {
        if (f === 'asin' || val == null) continue;
        attrs[f] = (Array.isArray(val) ? val : [val]).map((value) => ({ value, language_tag: 'en_US', marketplace_id: 'M' }));
      }
      return { summaries: [{ productType: 'X' }], attributes: attrs };
    },
  };
  const r = await main({ spapi, argv: [], sellerId: 'S', outDir: mkdtempSync(join(tmpdir(), 'rsc-copy-')) });
  assert.equal(r.failed, 0);
  assert.equal(r.results.find((x) => x.sku === 'RSC-DE-CL-02').action, 'skip');
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 7);
  for (const p of patches) assert.match(p.path, /mode=VALIDATION_PREVIEW/);
});
