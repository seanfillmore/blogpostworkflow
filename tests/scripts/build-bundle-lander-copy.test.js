import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANDERS, NEW_TEXT_FIELDS, factsFor, copyFor, gateFields, FOUNDER_IMAGE,
} from '../../scripts/build-bundle-lander-copy.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

// Only the Coconut Reset had founder/stats/timeline copy; the other five ran on
// hero + grid + FAQ, which is what left six empty padded sections on each page.

test('every lander clears the health-claim gate', () => {
  for (const handle of Object.keys(LANDERS)) {
    const r = checkSeoCopyFields(gateFields(handle, copyFor(handle, factsFor(handle))));
    assert.ok(r.ok, `${handle}: ${(r.claims ?? []).map((c) => `${c.field} "${c.match}"`).join('; ')}`);
  }
});

test('no lander describes the deodorant as an antiperspirant', () => {
  // RSC sells a cosmetic deodorant. Calling it by an OTC drug CATEGORY name is an
  // intended-use claim with no claim vocabulary in it — the gate's product-category
  // arm exists for exactly this, and it runs inside checkSeoCopyFields above.
  for (const handle of Object.keys(LANDERS)) {
    const all = Object.values(gateFields(handle, copyFor(handle, factsFor(handle)))).join(' ');
    assert.ok(!/antiperspirant/i.test(all), `${handle} used the word`);
  }
});

test('every stat matches what the roster actually says', () => {
  // The savings, unit counts and ingredient counts are computed from
  // config/bundles.json + config/ingredients.json, so a stat cannot drift from
  // the offer without this failing.
  for (const handle of Object.keys(LANDERS)) {
    const f = factsFor(handle);
    const labels = copyFor(handle, f).stats.map((s) => `${s.value} ${s.label}`).join(' | ');
    assert.match(labels, new RegExp(`\\$${f.savings}\\b`), `${handle}: savings not stated as $${f.savings} — ${labels}`);
  }
});

test('the Clean Swap ingredient count is the DISTINCT union, not the sum', () => {
  // 6 lotion + 6 deodorant + 6 toothpaste + 1 soap = 19 naive, but they share a
  // base. Quoting 19 would overstate what is in the box.
  const f = factsFor('clean-swap');
  assert.equal(f.distinctIngredients, 12);
  assert.equal(f.units, 4);
});

test('the 90-day box never claims ninety days of SOAP', () => {
  // config/consumption-rates.json: bar soap is 25d (20-30), so three bars is ~75
  // days. Its rule is explicit — claim SHORT, never above the binding rate,
  // because overstating supply is the documented reason subscribers churned.
  const copy = copyFor('90-day-clean-swap', factsFor('90-day-clean-swap'));
  const ninety = copy.stats.find((s) => s.value === '90');
  assert.match(ninety.label, /lotion and deodorant/, 'the 90-day stat must name which products it covers');
  const all = JSON.stringify(copy);
  assert.match(all, /two and a half months|60–90 days/, 'the soap shortfall has to be stated, not omitted');
});

test('a lander with no honest duration story gets NO timeline', () => {
  // Inventing a timeline for a discovery box or a gift is exactly the
  // manufactured-duration-claim failure this repo already has an incident for.
  for (const h of ['head-to-toe', 'gift-box', 'hand-soap-set']) {
    assert.equal(copyFor(h, factsFor(h)).timeline, undefined, `${h} should not have a timeline`);
  }
  for (const h of ['clean-swap', '90-day-clean-swap']) {
    assert.ok(copyFor(h, factsFor(h)).timeline.length >= 3, `${h} should have one`);
  }
});

test('a timeline always ships its own heading', () => {
  // The template's default eyebrow is "The 90 days", which is true of the Reset
  // and false of a one-month swap. A timeline without its own heading would
  // inherit that and state a duration nobody wrote.
  for (const h of Object.keys(LANDERS)) {
    const copy = copyFor(h, factsFor(h));
    if (!copy.timeline) continue;
    for (const k of NEW_TEXT_FIELDS) assert.ok(copy[k], `${h} is missing ${k}`);
  }
});

test('mechanism is deliberately NOT written', () => {
  // It renders a figure per row and falls back to an "Image coming soon"
  // placeholder. Filling the copy with no art trades empty bands for broken-
  // looking ones, and its heading is hardcoded to "Two formulas, one routine".
  for (const h of Object.keys(LANDERS)) {
    assert.equal(copyFor(h, factsFor(h)).mechanism, undefined);
  }
});

test('the founder image is the one already in Files, not a new upload', () => {
  assert.match(FOUNDER_IMAGE, /^gid:\/\/shopify\/MediaImage\/\d+$/);
});

test('an unknown handle throws rather than shipping an empty lander', () => {
  assert.throws(() => copyFor('not-a-bundle', { units: 1, distinctIngredients: 1, savings: 1, price: 1 }), /no copy written/);
  assert.throws(() => factsFor('not-a-bundle'), /not in config\/bundles\.json/);
});
