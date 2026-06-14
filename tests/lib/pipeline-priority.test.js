import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { scoreBase } from '../../lib/pipeline-priority.js';

const CFG = {
  base: { intentMult: { transactional: 1.4, commercial: 1.2, informational: 1.0 },
          volumeDivisor: 100, volumeCap: 50, kdEasyThreshold: 5, kdEasyBonus: 10,
          impressionsDivisor: 50 },
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

test('scoreBase: falls back to GSC impressions as a demand proxy when volume is absent', () => {
  // An injected unmapped-query idea has no search volume but real GSC demand.
  // impressions 500 / 50 = 10; commercial 1.2 = 12 (was 0 before the fallback).
  assert.equal(scoreBase({ impressions: 500, search_intent: 'commercial' }, CFG), 12);
});

test('scoreBase: real volume takes precedence over impressions when both present', () => {
  // volume 2000 -> 20 * 1.2 = 24; impressions ignored.
  assert.equal(scoreBase({ volume: 2000, impressions: 999999, search_intent: 'commercial', kd: 40 }, CFG), 24);
});

test('scoreBase: impressions fallback respects the volume cap', () => {
  assert.equal(scoreBase({ impressions: 999999, search_intent: 'informational' }, CFG), 50);
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

import { clusterSpacingOk, refreshCooldownOk } from '../../lib/pipeline-priority.js';

const GCFG = { ...HCFG, clusterSpacingDays: 14, clusterSpacingMax: 2, refreshCooldownDays: 45 };

test('clusterSpacingOk: under the cap within the window → ok', () => {
  const recent = { toothpaste: ['2026-06-10', '2026-06-02'] }; // 2 in last 14d? 06-02 is 13 days before 06-15
  // window from 2026-06-15 back 14 days = >= 2026-06-01; both count = 2 >= max → NOT ok
  assert.equal(clusterSpacingOk('toothpaste', recent, '2026-06-15', GCFG), false);
});

test('clusterSpacingOk: old posts outside window do not count', () => {
  const recent = { toothpaste: ['2026-05-01', '2026-05-10'] }; // both > 14 days ago
  assert.equal(clusterSpacingOk('toothpaste', recent, '2026-06-15', GCFG), true);
});

test('clusterSpacingOk: unknown cluster is always ok', () => {
  assert.equal(clusterSpacingOk('newcluster', {}, '2026-06-15', GCFG), true);
});

test('refreshCooldownOk: refreshed within cooldown → not ok', () => {
  const last = { 'natural-deodorant-for-men': '2026-06-01' }; // 14 days ago < 45
  assert.equal(refreshCooldownOk('natural-deodorant-for-men', last, '2026-06-15', GCFG), false);
});

test('refreshCooldownOk: never refreshed → ok', () => {
  assert.equal(refreshCooldownOk('brand-new-post', {}, '2026-06-15', GCFG), true);
});

import { computePlan } from '../../lib/pipeline-priority.js';

const FULL = {
  ...GCFG,
  base: CFG.base,
  buffer: { target: 2, days: 7 },
  maxPromotionsPerRun: 1,
  backlogLowWater: 5,
};
const NOW2 = new Date('2026-06-15T12:00:00-07:00'); // Monday
const TODAY2 = '2026-06-15';

function baseInputs(over = {}) {
  return {
    backlog: [
      { slug: 'a-post', keyword: 'a post', cluster: 'toothpaste', volume: 1000, kd: 2, search_intent: 'commercial', task_type: 'new', source: 'gap_report', status_override: null },
      { slug: 'b-post', keyword: 'b post', cluster: 'deodorant', volume: 500, kd: 10, search_intent: 'informational', task_type: 'new', source: 'gap_report', status_override: null },
    ],
    signals: [],
    bufferReady: 0,
    takenSlots: new Set(),
    clusterRecent: {},
    refreshRecent: {},
    coveredIndex: new Set(['a-post', 'b-post']),
    rejections: [],
    today: TODAY2,
    now: NOW2,
    cfg: FULL,
    ...over,
  };
}

test('computePlan: scores backlog with base + matching signal, provenance attached', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'revenue_cluster', key: 'toothpaste', cluster: 'toothpaste', taskType: 'new', strength: 111.8, label: 'revenue +$112' }],
  }));
  const a = plan.scored.find((i) => i.slug === 'a-post');
  // base: 1000/100=10 *1.2 +10 kd =22 ; +revenue 22 => 44
  assert.equal(a.priority_score, 44);
  assert.match(a.priority_provenance, /revenue/);
});

test('computePlan: fills buffer up to target but capped by maxPromotionsPerRun', () => {
  const plan = computePlan(baseInputs({ bufferReady: 0 })); // target 2, cap 1
  assert.equal(plan.promotions.length, 1);                  // only 1 this run
  assert.ok(plan.promotions[0].publish_date);
});

test('computePlan: no promotion when buffer already full', () => {
  const plan = computePlan(baseInputs({ bufferReady: 2 }));
  assert.equal(plan.promotions.length, 0);
});

test('computePlan: highest score promoted first', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'rank_drop', key: 'b post', cluster: 'deodorant', taskType: 'new', strength: 10, label: 'drop' }],
  }));
  assert.equal(plan.promotions[0].slug, 'b-post'); // boosted above a-post
});

test('computePlan: paused item is never promoted', () => {
  const inputs = baseInputs();
  inputs.backlog[0].status_override = 'paused';
  inputs.backlog[1].status_override = 'paused';
  const plan = computePlan(inputs);
  assert.equal(plan.promotions.length, 0);
});

test('computePlan: rush item is promoted ahead of higher-scored ones', () => {
  const inputs = baseInputs();
  inputs.backlog[1].status_override = 'rush'; // b-post (lower base) pinned
  const plan = computePlan(inputs);
  assert.equal(plan.promotions[0].slug, 'b-post');
});

test('computePlan: injects a new idea from an unmapped signal not yet covered', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'unmapped', key: 'coconut oil for stretch marks', taskType: 'new', cluster: null, strength: 5000, label: 'unmapped 5000' }],
    coveredIndex: new Set(['a-post', 'b-post']),
  }));
  const inj = plan.injections.find((i) => i.keyword === 'coconut oil for stretch marks');
  assert.ok(inj);
  assert.equal(inj.publish_date, null);          // backlog: no date until promoted
  assert.equal(inj.source, 'gsc_unmapped');
});

test('computePlan: does NOT inject an unmapped idea already covered', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'unmapped', key: 'a post', taskType: 'new', cluster: null, strength: 5000, label: 'u' }],
  }));
  assert.equal(plan.injections.length, 0);
});

test('computePlan: cluster spacing blocks promotion (defers, not drops)', () => {
  const plan = computePlan(baseInputs({
    bufferReady: 0,
    clusterRecent: { toothpaste: ['2026-06-12', '2026-06-05'] }, // 2 in window → a-post blocked
  }));
  // a-post (toothpaste) blocked → b-post promoted instead
  assert.equal(plan.promotions[0].slug, 'b-post');
});

test('computePlan: refresh cooldown blocks a refresh-type promotion', () => {
  const inputs = baseInputs({
    backlog: [{ slug: 'old-post', keyword: 'old post', cluster: 'soap', volume: 3000, kd: 1, search_intent: 'commercial', task_type: 'refresh', source: 'refresh', status_override: null }],
    refreshRecent: { 'old-post': '2026-06-01' }, // 14d ago < 45
    coveredIndex: new Set(['old-post']),
  });
  const plan = computePlan(inputs);
  assert.equal(plan.promotions.length, 0);
});

test('computePlan: backlog below low-water emits an alert', () => {
  const plan = computePlan(baseInputs()); // 2 ideas < lowWater 5
  assert.ok(plan.alerts.some((a) => /backlog/i.test(a)));
});

test('computePlan: never assigns two promotions to the same slot', () => {
  // force 2 promotions by raising the per-run cap
  const cfg = { ...FULL, maxPromotionsPerRun: 2 };
  const plan = computePlan(baseInputs({ cfg, bufferReady: 0 }));
  const dates = plan.promotions.map((p) => p.publish_date.slice(0, 10));
  assert.equal(new Set(dates).size, dates.length);
});

test('computePlan: scored items carry a structured contributing[] of matched signals', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'revenue_cluster', key: 'toothpaste', cluster: 'toothpaste', taskType: 'new', strength: 111.8, label: 'revenue +$112' }],
  }));
  const a = plan.scored.find((i) => i.slug === 'a-post');
  assert.ok(Array.isArray(a.contributing));
  assert.equal(a.contributing.length, 1);
  assert.equal(a.contributing[0].type, 'revenue_cluster');
  assert.equal(a.contributing[0].score, 22);
  assert.equal(a.contributing[0].strength, 111.8);
});

test('computePlan: an idea with no matching signal has empty contributing[]', () => {
  const plan = computePlan(baseInputs()); // no signals
  const a = plan.scored.find((i) => i.slug === 'a-post');
  assert.deepEqual(a.contributing, []);
});

test('computePlan: injected idea carries contributing[] of its injecting signal', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'unmapped', key: 'coconut oil for stretch marks', taskType: 'new', cluster: null, strength: 5000, label: 'u' }],
  }));
  const inj = plan.injections.find((i) => i.keyword === 'coconut oil for stretch marks');
  assert.equal(inj.contributing[0].type, 'unmapped');
  assert.equal(inj.contributing[0].score, 40);
});
