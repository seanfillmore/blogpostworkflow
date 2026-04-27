import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichWithMarketData, passesEnrichThreshold } from '../../../lib/keyword-index/dataforseo-enricher.js';

test('passesEnrichThreshold accepts entry with Amazon purchases > 0', () => {
  const entry = { amazon: { purchases: 1 }, gsc: null };
  assert.equal(passesEnrichThreshold(entry), true);
});

test('passesEnrichThreshold accepts entry with GSC impressions > 100', () => {
  const entry = { amazon: null, gsc: { impressions: 200 } };
  assert.equal(passesEnrichThreshold(entry), true);
});

test('passesEnrichThreshold rejects entry below thresholds', () => {
  const entry = { amazon: { purchases: 0 }, gsc: { impressions: 50 } };
  assert.equal(passesEnrichThreshold(entry), false);
});

test('enrichWithMarketData attaches market data for entries that pass threshold', async () => {
  const entries = {
    'natural deodorant for women': { amazon: { purchases: 1 }, gsc: null, market: null, keyword: 'natural deodorant for women' },
    'low signal kw': { amazon: { purchases: 0 }, gsc: { impressions: 30 }, market: null, keyword: 'low signal kw' },
  };
  // Mock dataforseo getSearchVolume — returns the real lib's shape:
  //   { keyword, volume, cpc, competition, competitionLevel, lowBid, highBid, monthlySearches }
  const mockGetSearchVolume = async (keywords) => {
    return keywords.map((k) => ({
      keyword: k, volume: 1100, cpc: 1.4, competition: 0.4, competitionLevel: 'MEDIUM',
    }));
  };
  await enrichWithMarketData({ entries, getSearchVolume: mockGetSearchVolume });
  assert.ok(entries['natural deodorant for women'].market);
  assert.equal(entries['natural deodorant for women'].market.volume, 1100);
  assert.equal(entries['natural deodorant for women'].market.cpc, 1.4);
  // keyword_difficulty + traffic_potential are not in getSearchVolume's response;
  // schema marks them nullable and v1 leaves them null.
  assert.equal(entries['natural deodorant for women'].market.keyword_difficulty, null);
  assert.equal(entries['natural deodorant for women'].market.traffic_potential, null);
  // The below-threshold entry was not enriched
  assert.equal(entries['low signal kw'].market, null);
});

test('enrichWithMarketData silently skips on enricher error', async () => {
  const entries = {
    'kw': { amazon: { purchases: 1 }, gsc: null, market: null, keyword: 'kw' },
  };
  const failingGet = async () => { throw new Error('rate limit'); };
  await enrichWithMarketData({ entries, getSearchVolume: failingGet });
  assert.equal(entries['kw'].market, null);
});
