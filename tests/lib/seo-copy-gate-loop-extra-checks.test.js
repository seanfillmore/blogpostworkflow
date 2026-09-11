/**
 * `extraChecks` on the shared gate loop — how a caller adds a blocking rule that
 * needs its own input (a product's ingredient list) without a second copy of the
 * retry policy. Pins: it blocks, it costs exactly the same one retry, its OWN
 * constraint reaches the prompt, and the cosmetic-compliance boilerplate does not
 * ride along with it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';

const EXTRACT = (p) => ({ title: p?.seo_title, meta: p?.seo_description, body: p?.body_html });
const CLEAN = { seo_title: 'Coconut Oil Lotion', seo_description: 'Six ingredients you can read.', body_html: '<p>It soaks in.</p>' };
const WATERLESS = { ...CLEAN, seo_description: 'Only 6 ingredients — no water.' };

const NO_WATER = {
  check: (fields) => (/no water/i.test(fields.meta || '')
    ? [{ field: 'meta', category: 'contradicts-ingredients', match: 'no water', why: 'says "no water", but the list includes "purified spring water"' }]
    : []),
  constraint: (v) => `INGREDIENT ACCURACY — ${v.map((x) => x.why).join('; ')}`,
};

test('an extra check blocks and costs a retry, not the candidate', async () => {
  const calls = [];
  const r = await gateGeneratedCopy(async (c) => { calls.push(c); return calls.length === 1 ? WATERLESS : CLEAN; },
    { extract: EXTRACT, extraChecks: [NO_WATER] });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.proposed, CLEAN);
  assert.match(calls[1], /INGREDIENT ACCURACY/);
  assert.match(calls[1], /purified spring water/);
});

test('its hits do not drag the cosmetic-compliance boilerplate into the retry', async () => {
  const calls = [];
  await gateGeneratedCopy(async (c) => { calls.push(c); return calls.length === 1 ? WATERLESS : CLEAN; },
    { extract: EXTRACT, extraChecks: [NO_WATER] });
  assert.doesNotMatch(calls[1], /COSMETIC COMPLIANCE/);
});

test('exactly one retry, and a second hit is returned as a violation', async () => {
  let n = 0;
  const r = await gateGeneratedCopy(async () => { n++; return WATERLESS; }, { extract: EXTRACT, extraChecks: [NO_WATER] });
  assert.equal(n, 2);
  assert.equal(r.ok, false);
  assert.equal(r.proposed, null);
  assert.deepEqual(r.violations.map((v) => v.category), ['contradicts-ingredients']);
});

test('a null check is skipped — a product with no ingredient list is not blocked', async () => {
  const r = await gateGeneratedCopy(async () => WATERLESS, { extract: EXTRACT, extraChecks: [null] });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
});

test('omitting extraChecks changes nothing for existing callers', async () => {
  const r = await gateGeneratedCopy(async () => WATERLESS, { extract: EXTRACT });
  assert.equal(r.ok, true);
});
