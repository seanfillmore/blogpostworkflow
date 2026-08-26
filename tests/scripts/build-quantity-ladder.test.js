import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLadderPreamble } from '../../scripts/build-quantity-ladder.mjs';

const TIERS = [
  { handle: 'coconut-soap', units: 1, isBase: true },
  { handle: 'coconut-bar-soap-4-pack', units: 4, isBase: false },
  { handle: 'coconut-bar-soap-12-pack', units: 12, isBase: false },
];
const LADDER = { base: 'coconut-soap', default: 'coconut-bar-soap-12-pack' };

test('the preamble bakes handles and units but never a price', () => {
  const out = renderLadderPreamble(TIERS, LADDER);
  assert.match(out, /assign ladder_handles = "coconut-soap,coconut-bar-soap-4-pack,coconut-bar-soap-12-pack"/);
  assert.match(out, /assign ladder_units = "1,4,12"/);
  assert.match(out, /assign ladder_default = "coconut-bar-soap-12-pack"/);
  assert.match(out, /assign ladder_base = "coconut-soap"/);
});

test('no price, money filter, or currency symbol is ever baked in', () => {
  // Prices must come from all_products at render time. A baked price is the
  // exact drift the lander architecture exists to prevent.
  const out = renderLadderPreamble(TIERS, LADDER);
  assert.doesNotMatch(out, /\$\d/);
  assert.doesNotMatch(out, /\d{3,}/); // no cent-denominated amounts
});
