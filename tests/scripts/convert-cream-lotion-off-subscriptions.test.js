import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dropSubscriptionWidget, assertBuyable } from '../../scripts/convert-cream-lotion-off-subscriptions-2026-10-05.mjs';

const tpl = (name) => JSON.parse(readFileSync(new URL(`../../theme/templates/product.landing-page-${name}.json`, import.meta.url)));

test('neither page carries a Recurpay block any more', () => {
  for (const name of ['cream', 'lotion']) {
    const main = tpl(name).sections.main;
    assert.ok(!Object.values(main.blocks).some((b) => /recurpay/i.test(b.type)), name);
    assert.ok(!main.block_order.some((id) => /recurpay/i.test(id)), name);
  }
});

test('cream and lotion both sell through the ladder (lotion since 2026-10-06)', () => {
  for (const page of ['cream', 'lotion']) {
    const order = tpl(page).sections.main.block_order;
    assert.ok(order.includes('quantity-ladder'), `${page}: ladder`);
    assert.ok(!order.includes('buy_buttons'), `${page}: old buy box gone`);
  }
});

test('dropSubscriptionWidget removes only Recurpay blocks', () => {
  const parsed = { sections: { main: {
    blocks: { a: { type: 'title' }, r: { type: 'shopify://apps/recurpay-subscriptions-app/blocks/x' }, buy_buttons: { type: 'buy_buttons' } },
    block_order: ['a', 'r', 'buy_buttons'],
  } } };
  assert.deepEqual(dropSubscriptionWidget(parsed), ['r']);
  assert.deepEqual(parsed.sections.main.block_order, ['a', 'buy_buttons']);
  assert.deepEqual(dropSubscriptionWidget(parsed), []);
});

test('assertBuyable refuses a page with no way to buy', () => {
  assert.throws(() => assertBuyable({ sections: { main: { block_order: ['title'] } } }));
  assert.doesNotThrow(() => assertBuyable({ sections: { main: { block_order: ['quantity-ladder'] } } }));
});
