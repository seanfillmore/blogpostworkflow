// agents/meta-ads-analyzer/index.js
/**
 * Meta Ads Analyzer
 *
 * Reads last 4 weeks of meta-ads-library snapshots, scores ads for effectiveness,
 * runs Claude analysis on qualifying ads, writes data/meta-ads-insights/YYYY-MM-DD.json.
 *
 * Usage:
 *   node agents/meta-ads-analyzer/index.js
 *   node agents/meta-ads-analyzer/index.js --dry-run
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function computeLongevityDays(ad, snapshotDate) {
  if (!ad.ad_delivery_start_time) return 0;
  if (ad.ad_delivery_stop_time) return 0; // stopped ad
  const start = new Date(ad.ad_delivery_start_time);
  const snap  = new Date(snapshotDate);
  const days  = Math.floor((snap - start) / 86400000);
  return Math.min(Math.max(days, 0), 60);
}

export function computeEffectivenessScore(longevityDays, variationCount) {
  return longevityDays + (variationCount * 2);
}

export function meetsFilter(longevityDays, variationCount, minDays, minVariations) {
  return longevityDays >= minDays || variationCount >= minVariations;
}

export function buildPass1Prompt(pageId, pageName, ads) {
  return `You are categorizing ads from a single brand by product/theme to identify creative variations.

Brand: ${pageName} (page ID: ${pageId})
Ads (${ads.length} total):
${JSON.stringify(ads, null, 2)}

Group these ads by product/theme. Each group should represent the same product being advertised with different copy angles. Do not group unrelated products together.

Return ONLY valid JSON (no markdown):
{
  "themes": [
    { "theme": "short product/angle label e.g. natural deodorant stick", "adIds": ["id1", "id2"] }
  ]
}`;
}

export function buildPass2Prompt(ad) {
  return `You are a paid advertising analyst. Analyze this Meta ad and explain why it is effective.

Brand: ${ad.pageName}
Body: ${ad.adCreativeBody || '(none)'}
Title: ${ad.adCreativeLinkTitle || '(none)'}
Description: ${ad.adCreativeLinkDescription || '(none)'}
Running for: ${ad.longevityDays} days (still active)
Creative variations from this brand: ${ad.variationCount}
Platforms: ${(ad.publisherPlatforms || []).join(', ')}

Return ONLY valid JSON (no markdown):
{
  "headline": "one-line summary of why this ad is working",
  "messagingAngle": "e.g. Ingredient transparency, Social proof, Problem/solution",
  "whyEffective": "2-3 sentences citing specific copy choices and the longevity/variation signals",
  "targetAudience": "who this ad is clearly aimed at",
  "keyTechniques": ["technique 1", "technique 2"],
  "copyInsights": "what makes the specific copy work: word choices, structure, CTA"
}`;
}

export function parsePass1Response(raw) {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned);
}

export function parsePass2Response(raw) {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned);
}

// ── Data loading ───────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

function loadRecentSnapshots(dir, weeks = 4) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse()
    .slice(0, weeks * 7) // up to weeks × 7 files (daily would be overkill; keep last N)
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function deduplicateAds(snapshots) {
  const seen = new Set();
  const ads = [];
  for (const snap of snapshots) {
    for (const ad of (snap.ads || [])) {
      if (!seen.has(ad.id)) { seen.add(ad.id); ads.push({ ...ad, _snapshotDate: snap.date }); }
    }
  }
  return ads;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log('Meta Ads Analyzer' + (isDryRun ? ' (dry run)' : '') + '\n');

  const env = loadEnv();
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'meta-ads.json'), 'utf8'));
  const { effectivenessMinDays = 14, effectivenessMinVariations = 3 } = cfg;

  const snapsDir = join(ROOT, 'data', 'snapshots', 'meta-ads-library');
  const snapshots = loadRecentSnapshots(snapsDir, 4);
  if (!snapshots.length) {
    console.log('No snapshots found — run meta-ads-collector first.');
    return;
  }

  const allAds = deduplicateAds(snapshots);
  console.log(`  Loaded ${allAds.length} unique ads from ${snapshots.length} snapshots`);

  // Group ads by page_id
  const byPage = new Map();
  for (const ad of allAds) {
    if (!byPage.has(ad.page_id)) byPage.set(ad.page_id, []);
    byPage.get(ad.page_id).push(ad);
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  // Pass 1 — variation grouping per brand
  // variationCountByPage: Map<pageId, number> — brand-level count, looked up per ad during scoring
  // Rules:
  //   - Brand with exactly 1 ad: skip Pass 1, variationCount = 1
  //   - Brand with 2+ ads, Claude succeeds: variationCount = max theme group size
  //   - Brand with 2+ ads, Claude fails: variationCount = total ad count for that brand (fallback)
  const variationCountByPage = new Map();
  for (const [pageId, ads] of byPage) {
    if (ads.length < 2) { variationCountByPage.set(pageId, 1); continue; }
    try {
      const prompt = buildPass1Prompt(pageId, ads[0].page_name, ads.map(a => ({
        id: a.id, body: a.ad_creative_body, title: a.ad_creative_link_title, description: a.ad_creative_link_description,
      })));
      const response = await client.messages.create({
        model: 'claude-opus-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const result = parsePass1Response(response.content[0].text);
      const maxThemeSize = Math.max(...(result.themes || []).map(t => t.adIds?.length || 0), 1);
      variationCountByPage.set(pageId, maxThemeSize);
    } catch (e) {
      console.warn(`  [pass1] ${ads[0].page_name}: ${e.message} — falling back to total ad count (${ads.length})`);
      variationCountByPage.set(pageId, ads.length); // fallback: total ads for this brand
    }
  }
  // After Pass 1: variationCountByPage is fully populated.
  // Each ad is scored using its brand's count: variationCount = variationCountByPage.get(ad.page_id)

  // Score and filter
  const today = snapshots[0].date;
  const scoredAds = allAds.map(ad => {
    const longevityDays = computeLongevityDays(ad, today);
    const variationCount = variationCountByPage.get(ad.page_id) || 1;
    const effectivenessScore = computeEffectivenessScore(longevityDays, variationCount);
    return { ...ad, longevityDays, variationCount, effectivenessScore };
  }).filter(ad => meetsFilter(ad.longevityDays, ad.variationCount, effectivenessMinDays, effectivenessMinVariations));

  console.log(`  Qualifying ads: ${scoredAds.length}`);

  if (isDryRun) {
    scoredAds.slice(0, 5).forEach(a => console.log(`  [dry-run] ${a.page_name} score=${a.effectivenessScore}`));
    return;
  }

  // Pass 2 — Claude analysis per qualifying ad
  const analyzedAds = [];
  for (const ad of scoredAds) {
    try {
      const prompt = buildPass2Prompt({
        pageName: ad.page_name,
        adCreativeBody: ad.ad_creative_body,
        adCreativeLinkTitle: ad.ad_creative_link_title,
        adCreativeLinkDescription: ad.ad_creative_link_description,
        longevityDays: ad.longevityDays,
        variationCount: ad.variationCount,
        publisherPlatforms: ad.publisher_platforms,
      });
      const response = await client.messages.create({
        model: 'claude-opus-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const analysis = parsePass2Response(response.content[0].text);
      analyzedAds.push({
        id: ad.id, pageId: ad.page_id, pageName: ad.page_name, pageSlug: ad.page_slug,
        adCreativeBody: ad.ad_creative_body, adCreativeLinkTitle: ad.ad_creative_link_title,
        adSnapshotUrl: ad.ad_snapshot_url, publisherPlatforms: ad.publisher_platforms,
        longevityDays: ad.longevityDays, variationCount: ad.variationCount,
        effectivenessScore: ad.effectivenessScore, analysis,
      });
    } catch (e) {
      console.warn(`  [pass2] ${ad.page_name} (${ad.id}): ${e.message}`);
      analyzedAds.push({
        id: ad.id, pageId: ad.page_id, pageName: ad.page_name, pageSlug: ad.page_slug,
        adCreativeBody: ad.ad_creative_body, adCreativeLinkTitle: ad.ad_creative_link_title,
        adSnapshotUrl: ad.ad_snapshot_url, publisherPlatforms: ad.publisher_platforms,
        longevityDays: ad.longevityDays, variationCount: ad.variationCount,
        effectivenessScore: ad.effectivenessScore, analysis: null,
      });
    }
  }

  analyzedAds.sort((a, b) => b.effectivenessScore - a.effectivenessScore);

  const outDir = join(ROOT, 'data', 'meta-ads-insights');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${today}.json`);
  writeFileSync(outPath, JSON.stringify({ date: today, ads: analyzedAds }, null, 2));
  console.log(`  Saved: ${outPath} (${analyzedAds.length} ads)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { notify } = await import('../../lib/notify.js');
  main()
    .then(() => notify({ subject: 'Meta Ads Analyzer completed', body: 'Insights saved', status: 'success' }).catch(() => {}))
    .catch(async err => {
      await notify({ subject: 'Meta Ads Analyzer failed', body: err.message, status: 'error' }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
}
