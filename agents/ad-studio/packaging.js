// agents/ad-studio/packaging.js
//
// Stage 5.
//
// Meta serves the frame you upload, so its artifact is the finished baked ad.
// Demand Gen mixes images, headlines and descriptions into combinations at serve time,
// so its native artifact is the TEXT-FREE plate plus copy as separate upload fields.
// The plate is not a fallback for Demand Gen — it is what the platform wants.

import { join } from 'node:path';

export const PLATFORM_TARGETS = [
  { platform: 'meta', ratio: '1:1', mode: 'finished' },
  { platform: 'meta', ratio: '4:5', mode: 'finished' },
  { platform: 'meta', ratio: '9:16', mode: 'finished' },
  { platform: 'demand-gen', ratio: '1.91:1', mode: 'plate' },
  { platform: 'demand-gen', ratio: '1:1', mode: 'plate' },
  { platform: 'demand-gen', ratio: '4:5', mode: 'plate' },
];

// Google Demand Gen text field limits.
const HEADLINE_MAX = 40;
const LONG_HEADLINE_MAX = 90;
const DESCRIPTION_MAX = 90;

export function variationDir(root, runId, conceptSlug, n) {
  return join(root, 'data', 'creatives', 'ad-studio', runId, conceptSlug, `v${n}`);
}

export function artifactName(platform, ratio, mode) {
  return `${mode}-${ratio.replace(/\./g, '_').replace(':', 'x')}.png`;
}

/**
 * Bucket the concept's copy into Demand Gen's text fields. Strings too long for every
 * field are reported in `dropped` — a silently truncated asset reads as full coverage.
 */
export function buildDemandGenAssets(zones) {
  const seen = new Set();
  const flat = [];
  for (const value of Object.values(zones || {})) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      const t = item.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      flat.push(t);
    }
  }

  const headlines = [];
  const longHeadlines = [];
  const descriptions = [];
  const dropped = [];

  for (const t of flat) {
    if (t.length <= HEADLINE_MAX) headlines.push(t);
    else if (t.length <= LONG_HEADLINE_MAX) longHeadlines.push(t);
    else { dropped.push({ text: t, limit: LONG_HEADLINE_MAX }); continue; }
    if (t.length <= DESCRIPTION_MAX) descriptions.push(t);
  }

  return { headlines, longHeadlines, descriptions, dropped };
}
