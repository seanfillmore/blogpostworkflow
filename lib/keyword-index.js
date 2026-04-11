#!/usr/bin/env node
/**
 * Shared Keyword Intelligence Index
 *
 * Aggregates all Ahrefs uploads, briefs, topical map, and GSC data into
 * a unified index. Any agent can import loadKeywordIndex() to get
 * cluster-wide keyword intelligence.
 *
 * Usage:
 *   import { loadKeywordIndex, analyzeGaps } from '../lib/keyword-index.js';
 *   const index = loadKeywordIndex();
 *
 * CLI:
 *   node lib/keyword-index.js --rebuild
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseCSV, parseSerpCsv, parseKeywordsCsv } from './csv-parsers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const INDEX_PATH = join(ROOT, 'data', 'keyword-index.json');
const AHREFS_DIR = join(ROOT, 'data', 'ahrefs');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');
const GSC_DIR = join(ROOT, 'data', 'snapshots', 'gsc');
const TOPICAL_MAP_PATH = join(ROOT, 'data', 'topical-map.json');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let memoryCache = null;
let memoryCacheTime = 0;

// ── Known categories for cluster assignment ──────────────────────────────────

const KNOWN_CATEGORIES = [
  'soap', 'toothpaste', 'lotion', 'deodorant', 'lip balm', 'lip-balm',
  'coconut oil', 'coconut-oil', 'shampoo', 'conditioner', 'sunscreen',
];

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSlug(keyword) {
  return keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function safeReadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadCSV(path) {
  try {
    return parseCSV(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

function latestFile(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

// ── Competitor aggregation ───────────────────────────────────────────────────

function buildCommonCompetitors(clusterKeywordEntries) {
  const domainStats = {};
  for (const entry of clusterKeywordEntries) {
    for (const s of (entry.serp || [])) {
      if (!s.url) continue;
      try {
        const domain = new URL(s.url).hostname.replace(/^www\./, '');
        if (!domainStats[domain]) domainStats[domain] = { appearances: 0, positions: [] };
        domainStats[domain].appearances++;
        if (s.position) domainStats[domain].positions.push(s.position);
      } catch { /* skip malformed URLs */ }
    }
  }
  return Object.entries(domainStats)
    .map(([domain, stats]) => ({
      domain,
      appearances: stats.appearances,
      avg_position: stats.positions.length
        ? Math.round(stats.positions.reduce((a, b) => a + b, 0) / stats.positions.length * 10) / 10
        : null,
    }))
    .sort((a, b) => b.appearances - a.appearances)
    .slice(0, 20);
}

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

// ── Gap analysis ─────────────────────────────────────────────────────────────

export function analyzeGaps(keywordSlug, index) {
  const kw = index.keywords[keywordSlug];
  const clusterName = kw?.cluster || 'unclustered';
  const cluster = index.clusters[clusterName];
  if (!cluster) {
    return { sufficient: false, needs_upload: true, has_cluster_data: false, missing: ['No cluster data available'] };
  }

  const nicheWords = extractNicheWords(
    kw?.keyword || keywordSlug.replace(/-/g, ' '),
    cluster.keywords.map(k => (index.keywords[k]?.keyword || k).replace(/-/g, ' ')),
  );
  const nicheTermCount = cluster.all_matching_terms
    .filter(t => nicheWords.some(nw => t.keyword.toLowerCase().includes(nw))).length;
  const hasOwnAhrefs = kw?.sources?.includes('ahrefs') || false;

  const sufficient = hasOwnAhrefs
    || (cluster.all_matching_terms.length >= 50 && cluster.common_competitors.length >= 5 && nicheTermCount >= 10);

  const missing = [];
  if (nicheTermCount < 10 && nicheWords.length > 0) {
    missing.push(nicheWords.join('/') + '-specific matching terms');
  }
  if (!hasOwnAhrefs && cluster.common_competitors.length < 5) {
    missing.push('SERP competitor data');
  }

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

// ── Build index ──────────────────────────────────────────────────────────────

function buildIndex() {
  const keywords = {};
  const clusters = {};

  // 1. Load topical map clusters
  const topicalMap = safeReadJSON(TOPICAL_MAP_PATH);
  const topicalMapClusters = topicalMap?.clusters || [];

  // 2. Process each Ahrefs directory
  if (existsSync(AHREFS_DIR)) {
    for (const dir of readdirSync(AHREFS_DIR)) {
      const dirPath = join(AHREFS_DIR, dir);
      if (!statSync(dirPath).isDirectory()) continue;

      const slug = dir;
      const serpPath = join(dirPath, 'serp.csv');
      const matchingPath = join(dirPath, 'matching_terms.csv');
      const keywordPath = join(dirPath, 'keyword.csv');

      // Parse SERP data
      const serpRows = safeReadCSV(serpPath);
      const { overview, serp } = serpRows.length ? parseSerpCsv(serpRows) : { overview: {}, serp: [] };

      // Parse matching terms
      const matchingRows = safeReadCSV(matchingPath);
      const matchingTerms = matchingRows.length ? parseKeywordsCsv(matchingRows) : [];

      // Parse keyword-level overview (may have volume/KD if separate file)
      const kwRows = safeReadCSV(keywordPath);
      const kwOverview = kwRows.length ? parseSerpCsv(kwRows).overview : {};

      const keyword = slug.replace(/-/g, ' ');
      const cluster = assignCluster(keyword, topicalMapClusters);

      const entry = {
        keyword,
        slug,
        cluster,
        volume: overview.volume ?? kwOverview.volume ?? null,
        keyword_difficulty: overview.keyword_difficulty ?? kwOverview.keyword_difficulty ?? null,
        traffic_potential: overview.traffic_potential ?? kwOverview.traffic_potential ?? null,
        search_intent: overview.search_intent ?? kwOverview.search_intent ?? null,
        matching_terms: matchingTerms,
        serp,
        sources: ['ahrefs'],
        semantic_keywords: [],
        gsc: null,
      };

      keywords[slug] = entry;
    }
  }

  // 3. Process briefs
  if (existsSync(BRIEFS_DIR)) {
    for (const file of readdirSync(BRIEFS_DIR).filter(f => f.endsWith('.json'))) {
      const brief = safeReadJSON(join(BRIEFS_DIR, file));
      if (!brief?.target_keyword) continue;

      const slug = brief.slug || toSlug(brief.target_keyword);
      const cluster = assignCluster(brief.target_keyword, topicalMapClusters);

      if (keywords[slug]) {
        // Merge into existing entry
        const entry = keywords[slug];
        if (brief.semantic_keywords?.length) {
          const existing = new Set(entry.semantic_keywords.map(sk => typeof sk === 'string' ? sk : sk.keyword));
          for (const sk of brief.semantic_keywords) {
            const key = typeof sk === 'string' ? sk : sk.keyword;
            if (!existing.has(key)) entry.semantic_keywords.push(sk);
          }
        }
        if (brief.serp_overview?.length) {
          entry.serp_from_brief = brief.serp_overview;
        }
        if (!entry.sources.includes('brief')) entry.sources.push('brief');
        entry.volume = entry.volume ?? brief.search_volume ?? null;
        entry.keyword_difficulty = entry.keyword_difficulty ?? brief.keyword_difficulty ?? null;
      } else {
        // Create new entry from brief
        keywords[slug] = {
          keyword: brief.target_keyword,
          slug,
          cluster,
          volume: brief.search_volume ?? null,
          keyword_difficulty: brief.keyword_difficulty ?? null,
          traffic_potential: null,
          search_intent: brief.search_intent ?? null,
          matching_terms: [],
          serp: [],
          serp_from_brief: brief.serp_overview || [],
          sources: ['brief'],
          semantic_keywords: brief.semantic_keywords || [],
          gsc: null,
        };
      }
    }
  }

  // 4. Attach GSC data from latest snapshot
  const gscPath = latestFile(GSC_DIR);
  if (gscPath) {
    const gscData = safeReadJSON(gscPath);
    const topQueries = gscData?.topQueries || [];
    for (const q of topQueries) {
      const slug = toSlug(q.query);
      if (keywords[slug]) {
        keywords[slug].gsc = {
          clicks: q.clicks,
          impressions: q.impressions,
          ctr: q.ctr,
          position: q.position,
        };
        if (!keywords[slug].sources.includes('gsc')) keywords[slug].sources.push('gsc');
      }
    }
  }

  // 5. Build cluster aggregations
  for (const entry of Object.values(keywords)) {
    const c = entry.cluster;
    if (!clusters[c]) {
      clusters[c] = {
        keywords: [],
        all_matching_terms: [],
        common_competitors: [],
        all_semantic_keywords: [],
      };
    }
    clusters[c].keywords.push(entry.slug);
  }

  // Deduplicate matching terms per cluster and build competitor lists
  for (const [clusterName, cluster] of Object.entries(clusters)) {
    const clusterEntries = cluster.keywords.map(s => keywords[s]).filter(Boolean);

    // Merge matching terms (deduplicate by keyword string)
    const termsSeen = new Set();
    for (const entry of clusterEntries) {
      for (const term of entry.matching_terms) {
        if (term.keyword && !termsSeen.has(term.keyword.toLowerCase())) {
          termsSeen.add(term.keyword.toLowerCase());
          cluster.all_matching_terms.push(term);
        }
      }
    }

    // Common competitors
    cluster.common_competitors = buildCommonCompetitors(clusterEntries);

    // Merge semantic keywords
    const semSeen = new Set();
    for (const entry of clusterEntries) {
      for (const sk of entry.semantic_keywords) {
        const key = typeof sk === 'string' ? sk : sk.keyword;
        if (key && !semSeen.has(key.toLowerCase())) {
          semSeen.add(key.toLowerCase());
          cluster.all_semantic_keywords.push(sk);
        }
      }
    }
  }

  const index = {
    built_at: new Date().toISOString(),
    keyword_count: Object.keys(keywords).length,
    cluster_count: Object.keys(clusters).length,
    keywords,
    clusters,
  };

  // Write to disk
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));

  return index;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function loadKeywordIndex() {
  // In-memory cache
  if (memoryCache && (Date.now() - memoryCacheTime) < CACHE_TTL_MS) {
    return memoryCache;
  }

  // Disk cache
  if (existsSync(INDEX_PATH)) {
    try {
      const stat = statSync(INDEX_PATH);
      if ((Date.now() - stat.mtimeMs) < CACHE_TTL_MS) {
        const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
        memoryCache = index;
        memoryCacheTime = Date.now();
        return index;
      }
    } catch { /* rebuild */ }
  }

  return rebuildIndex();
}

export function rebuildIndex() {
  const index = buildIndex();
  memoryCache = index;
  memoryCacheTime = Date.now();
  return index;
}

// ── CLI mode ─────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMain) {
  const force = process.argv.includes('--rebuild');
  console.log(force ? 'Rebuilding keyword index...' : 'Loading keyword index...');
  const index = force ? rebuildIndex() : loadKeywordIndex();
  console.log(`\nKeyword Index Summary`);
  console.log(`─────────────────────`);
  console.log(`  Keywords: ${index.keyword_count}`);
  console.log(`  Clusters: ${index.cluster_count}`);
  console.log(`  Built at: ${index.built_at}`);
  console.log();
  for (const [name, cluster] of Object.entries(index.clusters)) {
    console.log(`  [${name}] ${cluster.keywords.length} keywords, ${cluster.all_matching_terms.length} matching terms, ${cluster.common_competitors.length} competitors`);
  }
  console.log();

  // Show gap analysis for each keyword
  let sufficient = 0;
  let needsUpload = 0;
  for (const slug of Object.keys(index.keywords)) {
    const gap = analyzeGaps(slug, index);
    if (gap.sufficient) sufficient++;
    else needsUpload++;
  }
  console.log(`  Data sufficiency: ${sufficient} ready, ${needsUpload} need more data`);
}
