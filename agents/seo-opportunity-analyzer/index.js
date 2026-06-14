#!/usr/bin/env node
/**
 * SEO Opportunity Analyzer
 *
 * Weekly. Productizes the "where can we actually win?" analysis:
 *   1. Pull the GSC query+page rows we ALREADY rank for (positions 5-50 — real
 *      impressions, i.e. winnable, not fantasy head terms).
 *   2. Enrich each with DataForSEO search volume (cached 30 days to control cost).
 *   3. Cluster by destination page (one page ranking for 8 SLS variants = ONE
 *      opportunity worth the combined volume).
 *   4. Score by realistic monthly-click upside, boosted for product/collection
 *      pages (commercial intent), and classify the right action.
 *
 * Output: data/reports/seo-opportunities/{latest.json, YYYY-MM-DD.json}
 * Digest: top opportunities surfaced in the daily recap.
 *
 * Hybrid action model:
 *   - meta_rewrite  → auto-handled by the scheduled meta-optimizer (flagged here).
 *   - rank_push / refresh → top N staged as pending performance-queue items for
 *     dashboard approval (the bigger, content-mutating moves stay human-gated).
 *
 * Usage:
 *   node agents/seo-opportunity-analyzer/index.js
 *   node agents/seo-opportunity-analyzer/index.js --dry-run   # analyze only, no queue writes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllQueryPageRows } from '../../lib/gsc.js';
import { getSearchVolume } from '../../lib/dataforseo.js';
import { analyzeOpportunities } from '../../lib/seo-opportunities.js';
import { writeItem, activeSlugs } from '../performance-engine/lib/queue.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'seo-opportunities');
const CACHE_FILE = join(REPORTS_DIR, 'volume-cache.json');

const DRY = process.argv.includes('--dry-run');
const MIN_IMPRESSIONS = 50;     // 90-day floor to cut noise
const VOLUME_CACHE_DAYS = 30;   // search volume is monthly — cache to control cost
const MAX_VOLUME_FETCH = 200;   // cap new keywords priced per run
const STAGE_LIMIT = 3;          // bigger moves staged for approval per run

// Pure-brand navigational queries — not opportunities, just people finding us.
const BRAND_STOPWORDS = ['real skin care', 'realskincare', 'reale skincare', 'reale skin', 'reale actives', 'real skincare'];
const isBrandNav = (kw) => BRAND_STOPWORDS.some((b) => (kw || '').toLowerCase().trim() === b);

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
}

function productHandlesFromConfig() {
  try {
    const ing = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
    return Object.values(ing).map((p) => p.shopify_handle).filter(Boolean);
  } catch { return []; }
}

function siteHost() {
  try {
    const c = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
    return (c.url || 'https://www.realskincare.com').replace(/\/$/, '');
  } catch { return 'https://www.realskincare.com'; }
}

function slugFromPage(page) {
  const m = String(page).match(/\/([^/?#]+)\/?$/);
  return m ? m[1] : page.replace(/[^a-z0-9]+/gi, '-');
}

// Route an opportunity to the executor agent best suited to act on it, so a human
// approving the queue item knows exactly which agent runs it. Collections are the
// priority commercial asset and have dedicated executors.
function recommendedAgent(o) {
  if (o.page_type === 'collection') {
    // deep refresh → rewrite the on-page content; page-2 push → internal links.
    return o.action === 'refresh' ? 'collection-content-optimizer' : 'collection-linker';
  }
  if (o.page_type === 'product') return 'collection-linker'; // links blog content into product pages
  return o.action === 'rank_push' ? 'collection-linker' : 'refresh-runner';
}

// Google Ads (DataForSEO) rejects keywords with punctuation/symbols (e.g.
// question-form queries ending in "?"). One bad keyword fails the whole batch,
// so only send clean ones; mark the rest volume 0 (questions have ~0 volume
// anyway) and cache them so they don't get retried or re-break a batch.
const priceable = (kw) => /^[a-z0-9 '&-]+$/i.test(kw) && kw.length <= 80 && kw.trim().split(/\s+/).length <= 10;

async function enrichVolumes(keywords) {
  const cache = loadCache();
  const now = Date.now();
  const fresh = (e) => e && (now - (e.cached_at || 0)) < VOLUME_CACHE_DAYS * 864e5;
  const ts = Date.now();

  const stale = keywords.filter((k) => !fresh(cache[k.toLowerCase()]));
  // Cache un-priceable stale keywords as 0 so they're never sent to the API.
  for (const k of stale.filter((k) => !priceable(k))) cache[k.toLowerCase()] = { volume: 0, cached_at: ts };

  const toFetch = stale.filter(priceable).slice(0, MAX_VOLUME_FETCH);
  if (toFetch.length && !process.env.SKIP_VOLUME) {
    try {
      const rows = await getSearchVolume(toFetch);
      for (const r of rows) cache[r.keyword.toLowerCase()] = { volume: r.volume ?? 0, cached_at: ts };
    } catch (e) {
      console.warn(`  volume fetch failed (continuing with cache): ${e.message}`);
    }
  }
  saveCache(cache);
  const remaining = stale.filter(priceable).length - toFetch.length;
  if (remaining > 0) console.log(`  Note: ${remaining} keyword(s) left unpriced this run (cap ${MAX_VOLUME_FETCH}); cached next run.`);
  return (kw) => cache[kw.toLowerCase()]?.volume ?? 0;
}

async function main() {
  console.log(`\nSEO Opportunity Analyzer${DRY ? ' (dry-run)' : ''}\n`);

  const host = siteHost();
  const raw = await getAllQueryPageRows(5000, 90);
  const rows = raw.filter((r) =>
    r.page && r.page.startsWith(host)
    && r.position >= 5 && r.position <= 50
    && (r.impressions || 0) >= MIN_IMPRESSIONS
    && !isBrandNav(r.query));
  console.log(`  GSC rows we rank for (pos 5-50, ≥${MIN_IMPRESSIONS} impr): ${rows.length}`);

  const keywords = [...new Set(rows.map((r) => r.query))];
  const volOf = await enrichVolumes(keywords);

  const enriched = rows.map((r) => ({
    keyword: r.query, page: r.page,
    impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position,
    volume: volOf(r.query),
  }));

  const opps = analyzeOpportunities(enriched, { productHandles: productHandlesFromConfig() });
  console.log(`  Opportunities (clustered by page): ${opps.length}`);

  // ── persist report ──────────────────────────────────────────────────────
  mkdirSync(REPORTS_DIR, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    opportunity_count: opps.length,
    top: opps.slice(0, 25),
  };
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(report, null, 2));

  // ── Hybrid: stage the bigger moves for approval ───────────────────────────
  const active = activeSlugs();
  const toStage = opps
    .filter((o) => (o.action === 'rank_push' || o.action === 'refresh') && o.score > 0)
    .filter((o) => !active.has(`seo-opp-${slugFromPage(o.page)}`))
    .slice(0, STAGE_LIMIT);

  const staged = [];
  for (const o of toStage) {
    const slug = `seo-opp-${slugFromPage(o.page)}`;
    if (!DRY) {
      writeItem({
        slug,
        title: `SEO opportunity: ${o.topKeyword}`,
        trigger: 'seo-opportunity',
        signal_source: {
          type: 'gsc-opportunity-analyzer',
          page: o.page,
          page_type: o.page_type,
          cluster_volume: o.clusterVolume,
          impressions: o.impressions,
          position: o.position,
          keywords: o.keywords.slice(0, 10),
        },
        summary: {
          what_changed: `${o.keywordCount} query/queries (~${o.clusterVolume.toLocaleString()}/mo) hit ${o.page.replace(host, '')} at avg position ${o.position}.`,
          why: `Recommended: ${o.action.replace('_', ' ')} — est. +${o.est_monthly_clicks} clicks/mo${o.commercial ? ` (commercial ${o.page_type})` : ''}.`,
          projected_impact: o.action === 'rank_push'
            ? `Run ${recommendedAgent(o)}: internal links + on-page to push from page 2 onto page 1.`
            : `Run ${recommendedAgent(o)}: deeper content rebuild to become competitive.`,
        },
        resource_type: o.page_type === 'collection' ? 'collection' : 'seo-opportunity',
        recommended_action: o.action,
        recommended_agent: recommendedAgent(o),
        status: 'pending',
        created_at: new Date().toISOString(),
      });
    }
    staged.push(o);
  }

  // ── digest ────────────────────────────────────────────────────────────────
  const typeMark = (o) => (o.page_type === 'collection' ? '📂' : o.page_type === 'product' ? '🛍️' : '');
  const fmt = (o, i) => `${i + 1}. [${o.action}] ${o.topKeyword} — ~${o.clusterVolume.toLocaleString()}/mo, ${o.impressions} impr, pos ${o.position}, +${o.est_monthly_clicks} clk/mo ${typeMark(o)}\n   ${o.page.replace(host, '')}`;
  const autoMeta = opps.filter((o) => o.action === 'meta_rewrite').slice(0, 8);
  // Collections are the priority commercial asset (~80% of ecommerce SEO revenue) — call them out first.
  const collOpps = opps.filter((o) => o.page_type === 'collection').slice(0, 5);
  const body = [
    `Top opportunities (winnable — pages we already rank for):`,
    ...opps.slice(0, 8).map(fmt),
    '',
    `📂 Collection opportunities (highest revenue leverage): ${opps.filter((o) => o.page_type === 'collection').length}`,
    ...collOpps.map((o) => `  • ${o.topKeyword} (pos ${o.position}, ~${o.clusterVolume.toLocaleString()}/mo) → ${recommendedAgent(o)}\n    ${o.page.replace(host, '')}`),
    '',
    `Auto-handled by meta-optimizer this week (CTR rewrites): ${autoMeta.length}`,
    ...autoMeta.map((o) => `  • ${o.topKeyword} (pos ${o.position}, ${(o.ctr * 100).toFixed(1)}% CTR) ${o.page.replace(host, '')}`),
    '',
    `Staged for approval (bigger moves): ${staged.length}`,
    ...staged.map((o) => `  • ${o.topKeyword} → ${o.action} via ${recommendedAgent(o)} — review on dashboard`),
  ].join('\n');

  console.log(`\n${body}\n`);
  await notify({
    subject: `SEO Opportunities: ${opps.length} found, ${staged.length} staged`,
    body,
    status: 'info',
    category: 'seo',
  }).catch(() => {});

  console.log(`Done. ${opps.length} opportunities, ${staged.length} staged${DRY ? ' (dry-run, none written)' : ''}.`);
}

main().catch((err) => {
  notify({ subject: 'SEO Opportunity Analyzer failed', body: err.message || String(err), status: 'error' }).catch(() => {});
  console.error('Error:', err.message);
  process.exit(1);
});
