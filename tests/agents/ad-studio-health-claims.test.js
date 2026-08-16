import { strict as assert } from 'node:assert';
import {
  HEALTH_CLAIM_PATTERNS,
  findHealthClaims,
  hasHealthClaim,
  assertNoHealthClaims,
  selectQuotableReviews,
} from '../../agents/ad-studio/health-claims.js';

// The quote that started this. Verbatim, correctly sourced to a real Judge.me review, and
// passed the sourcing gate — which was right, it IS a real quote. But an advertiser is
// responsible for the claims an endorsement conveys (FTC 16 CFR 255), and a cosmetic
// becomes an unapproved drug on intended use, which marketing material including
// testimonials evidences (FDA). "It came from a review" is not a defence.
const LIVE_QUOTE =
  'I have tried prescription strength lotions, steroids, you name it, and everything ' +
  'under the sun over the counter to no avail.... Until Real Skin Care!!!!';

{
  const hits = findHealthClaims(LIVE_QUOTE);
  assert.ok(hits.length >= 1, 'the live testimonial must be caught');
  assert.ok(hits.some(h => h.category === 'drug'), 'prescription/steroids is drug language');
  assert.ok(hasHealthClaim(LIVE_QUOTE));
}

// ── Each category fires ─────────────────────────────────────────────────────────────
for (const [text, category] of [
  ['clears up eczema fast', 'disease'],
  ['gentle enough for psoriasis', 'disease'],
  ['no more dermatitis', 'disease'],
  ['better than a steroid cream', 'drug'],
  ['works when hydrocortisone did not', 'drug'],
  ['an over-the-counter alternative', 'drug'],
  ['heals dry, cracked skin', 'therapeutic'],
  ['cures flaky skin', 'therapeutic'],
  ['treats rough patches', 'therapeutic'],
  ['prevents future dryness', 'therapeutic'],
  ['reverses damage', 'therapeutic'],
  ['clinically proven to work', 'substantiation'],
  ['dermatologist approved', 'substantiation'],
  ['FDA approved formula', 'substantiation'],
]) {
  const hits = findHealthClaims(text);
  assert.ok(hits.length, `must catch: ${text}`);
  assert.ok(hits.some(h => h.category === category), `${text} → expected category ${category}`);
}

// ── Ordinary cosmetic language is the product's whole pitch and must survive ─────────
//
// A cosmetic may say what it DOES to the appearance and feel of skin. Blocking this would
// make the gate unusable and push the writer toward vaguer, worse copy.
for (const ok of [
  'Deeply moisturizing for dry skin',
  'Absorbs instead of sitting on top',
  'Soothes and softens rough, flaky skin',
  'Gentle enough for sensitive skin',
  'Non-greasy, fragrance-free hydration',
  'Six clean ingredients your skin recognizes',
  'For chronically dry hands',
  'Leaves skin feeling healthy and soft',
  'Nourishes the skin barrier',
  'Calms the look of redness and irritation',
]) {
  assert.deepEqual(findHealthClaims(ok), [], `must NOT flag ordinary cosmetic copy: ${ok}`);
}

// ── Word boundaries are load-bearing ────────────────────────────────────────────────
//
// "heal" must not fire on "healthy" and "cure" must not fire on "manicure", or the gate
// blocks the most ordinary skincare words there are.
assert.deepEqual(findHealthClaims('healthy-looking skin'), []);
assert.deepEqual(findHealthClaims('healthier skin barrier'), []);
assert.deepEqual(findHealthClaims('perfect after a manicure'), []);
assert.deepEqual(findHealthClaims('a pedicure staple'), []);
assert.deepEqual(findHealthClaims('treatable by moisture alone'), [], 'not a therapeutic assertion');
assert.ok(hasHealthClaim('heals overnight'), 'but the real verb still fires');
assert.ok(hasHealthClaim('a healing balm'));

// Empty and junk inputs are not errors.
assert.deepEqual(findHealthClaims(''), []);
assert.deepEqual(findHealthClaims(null), []);
assert.deepEqual(findHealthClaims(undefined), []);

// ── assertNoHealthClaims: runs on ZONES, including array zones ───────────────────────
//
// Checking the claims array instead would miss PURE PERSUASION copy, which carries no
// claim entry at all — and "heals dry skin" set as persuasion is exactly the case that
// matters.
assert.doesNotThrow(() => assertNoHealthClaims({
  headline: 'Six ingredients. Nothing to hide.',
  rows: ['Mostly water and mineral oil', 'A film that sits on top'],
  bottomBar: 'SIX CLEAN INGREDIENTS — $30',
}));

// NB: assert.throws with a RegExp tests the STRINGIFIED error ("Error: ..."), not
// err.message — so the prefix cannot be anchored here. buildConcept matches on
// err.message directly, which is why it can and does anchor with ^.
assert.throws(
  () => assertNoHealthClaims({ headline: LIVE_QUOTE, attribution: '— Verified customer' }),
  /Health claim gate failed/,
  'the message prefix is what buildConcept matches on',
);
{
  // Pin the anchored form the caller actually relies on.
  let msg = '';
  try { assertNoHealthClaims({ headline: LIVE_QUOTE }); } catch (e) { msg = e.message; }
  assert.ok(/^Health claim gate failed/.test(msg), 'buildConcept anchors on err.message');
}

// An array zone is checked entry by entry — one bad row must not hide behind good ones.
assert.throws(
  () => assertNoHealthClaims({ rows: ['Absorbs in seconds', 'Heals cracked heels', 'No parabens'] }),
  /Heals/,
);

// The error names the zone, the exact match and the reason — a verdict a human cannot act
// on just gets overridden.
try {
  assertNoHealthClaims({ headline: 'Clears eczema in days' });
  assert.fail('should have thrown');
} catch (err) {
  assert.match(err.message, /\[headline\]/);
  assert.match(err.message, /eczema/i);
  assert.match(err.message, /unapproved drug/i);
  assert.match(err.message, /quoting a customer does not change that/i);
}

// ── selectQuotableReviews: prevention, not just detection ────────────────────────────
//
// The gate would catch a disease quote AFTER the copy call — costing a call and an attempt
// for a choice the writer never needed to make. Dropping those reviews first is the same
// lesson the safe-zone block taught: detection without prevention burns retries.
{
  const reviews = [
    LIVE_QUOTE,
    "It's not greasy & really works. Esp for chronic dry skin.",
    'Finally something that absorbs instead of sitting on my skin.',
    'Cleared up my psoriasis in a week!',
  ];
  const quotable = selectQuotableReviews(reviews);
  assert.equal(quotable.length, 2, 'both condition-language reviews are withheld');
  assert.ok(quotable.every(r => !hasHealthClaim(r)));
  assert.ok(quotable.some(r => /not greasy/.test(r)), 'and the persuasive clean ones survive');
  assert.deepEqual(selectQuotableReviews([]), []);
  assert.deepEqual(selectQuotableReviews(null), []);
}

// Every pattern carries the metadata the error message is built from.
for (const p of HEALTH_CLAIM_PATTERNS) {
  assert.ok(p.category, 'each pattern needs a category');
  assert.ok(p.why && p.why.length > 20, `${p.category} needs a reason a human can act on`);
  assert.ok(p.pattern instanceof RegExp);
}
