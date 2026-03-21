// agents/creative-packager/index.js
/**
 * Creative Packager
 *
 * Triggered on-demand by dashboard POST /api/generate-creative.
 * Reads job spec, generates Gemini creatives, writes ZIP to data/creative-packages/.
 *
 * Usage:
 *   node agents/creative-packager/index.js --job-id <jobId>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

const PLACEMENT_MAP = {
  instagram: [
    { name: 'instagram-feed-1080x1080',    width: 1080, height: 1080, label: 'Instagram Feed (Square)' },
    { name: 'instagram-feed-1080x1350',    width: 1080, height: 1350, label: 'Instagram Feed (Portrait)' },
    { name: 'instagram-stories-1080x1920', width: 1080, height: 1920, label: 'Instagram Stories / Reels' },
  ],
  facebook: [
    { name: 'facebook-feed-1200x628',    width: 1200, height: 628,  label: 'Facebook Feed (Landscape)' },
    { name: 'facebook-feed-1080x1080',   width: 1080, height: 1080, label: 'Facebook Feed (Square)' },
    { name: 'facebook-stories-1080x1920', width: 1080, height: 1920, label: 'Facebook Stories' },
  ],
};

export function placementSizes(publisherPlatforms) {
  const sizes = [];
  for (const platform of publisherPlatforms) {
    if (PLACEMENT_MAP[platform]) sizes.push(...PLACEMENT_MAP[platform]);
  }
  return sizes;
}

export function formatCopyFile(variations) {
  const lines = ['META AD COPY VARIATIONS', '========================', ''];
  variations.forEach((v, i) => {
    lines.push(`Variation ${i + 1} — ${v.placement || 'General'}`);
    lines.push(`Headline: ${v.headline}`);
    lines.push(`Body: ${v.body}`);
    lines.push(`CTA: ${v.cta}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function formatSpecsFile(sizes) {
  const lines = ['AD PLACEMENT SPECIFICATIONS', '==========================', ''];
  for (const s of sizes) {
    lines.push(`${s.label}`);
    lines.push(`  Size: ${s.width} × ${s.height} px`);
    lines.push(`  File: ${s.name}.webp`);
    lines.push(`  Headline limit: 40 characters`);
    lines.push(`  Body limit: 125 characters`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildStylePrompt(ad) {
  return `You are a creative director preparing a brief for Gemini image generation.

Analyze this Meta ad and write a detailed image generation prompt that captures its visual style for a new ad creative.

Ad copy:
- Body: ${ad.adCreativeBody || '(none)'}
- Title: ${ad.adCreativeLinkTitle || '(none)'}
- Messaging angle: ${ad.analysis?.messagingAngle || 'unknown'}
- Why effective: ${ad.analysis?.whyEffective || 'unknown'}

Write a Gemini image generation prompt that:
1. Describes the mood and aesthetic (e.g., "clean, minimal, bright natural light")
2. Describes the color palette
3. Describes the composition and how the product should be featured
4. Describes the background and setting
5. Describes the lighting style
6. Specifies NOT to include any text, logos, or labels in the generated image

Return only the image prompt as plain text — no JSON, no explanation.`;
}
