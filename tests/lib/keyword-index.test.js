// tests/lib/keyword-index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Cluster assignment ───────────────────────────────────────────────────────

const KNOWN_CATEGORIES = ['soap', 'toothpaste', 'lotion', 'deodorant', 'lip balm', 'lip-balm', 'coconut oil', 'coconut-oil', 'shampoo', 'conditioner', 'sunscreen'];

function assignCluster(keyword, topicalMapClusters) {
  const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const cluster of topicalMapClusters) {
    for (const article of cluster.articles || []) {
      if (article.url && article.url.includes(slug)) return cluster.tag;
    }
  }
  const kw = keyword.toLowerCase();
  for (const cat of KNOWN_CATEGORIES) {
    if (kw.includes(cat.replace('-', ' ')) || kw.includes(cat)) return cat.replace('-', ' ');
  }
  return 'unclustered';
}

test('assignCluster: matches known category', () => {
  assert.equal(assignCluster('best natural bar soap for men', []), 'soap');
});

test('assignCluster: matches topical map article URL', () => {
  const clusters = [{ tag: 'mof', articles: [{ url: 'https://example.com/blogs/news/coconut-oil-guide' }] }];
  assert.equal(assignCluster('coconut oil guide', clusters), 'mof');
});

test('assignCluster: falls back to unclustered', () => {
  assert.equal(assignCluster('random topic nobody covers', []), 'unclustered');
});

test('assignCluster: handles multi-word categories', () => {
  assert.equal(assignCluster('organic coconut oil for skin', []), 'coconut oil');
  assert.equal(assignCluster('best lip balm recipe', []), 'lip balm');
});

// ── Niche word extraction ────────────────────────────────────────────────────

function extractNicheWords(keyword, clusterKeywords) {
  const words = new Set(keyword.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordCounts = {};
  for (const ck of clusterKeywords) {
    const ckWords = new Set(ck.toLowerCase().split(/\s+/));
    for (const w of words) {
      if (ckWords.has(w)) wordCounts[w] = (wordCounts[w] || 0) + 1;
    }
  }
  const threshold = Math.max(1, clusterKeywords.length * 0.5);
  return [...words].filter(w => (wordCounts[w] || 0) < threshold);
}

test('extractNicheWords: finds words unique to keyword not common in cluster', () => {
  const result = extractNicheWords('best soap for tattoos', ['natural bar soap', 'best natural soap', 'castile soap']);
  assert.ok(result.includes('tattoos'));
  assert.ok(!result.includes('soap'));
});

// ── Gap analysis ─────────────────────────────────────────────────────────────

function analyzeGaps(keywordSlug, index) {
  const kw = index.keywords[keywordSlug];
  const clusterName = kw?.cluster || 'unclustered';
  const cluster = index.clusters[clusterName];
  if (!cluster) return { sufficient: false, needs_upload: true, has_cluster_data: false, missing: ['No cluster data available'] };

  const nicheWords = extractNicheWords(kw?.keyword || keywordSlug.replace(/-/g, ' '), cluster.keywords.map(k => (index.keywords[k]?.keyword || k).replace(/-/g, ' ')));
  const nicheTermCount = cluster.all_matching_terms.filter(t => nicheWords.some(nw => t.keyword.toLowerCase().includes(nw))).length;
  const hasOwnAhrefs = kw?.sources?.includes('ahrefs') || false;

  const sufficient = hasOwnAhrefs
    || (cluster.all_matching_terms.length >= 50 && cluster.common_competitors.length >= 5 && nicheTermCount >= 10);

  const missing = [];
  if (nicheTermCount < 10 && nicheWords.length > 0) missing.push(nicheWords.join('/') + '-specific matching terms');
  if (!hasOwnAhrefs && cluster.common_competitors.length < 5) missing.push('SERP competitor data');

  return {
    has_cluster_data: cluster.all_matching_terms.length > 0,
    cluster_terms: cluster.all_matching_terms.length,
    niche_terms: nicheTermCount,
    niche_words: nicheWords,
    cluster_serp: cluster.common_competitors.length > 0,
    has_own_ahrefs: hasOwnAhrefs,
    sufficient,
    needs_upload: !sufficient,
    missing,
  };
}

test('analyzeGaps: sufficient when own Ahrefs data exists', () => {
  const index = {
    keywords: { 'natural-bar-soap': { keyword: 'natural bar soap', cluster: 'soap', sources: ['ahrefs'] } },
    clusters: { soap: { keywords: ['natural-bar-soap'], all_matching_terms: [], common_competitors: [] } },
  };
  const result = analyzeGaps('natural-bar-soap', index);
  assert.equal(result.sufficient, true);
  assert.equal(result.needs_upload, false);
});

test('analyzeGaps: needs upload when cluster data lacks niche coverage', () => {
  const index = {
    keywords: {
      'natural-bar-soap': { keyword: 'natural bar soap', cluster: 'soap', sources: ['ahrefs'] },
      'best-bar-soap': { keyword: 'best bar soap', cluster: 'soap', sources: ['ahrefs'] },
      'castile-soap': { keyword: 'castile soap bars', cluster: 'soap', sources: ['ahrefs'] },
      'best-soap-for-tattoos': { keyword: 'best soap for tattoos', cluster: 'soap', sources: [] },
    },
    clusters: {
      soap: {
        keywords: ['natural-bar-soap', 'best-bar-soap', 'castile-soap', 'best-soap-for-tattoos'],
        all_matching_terms: Array(60).fill({ keyword: 'organic soap bar', volume: 100 }),
        common_competitors: Array(6).fill({ domain: 'example.com', appearances: 2 }),
      },
    },
  };
  const result = analyzeGaps('best-soap-for-tattoos', index);
  assert.equal(result.has_cluster_data, true);
  assert.equal(result.sufficient, false);
  assert.ok(result.missing.some(m => m.includes('tattoo')));
});

test('analyzeGaps: sufficient when cluster has niche terms', () => {
  const tattooTerms = Array(15).fill({ keyword: 'soap for tattoos aftercare', volume: 200 });
  const genericTerms = Array(50).fill({ keyword: 'organic bar soap', volume: 100 });
  const index = {
    keywords: {
      'natural-bar-soap': { keyword: 'natural bar soap', cluster: 'soap', sources: ['ahrefs'] },
      'best-bar-soap': { keyword: 'best bar soap', cluster: 'soap', sources: ['ahrefs'] },
      'castile-soap': { keyword: 'castile soap bars', cluster: 'soap', sources: ['ahrefs'] },
      'best-soap-for-tattoos': { keyword: 'best soap for tattoos', cluster: 'soap', sources: [] },
    },
    clusters: {
      soap: {
        keywords: ['natural-bar-soap', 'best-bar-soap', 'castile-soap', 'best-soap-for-tattoos'],
        all_matching_terms: [...genericTerms, ...tattooTerms],
        common_competitors: Array(6).fill({ domain: 'example.com', appearances: 2 }),
      },
    },
  };
  const result = analyzeGaps('best-soap-for-tattoos', index);
  assert.equal(result.sufficient, true);
  assert.equal(result.niche_terms, 15);
});
