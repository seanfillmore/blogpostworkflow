// agents/ad-batch/vertical.js
//
// The 9:16 Stories/Reels version of a kept 4:5 ad (Sean, 2026-11-07: "we should be
// building both aspect ratios each time"). Reels and Stories took 38% of 30-day spend
// while every static was 4:5.
//
// The 4:5 is NOT re-rendered at 9:16. Asked to recompose the ad for a tall frame and keep
// text out of the bands Meta draws its UI over, gpt-image-2 and Gemini put the headline
// at 5-13% from the top on every attempt (2026-11-07 live tests), inside the 14% band.
// So the approved 4:5 is placed, centered, on a 9:16 canvas and the model only fills the
// empty bands above and below it (a masked edit). Text and label positions are then
// fixed by construction: a centered 4:5 occupies 14.9%-85.1% of the height, below Meta's
// top band, and a label in the 4:5's lower body lands around 70%. The check still reads
// every render and measures the bands (check.js safeZoneReasons), because the model
// redraws the whole frame and a 4:5 with text near its bottom edge can still reach the
// bottom band.

import sharp from 'sharp';
import { OPENAI_SIZES } from './render.js';

export const VERTICAL_SIZE = OPENAI_SIZES['9:16'].split('x').map(Number); // [w, h]
const FEED_SIZE = OPENAI_SIZES['4:5'].split('x').map(Number);
const GREY = { r: 128, g: 128, b: 128 };

export const OUTPAINT_PROMPT = 'This is a finished vertical ad with empty bands at the top and bottom. Fill ONLY those empty bands by extending the existing scene and background seamlessly upward and downward (more wall, sky, surface, table, floor or backdrop, matching its light and style). Keep every part of the existing picture exactly as it is: do not move, redraw, resize or restyle anything, and keep all lettering and the product label exactly where and how they are. Add NO new text, letters, logos, products or characters in the new bands.';

export const GEMINI_OUTPAINT_PROMPT = 'This is a finished vertical ad with two flat grey bands, one at the top and one at the bottom. Replace ONLY those grey bands by extending the existing scene and background seamlessly upward and downward, matching its light and style. Keep everything else exactly as it is: do not move, redraw, resize or restyle anything, and keep all lettering and the product label exactly where and how they are. Add NO new text, letters, logos, products or characters. Output the full image at the same 9:16 size.';

/** Where the 4:5 sits on the 9:16 canvas: full width, vertically centered. */
export function placement([w, h] = VERTICAL_SIZE, [fw, fh] = FEED_SIZE) {
  const scale = w / fw;
  const ph = Math.round(fh * scale);
  return { width: w, height: h, top: Math.round((h - ph) / 2), innerHeight: ph };
}

/**
 * Canvas (4:5 centered, transparent bands), mask (transparent = fill, opaque = keep) and a
 * grey-band version for Gemini, which takes no mask.
 */
export async function buildOutpaintInputs(feedPath) {
  const { width, height, top, innerHeight } = placement();
  const feed = await sharp(feedPath).resize(width, innerHeight, { fit: 'fill' }).png().toBuffer();
  const blank = (bg) => sharp({ create: { width, height, channels: 4, background: bg } });
  const canvas = await blank({ r: 0, g: 0, b: 0, alpha: 0 }).composite([{ input: feed, top, left: 0 }]).png().toBuffer();
  const keep = await sharp({ create: { width, height: innerHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  const mask = await blank({ r: 0, g: 0, b: 0, alpha: 0 }).composite([{ input: keep, top, left: 0 }]).png().toBuffer();
  const greyCanvas = await blank({ ...GREY, alpha: 1 }).composite([{ input: feed, top, left: 0 }]).png().toBuffer();
  return { canvas, mask, greyCanvas, top, innerHeight, width, height };
}
