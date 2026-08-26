import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLadderPreamble, renderBlock } from '../../scripts/build-quantity-ladder.mjs';

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
