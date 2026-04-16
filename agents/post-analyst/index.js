/**
 * Post Analyst
 *
 * Pure-research agent: for a given post, pulls actual GSC ranking keywords,
 * GSC performance (90d), and top-3 SERP competitor URLs for the primary
 * ranking keyword. Writes `data/analysis/<slug>.json` — no mutations.
 *
 * Consumed by:
 *   - legacy-rebuilder (rebuild-tier posts): fresh competitive research
 *   - writer: target word count from competitor benchmark
 *   - answer-first-rewriter: target the highest-impression query, not
 *     just the intended keyword
 *
 * Usage:
 *   node agents/post-analyst/index.js <slug>
 *   node agents/post-analyst/index.js --all            # analyze every legacy post
 *   node agents/post-analyst/index.js --tier rebuild   # analyze only posts in a given tier
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getPostMeta, ROOT } from '../../lib/posts.js';
import * as gsc from '../../lib/gsc.js';
import { getSerpResults } from '../../lib/dataforseo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(ROOT, 'data', 'analysis');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const CANONICAL_ROOT = (config.url || '').replace(/\/$/, '');

const args = process.argv.slice(2);
const tierIdx = args.indexOf('--tier');
const tierFilter = tierIdx !== -1 ? args[tierIdx + 1] : null;
const all = args.includes('--all') || tierFilter !== null;
const slugArg = !all ? args.find((a) => !a.startsWith('--')) : null;

function toCanonicalUrl(meta, slug) {
  if (meta?.shopify_handle) return `${CANONICAL_ROOT}/blogs/news/${meta.shopify_handle}`;
  if (meta?.shopify_url) return meta.shopify_url.replace(/https?:\/\/[^\/]+/, CANONICAL_ROOT);
  return `${CANONICAL_ROOT}/blogs/news/${slug}`;
}

async function analyzePost(slug) {
  const meta = getPostMeta(slug);
  if (!meta) throw new Error(`No metadata for ${slug}`);
  const url = toCanonicalUrl(meta, slug);

  const [performance, keywords] = await Promise.all([
    gsc.getPagePerformance(url, 90).catch(() => null),
    gsc.getPageKeywords(url, 20, 90).catch(() => []),
  ]);

  const sorted = (keywords || []).sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  const primary = sorted[0] || null;
  const secondary = sorted.slice(1, 6);

  let competitors = [];
  let serpFeatures = [];
  if (primary?.keyword) {
    try {
      const { organic, serpFeatures: feats } = await getSerpResults(primary.keyword, 10);
      competitors = (organic || []).slice(0, 3).map((r) => ({
        position: r.position,
        url: r.url,
        title: r.title,
        domain: r.domain,
        description: r.description,
      }));
      serpFeatures = feats || [];
    } catch { /* skip */ }
  }

  const analysis = {
    slug,
    title: meta.title || slug,
    url,
    analyzed_at: new Date().toISOString(),
    legacy_bucket: meta.legacy_bucket || null,
    performance: performance || null,
    primary_keyword: primary,
    secondary_keywords: secondary,
    competitors,
    serp_features: serpFeatures,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, `${slug}.json`);
  writeFileSync(outPath, JSON.stringify(analysis, null, 2));

  return { analysis, outPath };
}

async function main() {
  console.log('\nPost Analyst\n');

  if (slugArg) {
    const { analysis, outPath } = await analyzePost(slugArg);
    console.log(`  ${slugArg}`);
    console.log(`    Primary keyword: ${analysis.primary_keyword?.keyword || 'none'}`);
    console.log(`    Impressions (90d): ${analysis.performance?.impressions || 0}`);
    console.log(`    Competitors found: ${analysis.competitors.length}`);
    console.log(`\n  Saved: ${outPath}`);
    return;
  }

  // Batch mode
  const slugs = listAllSlugs().filter((slug) => {
    const meta = getPostMeta(slug);
    if (!meta?.shopify_article_id) return false;
    if (tierFilter && meta.legacy_bucket !== tierFilter) return false;
    return true;
  });

  console.log(`  Analyzing ${slugs.length} post(s)${tierFilter ? ` (tier: ${tierFilter})` : ''}\n`);

  let analyzed = 0;
  let failed = 0;
  for (const slug of slugs) {
    try {
      const { analysis } = await analyzePost(slug);
      analyzed++;
      console.log(`  ✓ ${slug} — primary: ${analysis.primary_keyword?.keyword || '—'}, ${analysis.performance?.impressions || 0} impr`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${slug} — ${e.message}`);
    }
  }

  console.log(`\nDone. ${analyzed} analyzed, ${failed} failed.`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
