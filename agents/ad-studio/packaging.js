// agents/ad-studio/packaging.js
//
// Stage 5.
//
// EVERY platform's shipping artifact is now the TEXT-FREE PLATE.
//
// It was already what Demand Gen wants — Google mixes images, headlines and descriptions
// into combinations at serve time, so the plate plus copy-as-fields is native there, not a
// fallback. It is now what Meta gets too, for a different reason: the operator sets the
// type and the icons in Photoshop, against the safe-zone guide this file emits.
//
// The finished-looking frame still exists as a COMP, derived from the plate. It is a
// picture of what the ad could be, not the ad. Nothing downstream should treat it as
// shippable, and the gate deliberately no longer fails a render over its text.

import { join } from 'node:path';
import sharp from 'sharp';
import { SAFE_ZONE_RATIOS } from './critique.js';

// Every target renders a text-free PLATE. `wantsComp` decides whether a throwaway
// finished-looking comp is derived from it afterwards: Meta gets one because a human is
// about to lay type onto that plate and wants to see the intent; Demand Gen does not,
// because Google composites the text itself at serve time and a comp would illustrate a
// layout that will never exist.
export const PLATFORM_TARGETS = [
  { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: true },
  { platform: 'meta', ratio: '4:5', mode: 'plate', wantsComp: true },
  { platform: 'meta', ratio: '9:16', mode: 'plate', wantsComp: true },
  { platform: 'demand-gen', ratio: '1.91:1', mode: 'plate', wantsComp: false },
  { platform: 'demand-gen', ratio: '1:1', mode: 'plate', wantsComp: false },
  { platform: 'demand-gen', ratio: '4:5', mode: 'plate', wantsComp: false },
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

export function ratioSlug(ratio) {
  return String(ratio).replace(/\./g, '_').replace(':', 'x');
}

/**
 * `kind` is 'plate' (the text-free ad base — the artifact that ships to Photoshop) or
 * 'comp' (the derived, throwaway example of what it could look like finished).
 *
 * The platform is in the name because both Meta and Demand Gen now want a plate, and at
 * 1:1 and 4:5 they ask for the same ratio — without it the two would collide in one
 * variation directory and the second write would silently win.
 */
export function artifactName(platform, ratio, kind) {
  return `${platform}-${kind}-${ratioSlug(ratio)}.png`;
}

// Pixel dimensions to draw a guide at. The guide is an overlay opened next to the plate
// in Photoshop, so it only has to match the plate's ASPECT — 1600px on the long edge is
// plenty to place type against and small enough to be free.
const GUIDE_LONG_EDGE = 1600;

export function guideDimensions(ratio) {
  const [w, h] = String(ratio).split(':').map(Number);
  if (!w || !h) throw new Error(`ad-studio: cannot parse ratio "${ratio}"`);
  return w >= h
    ? { width: GUIDE_LONG_EDGE, height: Math.round((GUIDE_LONG_EDGE * h) / w) }
    : { width: Math.round((GUIDE_LONG_EDGE * w) / h), height: GUIDE_LONG_EDGE };
}

/**
 * The Photoshop safe-zone guide for one ratio.
 *
 * This is where the safe zone LIVES now. It used to be something the image model had to
 * obey and the gate hard-failed — which failed 6 of 6 vertical frames, because every
 * layoutBrief runs a headline to the top edge and the model fills the frame regardless of
 * instruction. Type is set by hand now, so the safe zone becomes what it always should
 * have been: a guide the person doing the layout can see.
 *
 * Bands come from SAFE_ZONE_RATIOS (Meta's published Stories/Reels numbers) where the
 * platform actually draws UI. Everywhere else there is no overlay, so the guide shows a
 * plain 6% bleed margin — useful for keeping type off the edge, not a platform rule.
 */
export function buildSafeZoneGuide(ratio) {
  const { width: W, height: H } = guideDimensions(ratio);
  const zone = SAFE_ZONE_RATIOS[ratio];
  const top = Math.round(H * (zone ? zone.top : 0.06));
  const bottom = Math.round(H * (zone ? zone.bottom : 0.06));
  const side = Math.round(W * (zone ? zone.sides : 0.06));
  const reels = zone ? Math.round(H * 0.35) : null;
  const fs = Math.max(12, Math.round(W * 0.022));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#ff2d55" stroke-width="3"/>
${zone ? `  <rect x="0" y="0" width="${W}" height="${top}" fill="#ff2d55" fill-opacity="0.14"/>
  <rect x="0" y="${H - bottom}" width="${W}" height="${bottom}" fill="#ff2d55" fill-opacity="0.14"/>
  <line x1="0" y1="${H - reels}" x2="${W}" y2="${H - reels}" stroke="#ff8c00" stroke-width="2" stroke-dasharray="10 8"/>
  <text x="10" y="${H - reels - 8}" font-family="Arial, sans-serif" font-size="${fs}" fill="#ff8c00">Reels controls reach up to here</text>
` : ''}  <rect x="${side}" y="${top}" width="${W - side * 2}" height="${H - top - bottom}" fill="none" stroke="#00c2ff" stroke-width="3" stroke-dasharray="16 12"/>
  <text x="${side + 8}" y="${top + fs + 8}" font-family="Arial, sans-serif" font-size="${fs}" fill="#00c2ff">SAFE ZONE — set all type inside this box</text>
${zone ? `  <text x="10" y="${top - 10}" font-family="Arial, sans-serif" font-size="${fs}" fill="#ff2d55">Platform UI covers this band</text>
` : ''}</svg>`;
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
