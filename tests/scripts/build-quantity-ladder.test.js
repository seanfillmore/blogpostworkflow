import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLadderPreamble, renderBlock, checkPricingCoherence } from '../../scripts/build-quantity-ladder.mjs';

const TIERS = [
  { handle: 'coconut-soap', units: 1, isBase: true },
  { handle: 'coconut-bar-soap-4-pack', units: 4, isBase: false },
  { handle: 'coconut-bar-soap-12-pack', units: 12, isBase: false },
];
const LADDER = { base: 'coconut-soap', default: 'coconut-bar-soap-12-pack', unit_noun: 'bar' };

test('the preamble bakes handles, units and unit noun but never a price', () => {
  const out = renderLadderPreamble(TIERS, LADDER);
  assert.match(out, /assign ladder_handles = "coconut-soap,coconut-bar-soap-4-pack,coconut-bar-soap-12-pack"/);
  assert.match(out, /assign ladder_units = "1,4,12"/);
  assert.match(out, /assign ladder_default = "coconut-bar-soap-12-pack"/);
  assert.match(out, /assign ladder_base = "coconut-soap"/);
  assert.match(out, /assign ladder_unit_noun = "bar"/);
});

test('no price or currency symbol is ever baked into the shipped block', () => {
  // renderBlock() -- preamble + the full Liquid body -- is what actually
  // ships to Shopify, and is the one place a hardcoded price like $11.00
  // would realistically appear. Testing renderLadderPreamble alone (whose
  // inputs contain no price-shaped value at all) cannot catch that: it was
  // asserting about an object that can never fail the assertion.
  const out = renderBlock(TIERS, LADDER);
  assert.doesNotMatch(out, /\$\d/);
});

// checkPricingCoherence — the divergence check the spec's "Data model" section
// describes and freeUnitFraming was never wired to. Prices are integer cents,
// matching lib/quantity-ladder.js's own convention (soap 12-pack: 8800/1100).

test('checkPricingCoherence: passes on coherent real-catalogue prices', () => {
  const prices = { 'coconut-soap': 1100, 'coconut-bar-soap-4-pack': 3900, 'coconut-bar-soap-12-pack': 8800 };
  assert.deepEqual(checkPricingCoherence(TIERS, prices, LADDER), []);
});

test('checkPricingCoherence: refuses a multipack priced ABOVE buying singly', () => {
  const prices = { 'coconut-soap': 1100, 'coconut-bar-soap-4-pack': 4401, 'coconut-bar-soap-12-pack': 8800 };
  const errors = checkPricingCoherence(TIERS, prices, LADDER);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /coconut-bar-soap-4-pack/);
  assert.match(errors[0], /at or above buying singly/);
});

test('checkPricingCoherence: refuses a multipack priced EQUAL to buying singly', () => {
  // Exact equality is the case freeUnitFraming alone reads as clean --
  // paid === units routes to the savings branch, not an error -- but a
  // multipack with zero savings over singles is still a repricing accident.
  const prices = { 'coconut-soap': 1100, 'coconut-bar-soap-4-pack': 4400, 'coconut-bar-soap-12-pack': 8800 };
  const errors = checkPricingCoherence(TIERS, prices, LADDER);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /coconut-bar-soap-4-pack/);
});

test('checkPricingCoherence: refuses when the base tier has no usable live price', () => {
  const prices = { 'coconut-bar-soap-4-pack': 3900, 'coconut-bar-soap-12-pack': 8800 };
  const errors = checkPricingCoherence(TIERS, prices, LADDER);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no usable live price for base tier/);
});

test('checkPricingCoherence: refuses when a non-base tier has no usable live price', () => {
  const prices = { 'coconut-soap': 1100, 'coconut-bar-soap-12-pack': 8800 };
  const errors = checkPricingCoherence(TIERS, prices, LADDER);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no usable live price for tier "coconut-bar-soap-4-pack"/);
});

// Note: the first passing test above ("passes on coherent real-catalogue
// prices") already exercises the free-units branch via the soap 12-pack
// (8800/1100 = 8, an exact whole-unit remainder), not just the savings
// branch the other tests here trip.

// ── theme/blocks/quantity-ladder.liquid — three hard-won guards ────────────
//
// Nothing tests the Liquid block itself: it isn't Node, so it can't be
// imported and exercised the way lib/quantity-ladder.js can. These are source
// scans over renderBlock()'s output -- the actual shipped artifact, preamble
// plus body, not just the theme file read in isolation -- for the same reason
// tests/agents/link-injectors-guarded.test.js and
// tests/lib/briefs-dir-readers.test.js scan source rather than run it: the
// three defects below were each found by a human reading during review, and
// each is the kind that regresses silently on the next edit.
//
// If any of these ever fail against the CURRENT liquid, that means the block
// itself has regressed -- a much bigger finding than a missing test, and not
// something to "fix" by loosening the assertion.

test('the free-unit predicate is an exact remainder test, not a float-tolerance comparison', () => {
  const block = renderBlock(TIERS, LADDER);
  // All prices are integer cents (lib/quantity-ladder.js's freeUnitFraming
  // documents exactly this), so the Liquid side must test equality to zero,
  // not fall inside some tolerance band -- a tolerance would disagree with
  // the JS side's exact `% baseUnitPrice !== 0` at prices like 8801/1100.
  assert.match(block, /paid_remainder == 0/,
    'the free-unit predicate must be an exact `paid_remainder == 0` test');
  assert.doesNotMatch(block, /paid_remainder\s*<[=]?\s*[1-9]/,
    'a `paid_remainder < N` (N > 0) shape would be a tolerance band, not an exact test, ' +
    'and would silently disagree with the JS side at fractional cents');
});

test('the variants JSON blob places commas by a printed-flag, never `unless forloop.last`', () => {
  const block = renderBlock(TIERS, LADDER);
  // The Critical bug this pins: entries are filtered by an `if` (a handle
  // missing from all_products is skipped), so if the LAST handle in the loop
  // happens to be the one that's absent, `unless forloop.last` still emits a
  // trailing comma with nothing after it -- `{"a":{...},}` -- and
  // JSON.parse throws, killing the whole selector IIFE behind an enabled,
  // dead CTA button. The default tier is always last in all three configured
  // ladders, which is exactly the shape that trips this.
  // Matches the actual Liquid TAG form, `{%- unless forloop.last -%}` etc --
  // not a bare `/unless\s+forloop\.last/`, which also matches the block's own
  // explanatory comment prose above (it deliberately names the rejected idiom
  // to document why it was rejected) and would false-positive on that.
  assert.doesNotMatch(block, /\{%-?\s*unless\s+forloop\.last/,
    'commas must be emitted by a printed-flag guard, not forloop.last, ' +
    'because the loop body is filtered by an `if`');
  // Positive assertion: the actual (safe) mechanism is present, so this test
  // pins the fix, not just the absence of the bug.
  assert.match(block, /tier_printed/, 'expected the printed-flag comma guard for tiers');
  assert.match(block, /variant_printed/, 'expected the printed-flag comma guard for variants');
});

test('divided_by/modulo against base_unit_price is guarded by a positivity check', () => {
  const block = renderBlock(TIERS, LADDER);
  // A missing base product means base_unit_price is nil/0; unguarded
  // `divided_by`/`modulo` against that would print a visible
  // "Liquid error: divided by 0" as text on a live PDP.
  const guardMatch = block.match(
    /\{%-\s*if base_unit_price and base_unit_price > 0\s*-%\}([\s\S]*?)\{%-\s*endif\s*-%\}/
  );
  assert.ok(guardMatch,
    'expected an `if base_unit_price and base_unit_price > 0` guard around the divide/modulo assigns');

  const guardedBody = guardMatch[1];
  assert.match(guardedBody, /divided_by:\s*base_unit_price/,
    '`divided_by: base_unit_price` must sit inside the positivity guard');
  assert.match(guardedBody, /modulo:\s*base_unit_price/,
    '`modulo: base_unit_price` must sit inside the positivity guard');

  // And neither operation may appear a second time, unconditionally, outside
  // that guard -- which is what would actually reach the divide-by-zero.
  const outsideGuard = block.replace(guardMatch[0], '');
  assert.doesNotMatch(outsideGuard, /divided_by:\s*base_unit_price/,
    'an unconditional divided_by: base_unit_price outside the guard can divide by zero');
  assert.doesNotMatch(outsideGuard, /modulo:\s*base_unit_price/,
    'an unconditional modulo: base_unit_price outside the guard can divide by zero');
});

test('option labels strip the redundant pack-count prefix and collapse Variety titles', () => {
  // The tier card already says "12-pack" / "4-pack", so the <select> must not
  // repeat the count -- operator's words: "We don't need to tell them how
  // many of each scent, it is implied." This is real logic (a regex
  // transform), inline in the block's IIFE, not something Liquid renders --
  // so per the pattern in this file (and tests/agents/link-injectors-guarded
  // .test.js) it's exercised by extracting the function's own source out of
  // renderBlock()'s shipped output and running it for real, rather than just
  // grepping for a string. That makes this assertion able to actually go red
  // if the transform regresses, not just if it disappears.
  const block = renderBlock(TIERS, LADDER);
  const fnMatch = block.match(/function ladderOptionLabel\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(fnMatch, 'expected a ladderOptionLabel(title) function in the shipped IIFE');

  // eslint-disable-next-line no-new-func -- extracting real shipped logic to run it, not user input
  const ladderOptionLabel = new Function(`return (${fnMatch[0]});`)();

  assert.equal(ladderOptionLabel('12x Calming Lavender'), 'Calming Lavender');
  assert.equal(ladderOptionLabel('4x Nourishing Tea Tree'), 'Nourishing Tea Tree');
  assert.equal(ladderOptionLabel('3x Calming Lavender'), 'Calming Lavender');
  assert.equal(ladderOptionLabel('Variety — 3 of each'), 'Variety');
  assert.equal(ladderOptionLabel('Variety — one of each'), 'Variety');
  // Unrecognised shape: no count prefix, not a Variety title -- must degrade
  // to the raw title unchanged, never to an empty string.
  assert.equal(ladderOptionLabel('Ocean Breeze'), 'Ocean Breeze');
  assert.equal(ladderOptionLabel(''), '');
});

test('the generated preamble bakes no 3+ digit run (no baked price)', () => {
  // Restores the cent-denominated no-baked-price check, but only where it can
  // actually fire: asserting this over the FULL block (renderBlock) trips on
  // CSS hex colours in the static Liquid/CSS/JS body (e.g. #b3261e contains
  // the digit run "3261"), which is a false positive unrelated to price
  // baking. The preamble is the generated half and carries only handles,
  // units and the unit noun -- structure, never a price -- so it is the one
  // place this check is clean.
  const preamble = renderLadderPreamble(TIERS, LADDER);
  assert.doesNotMatch(preamble, /\d{3,}/,
    'a 3+ digit run in the generated preamble would indicate a baked price literal');
});

test('the badge sits inside the same element as the quantity label, not beside the price', () => {
  // 2026-08-26 UI fix: the badge used to render in its own grid column
  // beside qty-ladder__price, with a grid-template-rows height reservation
  // to keep badge-less cards the same height -- which rendered as a visible
  // empty green box on every tier that HAD a badge. The fix moves the badge
  // inside qty-ladder__qty-wrap, immediately after qty-ladder__qty, so a
  // future edit that quietly moves it back toward the price is what this
  // pins against.
  const block = renderBlock(TIERS, LADDER);

  // The badge markup and the quantity label must both sit inside one
  // qty-ladder__qty-wrap span, and that span must be the element
  // immediately preceding qty-ladder__price in source order -- i.e. the
  // badge is beside the quantity, and the price comes after the whole
  // wrapped group, not interleaved with it.
  const wrapMatch = block.match(
    /<span class="qty-ladder__qty-wrap">([\s\S]*?)<\/span>\s*<span class="qty-ladder__price">/
  );
  assert.ok(wrapMatch,
    'expected a qty-ladder__qty-wrap span immediately followed by qty-ladder__price');
  assert.match(wrapMatch[1], /qty-ladder__qty"/,
    'the quantity label must be inside qty-ladder__qty-wrap');
  assert.match(wrapMatch[1], /qty-ladder__badge/,
    'the badge markup must be inside qty-ladder__qty-wrap, beside the quantity label, not beside the price');

  // The height-reservation hack must be gone: once the badge is inline with
  // the quantity label, every card is naturally two rows and nothing needs
  // to reserve height for a badge that might not be there.
  assert.doesNotMatch(block, /grid-template-rows/,
    'the row-height reservation hack should be removed now that the badge renders inline with the quantity label');
});
