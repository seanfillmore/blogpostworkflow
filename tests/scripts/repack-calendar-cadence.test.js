import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRepack } from '../../scripts/repack-calendar-cadence.mjs';

const NOW = new Date('2026-10-14T12:00:00Z'); // Wednesday
const it = (slug, d) => ({ slug, keyword: slug, publish_date: d });

test('items inside the lead window or on Shopify stay put; the rest pack onto publish days', () => {
  const items = [
    it('soon', '2026-10-19T15:00:00.000Z'),        // inside 7-day window: fixed
    it('on-shopify', '2026-11-02T15:00:00.000Z'),  // on Shopify: fixed
    it('a', '2026-10-22T15:00:00.000Z'),
    it('b', '2026-10-26T15:00:00.000Z'),
    it('c', '2026-10-29T15:00:00.000Z'),
    { slug: 'undated', keyword: 'x', publish_date: null },
  ];
  const moves = planRepack(items, { now: NOW, leadDays: 7, onShopify: (s) => s === 'on-shopify' });
  const to = Object.fromEntries(moves.map((m) => [m.slug, m.to.slice(0, 10)]));
  assert.equal(to.soon, undefined);
  assert.equal(to['on-shopify'], undefined);
  assert.equal(to.undated, undefined);
  // lead window ends 10-21; slots from 10-22: Thu 22 (already a's date, no move), Fri 23, Mon 26 (b's own date is the 3rd slot)
  assert.equal(to.a, undefined);
  assert.equal(to.b, '2026-10-23');
  assert.equal(to.c, '2026-10-26');
});
