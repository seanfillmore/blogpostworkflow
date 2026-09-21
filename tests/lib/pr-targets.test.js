import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDomain, classifySource, aggregateCitations, rankTargets,
  canonicalizeCitationUrl, pickTopUrl, isGroundingRedirect,
} from '../../lib/pr-targets.js';

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
  assert.equal(classifySource('bit.ly', opts), 'exclude');           // link shortener
  assert.equal(classifySource('swellrewards.com', opts), 'exclude'); // loyalty/rewards
  assert.equal(classifySource('couponwallet.org', opts), 'exclude'); // coupon (pattern)
  assert.equal(classifySource('clientsbee.com', opts), 'exclude');   // directory aggregator
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

test('citation_urls (when present) are collected per domain, most-cited first', () => {
  const withUrls = [{
    results: [{
      prompt: 'best natural deodorant',
      responses: {
        perplexity: {
          mentioned: false, cited: false,
          citations: ['thegoodtrade.com', 'thegoodtrade.com'],
          citation_urls: ['https://www.thegoodtrade.com/features/best-natural-deodorant', 'https://www.thegoodtrade.com/features/best-natural-deodorant'],
          competitor_mentions: ['Native'], competitor_citations: [],
        },
        gemini: {
          mentioned: false, cited: false,
          citations: ['thegoodtrade.com'],
          citation_urls: ['https://www.thegoodtrade.com/features/clean-beauty'],
          competitor_mentions: ['Native'], competitor_citations: [],
        },
      },
    }],
  }];
  const { pitch } = rankTargets(withUrls, { brand, competitors });
  const tgt = pitch.find((p) => p.domain === 'thegoodtrade.com');
  assert.equal(tgt.top_url, 'https://www.thegoodtrade.com/features/best-natural-deodorant'); // cited 2× > 1×
  assert.equal(tgt.urls.length, 2);
});

test('falls back to domain-only snapshots (no citation_urls) without urls', () => {
  const { pitch } = rankTargets(snapshots, { brand, competitors });
  const tgt = pitch.find((p) => p.domain === 'thegoodtrade.com');
  assert.equal(tgt.top_url, null);
  assert.deepEqual(tgt.urls, []);
});

test('commercial weighting raises a high-value prompt', () => {
  const base = rankTargets(snapshots, { brand, competitors });
  const weighted = rankTargets(snapshots, { brand, competitors, commercialValueByPrompt: { 'best natural deodorant': 5 } });
  const baseTop = base.pitch.find((p) => p.domain === 'thegoodtrade.com').score;
  const wTop = weighted.pitch.find((p) => p.domain === 'thegoodtrade.com').score;
  assert.ok(wTop > baseTop);
});

// ── Citation URL quality ─────────────────────────────────────────────────────
// Added 2026-09-20. `pr-target-finder` can only check a target's freshness (and
// only hand a human something to pitch) when the row carries a real ARTICLE
// URL. Two things were stopping that: Gemini cites through an opaque redirector,
// and engines stamp their own referrer params so one article arrives under
// several spellings and its citation count is split across them.

test('canonicalizeCitationUrl strips referrer params, fragment and trailing slash', () => {
  assert.equal(
    canonicalizeCitationUrl('https://www.gq.com/story/best-natural-deodorants?utm_source=openai'),
    'https://www.gq.com/story/best-natural-deodorants');
  assert.equal(
    canonicalizeCitationUrl('https://www.byrdie.com/best-8722607?srsltid=AU7gw0xyz#reviews'),
    'https://www.byrdie.com/best-8722607');
  assert.equal(
    canonicalizeCitationUrl('https://thefiltery.com/best-lotion/'),
    'https://thefiltery.com/best-lotion');
});

test('canonicalizeCitationUrl keeps params that address a different page', () => {
  // A closed list of referrer noise, never a guess at what looks unimportant:
  // merging two real pages is a worse failure than leaving one param on.
  const withVariant = 'https://www.saltandstone.com/products/natural-deodorant?variant=42738010063098';
  assert.equal(canonicalizeCitationUrl(withVariant), withVariant);
  assert.equal(
    canonicalizeCitationUrl('https://example.com/archive?page=3'),
    'https://example.com/archive?page=3');
});

test('canonicalizeCitationUrl returns unparseable input unchanged', () => {
  assert.equal(canonicalizeCitationUrl('thegoodtrade.com'), 'thegoodtrade.com');
  assert.equal(canonicalizeCitationUrl(''), '');
  assert.equal(canonicalizeCitationUrl(null), '');
});

test('referrer params no longer split one article across engines', () => {
  // The same GQ article, cited by three engines under three spellings, must be
  // ONE url counted 3× — not three urls counted once each, which is how a
  // genuinely-dominant article loses the top slot to an arbitrary first match.
  const snaps = [{
    results: [{
      prompt: 'best natural deodorant',
      responses: {
        perplexity: {
          citations: ['gq.com', 'gq.com'],
          citation_urls: [
            'https://www.gq.com/story/best-natural-deodorants',
            'https://www.gq.com/story/a-different-piece',
          ],
          competitor_mentions: ['Native'], competitor_citations: [],
        },
        chatgpt: {
          citations: ['gq.com'],
          citation_urls: ['https://www.gq.com/story/best-natural-deodorants?utm_source=openai'],
          competitor_mentions: ['Native'], competitor_citations: [],
        },
        google_ai_overview: {
          citations: ['gq.com'],
          citation_urls: ['https://www.gq.com/story/best-natural-deodorants?srsltid=AU7gw0abc'],
          competitor_mentions: ['Native'], competitor_citations: [],
        },
      },
    }],
  }];
  const { pitch } = rankTargets(snaps, { brand, competitors });
  const gq = pitch.find((p) => p.domain === 'gq.com');
  assert.equal(gq.urls.length, 2, 'three spellings of one article collapse to one url');
  assert.equal(gq.top_url, 'https://www.gq.com/story/best-natural-deodorants');
});

test('pickTopUrl prefers an article over a more-cited homepage', () => {
  // A homepage is precisely the row whose freshness cannot be read — see the
  // article_date_source guard in agents/pr-target-finder. Picking one because it
  // was cited more often picks the row that cannot be checked.
  const top = pickTopUrl(new Map([
    ['https://example.com', 9],
    ['https://example.com/best-natural-deodorant', 2],
  ]));
  assert.equal(top, 'https://example.com/best-natural-deodorant');
});

test('pickTopUrl falls back to a homepage when there is no article, and to null when empty', () => {
  assert.equal(pickTopUrl(new Map([['https://example.com', 3]])), 'https://example.com');
  assert.equal(pickTopUrl(new Map()), null);
  assert.equal(pickTopUrl(undefined), null);
});

test('pickTopUrl breaks ties deterministically, not by insertion order', () => {
  const a = pickTopUrl(new Map([['https://e.com/zebra', 2], ['https://e.com/ant', 2]]));
  const b = pickTopUrl(new Map([['https://e.com/ant', 2], ['https://e.com/zebra', 2]]));
  assert.equal(a, b);
  assert.equal(a, 'https://e.com/ant', 'shortest, then lexicographic');
});

test('pickTopUrl never returns an unresolved grounding redirect', () => {
  const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQabc';
  assert.equal(pickTopUrl(new Map([[redirect, 50]])), null);
  assert.equal(
    pickTopUrl(new Map([[redirect, 50], ['https://e.com/article', 1]])),
    'https://e.com/article');
});

test('isGroundingRedirect recognises the redirector and nothing else', () => {
  assert.equal(isGroundingRedirect('https://vertexaisearch.cloud.google.com/grounding-api-redirect/xyz'), true);
  assert.equal(isGroundingRedirect('https://vertexaisearch.cloud.google.com/something-else'), false);
  assert.equal(isGroundingRedirect('https://gq.com/story/x'), false);
  assert.equal(isGroundingRedirect(null), false);
});

// A snapshot of real Gemini output: every citation is a redirect, so without
// resolution all of them fold onto one host and the engine contributes nothing.
const geminiSnaps = [{
  results: [{
    prompt: 'best natural deodorant',
    responses: {
      gemini: {
        citations: ['vertexaisearch.cloud.google.com'],
        citation_urls: [
          'https://vertexaisearch.cloud.google.com/grounding-api-redirect/TOKEN_A',
          'https://vertexaisearch.cloud.google.com/grounding-api-redirect/TOKEN_B',
        ],
        competitor_mentions: ['Native'], competitor_citations: [],
      },
      perplexity: {
        citations: ['thegoodtrade.com'],
        citation_urls: ['https://www.thegoodtrade.com/features/best-natural-deodorant'],
        competitor_mentions: ['Native'], competitor_citations: [],
      },
    },
  }],
}];

test('unresolved grounding redirects are excluded, never ranked as a publication', () => {
  // Measured 2026-09-20: unresolved, this host carried citation_count 3,796 and
  // ranked SECOND by score. It is a redirector, not a target.
  const { pitch } = rankTargets(geminiSnaps, { brand, competitors });
  assert.equal(pitch.some((p) => p.domain === 'vertexaisearch.cloud.google.com'), false);
  assert.equal(classifySource('vertexaisearch.cloud.google.com'), 'exclude');
});

test('resolvedUrls turns a Gemini redirect into a real publication and article URL', () => {
  const resolvedUrls = new Map([
    ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/TOKEN_A', 'https://lonekauri.com/blogs/news/natural-deodorant-ingredients'],
    ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/TOKEN_B', 'https://lonekauri.com/blogs/news/natural-deodorant-ingredients'],
  ]);
  const { pitch } = rankTargets(geminiSnaps, { brand, competitors, resolvedUrls });
  const lk = pitch.find((p) => p.domain === 'lonekauri.com');
  assert.ok(lk, 'the publisher behind the redirect is now a target');
  assert.equal(lk.top_url, 'https://lonekauri.com/blogs/news/natural-deodorant-ingredients');
  assert.deepEqual(lk.engines, ['gemini'], 'gemini now counts as an engine for a real domain');
});

test('a PARTIAL resolution degrades: resolved rows gain a URL, the rest behave as before', () => {
  const resolvedUrls = new Map([
    ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/TOKEN_A', 'https://lonekauri.com/blogs/news/x'],
  ]);
  const { pitch } = rankTargets(geminiSnaps, { brand, competitors, resolvedUrls });
  assert.ok(pitch.find((p) => p.domain === 'lonekauri.com'));
  assert.equal(pitch.some((p) => p.domain === 'vertexaisearch.cloud.google.com'), false);
  // The unresolved sibling is simply absent — it never becomes a bad target.
  const tgt = pitch.find((p) => p.domain === 'thegoodtrade.com');
  assert.equal(tgt.top_url, 'https://www.thegoodtrade.com/features/best-natural-deodorant');
});

test('resolvedUrls accepts a plain object and is optional everywhere', () => {
  const asObject = rankTargets(geminiSnaps, {
    brand, competitors,
    resolvedUrls: { 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/TOKEN_A': 'https://lonekauri.com/a' },
  });
  assert.ok(asObject.pitch.find((p) => p.domain === 'lonekauri.com'));
  // Omitted entirely — the pre-existing signature still works.
  assert.doesNotThrow(() => aggregateCitations(geminiSnaps));
});

test('domain-only rows keep working exactly as they do today', () => {
  // The degrade requirement: a snapshot with no citation_urls at all still
  // produces targets, with top_url null and urls empty.
  const { pitch } = rankTargets(snapshots, { brand, competitors, resolvedUrls: new Map() });
  const tgt = pitch.find((p) => p.domain === 'thegoodtrade.com');
  assert.equal(tgt.top_url, null);
  assert.deepEqual(tgt.urls, []);
  assert.equal(tgt.engines.length, 2);
});
