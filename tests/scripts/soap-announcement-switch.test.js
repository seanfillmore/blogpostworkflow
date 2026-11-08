import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, serialize, SWITCH_AT, LAST_DAY, TEXT, TEXT_MOBILE } from '../../scripts/soap-announcement-switch.mjs';

const live = (text) => serialize('/* auto-generated */\n', {
  sections: { 'announcement-bar': { type: 'announcement-bar', blocks: {
    'unscented-bars-60': { type: 'announcement', settings: { text, text_on_mobile: 'm', link: 'shopify://collections/all-products' } },
    other: { type: 'announcement', settings: { text: 'Free Shipping on Orders Over $45' } },
  } } },
});

test('refuses before the offer is live, does nothing after 2026', () => {
  assert.equal(plan(live('x'), SWITCH_AT - 1).action, 'refuse-early');
  assert.equal(plan(live('x'), LAST_DAY + 1).action, 'expired');
});

test('switches only the soap block, keeps escaping, and is idempotent', () => {
  const p = plan(live('2 free Pure Unscented soap bars on orders of $60+'), SWITCH_AT + 1000);
  assert.equal(p.action, 'switch');
  assert.match(p.out, /shopify:\\\/\\\/collections/);
  assert.match(p.out, /Free Shipping on Orders Over \$45/);
  const obj = JSON.parse(p.out.replace(/^\/\*[\s\S]*?\*\/\s*/, ''));
  assert.equal(obj.sections['announcement-bar'].blocks['unscented-bars-60'].settings.text, TEXT);
  assert.equal(obj.sections['announcement-bar'].blocks['unscented-bars-60'].settings.text_on_mobile, TEXT_MOBILE);
  assert.equal(plan(p.out, SWITCH_AT + 2000).action, 'already-done');
});

test('refuses when the block is gone rather than guessing', () => {
  const raw = serialize('', { sections: { 'announcement-bar': { blocks: {} } } });
  assert.equal(plan(raw, SWITCH_AT + 1).action, 'refuse-missing-block');
});
