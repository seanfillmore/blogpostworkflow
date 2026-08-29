import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEGMENTS,
  FRUSTRATION_KEYS,
  NO_PURCHASE_LINE,
  renderFrustrationEmail,
  renderAll,
  segmentDefinition,
} from '../../lib/giveaway/frustration-campaigns.js';

test('covers exactly the four gv_frustration values the entry endpoint accepts', () => {
  // agents/dashboard/routes/giveaway.js validates against this same set. A fifth answer
  // added there without a segment here means those entrants silently receive nothing.
  assert.deepEqual([...FRUSTRATION_KEYS].sort(), ['dry', 'fragrance', 'ingredients', 'reactive']);
  assert.deepEqual(SEGMENTS.map((s) => s.key).sort(), [...FRUSTRATION_KEYS].sort());
});

test('segments are mutually exclusive, so nobody receives two of these', () => {
  const keys = SEGMENTS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    const def = segmentDefinition(key);
    const conds = def.condition_groups.flatMap((g) => g.conditions);
    assert.equal(conds.length, 1, `${key}: one equality condition, or the segments can overlap`);
    assert.equal(conds[0].filter.operator, 'equals');
    assert.equal(conds[0].filter.value, key);
  }
});

test('all four render', () => {
  const rendered = renderAll();
  assert.equal(rendered.length, 4);
  for (const r of rendered) assert.match(r.html, /^<!DOCTYPE html>/);
});

test('every email carries the full sweepstakes disclaimer', () => {
  // Selling into an OPEN contest. All three sentences, verbatim — see NO_PURCHASE_LINE.
  for (const r of renderAll()) {
    assert.ok(r.html.includes(NO_PURCHASE_LINE), `${r.key} is missing the no-purchase line`);
    assert.ok(r.html.includes('already in for the drawing'), `${r.key} does not say entries are unaffected`);
  }
});

test('every email carries unsubscribe, official rules, and the entry-is-safe promise', () => {
  for (const r of renderAll()) {
    assert.ok(r.html.includes('{% unsubscribe %}'), `${r.key}: no unsubscribe tag`);
    assert.ok(r.html.includes('/pages/giveaway-official-rules'), `${r.key}: no official rules link`);
    // §12 of the published rules. Dropping it would contradict the rules in a send.
    assert.ok(r.html.includes('unsubscribing does not forfeit your entry'), `${r.key}: no §12 line`);
  }
});

test('no email claims the product is made anywhere but the USA', () => {
  for (const r of renderAll()) {
    assert.ok(!/made in .{0,24}(blum|texas)/i.test(r.html), `${r.key}: origin claim names Blum/Texas`);
  }
});

test('the health-claim gate actually fires — it is not decorative', () => {
  const base = SEGMENTS.find((s) => s.key === 'reactive');

  for (const [field, bad] of [
    ['headline', 'Clears up eczema for good'],
    ['subject', 'The steroid-free answer your dermatologist missed'],
    ['ctaLabel', 'Start healing today'],
  ]) {
    assert.throws(
      () => renderFrustrationEmail({ ...base, [field]: bad }),
      /Health claim gate failed/,
      `a disallowed claim in ${field} must stop the render`,
    );
  }

  // Body paragraphs are an array — the gate has to walk into it, not stringify past it.
  assert.throws(
    () => renderFrustrationEmail({ ...base, paras: ['Fine copy.', 'It treats dermatitis.'] }),
    /Health claim gate failed/,
  );
});

test('ordinary cosmetic language still passes', () => {
  // The gate must not be so blunt it eats the vocabulary the products are actually sold on.
  const base = SEGMENTS.find((s) => s.key === 'dry');
  assert.doesNotThrow(() =>
    renderFrustrationEmail({
      ...base,
      paras: ['Moisturizes dry, flaky, itchy skin and softens the feel of a rough patch, without a greasy film.'],
    }),
  );
});

test('a discount code cannot reach this full-price send', () => {
  // The consolation offer is the day-30 revenue event. Spending SOAP6MO here would burn it
  // three weeks early, which is exactly what §7.1 traded the entry moment to protect.
  const base = SEGMENTS.find((s) => s.key === 'dry');
  for (const code of ['SOAP4MO', 'SOAP6MO', 'FIRST20']) {
    assert.throws(
      () => renderFrustrationEmail({ ...base, paras: [`Use ${code} at checkout.`] }),
      /full price/,
      `${code} must be rejected`,
    );
  }
});

test('the EWG figure keeps its hedge, its date and its framing', () => {
  const ing = renderAll().find((r) => r.key === 'ingredients');

  // The retired angle p2a2 quoted EWG's 2004 figure of 126, which EWG's own 2023 re-run
  // revised DOWN to 112. Quoting it bare, undated, or as a safety claim reintroduces
  // exactly the angle that was retired.
  assert.ok(ing.html.includes('2023'), 'the year must survive — the 2004 figure is the retired one');
  assert.ok(ing.html.includes('as many as 112'), 'the figure must keep its "as many as" hedge');
  assert.ok(ing.html.includes('EWG and Morning Consult'), 'the source must be named');
  assert.ok(ing.html.includes('2,200 U.S. adults'), 'the sample must be named');
  assert.ok(
    /not a safety verdict/i.test(ing.html),
    'the count must be explicitly disclaimed as not a safety claim',
  );
  assert.ok(!/\b126\b/.test(ing.html), 'the superseded 2004 figure must not appear');
});

test('every segment points at the same product, so the angle is the only variable', () => {
  // Hold the SKU constant or a difference between segments is unattributable. See the
  // module header. `secondary` may differ; the measured CTA may not.
  for (const r of renderAll()) {
    assert.ok(
      r.html.includes('/products/sensitive-skin-starter-set'),
      `${r.key}: primary CTA is not the Set`,
    );
  }
});

test('an unknown segment key is refused rather than rendered blank', () => {
  assert.throws(() => renderFrustrationEmail({ key: 'oily', paras: [] }), /unknown frustration segment/);
  assert.throws(() => segmentDefinition('oily'), /unknown frustration segment/);
});
