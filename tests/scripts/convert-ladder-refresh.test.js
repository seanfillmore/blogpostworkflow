import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convert, LADDER_ID, ANCHOR, GUARANTEE_ID } from '../../scripts/convert-liquid-soap-to-ladder-2026-09-05.mjs';

// The live pump page's order: payment icons deliberately sit BETWEEN the ladder
// and the guarantee (2026-10-07). A refresh must not "fix" that.
const page = (liquid) => ({
  sections: { main: {
    block_order: [ANCHOR, LADDER_ID, 'payment-icons', GUARANTEE_ID],
    blocks: { [ANCHOR]: {}, [LADDER_ID]: { type: 'custom_liquid', settings: { custom_liquid: liquid } }, 'payment-icons': {}, [GUARANTEE_ID]: {} },
  } },
});

test('a page already on a ladder is REFRESHED when the roster tiers change', () => {
  // 2026-10-08: the pump soap top rung went 4-pack -> 5-pack. The old convert()
  // left the stale block and reported the page "already converted".
  const p = page('<!-- tiers: 1/2/4 -->');
  const notes = convert(p, '<!-- tiers: 1/2/5 -->');
  assert.equal(p.sections.main.blocks[LADDER_ID].settings.custom_liquid, '<!-- tiers: 1/2/5 -->');
  assert.ok(notes.some((n) => /refreshed/.test(n)));
  assert.deepEqual(p.sections.main.block_order, [ANCHOR, LADDER_ID, 'payment-icons', GUARANTEE_ID], 'a refresh never re-orders blocks');
});

test('identical ladder content is a no-op', () => {
  const p = page('<!-- same -->');
  const before = JSON.stringify(p);
  assert.deepEqual(convert(p, '<!-- same -->'), ['already converted']);
  assert.equal(JSON.stringify(p), before);
});
