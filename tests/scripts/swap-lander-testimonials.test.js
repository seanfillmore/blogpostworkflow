import test from 'node:test';
import assert from 'node:assert/strict';

import { swapTestimonials, renderQuote, PLAN, SECTION } from '../../scripts/swap-lander-testimonials.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../../agents/ad-studio/health-claims.js';

/** The live ugc-photos section as measured on 2026-09-02. */
const liveTemplate = () => ({
  sections: {
    'ugc-photos': {
      type: 'multicolumn',
      settings: { heading: 'Real Customers, Real Skin.' },
      blocks: {
        'ugc-1': { type: 'column', settings: { image: 'shopify://shop_images/ugc-1-bathroom-counter.jpg', title: PLAN[0].oldName, text: PLAN[0].oldText } },
        'ugc-2': { type: 'column', settings: { image: 'shopify://shop_images/ugc-2-cream-in-hand.jpg', title: 'Ariel M.', text: '<p>"As soon as you put it on it just absorbs."</p>' } },
        'ugc-3': { type: 'column', settings: { image: 'shopify://shop_images/ugc-3-nightstand-tray.jpg', title: PLAN[1].oldName, text: PLAN[1].oldText } },
        'ugc-4': { type: 'column', settings: { image: 'shopify://shop_images/ugc-4-unboxing.jpg', title: 'Nicole H.', text: '<p>"Perfect moisturizer for my kids."</p>' } },
      },
      block_order: ['ugc-1', 'ugc-2', 'ugc-3', 'ugc-4'],
    },
  },
});

const blk = (t, id) => t.sections[SECTION].blocks[id].settings;

test('every OLD quote genuinely trips the gate — both swaps were necessary', () => {
  for (const e of PLAN) {
    const plain = e.oldText.replace(/<[^>]+>/g, '');
    assert.equal(checkSeoCopyFields({ t: plain }).ok, false, `${e.block} BEFORE should trip`);
  }
});

test('every replacement passes both gates', () => {
  for (const e of PLAN) {
    assert.equal(checkSeoCopyFields({ t: e.body }).ok, true, e.block);
    assert.equal(hasHealthClaim(e.body), false, e.block);
  }
});

test('replacements carry no disease or drug vocabulary, including words the gate lacks', () => {
  // `diabetic` is not in the gate's vocabulary and turned up in a candidate —
  // this is the belt-and-braces screen, not a duplicate of the gate.
  for (const e of PLAN) {
    for (const w of ['eczema', 'psoria', 'rosacea', 'dermat', 'steroid', 'prescription', 'diabet', 'cure', 'heal', 'treat']) {
      assert.doesNotMatch(e.body, new RegExp(w, 'i'), `${e.block} should not contain "${w}"`);
    }
  }
});

test('quotes are used VERBATIM — only wrapping markup is added', () => {
  for (const e of PLAN) {
    assert.equal(renderQuote(e.body), `<p>"${e.body}"</p>`);
    assert.equal(renderQuote(e.body).replace(/<\/?p>|"/g, ''), e.body);
  }
});

test('curly apostrophes in the source reviews survive intact', () => {
  // Straightening them would be an edit to an endorsement, however cosmetic.
  assert.ok(PLAN.some((e) => e.body.includes('’')), 'fixture should exercise this');
  const { template } = swapTestimonials(liveTemplate());
  for (const e of PLAN) {
    if (e.body.includes('’')) assert.ok(blk(template, e.block).text.includes('’'));
  }
});

test('provenance is recorded for every replacement', () => {
  for (const e of PLAN) {
    assert.ok(Number.isInteger(e.source.reviewId), e.block);
    assert.equal(e.source.rating, 5, e.block);
    assert.match(e.source.createdAt, /^\d{4}-\d{2}-\d{2}$/, e.block);
    assert.ok(e.source.product && e.source.verified, e.block);
  }
});

test('no reviewer PII rides along in the plan', () => {
  const blob = JSON.stringify(PLAN);
  assert.doesNotMatch(blob, /@/, 'no email');
  assert.doesNotMatch(blob, /\b\d{10,}\b/, 'no phone / reviewer id');
});

test('both claim-carrying blocks are swapped, name and quote together', () => {
  const { template, applied, skipped } = swapTestimonials(liveTemplate());
  assert.equal(applied.length, 2);
  assert.equal(skipped.length, 0);
  for (const e of PLAN) {
    assert.equal(blk(template, e.block).title, e.name);
    assert.equal(blk(template, e.block).text, renderQuote(e.body));
  }
});

test('the untouched testimonials and every photo survive', () => {
  const before = liveTemplate();
  const { template } = swapTestimonials(before);
  assert.deepEqual(blk(template, 'ugc-2'), blk(before, 'ugc-2'));
  assert.deepEqual(blk(template, 'ugc-4'), blk(before, 'ugc-4'));
  for (const id of ['ugc-1', 'ugc-2', 'ugc-3', 'ugc-4']) {
    assert.equal(blk(template, id).image, blk(before, id).image, `${id} photo must not move`);
  }
  assert.deepEqual(template.sections[SECTION].block_order, before.sections[SECTION].block_order);
});

test('no attribution is duplicated across the four cards', () => {
  const { template } = swapTestimonials(liveTemplate());
  const names = template.sections[SECTION].block_order.map((id) => blk(template, id).title);
  assert.equal(new Set(names).size, names.length, `duplicate attribution: ${names.join(', ')}`);
});

test('re-running is a no-op', () => {
  const once = swapTestimonials(liveTemplate()).template;
  const again = swapTestimonials(once);
  assert.equal(again.applied.length, 0);
  assert.ok(again.skipped.every((s) => s.why === 'already applied'));
});

test('a drifted block is SKIPPED, never overwritten', () => {
  const t = liveTemplate();
  t.sections[SECTION].blocks['ugc-1'].settings.text = '<p>"Someone edited this."</p>';
  const { template, applied, skipped } = swapTestimonials(t);
  assert.equal(applied.length, 1); // ugc-3 still applies
  assert.equal(skipped[0].block, 'ugc-1');
  assert.equal(skipped[0].why, 'live value matches neither BEFORE nor AFTER');
  assert.equal(blk(template, 'ugc-1').text, '<p>"Someone edited this."</p>');
});

test('the input template is never mutated', () => {
  const input = liveTemplate();
  const snapshot = JSON.stringify(input);
  swapTestimonials(input);
  assert.equal(JSON.stringify(input), snapshot);
});
