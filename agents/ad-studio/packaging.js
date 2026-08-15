// agents/ad-studio/packaging.js
//
// Stage 5.
//
// Meta serves the frame you upload, so its artifact is the finished baked ad.
// Demand Gen mixes images, headlines and descriptions into combinations at serve time,
// so its native artifact is the TEXT-FREE plate plus copy as separate upload fields.
// The plate is not a fallback for Demand Gen — it is what the platform wants.

import { join } from 'node:path';
import sharp from 'sharp';

export const PLATFORM_TARGETS = [
  { platform: 'meta', ratio: '1:1', mode: 'finished' },
  { platform: 'meta', ratio: '4:5', mode: 'finished' },
  { platform: 'meta', ratio: '9:16', mode: 'finished' },
  { platform: 'demand-gen', ratio: '1.91:1', mode: 'plate' },
  { platform: 'demand-gen', ratio: '1:1', mode: 'plate' },
  { platform: 'demand-gen', ratio: '4:5', mode: 'plate' },
];

/**
 * Resolve a `--targets` spec to a subset of PLATFORM_TARGETS.
 *
 * Every variation used to render all six targets, forced, so the floor for "show me one
 * ad style" was 6 renders (~$0.78) — half of it Demand Gen plates, which are only useful
 * if a Demand Gen campaign is actually running.
 *
 * Accepts a comma-separated list of:
 *   all                — every target
 *   meta | demand-gen  — every target of that platform
 *   <platform>=<ratio> — one placement, e.g. meta=9:16
 *
 * The `=` matters: a ratio contains a colon, so `meta:9:16` cannot be split unambiguously.
 *
 * Results follow PLATFORM_TARGETS order rather than the order the flag was written, so
 * output paths and the progress tree stay stable however it is typed, and duplicates
 * collapse instead of rendering the same target twice. An unrecognised token throws with
 * the valid values named — a typo would otherwise silently render the wrong set, or none.
 */
export function selectTargets(spec) {
  const tokens = String(spec || '').split(',').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('ad-studio: --targets must name at least one target (all, meta, demand-gen, or <platform>=<ratio>)');
  }

  const platforms = [...new Set(PLATFORM_TARGETS.map(t => t.platform))];
  const keep = new Set();

  for (const token of tokens) {
    if (token === 'all') {
      PLATFORM_TARGETS.forEach((t, i) => keep.add(i));
      continue;
    }
    const [platform, ratio] = token.includes('=') ? token.split('=') : [token, null];
    if (!platforms.includes(platform)) {
      throw new Error(
        `ad-studio: unknown --targets value "${token}". Valid: all, ${platforms.join(', ')}, ` +
        `or <platform>=<ratio> such as ${PLATFORM_TARGETS[0].platform}=${PLATFORM_TARGETS[0].ratio}`
      );
    }
    const matches = PLATFORM_TARGETS
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.platform === platform && (ratio === null || t.ratio === ratio));
    if (matches.length === 0) {
      throw new Error(
        `ad-studio: no target "${token}" — ${platform} renders ` +
        `${PLATFORM_TARGETS.filter(t => t.platform === platform).map(t => t.ratio).join(', ')}`
      );
    }
    for (const { i } of matches) keep.add(i);
  }

  return PLATFORM_TARGETS.filter((_, i) => keep.has(i));
}

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

// Gemini's image endpoint only accepts a fixed set of aspect ratios (confirmed by
// the live 400: "aspect_ratio must be one of ..."). Google Demand Gen's own
// required landscape ratio, 1.91:1, is NOT in that set, so it can never be
// requested from Gemini directly.
export const GEMINI_SUPPORTED_ASPECT_RATIOS = [
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9',
];

// The ratio we DELIVER may differ from the ratio we ASK GEMINI FOR. Every entry's
// requestRatio must be one Gemini actually supports — renderRatioFor re-checks that
// at call time so an unmapped or newly-added delivery ratio can never reach a paid
// call unvalidated; that silent pass-through is what produced the live crash.
const RENDER_RATIO_MAP = {
  '1:1': { requestRatio: '1:1', needsCrop: false },
  '4:5': { requestRatio: '4:5', needsCrop: false },
  '9:16': { requestRatio: '9:16', needsCrop: false },
  // 16:9 (1.778:1) is the closest Gemini-supported ratio to 1.91:1 and, being
  // narrower, always has enough pixels to crop DOWN to 1.91:1 — see cropToRatio.
  '1.91:1': { requestRatio: '16:9', needsCrop: true },
};

/**
 * @param {string} deliveryRatio a PLATFORM_TARGETS ratio, e.g. '1.91:1'
 * @returns {{requestRatio:string, needsCrop:boolean}}
 */
export function renderRatioFor(deliveryRatio) {
  const entry = RENDER_RATIO_MAP[deliveryRatio];
  if (!entry) {
    throw new Error(
      `ad-studio: no render-ratio mapping for delivery ratio "${deliveryRatio}" — add one to ` +
      `RENDER_RATIO_MAP in packaging.js. Never request an unmapped ratio from Gemini directly.`
    );
  }
  if (!GEMINI_SUPPORTED_ASPECT_RATIOS.includes(entry.requestRatio)) {
    throw new Error(
      `ad-studio: RENDER_RATIO_MAP maps "${deliveryRatio}" to request ratio "${entry.requestRatio}", ` +
      `which is not in GEMINI_SUPPORTED_ASPECT_RATIOS. Fix the map before this reaches a paid call.`
    );
  }
  return entry;
}

function parseRatio(ratio) {
  const [w, h] = String(ratio).split(':').map(Number);
  if (!w || !h) throw new Error(`ad-studio: cannot parse ratio "${ratio}"`);
  return w / h;
}

/**
 * Centre-crop `buffer` down to `targetRatio` (a "W:H" string), preserving whichever
 * dimension needs no trimming and cutting the other symmetrically.
 *
 * 16:9 (≈1.778) is NARROWER than 1.91:1 (1.91 > 1.778) — width/height must increase
 * to reach the target, which cropping can only do by REDUCING height while holding
 * width fixed. (Trimming width instead would require growing width past the
 * source's actual pixel count, which cropping cannot do — that branch only applies
 * when the target is narrower than the source, not wider.) Verified against a
 * synthetic 1920x1080 fixture: crops to 1920x1005, ratio 1.9104 — within a pixel of
 * 1.91:1.
 */
export async function cropToRatio(buffer, targetRatio) {
  const target = parseRatio(targetRatio);
  const img = sharp(buffer);
  const { width, height } = await img.metadata();
  if (!width || !height) {
    throw new Error('ad-studio: could not read image dimensions to crop — corrupt or unsupported image?');
  }
  const sourceRatio = width / height;

  let cropWidth = width;
  let cropHeight = height;
  if (target > sourceRatio) {
    // Target is wider than the source: hold width fixed, trim height.
    cropHeight = Math.round(width / target);
  } else if (target < sourceRatio) {
    // Target is narrower/taller than the source: hold height fixed, trim width.
    cropWidth = Math.round(height * target);
  }

  const left = Math.round((width - cropWidth) / 2);
  const top = Math.round((height - cropHeight) / 2);
  return img.extract({ left, top, width: cropWidth, height: cropHeight }).toBuffer();
}

/**
 * Bucket the concept's copy into Demand Gen's text fields. Strings too long for every
 * field are reported in `dropped` — a silently truncated asset reads as full coverage.
 *
 * Demand Gen's headline/long-headline/description fields are single-line; a zone
 * value may legitimately contain a newline for the IMAGE layout (a two-line headline
 * baked into the render is fine there — buildRenderPrompt/expectedStrings read the
 * zone value directly and are untouched by this function). Normalizing here, once,
 * before de-dup/bucketing/length-checking, keeps that newline out of the uploaded
 * text field without changing what gets rendered.
 */
export function buildDemandGenAssets(zones) {
  const seen = new Set();
  const flat = [];
  for (const value of Object.values(zones || {})) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      // Collapse every whitespace run — \n, \r, \t, repeated spaces — to a single
      // space before anything downstream sees this string, so length checks and
      // de-dup both operate on the same normalized value that gets emitted.
      const t = item.replace(/\s+/g, ' ').trim();
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
