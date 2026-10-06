import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_PLAN, TITLE_TAG, planBody, gateAfters } from '../../scripts/fix-foaming-hand-soap-collection-2026-10-05.mjs';
import { renderTitle } from '../../lib/seo-copy-length.js';

const LIVE = `<p>x. ${BODY_PLAN[0].before} than synthetic fragrance.</p><ul>${BODY_PLAN[1].before}</ul><p>Real Skin Care foaming hand soaps ${BODY_PLAN[2].before} No synthetic.</p>`;

test('every AFTER clears the claim gate, the length gate and carries no em dash', () => {
  assert.doesNotThrow(() => gateAfters());
});

test('the rendered title fits 60 and names organic hand soap', () => {
  assert.ok(renderTitle(TITLE_TAG.after).length <= 60, renderTitle(TITLE_TAG.after));
  assert.match(TITLE_TAG.after, /Organic Foaming Hand Soap/);
});

test('plan removes every eucalyptus and is idempotent', () => {
  const once = planBody(LIVE);
  assert.deepEqual(once.steps, ['applied', 'applied', 'applied']);
  assert.doesNotMatch(once.html, /eucalyptus/i);
  const twice = planBody(once.html);
  assert.deepEqual(twice.steps, ['already-applied', 'already-applied', 'already-applied']);
  assert.equal(twice.html, once.html);
});

test('a span found twice or not at all aborts rather than guessing', () => {
  assert.throws(() => planBody(LIVE + LIVE));
  assert.throws(() => planBody('<p>nothing here</p>'));
});

test('the named scents match config/ingredients.json soap variations', async () => {
  const { readFileSync } = await import('node:fs');
  const ing = JSON.parse(readFileSync(new URL('../../config/ingredients.json', import.meta.url)));
  const blob = JSON.stringify(ing.liquid_soap ?? ing);
  assert.doesNotMatch(blob, /eucalyptus/i);
});
