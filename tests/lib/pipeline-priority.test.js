import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { scoreBase } from '../../lib/pipeline-priority.js';

const CFG = {
  base: { intentMult: { transactional: 1.4, commercial: 1.2, informational: 1.0 },
          volumeDivisor: 100, volumeCap: 50, kdEasyThreshold: 5, kdEasyBonus: 10 },
};

test('scoreBase: volume normalized, capped, times intent', () => {
  // volume 2000 -> 20; commercial 1.2 -> 24
  assert.equal(scoreBase({ volume: 2000, search_intent: 'commercial', kd: 40 }, CFG), 24);
});

test('scoreBase: volume cap applies', () => {
  // volume 999999 -> capped 50; informational 1.0 -> 50
  assert.equal(scoreBase({ volume: 999999, search_intent: 'informational', kd: 40 }, CFG), 50);
});

test('scoreBase: low-KD bonus added', () => {
  // volume 1000 -> 10; transactional 1.4 -> 14; +10 kd bonus = 24
  assert.equal(scoreBase({ volume: 1000, search_intent: 'transactional', kd: 2 }, CFG), 24);
});

test('scoreBase: missing fields default safely', () => {
  assert.equal(scoreBase({}, CFG), 0);
});

import { classify } from '../../lib/pipeline-priority.js';

const SCFG = {
  strongThreshold: 30,
  signals: {
    unmapped:        { minImpressions: 500, strongImpressions: 3000, perImpression: 0.01, cap: 40 },
    rank_drop:       { strongPositions: 5, perPosition: 3, cap: 40, trafficStrongPct: 20 },
    revenue_cluster: { minDelta: 25, strongDelta: 100, perDollar: 0.2, cap: 30 },
    competitor_gap:  { boost: 15, cap: 30 },
    ai_gap:          { boost: 12, cap: 24 },
  },
};

test('classify unmapped: score from impressions, strong over cap', () => {
  const r = classify({ type: 'unmapped', strength: 2000, label: 'unmapped 2000 impr' }, SCFG);
  assert.equal(r.score, 20);          // 2000 * 0.01
  assert.equal(r.strong, false);      // < 3000 and < strongThreshold
  assert.match(r.provenance, /\+20/);
});

test('classify unmapped: strong when impressions exceed strongImpressions', () => {
  const r = classify({ type: 'unmapped', strength: 5000 }, SCFG);
  assert.equal(r.score, 40);          // capped
  assert.equal(r.strong, true);
});

test('classify rank_drop: strong at >=5 positions', () => {
  const r = classify({ type: 'rank_drop', strength: 8 }, SCFG);
  assert.equal(r.score, 24);          // 8 * 3
  assert.equal(r.strong, true);       // >= strongPositions
});

test('classify revenue_cluster: scaled by dollars, strong over strongDelta', () => {
  const r = classify({ type: 'revenue_cluster', strength: 111.8 }, SCFG);
  assert.equal(r.score, 22);          // round(111.8 * 0.2)
  assert.equal(r.strong, true);       // >= 100
});

test('classify competitor_gap: fixed boost, never strong on its own', () => {
  const r = classify({ type: 'competitor_gap', strength: 1 }, SCFG);
  assert.equal(r.score, 15);
  assert.equal(r.strong, false);
});

test('classify: score crossing strongThreshold forces strong', () => {
  const r = classify({ type: 'rank_drop', strength: 11 }, SCFG); // 33 >= 30
  assert.equal(r.strong, true);
});

import { applyHysteresis } from '../../lib/pipeline-priority.js';

const HCFG = { ...SCFG, hysteresisRuns: 2 };

test('hysteresis: weak signal first seen today is held back', () => {
  const sig = { type: 'unmapped', key: 'x', strength: 1000 }; // weak (score 10)
  const { active, state } = applyHysteresis([sig], {}, '2026-06-15', HCFG);
  assert.equal(active.length, 0);                 // needs 2 runs
  assert.equal(state['unmapped:x'].runs, 1);
});

test('hysteresis: weak signal persisting a 2nd run becomes active', () => {
  const sig = { type: 'unmapped', key: 'x', strength: 1000 };
  const prior = { 'unmapped:x': { firstSeen: '2026-06-14', lastSeen: '2026-06-14', runs: 1 } };
  const { active } = applyHysteresis([sig], prior, '2026-06-15', HCFG);
  assert.equal(active.length, 1);
});

test('hysteresis: strong signal is active immediately', () => {
  const sig = { type: 'rank_drop', key: 'y', strength: 8 }; // strong
  const { active } = applyHysteresis([sig], {}, '2026-06-15', HCFG);
  assert.equal(active.length, 1);
});

test('hysteresis: a signal absent this run resets (not carried forward)', () => {
  const prior = { 'unmapped:x': { firstSeen: '2026-06-13', lastSeen: '2026-06-14', runs: 5 } };
  const { state } = applyHysteresis([], prior, '2026-06-15', HCFG);
  assert.equal(state['unmapped:x'], undefined); // dropped — must re-accumulate
});
