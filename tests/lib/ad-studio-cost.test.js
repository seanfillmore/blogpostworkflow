import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { USD_PER_RENDER, countTargetKinds, estimateRenders } from '../../lib/ad-studio-cost.js';

const META = [
  { platform: 'meta', ratio: '1:1' },
  { platform: 'meta', ratio: '4:5' },
  { platform: 'meta', ratio: '9:16' },
];
const ALL = [
  ...META,
  { platform: 'demand-gen', ratio: '1.91:1' },
  { platform: 'demand-gen', ratio: '1:1' },
  { platform: 'demand-gen', ratio: '4:5' },
];

test('counts targets by platform', () => {
  assert.deepEqual(countTargetKinds(META), { meta: 3, demandGen: 0 });
  assert.deepEqual(countTargetKinds(ALL), { meta: 3, demandGen: 3 });
});

// THE POINT OF THIS MODULE. A Meta target bills the plate AND the comp derived from
// it — index.js's comp pass calls budget.take(). Three separate documents said a
// default run was 3 renders; it is 6. If this assertion ever "fails" because the
// number changed, check whether the comp still costs a render before touching it.
test('a Meta target bills two renders, a Demand Gen target one', () => {
  const one = estimateRenders({ formats: ['ingredient-callout'], variations: 1, targets: META });
  assert.equal(one.expected, 6);
  assert.equal(one.expectedUsd, 0.78);
});

// Worst case: every plate burns all 3 attempts. A REJECTED plate never gets a comp,
// which is why the comp term stays at m and does not triple with the plates.
test('worst case triples the plates but not the comps', () => {
  const one = estimateRenders({ formats: ['ingredient-callout'], variations: 1, targets: META });
  assert.equal(one.worstCase, 12);          // 3*(3+0) + 3
  assert.equal(one.worstCaseUsd, 1.56);
});

test('demand-gen targets add one render each, with no comp', () => {
  const r = estimateRenders({ formats: ['ingredient-callout'], variations: 1, targets: ALL });
  assert.equal(r.expected, 9);              // 2*3 + 3
  assert.equal(r.worstCase, 21);            // 3*6 + 3
});

// The number the spec quotes for a full sweep. It is in the spec so an operator can
// see what the expensive path costs; it is here so it cannot quietly stop being true.
test('the full sweep matches the figure written into the spec', () => {
  const r = estimateRenders({
    formats: ['us-vs-them', 'ingredient-callout', 'manifesto', 'problem-aware', 'top-x-review',
              'offer-focused', 'testimonial', 'stat-stack', 'state-contrast'],
    variations: 3,
    targets: ALL,
  });
  assert.equal(r.expected, 243);
  assert.equal(r.expectedUsd, 31.59);
  assert.equal(r.worstCase, 567);
  assert.equal(r.worstCaseUsd, 73.71);
});

test('an empty format selection costs nothing', () => {
  const r = estimateRenders({ formats: [], variations: 1, targets: META });
  assert.equal(r.expected, 0);
  assert.equal(r.expectedUsd, 0);
});

// A real float-noise case, not a tautology. 30 × 0.13 is 3.9000000000000004 in IEEE 754,
// so multiplying without rounding puts thirteen decimal places into a dollar figure the
// browser then renders. The first assertion proves the noise is genuinely there, which is
// what the previous version of this test lacked: it compared the function's own output to
// its own output rounded, and passed with no rounding at all.
test('money is rounded to cents, never left as float noise', () => {
  const raw = 30 * USD_PER_RENDER;
  assert.notEqual(raw, 3.9, 'sanity: this case really does carry float noise');

  const r = estimateRenders({ formats: ['a', 'b', 'c', 'd', 'e'], variations: 1, targets: META });
  assert.equal(r.expected, 30);
  assert.equal(r.expectedUsd, 3.9);
});

test('the per-render price is exported for callers that show it', () => {
  assert.equal(USD_PER_RENDER, 0.13);
});
