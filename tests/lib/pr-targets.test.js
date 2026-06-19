import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, classifySource, aggregateCitations, rankTargets } from '../../lib/pr-targets.js';

const brand = { domain: 'realskincare.com', aliases: ['real skin care'] };
const competitors = [
  { name: 'Native', domain: 'nativecos.com' },
  { name: 'Primally Pure', domain: 'primallypure.com' },
];

test('normalizeDomain strips scheme/www/path', () => {
  assert.equal(normalizeDomain('https://www.TheGoodTrade.com/best/x'), 'thegoodtrade.com');
});

test('classifySource buckets correctly', () => {
  const opts = { brandDomain: brand.domain, competitorDomains: competitors.map((c) => c.domain) };
  assert.equal(classifySource('reddit.com', opts), 'engage');
  assert.equal(classifySource('google.com', opts), 'exclude');     // platform
  assert.equal(classifySource('amazon.com', opts), 'exclude');     // retailer
  assert.equal(classifySource('primallypure.com', opts), 'exclude'); // competitor-owned
  assert.equal(classifySource('realskincare.com', opts), 'exclude'); // our own
  assert.equal(classifySource('thegoodtrade.com', opts), 'pitch');   // editorial
});

const snapshots = [{
  results: [
    {
      prompt: 'best natural deodorant',
      responses: {
        perplexity: { mentioned: false, cited: false, citations: ['thegoodtrade.com', 'reddit.com', 'primallypure.com'], competitor_mentions: ['Native', 'Primally Pure'], competitor_citations: ['Primally Pure'] },
        gemini: { mentioned: false, cited: false, citations: ['thegoodtrade.com'], competitor_mentions: ['Native'], competitor_citations: [] },
        chatgpt: { error: 'API 429', citations: [] },
      },
    },
    {
      prompt: 'aluminum free deodorant for women',
      responses: {
        perplexity: { mentioned: false, cited: false, citations: ['thegoodtrade.com', 'health.com'], competitor_mentions: ["Schmidt's"], competitor_citations: [] },
      },
    },
  ],
}];

test('aggregateCitations tallies engines/prompts/competitors, ignores errored engine', () => {
  const agg = aggregateCitations(snapshots);
  const tgt = agg.find((a) => a.domain === 'thegoodtrade.com');
  assert.equal(tgt.engines.size, 2);   // perplexity + gemini (chatgpt errored)
  assert.equal(tgt.prompts.size, 2);
  assert.ok(tgt.competitors.has('Native') && tgt.competitors.has("Schmidt's"));
});

test('rankTargets splits buckets, excludes competitor/platform, ranks by breadth', () => {
  const { pitch, engage, excluded } = rankTargets(snapshots, { brand, competitors });
  const domains = pitch.map((p) => p.domain);
  assert.ok(domains.includes('thegoodtrade.com'));
  assert.ok(domains.includes('health.com'));
  assert.ok(!domains.includes('primallypure.com'), 'competitor-owned excluded');
  assert.ok(!domains.includes('reddit.com'), 'reddit goes to engage, not pitch');
  assert.equal(engage[0]?.domain, 'reddit.com');
  // thegoodtrade (2 engines × 2 prompts = breadth 4) outranks health.com (1×1)
  assert.equal(pitch[0].domain, 'thegoodtrade.com');
  assert.ok(excluded >= 1);
});

test('commercial weighting raises a high-value prompt', () => {
  const base = rankTargets(snapshots, { brand, competitors });
  const weighted = rankTargets(snapshots, { brand, competitors, commercialValueByPrompt: { 'best natural deodorant': 5 } });
  const baseTop = base.pitch.find((p) => p.domain === 'thegoodtrade.com').score;
  const wTop = weighted.pitch.find((p) => p.domain === 'thegoodtrade.com').score;
  assert.ok(wTop > baseTop);
});
