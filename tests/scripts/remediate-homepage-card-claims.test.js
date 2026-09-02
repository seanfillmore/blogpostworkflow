import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPlan, PLAN, NOT_REMEDIATED } from '../../scripts/remediate-homepage-card-claims.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const templateWith = (text) => ({
  sections: {
    'product-line': {
      blocks: { 'prod-cream': { type: 'column', settings: { title: 'Body Cream', text } } },
      block_order: ['prod-cream'],
    },
  },
});

const entry = PLAN[0];
const liveTemplate = () => templateWith(entry.before);

test('every AFTER in the plan passes the health-claim gate', () => {
  for (const e of PLAN) {
    const g = checkSeoCopyFields({ [e.field]: e.after });
    assert.ok(g.ok, `${e.id}: ${g.blocking.map((v) => v.category + ':' + v.match).join(', ')}`);
  }
});

test('every BEFORE in the plan actually trips the gate', () => {
  // A plan entry whose BEFORE is already clean is a rewrite nobody needed —
  // the over-correction this gate's two tiers exist to prevent.
  for (const e of PLAN) {
    const g = checkSeoCopyFields({ [e.field]: e.before });
    assert.equal(g.ok, false, `${e.id}: BEFORE does not trip the gate`);
    assert.ok(g.blocking.some((v) => v.category === e.category),
      `${e.id}: expected category ${e.category}`);
  }
});

test('the rewrite is applied to the live value', () => {
  const { template, applied, skipped } = applyPlan(liveTemplate());
  assert.equal(applied.length, 1);
  assert.equal(skipped.length, 0);
  assert.equal(template.sections['product-line'].blocks['prod-cream'].settings.text, entry.after);
});

test('the disease word is gone and the buy link survives', () => {
  const { template } = applyPlan(liveTemplate());
  const text = template.sections['product-line'].blocks['prod-cream'].settings.text;
  assert.doesNotMatch(text, /eczema/i);
  assert.match(text, /href="\/products\/coconut-moisturizer"/);
  assert.match(text, /Shop →/);
});

test('only the disease word changes — the rest of the sentence is preserved', () => {
  // Guards against an over-correction that quietly rewrites working copy.
  for (const kept of ['For dry patches', 'overnight repair']) {
    assert.ok(entry.after.includes(kept), `AFTER should keep "${kept}"`);
  }
});

test('re-running is a no-op, reported as already applied', () => {
  const once = applyPlan(liveTemplate()).template;
  const again = applyPlan(once);
  assert.equal(again.applied.length, 0);
  assert.equal(again.skipped[0].why, 'already applied');
  assert.equal(again.template.sections['product-line'].blocks['prod-cream'].settings.text, entry.after);
});

test('a live value matching neither BEFORE nor AFTER is SKIPPED, never overwritten', () => {
  // The guard that caught a transcribed U+00A0 in remediate-live-health-claims.js.
  const drifted = '<p>Someone edited this card by hand.</p>';
  const { template, applied, skipped } = applyPlan(templateWith(drifted));
  assert.equal(applied.length, 0);
  assert.equal(skipped[0].why, 'live value matches neither BEFORE nor AFTER');
  assert.equal(template.sections['product-line'].blocks['prod-cream'].settings.text, drifted);
});

test('a missing block is skipped rather than throwing', () => {
  const { applied, skipped } = applyPlan({ sections: { 'product-line': { blocks: {} } } });
  assert.equal(applied.length, 0);
  assert.equal(skipped[0].why, 'block not found');
});

test('the input template is never mutated', () => {
  const input = liveTemplate();
  const snapshot = JSON.stringify(input);
  applyPlan(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('the deliberate non-remediations are recorded with a reason', () => {
  // "We looked and decided" must stay distinguishable from "we missed it".
  assert.ok(NOT_REMEDIATED.length >= 2);
  for (const n of NOT_REMEDIATED) {
    assert.ok(n.where && n.why && n.categories.length, `${n.where} needs where/why/categories`);
  }
  assert.ok(NOT_REMEDIATED.some((n) => n.where.startsWith('featured-testimonial')));
  assert.ok(NOT_REMEDIATED.some((n) => n.where.startsWith('founder')));
});
