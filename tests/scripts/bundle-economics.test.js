import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { evaluate, buildMarkdown, SKUS, BUNDLES, CAC } from '../../scripts/bundle-economics.mjs';
import { FALLBACK_PACKAGE_COSTS } from '../../lib/shipping-costs.js';

const ev = b => evaluate(b, FALLBACK_PACKAGE_COSTS);

test('evaluate reproduces the 90-Day Reset economics', () => {
  const r = ev({ name: 'Reset', status: 'draft', price: 99, items: { lotion: 3, cream: 1 }, story: '' });
  assert.equal(r.msrp, 118);          // 3x$30 + $28 — the compare-at anchor
  assert.equal(r.cogs, 19.94);
  assert.equal(r.units, 4);
  assert.equal(r.pounds, 2.19);
  assert.equal(r.shipping, 7.83);     // 10x5x5
  assert.equal(r.contrib, 68.06);
  assert.equal(r.verdict, 'scale');
});

test('a refill in the basket forces the expensive box and flips the verdict', () => {
  const r = ev({ name: 'Pump + Refill', status: 'x', price: 34, items: { pump: 1, refill: 1 }, story: '' });
  assert.equal(r.shipping, 21.31, 'must route to the 14x10x4');
  assert.ok(r.contrib < 0, `expected a loss, got ${r.contrib}`);
  assert.equal(r.verdict, 'loss');
});

test('a pump-only multipack sits on the CAC line — any discount sinks it', () => {
  // Pumps are 67% margin and 10 oz, so four of them need a real box. At full
  // MSRP the 4-pack only just clears CAC; discounting it at all pushes it under.
  const atMsrp = ev({ name: 'Pump 4', status: 'x', price: 52, items: { pump: 4 }, story: '' });
  assert.equal(atMsrp.discountPct, 0);
  assert.ok(atMsrp.contrib >= CAC && atMsrp.contrib < CAC * 1.2,
    `expected marginal (~$${CAC}), got ${atMsrp.contrib}`);

  const discounted = ev({ name: 'Pump 4', status: 'x', price: 44, items: { pump: 4 }, story: '' });
  assert.ok(discounted.contrib < CAC, `discounted 4-pack should fall under CAC, got ${discounted.contrib}`);
  assert.equal(discounted.verdict, 'thin');

  // One high-margin lotion (84%, 10 oz) is what makes it comfortable.
  const withLotion = ev({ name: 'Pump 4 + lotion', status: 'x', price: 72, items: { pump: 4, lotion: 1 }, story: '' });
  assert.ok(withLotion.contrib > discounted.contrib * 2,
    `lotion should roughly double contribution, got ${withLotion.contrib} vs ${discounted.contrib}`);
});

test('verdict thresholds key off CAC', () => {
  const mk = (price, items) => ev({ name: 'x', status: 'x', price, items, story: '' }).verdict;
  assert.equal(mk(159, { deo: 3, toothpaste: 3, barsoap: 3, lotion: 3 }), 'scale');
  assert.equal(mk(46.80, { lotion: 1, cream: 1 }), 'breakeven');
  assert.equal(mk(30, { lotion: 1 }), 'thin');
});

test('discountPct is computed against MSRP', () => {
  const r = ev({ name: 'x', status: 'x', price: 46.80, items: { lotion: 1, cream: 1 }, story: '' });
  assert.equal(r.msrp, 58);
  assert.equal(r.discountPct, 19);
});

test('every configured bundle references real SKUs', () => {
  for (const b of BUNDLES) {
    for (const k of Object.keys(b.items)) {
      assert.ok(SKUS[k], `${b.name} references unknown SKU "${k}"`);
    }
    assert.ok(b.story, `${b.name} is missing its rationale`);
  }
});

test('the Foam Soap Bundle stays flagged as a loss so it is never published', () => {
  const foam = BUNDLES.find(b => b.name === 'Foam Soap Bundle');
  assert.ok(foam, 'Foam Soap Bundle must stay in the roster as a documented rejection');
  assert.equal(ev(foam).verdict, 'loss');
});

test('buildMarkdown renders tables and flags losses', () => {
  const rows = BUNDLES.map(ev);
  const md = buildMarkdown(rows, { packageCosts: FALLBACK_PACKAGE_COSTS, average: 7.33, live: false });
  assert.match(md, /# Bundle economics/);
  assert.match(md, /90-Day Clean Swap/);
  assert.match(md, /loses money/);
  assert.match(md, /Regenerate with/);
});

test('packaging cost comes straight off contribution', () => {
  const withoutBox = ev({ name: 'Gift Box', status: 'x', price: 62,
    items: { lotion: 1, lipbalm: 1, barsoap: 1, deo: 1 }, story: '' });
  const withBox = ev({ name: 'Gift Box', status: 'x', price: 62, packaging: 1.00,
    items: { lotion: 1, lipbalm: 1, barsoap: 1, deo: 1 }, story: '' });

  assert.equal(withoutBox.contrib - withBox.contrib, 1.00,
    'a $1 box must cost exactly $1 of contribution');
  assert.equal(withBox.packaging, 1.00, 'packaging must survive onto the result');
});

test('packaging defaults to zero so every other bundle is unchanged', () => {
  const r = ev({ name: 'Reset', status: 'draft', price: 99, items: { lotion: 3, cream: 1 }, story: '' });
  assert.equal(r.packaging, 0);
  assert.equal(r.contrib, 68.06, 'the Reset contribution must not move');
});

test('roster-derived bundles reproduce the known contributions', () => {
  const byName = Object.fromEntries(BUNDLES.map(b => [b.name, b]));

  // $86.28 at the $144 price set 2026-07-31, when the three hero bundles were moved to
  // 30% off MSRP. It was $100.85 at $159. The number is pinned to catch an accidental
  // change to the derivation — so when a price moves deliberately, this moves with it.
  const cleanSwap90 = ev(byName['The 90-Day Clean Swap']);
  assert.equal(cleanSwap90.contrib, 86.28, '90-Day Clean Swap at $144');

  const giftBox = ev(byName['Gift Box']);
  assert.equal(giftBox.packaging, 1.0);
  assert.equal(giftBox.contrib, 34.32, 'Gift Box after its $1 box');
});

test('the hand soap ladder produces one row per rung, pump-only', () => {
  // Was "the Hand Soap Set produces three ladder rows" ($44 / $59 / $72, the
  // top rung carrying a body lotion). That product sold 0 units in 365 days and
  // was retired on 2026-09-05 for a plain quantity ladder on the liquid soap
  // PDP. The row COUNT is the property worth keeping and it now says something
  // sharper: economicsRows collapses variants that share a basket, so a rung
  // whose four scents are all N-of-one-pump must produce exactly ONE row. Two
  // rows here means two rungs; three would mean a rung had grown a second
  // basket — which is how the Set started.
  const rows = BUNDLES.filter(b => b.name.startsWith('Coconut Hand Soap'));
  assert.equal(rows.length, 2, 'one row per rung, not one per scent');
  assert.deepEqual(rows.map(r => r.price), [24, 44], 'rows must read as a ladder');
  assert.deepEqual(ev(rows[0]).items, { pump: 2 });
  assert.deepEqual(ev(rows[1]).items, { pump: 4 });
});
