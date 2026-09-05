// tests/lib/ctr-wave.test.js
//
// THE WAVE LIFECYCLE. The CTR program planned a rigorous experiment every
// Monday and never ran one — see lib/ctr-wave.js for the three defects measured
// on production 2026-09-05. These tests pin the two properties that make the
// experiment valid and the one that stops it deadlocking.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  waveState,
  treatmentCoverage,
  requiredCoverage,
  handleOf,
  MEASUREMENT_WINDOW_DAYS,
} from '../../lib/ctr-wave.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const u = (h) => `https://www.realskincare.com/blogs/news/${h}`;

/** The live 2026-08-31 power block, verbatim. */
const REAL_POWER = {
  powered: true,
  impressionsPerArm: 36134.62222222222,
  baselineCtr: 0.0035644485006069895,
  mde: 0.0012421609012244162,
  targetRelativeLift: 0.5,
  targetAbsoluteLift: 0.0017822242503034947,
};

const waveOf = (over = {}) => ({
  generated_at: '2026-08-31T14:55:00.000Z',
  power: REAL_POWER,
  target_relative_lift: 0.5,
  treatment: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((h) => ({ url: u(h) })),
  holdout: ['k', 'l'].map((h) => ({ url: u(h) })),
  ...over,
});

const entry = (h, testedAt) => ({ pageUrl: u(h), testedAt });

// ── the derived floor ────────────────────────────────────────────────────────

test('requiredCoverage is DERIVED from the wave power block, not picked', () => {
  // If a fraction f of the arm is rewritten the observable effect is ~f x
  // target, so a result is only readable while f >= mde / targetAbsoluteLift.
  // On the live wave that is 0.0012422 / 0.0017822 = 0.697.
  const r = requiredCoverage(REAL_POWER);
  assert.ok(Math.abs(r - 0.6969) < 0.001, `expected ~0.697, got ${r}`);
});

test('requiredCoverage degrades to the floor rather than blocking forever', () => {
  // A wave we cannot reason about must demand LESS, not freeze the program —
  // waveState expires it on time regardless.
  for (const p of [undefined, {}, { mde: 1, targetAbsoluteLift: 0 }, { mde: NaN, targetAbsoluteLift: 1 }]) {
    const r = requiredCoverage(p);
    assert.ok(r >= 0.5 && r <= 1, `${JSON.stringify(p)} → ${r}`);
  }
});

test('requiredCoverage is clamped to [0.5, 1]', () => {
  assert.equal(requiredCoverage({ mde: 0.009, targetAbsoluteLift: 0.001 }), 1); // would be 9
  assert.equal(requiredCoverage({ mde: 0.0001, targetAbsoluteLift: 0.01 }), 0.5); // would be 0.01
});

// ── coverage ─────────────────────────────────────────────────────────────────

test('coverage counts only rewrites made AFTER the wave was planned', () => {
  // A page rewritten last month was not treated as part of THIS wave and its
  // effect is already inside the baseline. Counting it would inflate coverage
  // and let an unreadable wave conclude.
  const cov = treatmentCoverage(waveOf(), [
    entry('a', '2026-09-01T00:00:00.000Z'), // during the wave
    entry('b', '2026-07-01T00:00:00.000Z'), // long before it
  ]);
  assert.equal(cov.treated, 1);
  assert.deepEqual(cov.treatedPages, ['a']);
  assert.ok(cov.untreatedPages.includes('b'));
});

test('a tracker entry with an unparseable date is ignored, never counted', () => {
  // The failure direction is "we say it is less covered than it is", which only
  // ever delays a verdict. The opposite would let a half-treated wave conclude.
  const cov = treatmentCoverage(waveOf(), [entry('a', undefined), entry('b', 'not a date')]);
  assert.equal(cov.treated, 0);
});

test('THE REAL TRACKER FORMAT: testedAt is DATE-ONLY and must still count', () => {
  // The bug this exists to prevent, found only by running against production.
  // meta-ab-tracker.json stamps `testedAt: "2026-08-31"` while the wave carries
  // `generated_at: "2026-08-31T14:55:02.682Z"`. Compared as instants, the
  // rewrite parses to midnight and sorts BEFORE the wave that prompted it — so
  // the live wave reported 0/10 treated when it was 1/10. Every fixture above
  // uses full ISO strings, which is exactly why they all passed.
  const cov = treatmentCoverage(
    waveOf({ generated_at: '2026-08-31T14:55:02.682Z' }),
    [{ pageUrl: u('a'), testedAt: '2026-08-31' }],
  );
  assert.equal(cov.treated, 1, 'a same-day date-only rewrite counts toward the wave');
});

test('a date-only rewrite from BEFORE the wave still does not count', () => {
  const cov = treatmentCoverage(
    waveOf({ generated_at: '2026-08-31T14:55:02.682Z' }),
    [{ pageUrl: u('a'), testedAt: '2026-08-30' }],
  );
  assert.equal(cov.treated, 0);
});

test('a rewrite of a page outside the arm does not count toward coverage', () => {
  const cov = treatmentCoverage(waveOf(), [entry('zzz-not-in-wave', '2026-09-01T00:00:00.000Z')]);
  assert.equal(cov.treated, 0);
});

// ── the three states ─────────────────────────────────────────────────────────

test('no wave on disk → plan one', () => {
  for (const w of [null, undefined, {}, { treatment: 'nope' }]) {
    const s = waveState(w, [], { now: NOW });
    assert.equal(s.status, 'none');
    assert.equal(s.replan, true);
  }
});

test('IN FLIGHT: a young wave FREEZES the arms — this is the whole experiment', () => {
  // Defect 2: the cron is weekly but a wave measures over 28 days, and
  // writeWave overwrote wave.json unconditionally, so arms reshuffled six days
  // into every measurement.
  const s = waveState(waveOf(), [], { now: Date.parse('2026-09-05T00:00:00Z') });
  assert.equal(s.status, 'in-flight');
  assert.equal(s.replan, false, 'an in-flight wave must never be re-planned');
  assert.equal(s.concludable, false);
  assert.match(s.reason, /FROZEN/);
});

test('DUE: the window elapsed → measure it, then plan the next', () => {
  const now = Date.parse('2026-08-31T14:55:00Z') + (MEASUREMENT_WINDOW_DAYS + 1) * DAY;
  const treated = 'abcdefg'.split('').map((h) => entry(h, '2026-09-02T00:00:00.000Z')); // 7/10 = 0.70
  const s = waveState(waveOf(), treated, { now });
  assert.equal(s.status, 'due');
  assert.equal(s.replan, true);
  assert.equal(s.concludable, true, '7/10 clears the derived 0.697 floor');
});

test('DUE BUT UNDERDOSED: replans anyway — an expiry is not optional', () => {
  // A wave that pinned the program forever because it was never treated is the
  // failure this repo has already paid for twice: the six-day held tattoo merge
  // and PINNED_MIRROR_SLUGS with no expiry. Both became outages nobody was
  // looking for.
  const now = Date.parse('2026-08-31T14:55:00Z') + (MEASUREMENT_WINDOW_DAYS + 1) * DAY;
  const s = waveState(waveOf(), [entry('a', '2026-09-02T00:00:00.000Z')], { now });
  assert.equal(s.status, 'due');
  assert.equal(s.replan, true, 'an unreadable wave must still be replaced, or the program deadlocks');
  assert.equal(s.concludable, false, 'and it must NOT be read as a verdict');
  assert.match(s.reason, /UNDERDOSED/);
});

test('an undateable wave is DUE, never frozen forever', () => {
  const s = waveState(waveOf({ generated_at: 'nonsense' }), [], { now: NOW });
  assert.equal(s.status, 'due');
  assert.equal(s.replan, true);
});

test('the in-flight / due boundary is MEASUREMENT_WINDOW_DAYS', () => {
  const start = Date.parse('2026-08-31T14:55:00Z');
  const just = waveState(waveOf(), [], { now: start + MEASUREMENT_WINDOW_DAYS * DAY - 1000 });
  const past = waveState(waveOf(), [], { now: start + MEASUREMENT_WINDOW_DAYS * DAY + 1000 });
  assert.equal(just.status, 'in-flight');
  assert.equal(past.status, 'due');
});

test('MEASUREMENT_WINDOW_DAYS is the MEASUREMENT window, not the wave file\'s lookback', () => {
  // wave.window_days is 90 on the live wave — the lookback used to RANK pages.
  // Confusing the two would freeze every wave for three months.
  assert.equal(MEASUREMENT_WINDOW_DAYS, 28);
  const s = waveState(waveOf({ window_days: 90 }), [], { now: NOW });
  assert.equal(s.status, 'in-flight'); // 5 days old, judged against 28 not 90
});

// ── the real production case ─────────────────────────────────────────────────

test('THE LIVE 2026-08-31 WAVE: 1 of 10 treated, in flight, not concludable', () => {
  // Reproduces exactly what production looked like on 2026-09-05. Of the five
  // weekly slots two went to `individual` pages (correct), two to pages the
  // wave had DEFERRED, and one landed in the treatment arm — and only one was
  // even selectable, because candidates are QUERIES and the wave picks PAGES.
  const live = waveOf({
    treatment: [
      'best-toothpaste-without-sls-2025',
      'sls-free-toothpaste-list-best-natural-options-2026',
      'best-cinnamon-toothpaste-benefits-brands-what-to-know',
      'best-deodorant-for-sensitive-skin-what-to-look-for',
      'unscented-deodorant-what-it-is-why-it-works',
      'antibacterial-body-soap-what-to-look-for-why-it-matters',
      'coconut-soap-benefits-discover-the-wonders-of-coconut-oil-in-soap',
      'best-unscented-lotion-clean-fragrance-free-picks',
      'how-to-make-a-natural-moisturizer-at-home-easy-recipes-1',
      'vanilla-lotion-best-natural-options-for-soft-skin',
    ].map((h) => ({ url: u(h) })),
  });
  const tracker = [
    entry('best-soap-for-tattoos-what-to-use-for-safe-healing-2', '2026-08-31T15:02:00Z'), // individual
    entry('toothpaste-without-sls-what-to-know-best-options', '2026-08-31T15:03:00Z'),     // individual
    entry('coconut-oil-deodorant-does-it-work-is-it-safe', '2026-08-31T15:04:00Z'),        // deferred
    entry('sls-free-toothpaste-list-best-natural-options-2026', '2026-08-31T15:05:00Z'),   // treatment
    entry('why-glycerin-free-toothpaste-matters', '2026-08-31T15:06:00Z'),                 // deferred
  ];

  const s = waveState(live, tracker, { now: NOW });
  assert.equal(s.coverage.treated, 1, 'exactly one treatment page was rewritten');
  assert.equal(s.coverage.total, 10);
  assert.equal(s.status, 'in-flight');
  assert.equal(s.concludable, false);
  // 10% against a required 70% — nowhere near readable.
  assert.ok(s.coverage.ratio < s.required);
});

// ── handle join key ──────────────────────────────────────────────────────────

test('handleOf survives query strings, fragments and trailing slashes', () => {
  const want = 'best-unscented-lotion';
  for (const v of [
    'https://www.realskincare.com/blogs/news/best-unscented-lotion',
    'https://www.realskincare.com/blogs/news/best-unscented-lotion/',
    'https://www.realskincare.com/blogs/news/best-unscented-lotion?utm=x',
    'https://rsc.myshopify.com/blogs/news/best-unscented-lotion#faq',
  ]) assert.equal(handleOf(v), want, v);
});
