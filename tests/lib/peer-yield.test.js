import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  positionBand, peerCtrByBand, judgeYield, MIN_EXPECTED_CLICKS, UNDER_YIELD_RATIO,
} from '../../lib/peer-yield.js';

// Site blog CTR by band, measured on production 2026-09-21 (90d, 300 pages).
const BANDS = { '1-3': 0.0109, '4-6': 0.0077, '7-10': 0.0046, '11-20': 0.0036, '21-40': 0.0022, '41+': 0.0012 };

describe('positionBand / peerCtrByBand', () => {
  test('bands', () => {
    assert.equal(positionBand(1), '1-3');
    assert.equal(positionBand(7.9), '7-10');
    assert.equal(positionBand(38.5), '21-40');
    assert.equal(positionBand(null), null);
  });

  test('peer CTR is clicks over impressions per band, and an empty band is ABSENT', () => {
    const ctr = peerCtrByBand([
      { clicks: 10, impressions: 1000, position: 8 },
      { clicks: 0, impressions: 1000, position: 9 },
      { clicks: 5, impressions: 0, position: 2 },
    ]);
    assert.deepEqual(ctr, { '7-10': 0.005 });
  });
});

describe('judgeYield — the replacement for traffic_potential projections', () => {
  test('the case that forced this: a healthy page is no longer "0% of 144,000"', () => {
    // best-aluminum-free-deodorant: 5 clicks on 920 impressions at pos 11 read as
    // "0% of projected 144,000". Against peers it is judged on its own demand.
    const r = judgeYield({ clicks: 5, impressions: 920, position: 11.0 }, BANDS, { days: 90, judgeLowDemand: true });
    assert.notEqual(r.verdict, 'REFRESH');
    assert.ok(r.why.includes('expected'));
  });

  test('a real under-performer is flagged: ranks page 1 on real demand, earns almost nothing', () => {
    // how-to-make-a-natural-moisturizer: 1 click on 7,321 impressions at pos 7.9.
    const r = judgeYield({ clicks: 1, impressions: 7321, position: 7.9 }, BANDS, { days: 90 });
    assert.equal(r.verdict, 'REFRESH');
    assert.ok(r.ratio < UNDER_YIELD_RATIO);
  });

  test('too little expected to judge is UNJUDGED, never a flag', () => {
    // 0 clicks expected 1.4 happens ~25% of the time by chance.
    const r = judgeYield({ clicks: 0, impressions: 305, position: 8.6 }, BANDS, { days: 90 });
    assert.equal(r.verdict, 'UNJUDGED');
    assert.ok(r.expected < MIN_EXPECTED_CLICKS);
  });

  test('LOW_DEMAND needs both few impressions AND at most one click, and only when asked', () => {
    assert.equal(judgeYield({ clicks: 0, impressions: 128, position: 10.7 }, BANDS, { days: 90, judgeLowDemand: true }).verdict, 'LOW_DEMAND');
    assert.notEqual(judgeYield({ clicks: 3, impressions: 128, position: 10.7 }, BANDS, { days: 90, judgeLowDemand: true }).verdict, 'LOW_DEMAND');
    assert.notEqual(judgeYield({ clicks: 0, impressions: 128, position: 10.7 }, BANDS, { days: 90 }).verdict, 'LOW_DEMAND');
  });

  test('the low-demand floor is pro-rated to the window', () => {
    // 60 days → 133 impressions floor.
    assert.equal(judgeYield({ clicks: 0, impressions: 140, position: 10 }, BANDS, { days: 60, judgeLowDemand: true }).verdict === 'LOW_DEMAND', false);
    assert.equal(judgeYield({ clicks: 0, impressions: 120, position: 10 }, BANDS, { days: 60, judgeLowDemand: true }).verdict, 'LOW_DEMAND');
  });

  test('no peer data for the band → UNJUDGED', () => {
    assert.equal(judgeYield({ clicks: 0, impressions: 5000, position: 5 }, { '7-10': 0.004 }, { days: 90 }).verdict, 'UNJUDGED');
  });
});
