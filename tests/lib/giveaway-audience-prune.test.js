// tests/lib/giveaway-audience-prune.test.js
//
// Suppressing the unengaged remainder of the entrant list takes them off Klaviyo
// billing. Unlike the §5 bot cohort, THESE ARE REAL PEOPLE who legitimately
// entered. Suppression is invisible — nobody notices they stopped receiving email
// — so every protection here is arithmetic and every failure is a refusal.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planPrune } from '../../lib/giveaway/audience-prune.js';

const base = {
  listEmails: ['eng@x.com', 'cold1@x.com', 'cold2@x.com', 'buyer@x.com', 'winner@x.com'],
  engagedEmails: ['eng@x.com'],
  purchaserEmails: ['buyer@x.com'],
  protectedEmails: ['winner@x.com'],
  suppressedEmails: [],
  engagedFloor: 1,
};

test('suppresses only the cold, unprotected, non-buying remainder', () => {
  const p = planPrune(base);
  assert.deepEqual(p.toSuppress.sort(), ['cold1@x.com', 'cold2@x.com']);
});

test('NEVER suppresses an engaged profile', () => {
  assert.ok(!planPrune(base).toSuppress.includes('eng@x.com'));
});

test('NEVER suppresses someone who has ever placed an order', () => {
  // A past customer is the one profile where being wrong actually costs revenue,
  // and the cost of keeping them is one profile on the bill.
  const p = planPrune(base);
  assert.ok(!p.toSuppress.includes('buyer@x.com'));
  assert.equal(p.kept.purchasers, 1);
});

test('NEVER suppresses the winner or an alternate', () => {
  const p = planPrune(base);
  assert.ok(!p.toSuppress.includes('winner@x.com'));
  assert.equal(p.kept.protected, 1);
});

test('an already-suppressed profile is skipped, not re-suppressed', () => {
  const p = planPrune({ ...base, suppressedEmails: ['cold1@x.com'] });
  assert.deepEqual(p.toSuppress, ['cold2@x.com']);
  assert.equal(p.alreadySuppressed, 1);
});

test('REFUSES when the engaged set is below the floor', () => {
  // The failure this stops: a segment that silently stopped matching (or had not
  // yet materialised) makes almost the whole list look cold, and the prune then
  // suppresses nearly every real entrant.
  assert.throws(() => planPrune({ ...base, engagedEmails: [], engagedFloor: 1 }), /engaged/i);
  assert.throws(() => planPrune({ ...base, engagedFloor: 500 }), /floor/i);
});

test('REFUSES when the prune would take an implausible share of the list', () => {
  // Belt and braces behind the floor: if the engaged set is populated but the
  // arithmetic still condemns almost everyone, something upstream is wrong.
  const listEmails = Array.from({ length: 100 }, (_, i) => `c${i}@x.com`);
  assert.throws(
    () => planPrune({
      listEmails, engagedEmails: ['c0@x.com'], purchaserEmails: [], protectedEmails: [],
      suppressedEmails: [], engagedFloor: 1, maxShare: 0.8,
    }),
    /share/i,
  );
});

test('comparison is case-insensitive on every input', () => {
  const p = planPrune({
    ...base,
    listEmails: ['ENG@X.com', 'Cold1@X.com', 'BUYER@x.com', 'Winner@x.com'],
  });
  assert.deepEqual(p.toSuppress, ['cold1@x.com']);
});

test('an empty prune is reported, not thrown — a second run is a clean no-op', () => {
  const p = planPrune({ ...base, suppressedEmails: ['cold1@x.com', 'cold2@x.com'] });
  assert.deepEqual(p.toSuppress, []);
  assert.equal(p.alreadySuppressed, 2);
});
