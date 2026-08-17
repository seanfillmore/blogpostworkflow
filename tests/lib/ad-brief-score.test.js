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

// Found live on the server the morning after PR #504 deployed: every RSC cluster
// scoreCommercial actually matched against was attributing $0 revenue, and a MATCHED
// cluster carrying $0 revenue used to fall through to the ordinary formula and compute
// 0/10 + 0 = 0 — reading as "commercially worthless" when $0 attributed revenue (from an
// attribution pipeline this repo's own notes call directional-only) means nothing was
// measured, the same epistemic position as no match at all. A matched cluster with $0
// revenue and $0 revenueDelta (no momentum in either direction) must score the same
// neutral as no match, not the bottom of the range.
test('a matched cluster with zero revenue and no momentum scores neutral, not zero (the live 2026-08-17 bug)', () => {
  const ZERO_SIGNAL = { clusters: [{ cluster: 'soap', revenue: 0, revenueDelta: 0 }] };
  assert.equal(scoreCommercial('coconut-soap', ZERO_SIGNAL), 12);
});

// The fix above must not launder a REAL decline into the same neutral. A cluster can
// attribute $0 revenue in the window and still carry a genuine negative revenueDelta —
// "body lotion" on the server was rev=0, delta=-25.2 the day this was found. That is
// evidence of a real decline, not silence, and must score below the no-signal neutral.
test('a matched cluster with zero revenue but genuine negative momentum scores low, not neutral', () => {
  const DECLINING = { clusters: [{ cluster: 'body lotion', revenue: 0, revenueDelta: -25.2 }] };
  const declining = scoreCommercial('coconut-lotion', DECLINING);
  assert.ok(declining < 12, `a real decline must score below the no-signal neutral, got ${declining}`);
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

// This test claimed to prove the ceiling and did not: its fixture quote was `'exact'`, five
// characters, which fails scoreProof's `head.length > 12` guard — so proof scored 6 instead
// of 25 and the "maximum everything" total came to 81. A ceiling test that never reaches the
// ceiling proves the arithmetic is bounded by something, but not by what it says. The quote is
// now long enough to clear the head guard, and the assertion is the exact 100 rather than
// `<= 100`, so a future weight change that pushed a component past its cap would fail here
// instead of passing quietly. (Code review, 2026-08-17.)
test('the total is exactly 100 at maximum everything, and cannot exceed it', () => {
  const MAXED_QUOTE = 'it cleared up the dry patches on my hands in about four days';
  const s = scoreBrief({
    persona: { evidence_count: 9999, emotional_intensity: 10 },
    angle: { awareness: 'unaware', source_quotes: [MAXED_QUOTE] },
    reviews: [{ body: MAXED_QUOTE }],
    productHandle: 'coconut-lotion',
    seoImpact: { clusters: [{ cluster: 'lotion', revenue: 1e9, revenueDelta: 1e9 }] },
  });
  // Named individually so a failure says WHICH cap leaked rather than only that the sum did.
  assert.equal(s.persona, 30, 'persona must cap at 30');
  assert.equal(s.proof, 25, 'proof must reach its 25 — a fixture quote too short for the 12-character head guard scores 6 and hides the ceiling');
  assert.equal(s.commercial, 25, 'commercial must cap at 25');
  assert.equal(s.headroom, 20, 'headroom must cap at 20');
  assert.equal(s.total, 100, `total was ${s.total}`);
});

// Nothing in this module validates its inputs, and the data it reads is generated
// (personas.json) or absent in a local checkout (seo-impact's latest.json), so hostile and
// nonsensical values reach it in the ordinary course of business. Every component must degrade
// to a number in range rather than to NaN — a NaN total sorts unpredictably in listBriefs and
// would silently bury or float a brief.
test('negative, NaN and non-numeric inputs degrade to in-range numbers, never NaN', () => {
  const s = scoreBrief({
    persona: { evidence_count: -50, emotional_intensity: -9 },
    angle: { awareness: 'problem-aware', source_quotes: [] },
    reviews: null,
    productHandle: 'coconut-lotion',
    seoImpact: { clusters: [{ cluster: 'lotion', revenue: -1e9, revenueDelta: -1e9 }] },
  });
  for (const k of ['persona', 'proof', 'commercial', 'headroom', 'total']) {
    assert.ok(Number.isFinite(s[k]), `${k} must be a finite number, got ${s[k]}`);
    assert.ok(s[k] >= 0, `${k} must never go negative, got ${s[k]}`);
  }
  assert.ok(s.total <= 100, `total was ${s.total}`);

  // Garbage of the wrong TYPE, too — scorePersona/scoreCommercial coerce with Number(), which
  // yields NaN for a string, and `Math.min(NaN, 15)` is NaN. `|| 0` is what stops that; this
  // pins it.
  const t = scoreBrief({
    persona: { evidence_count: 'lots', emotional_intensity: {} },
    angle: { awareness: 'banana', source_quotes: ['x'] },
    reviews: [{ body: null }],
    productHandle: '',
    seoImpact: { clusters: [{ cluster: 'lotion', revenue: 'a bit', revenueDelta: undefined }] },
  });
  for (const k of ['persona', 'proof', 'commercial', 'headroom', 'total']) {
    assert.ok(Number.isFinite(t[k]), `${k} must be a finite number, got ${t[k]}`);
  }
});
