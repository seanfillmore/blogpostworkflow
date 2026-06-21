import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findStaleYears, isHistoricalYearReference } from '../../lib/year-accuracy.js';

const CUR = 2026; // fixed so tests are deterministic

// ── The reported false positive must NOT be flagged ──
test('historical "since YEAR" is not flagged', () => {
  const text = 'The market has expanded significantly since 2020, but the term "clean" still isn\'t regulated.';
  assert.deepEqual(findStaleYears(text, CUR), []);
});

test('a range of historical/citation references is not flagged', () => {
  const cases = [
    'A 2021 study found that fluoride-free options work.',
    'The brand was founded in 2019 by two chemists.',
    'Demand surged during the 2020 pandemic.',
    'Sales grew from 2019 to 2022 across the category.',
    'The data covers 2018–2021 for the whole sector.',
    'Between 2019 and 2021 the rules changed twice.',
    'Regulations introduced before 2022 still apply.',
    'Nothing changed until 2021 in this space.',
    '© 2021 Real Skin Care. All rights reserved.',
    'Back in 2020 the category barely existed.',
    'The 2020 recall affected several brands.',
  ];
  for (const text of cases) {
    assert.deepEqual(findStaleYears(text, CUR), [], `should not flag: ${text}`);
  }
});

test('pre-2020, current, and future years are never flagged', () => {
  assert.deepEqual(findStaleYears('A 2008 study and a 2019 review.', CUR), []); // both < 2020
  assert.deepEqual(findStaleYears('Updated for 2026 and ready for 2030.', CUR), []);
});

// ── Stale CURRENT-YEAR framing must still be caught ──
test('title/theme current-year framing IS flagged', () => {
  const r1 = findStaleYears('Best Natural Deodorant 2024: Top Picks', CUR);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].year, 2024);

  const r2 = findStaleYears('This guide was updated for 2023 with new picks.', CUR);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].year, 2023);

  const r3 = findStaleYears('As of 2022, the lineup includes three scents.', CUR);
  assert.equal(r3.length, 1);
  assert.equal(r3[0].year, 2022);
});

test('mixed: flags the stale title year, spares the historical citation', () => {
  const text = 'Best SLS-Free Toothpaste 2024. The market has grown since 2020, per a 2021 study.';
  const out = findStaleYears(text, CUR);
  assert.deepEqual(out.map((s) => s.year), [2024]);
});

test('isHistoricalYearReference: direct checks', () => {
  const t = 'expanded since 2020';
  const idx = t.indexOf('2020');
  assert.equal(isHistoricalYearReference(t, idx), true);

  const t2 = 'Deodorant 2024';
  assert.equal(isHistoricalYearReference(t2, t2.indexOf('2024')), false);
});

test('snippet is captured for reporting', () => {
  const out = findStaleYears('The Best Lotion 2024 Edition is here.', CUR);
  assert.equal(out.length, 1);
  assert.match(out[0].snippet, /2024/);
});

// ── Academic / source citations must be preserved (not flagged, not bumped) ──
import { bumpStaleYears } from '../../lib/year-accuracy.js';

test('parenthesized citations are not flagged as stale', () => {
  const cases = [
    'Coconut oil reduces protein loss (Rele & Mohile, 2021).',
    'A landmark result, Smith et al. (2021), confirmed this.',
    'Per Dayrit, F.M. (2021), lauric acid dominates.',
    'Published in Nutrients (2021).',
    'The mechanism is well documented (Robbins, 2021).',
  ];
  for (const text of cases) {
    assert.deepEqual(findStaleYears(text, CUR), [], `should not flag: ${text}`);
  }
});

test('bumpStaleYears: preserves citations and historical refs', () => {
  assert.equal(bumpStaleYears('Smith et al. (2021)', CUR).text, 'Smith et al. (2021)');
  assert.equal(bumpStaleYears('Dayrit, F.M. (2021)', CUR).text, 'Dayrit, F.M. (2021)');
  assert.equal(bumpStaleYears('Nutrients (2021)', CUR).text, 'Nutrients (2021)');
  assert.equal(bumpStaleYears('the market has grown since 2021', CUR).text, 'the market has grown since 2021');
  assert.equal(bumpStaleYears('founded in 2021', CUR).text, 'founded in 2021');
});

test('bumpStaleYears: bumps edition-marker text', () => {
  assert.equal(bumpStaleYears('Best Lotions 2024', CUR).text, 'Best Lotions 2026');
  assert.equal(bumpStaleYears('updated for 2023', CUR).text, 'updated for 2026');
  assert.equal(bumpStaleYears('guide (2024)', CUR).text, 'guide (2026)'); // lowercase noun → not a citation
});

test('bumpStaleYears: leaves current/future/pre-2020 alone', () => {
  assert.equal(bumpStaleYears('ready for 2026 and 2030, since 2008', CUR).changed, false);
});
