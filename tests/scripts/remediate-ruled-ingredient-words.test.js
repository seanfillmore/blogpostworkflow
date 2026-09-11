import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN, RULED_WORDS, DISEASE_WORDS, gateAfter, gateText, groupByTarget, applyGroup, main,
} from '../../scripts/remediate-ruled-ingredient-words.mjs';

// Real live spans, copied read-only on 2026-09-11.
const CREAM_BODY = '<li>\n<strong>A little goes a long way.</strong> A tiny bit covers more than a pump of lotion does.</li>\n'
  + '<li>\n<strong>Beeswax is what makes it a cream.</strong> No petrolatum, no mineral oil, no synthetic fragrance, no parabens.</li>\n';
const SENSITIVE_BODY = 'adds organic beeswax — a breathable barrier that locks moisture in without sealing pores closed the way petrolatum does — and organic palm stearic for real cream body'
  + '</p><p><strong>Never in the formula:</strong> synthetic fragrance, parabens, phenoxyethanol, propylene glycol, mineral oil, petrolatum, dimethicone or lanolin. Pure Unscented';
const HEAD_TO_TOE_BUYBOX = '["One of each of all seven products we make — full size","The simplest way to find which one you reach for most","Coconut-oil based, cold-pressed, with organic jojoba","No synthetic fragrance, no petrolatum, no parabens, no SLS"]';
const HOMEPAGE = '{"a": "<p>for people whose skin doesn\'t tolerate fragrance, parabens, dimethicones, or mineral oil. No exceptions.<\\/p>",'
  + ' "b": "<p>We started Real Skin Care because the labels lied. \\"Natural\\" lotions still used petrolatum. \\"Gentle\\" creams still relied on dimethicones.<\\/p>",'
  + ' "c": "<ul><li>Parabens<\\/li><li>Petrolatum<\\/li><li>Mineral oil<\\/li><li>Dimethicone<\\/li><li>Lanolin<\\/li><\\/ul>",'
  + ' "d": "<p>body creams labeled \\"natural\\" that still relied on petrolatum, dimethicone, or undisclosed fragrance.<\\/p>"}';

test('the plan is a fixed, fully-specified table', () => {
  const ids = new Set();
  for (const e of PLAN) {
    for (const k of ['id', 'kind', 'before', 'after', 'reason', 'expectedOccurrences']) {
      assert.ok(e[k] !== undefined && e[k] !== '', `${e.id} needs ${k}`);
    }
    assert.ok(['product', 'metaobject', 'theme-asset'].includes(e.kind), `${e.id} kind`);
    assert.notEqual(e.before, e.after);
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
  }
});

test('every entry removes a ruled word or disease claim — except the one declared non-ruled row', () => {
  const nonRuled = PLAN.filter((e) => e.nonRuledReason).map((e) => e.id);
  assert.deepEqual(nonRuled, ['cream-pump-comparison'], 'growth here must be a visible decision');
  for (const e of PLAN) {
    const hits = RULED_WORDS.test(gateText(e.before)) || DISEASE_WORDS.test(gateText(e.before));
    if (e.nonRuledReason) assert.equal(hits, false, `${e.id} carries nonRuledReason but trips a rule`);
    else assert.equal(hits, true, `${e.id} BEFORE names nothing the ruling covers`);
  }
});

test('every AFTER is clean: no ruled word, no disease, health gate passes', () => {
  for (const e of PLAN) assert.deepEqual(gateAfter(e), { ok: true }, e.id);
});

test('"petroleum" is allowed in an AFTER (ruling 2026-09-11) and is the plain-word replacement', () => {
  const band = PLAN.find((e) => e.id === 'homepage-exclusion-band');
  assert.match(band.after, /Petroleum jelly/);
  assert.equal(gateAfter(band).ok, true);
});

test('no AFTER introduces a new absence claim that was not in its BEFORE', () => {
  const claims = (s) => new Set((gateText(s).toLowerCase().match(/\bno ([a-z -]+?)(?=[,.]|$| or )/g) || []).map((c) => c.trim()));
  for (const e of PLAN.filter((x) => x.kind !== 'theme-asset')) {
    const before = claims(e.before);
    for (const c of claims(e.after)) assert.ok(before.has(c), `${e.id} adds "${c}"`);
  }
});

test('the pump fix removes the pump and keeps the comparison', () => {
  const e = PLAN.find((x) => x.id === 'cream-pump-comparison');
  assert.doesNotMatch(e.after, /pump/i);
  assert.match(e.after, /same amount of lotion/);
});

test('grouping writes each target once: the four homepage swaps apply together from one source', () => {
  const groups = groupByTarget(PLAN);
  const home = groups.get('theme:templates/index.json');
  assert.equal(home.length, 4);
  const { next, decisions, changed } = applyGroup(home, HOMEPAGE);
  assert.equal(changed, true);
  assert.deepEqual(decisions.map((d) => d.action), ['apply', 'apply', 'apply', 'apply']);
  assert.doesNotMatch(next, RULED_WORDS);
  assert.match(next, /Petroleum jelly<\\\/li><li>Silicones/);
  assert.doesNotThrow(() => JSON.parse(next), 'escaping must survive the swap');
  // Idempotent.
  assert.deepEqual(applyGroup(home, next).decisions.map((d) => d.action), ['already-applied', 'already-applied', 'already-applied', 'already-applied']);
});

test('product groups apply against the real live spans', () => {
  const groups = groupByTarget(PLAN);
  const cream = applyGroup(groups.get('product:7644968911018'), CREAM_BODY);
  assert.doesNotMatch(cream.next, RULED_WORDS);
  assert.doesNotMatch(cream.next, /pump/);
  assert.match(cream.next, /No synthetic fragrance, no parabens\./);
  const sensitive = applyGroup(groups.get('product:8390839468202'), SENSITIVE_BODY);
  assert.doesNotMatch(sensitive.next, RULED_WORDS);
  assert.match(sensitive.next, /locks moisture in — and organic palm stearic/);
  assert.match(sensitive.next, /propylene glycol or lanolin\./);
});

test('a metaobject list field stays valid JSON after the swap', () => {
  const g = groupByTarget(PLAN).get('metaobject:gid://shopify/Metaobject/219322482858:buybox_bullets');
  const { next } = applyGroup(g, HEAD_TO_TOE_BUYBOX);
  assert.deepEqual(JSON.parse(next).at(-1), 'No synthetic fragrance, no parabens, no SLS');
});

test('SKIPS a target whose copy has moved since the plan was written', () => {
  const g = groupByTarget(PLAN).get('product:7644968911018');
  const moved = CREAM_BODY.replace('No petrolatum, no mineral oil,', 'No petrolatum or mineral oil,');
  const d = applyGroup(g, moved).decisions.find((x) => x.id === 'cream-beeswax-line');
  assert.equal(d.action, 'skip');
});

function stubApi({ themeLiveId = 1, assets = {} } = {}) {
  const writes = [];
  return {
    writes,
    api: {
      getProduct: async (id) => ({ body_html: id === 7644968911018 ? CREAM_BODY : id === 8390839468202 ? SENSITIVE_BODY : '<p>unrelated</p>' }),
      updateProduct: async (...a) => { writes.push(['product', ...a]); return {}; },
      shopifyGraphQL: async (q) => {
        if (q.startsWith('mutation')) { writes.push(['metaobject', q]); return { metaobjectUpdate: { userErrors: [] } }; }
        return { metaobject: { fields: [{ key: 'buybox_bullets', value: HEAD_TO_TOE_BUYBOX }, { key: 'bullets', value: '[]' }, { key: 'tabs', value: '[]' }] } };
      },
      getMainThemeId: async () => themeLiveId,
      getThemeAsset: async (id, key) => assets[`${id}:${key}`] ?? null,
      updateThemeAsset: async (...a) => { writes.push(['theme', ...a]); return {}; },
    },
  };
}

test('DRY RUN performs no Shopify write of any kind', async () => {
  const { api, writes } = stubApi({ assets: { '1:templates/index.json': HOMEPAGE, '2:templates/index.json': HOMEPAGE } });
  await main({ api, argv: ['node', 's', '--theme-id', '2'], sleep: async () => {} });
  assert.equal(writes.length, 0);
});

test('REFUSES the live theme without --allow-live-theme, even with --apply', async () => {
  const { api, writes } = stubApi({ assets: { '1:templates/index.json': HOMEPAGE } });
  await assert.rejects(main({ api, argv: ['node', 's', '--apply', '--theme-id', '1'], sleep: async () => {} }), /LIVE theme/);
  assert.equal(writes.filter((w) => w[0] === 'theme').length, 0);
});

test('a preview write is built from the LIVE asset, not the preview copy', async () => {
  const stalePreview = HOMEPAGE.replace('No exceptions.', 'STALE PREVIEW TEXT.');
  const { api, writes } = stubApi({ assets: { '1:templates/index.json': HOMEPAGE, '2:templates/index.json': stalePreview } });
  await main({ api, argv: ['node', 's', '--apply', '--theme-id', '2'], sleep: async () => {} });
  const themeWrite = writes.find((w) => w[0] === 'theme' && w[2] === 'templates/index.json');
  assert.ok(themeWrite, 'expected a preview write');
  assert.equal(themeWrite[1], 2);
  assert.doesNotMatch(themeWrite[3], /STALE PREVIEW TEXT/);
  assert.doesNotMatch(themeWrite[3], RULED_WORDS);
});
