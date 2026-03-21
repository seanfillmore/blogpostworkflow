// tests/agents/meta-ads-analyzer.test.js
import { strict as assert } from 'node:assert';
import {
  computeLongevityDays,
  computeEffectivenessScore,
  meetsFilter,
  buildPass1Prompt,
  buildPass2Prompt,
  parsePass1Response,
  parsePass2Response,
} from '../../agents/meta-ads-analyzer/index.js';

// computeLongevityDays — still running ad
{
  const ad = { ad_delivery_start_time: '2026-02-19', ad_delivery_stop_time: null };
  const days = computeLongevityDays(ad, '2026-03-21');
  assert.equal(days, 30, 'should be 30 days running');
}

// computeLongevityDays — stopped ad returns 0
{
  const ad = { ad_delivery_start_time: '2026-02-01', ad_delivery_stop_time: '2026-03-01' };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 0, 'stopped ad = 0 longevity');
}

// computeLongevityDays — cap at 60
{
  const ad = { ad_delivery_start_time: '2025-01-01', ad_delivery_stop_time: null };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 60, 'capped at 60');
}

// computeLongevityDays — cap at 60 (ad running for 90 days)
{
  const ad = { ad_delivery_start_time: '2025-12-21', ad_delivery_stop_time: null };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 60, 'must cap at 60 days');
}

// computeLongevityDays — null start_time
{
  const ad = { ad_delivery_start_time: null, ad_delivery_stop_time: null };
  assert.equal(computeLongevityDays(ad, '2026-03-21'), 0);
}

// computeEffectivenessScore
assert.equal(computeEffectivenessScore(30, 4), 38, '30 + (4 × 2) = 38');
assert.equal(computeEffectivenessScore(0, 5), 10, '0 + (5 × 2) = 10');
assert.equal(computeEffectivenessScore(60, 0), 60, 'longevity only');

// meetsFilter
assert.equal(meetsFilter(20, 1, 14, 3), true, 'longevity threshold met');
assert.equal(meetsFilter(5, 4, 14, 3), true, 'variation threshold met');
assert.equal(meetsFilter(10, 2, 14, 3), false, 'neither threshold met');
assert.equal(meetsFilter(14, 3, 14, 3), true, 'exactly at both thresholds');

// buildPass1Prompt — contains required fields
{
  const prompt = buildPass1Prompt('123', 'Dove', [
    { id: 'a1', body: 'natural deodorant', title: 'Shop now', description: 'Free of aluminum' },
  ]);
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.includes('Dove'), 'must include brand name');
  assert.ok(prompt.includes('natural deodorant'), 'must include ad body');
  assert.ok(prompt.includes('themes'), 'must instruct to return themes');
}

// buildPass2Prompt — contains required fields
{
  const ad = {
    pageName: 'Dove',
    adCreativeBody: 'Stay fresh naturally',
    adCreativeLinkTitle: 'Shop Now',
    adCreativeLinkDescription: 'Aluminum-free',
    longevityDays: 30,
    variationCount: 4,
    publisherPlatforms: ['instagram', 'facebook'],
  };
  const prompt = buildPass2Prompt(ad);
  assert.ok(prompt.includes('Dove'));
  assert.ok(prompt.includes('30'));
  assert.ok(prompt.includes('instagram'));
  assert.ok(prompt.includes('headline'), 'must instruct to return headline');
  assert.ok(prompt.includes('messagingAngle'), 'must instruct to return messagingAngle');
}

// parsePass1Response — valid JSON
{
  const raw = JSON.stringify({ themes: [{ theme: 'deodorant', adIds: ['a1', 'a2'] }] });
  const result = parsePass1Response(raw);
  assert.deepEqual(result.themes[0].adIds, ['a1', 'a2']);
}

// parsePass1Response — strips markdown fences
{
  const raw = '```json\n{"themes":[{"theme":"soap","adIds":["b1"]}]}\n```';
  const result = parsePass1Response(raw);
  assert.equal(result.themes[0].theme, 'soap');
}

// parsePass2Response — valid JSON
{
  const raw = JSON.stringify({
    headline: 'Why this works', messagingAngle: 'Social proof',
    whyEffective: 'Because...', targetAudience: 'Women 25-45',
    keyTechniques: ['urgency'], copyInsights: 'Strong CTA',
  });
  const result = parsePass2Response(raw);
  assert.equal(result.headline, 'Why this works');
}

console.log('✓ meta-ads-analyzer unit tests pass');
