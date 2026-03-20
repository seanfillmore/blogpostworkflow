// agents/ads-optimizer/index.js
/**
 * Google Ads Optimizer Agent
 *
 * Loads Google Ads snapshot + GSC + GA4 + Shopify + Ahrefs data, runs
 * Claude analysis, saves suggestions to data/ads-optimizer/YYYY-MM-DD.json,
 * and sends an alert email if suggestions exist.
 *
 * Usage:
 *   node agents/ads-optimizer/index.js
 *   node agents/ads-optimizer/index.js --date 2026-03-19
 */

import { join } from 'node:path';

// ── Pure exports (tested) ──────────────────────────────────────────────────────

export function suggestionFilePath(date, rootDir) {
  return join(rootDir, 'data', 'ads-optimizer', `${date}.json`);
}

export function buildAlertEmailBody(snap, suggestions, dashboardUrl) {
  const lines = [
    `Yesterday: $${snap.spend.toFixed(2)} spend · ${snap.clicks} clicks · ${snap.conversions} conv · ${snap.roas.toFixed(2)}x ROAS`,
    '',
    'Suggestions:',
  ];
  for (const s of suggestions) {
    const badge = s.confidence === 'high' ? 'HIGH' : s.confidence === 'medium' ? 'MED' : 'LOW';
    const label = s.type === 'copy_rewrite'
      ? `Rewrite ${s.target}${s.adGroup ? ', ' + s.adGroup : ''}`
      : s.type === 'keyword_pause'
      ? `Pause "${s.target}"`
      : s.type === 'keyword_add'
      ? `Add keyword "${s.target}"`
      : `Add negative "${s.target}"`;
    lines.push(`• [${badge}] ${label} — ${s.rationale}`);
  }
  lines.push('');
  lines.push(`Review and approve: ${dashboardUrl} → Ads tab`);
  return lines.join('\n');
}

export function parseSuggestionsResponse(raw) {
  // Strip markdown code fence if Claude wraps output
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}`);
  }
  // Ensure all suggestions have status: 'pending'
  if (Array.isArray(parsed.suggestions)) {
    parsed.suggestions = parsed.suggestions.map(s => ({ ...s, status: s.status || 'pending' }));
  }
  return parsed;
}
