import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  HEADROOM_BY_AWARENESS, scorePersona, scoreProof, scoreCommercial, scoreHeadroom, scoreBrief,
} from '../../lib/ad-brief-score.js';

const P1 = { id: 'p1', evidence_count: 18, emotional_intensity: 9.2 };
const P_WEAK = { id: 'p9', evidence_count: 1, emotional_intensity: 2 };

const ANGLE = {
  id: 'p1a1', awareness: 'problem-aware',
  proof: 'Verified reviewer with severe eczema reports going from hourly reapplication to twice a day.',
  source_quotes: ['I have tried prescription strength lotions, steroids, you name it, to no avail'],
};

const REVIEWS = [{ body: 'I have tried prescription strength lotions, steroids, you name it, to no avail' }];

const SEO = {
  clusters: [
    { cluster: 'body lotion', revenue: 177.8, revenueDelta: 111.8 },
    { cluster: 'lotion', revenue: 30, revenueDelta: -29.4 },
    { cluster: 'soap', revenue: 0, revenueDelta: 0 },
  ],
};

// ── persona strength ────────────────────────────────────────────────────────────────
test('persona strength rewards evidence and intensity, capped at 30', () => {
  assert.equal(scorePersona(P1), 30);
  assert.ok(scorePersona(P_WEAK) < 10);
  assert.ok(scorePersona(P1) > scorePersona(P_WEAK));
});

test('a persona with missing fields scores 0 rather than NaN', () => {
  assert.equal(scorePersona({}), 0);
  assert.equal(scorePersona(null), 0);
});

// ── proof ───────────────────────────────────────────────────────────────────────────
//
// The point of this component: an angle whose proof traces to a REAL review is worth more
// than one asserting a benefit nobody said. A quote that appears in no review on file is
// not proof, however confident the persona file sounds.
test('proof scores full when a source quote appears in a real review', () => {
  assert.equal(scoreProof(ANGLE, REVIEWS), 25);
});

test('proof scores low when no review corroborates the quote', () => {
  assert.ok(scoreProof(ANGLE, [{ body: 'nice smell, fast shipping' }]) < 10);
});

test('proof matching ignores case and punctuation drift', () => {
  const drifted = [{ body: 'I HAVE TRIED PRESCRIPTION-STRENGTH LOTIONS, STEROIDS... you name it, to no avail!' }];
  assert.equal(scoreProof(ANGLE, drifted), 25);
});

test('an angle with no source quotes scores 0 proof, not full marks', () => {
  assert.equal(scoreProof({ id: 'x', proof: 'trust me' }, REVIEWS), 0);
});

// A quote head must survive inside ONE review, not be assembled from the tail of one
// review and the head of the next. Two reviews that, concatenated with a single space,
// would contain the quote's head — but neither contains it alone — must not score proof.
test('proof does not score full marks when a quote head only matches across a review boundary', () => {
  const splitAngle = {
    id: 'split-quote',
    source_quotes: ['all day long totally changed my morning routine'],
  };
  const splitReviews = [
    { body: 'stays put all day long' },
    { body: 'totally changed my morning routine forever' },
  ];
  assert.ok(scoreProof(splitAngle, splitReviews) < 25);
});

// ── commercial ──────────────────────────────────────────────────────────────────────
test('commercial rewards a product whose cluster earns revenue', () => {
  assert.ok(scoreCommercial('coconut-lotion', SEO) > scoreCommercial('coconut-soap', SEO));
});

// Absence of data is NOT evidence of a bad product. A product with no matching cluster
// must land mid-scale, never at zero — otherwise every new product is ranked last for
// the crime of being new.
test('a product with no matching cluster scores neutral, not zero', () => {
  const n = scoreCommercial('coconut-oil-lip-balm', SEO);
  assert.ok(n > 0, 'no-data must not score zero');
  assert.ok(n < 25, 'no-data must not score full marks either');
});

test('a missing or malformed seo-impact report scores neutral for everything', () => {
  assert.equal(scoreCommercial('coconut-lotion', null), scoreCommercial('coconut-soap', null));
});

// ── headroom ────────────────────────────────────────────────────────────────────────
//
// Narrow product-aware angles harvest fast and exhaust fast; broad problem-aware and
// unaware angles convert slower and keep running. Without this the queue fills with the
// angles that run dry first.
test('headroom ranks broad angles above narrow ones', () => {
  assert.ok(scoreHeadroom('unaware') > scoreHeadroom('solution-aware'));
  assert.ok(scoreHeadroom('problem-aware') > scoreHeadroom('solution-aware'));
  assert.ok(scoreHeadroom('solution-aware') > scoreHeadroom('product-aware'));
  assert.equal(scoreHeadroom('unaware'), 20);
});

test('an unknown awareness value scores 0 headroom rather than throwing', () => {
  assert.equal(scoreHeadroom('banana'), 0);
  assert.equal(scoreHeadroom(undefined), 0);
});

test('every awareness level in the table has a headroom value', () => {
  for (const level of ['unaware', 'problem-aware', 'solution-aware', 'product-aware', 'most-aware']) {
    assert.equal(typeof HEADROOM_BY_AWARENESS[level], 'number', `${level} must have a headroom score`);
  }
});

// ── the whole score ─────────────────────────────────────────────────────────────────
test('scoreBrief returns every component alongside the total', () => {
  const s = scoreBrief({ persona: P1, angle: ANGLE, reviews: REVIEWS, productHandle: 'coconut-lotion', seoImpact: SEO });
  assert.equal(s.total, s.persona + s.proof + s.commercial + s.headroom);
  assert.ok(s.total > 0 && s.total <= 100);
  for (const k of ['persona', 'proof', 'commercial', 'headroom']) {
    assert.equal(typeof s[k], 'number', `${k} must be reported, not hidden`);
  }
});

test('the total can never exceed 100 even at maximum everything', () => {
  const s = scoreBrief({
    persona: { evidence_count: 9999, emotional_intensity: 10 },
    angle: { awareness: 'unaware', source_quotes: ['exact'] },
    reviews: [{ body: 'exact' }],
    productHandle: 'coconut-lotion',
    seoImpact: { clusters: [{ cluster: 'lotion', revenue: 1e9, revenueDelta: 1e9 }] },
  });
  assert.ok(s.total <= 100, `total was ${s.total}`);
});
