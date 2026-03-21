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
