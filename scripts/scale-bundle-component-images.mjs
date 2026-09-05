#!/usr/bin/env node
/**
 * Re-scale EVERY bundle-lander component image to one global scale, so a bar of
 * soap stops rendering as tall as a lotion bottle.
 *
 *   node scripts/scale-bundle-component-images.mjs --theme <preview id>
 *   node scripts/scale-bundle-component-images.mjs --theme <preview id> --apply
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * `whats-in-it` renders every component through
 * `.wib__card img{width:100%;height:clamp(200px,30vw,300px);object-fit:contain}`.
 * `contain` fits each image to its own box, so rendered size is decided by how
 * much of ITS canvas each product fills — not by how big the product is.
 *
 * Measured on the live theme: 13 of the 15 component assets are a tight crop
 * filling 100% of a 420px-tall canvas. Five of them are narrow enough to be
 * height-limited in the card, so at a ~182x300 box a 2oz deodorant, a 4oz
 * toothpaste tube, a 0.15oz lip balm and an 8oz lotion bottle ALL render at
 * exactly 300px. (The bar soap is the one exception: its canvas is square, so it
 * is width-limited and already renders shorter, at ~182px. That accident is why
 * the soap looked least wrong and is not a reason to leave it alone.)
 *
 * ── HOW THE TARGET FRACTIONS WERE DERIVED, NOT GUESSED ──────────────────────
 * Two real measurements per product, no tape measure required:
 *
 *   1. VOLUME, from the Shopify variant titles / catalogue (8oz lotion, 4oz
 *      cream, 2oz deodorant, 4oz toothpaste, 3.4oz bar, 8oz foaming hand soap).
 *   2. ASPECT RATIO, from the asset itself — every source is a tight crop, so
 *      its pixel width/height IS the product's real width/height ratio.
 *
 * For a roughly prismatic container, V ~ k*W^2*H; with r = W/H that gives
 * H ~ (V / (k r^2))^(1/3). Sanity check against the real world — the model puts
 * the 4oz cream jar at 2.14in, the 4oz toothpaste tube at 5.4in, the deodorant
 * at 3.6in and the 8oz foaming pump at 7.41in, anchoring the 8oz lotion bottle
 * at 6.5in. Those are all right, which is the evidence that the model holds.
 *
 * The lip balm is the one product the model CANNOT do, though not for the reason
 * its "4-pack" label suggests — the asset is 96x420, which is one tube, not four
 * side by side. It fails because a twist-up tube is mostly MECHANISM: 0.15oz of
 * product in a 2.75in body, so volume badly under-represents height and the model
 * returns ~2.0in. It is anchored directly instead, on a real 2.75in tube against
 * the 6.5in bottle. Volume is a fair proxy for height only where the container is
 * mostly full of the thing it sells.
 *
 * ── THE ONE JUDGEMENT, AND WHOSE IT IS ──────────────────────────────────────
 * True scale alone renders a bar of soap at 29% of a lotion bottle, which is
 * accurate and too small to read. The operator has expressed this preference
 * exactly once, on the Coconut Reset: true cream/lotion is 0.330 and they
 * shipped 0.405, having asked for the first attempt to be 20% larger. That single
 * data point is fitted as a compression exponent, shown = true^GAMMA, so
 * everything small is lifted by the same rule rather than by taste applied 15
 * times. GAMMA < 1 can never reorder two products.
 *
 * ── WHY ONE GLOBAL SCALE AND NOT ONE PER LANDER ─────────────────────────────
 * The assets are SHARED. `head-to-toe` contains the hand soap, the tallest thing
 * in the catalogue, while `clean-swap` tops out at the lotion — so a per-lander
 * normalisation wants lotion at 0.899 on one page and 1.000 on another, and one
 * file cannot be both. Normalising everything to the tallest product in the
 * CATALOGUE gives each asset exactly one correct fraction, and preserves true
 * relative scale across landers as a bonus.
 *
 * It also costs the operator's approved ratio nothing, which is the point worth
 * checking before running this: on the Reset lander cream goes 0.405 -> 0.364 and
 * lotion goes 1.000 -> 0.899, and 0.364/0.899 = 0.405. The approved RELATIONSHIP
 * is exactly preserved; both simply gain some headroom above them.
 *
 * ── GUARDS ──────────────────────────────────────────────────────────────────
 * Refuses the live theme outright — there is no override, because this rewrites
 * 15 assets at once and the whole point is to eyeball a preview first. Refuses an
 * already-padded source (scaling a scaled image compounds the ratio silently).
 * Backs every original up before writing. Dry by default.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { alreadyPadded } from './scale-theme-component-image.mjs';
import { resolveLiveThemeId, UNRESOLVED_LIVE_THEME_REASON } from '../lib/shopify-live-theme.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/** Measured volume (fl oz) and the tight-crop pixel aspect of each product. */
export const PRODUCTS = Object.freeze({
  lotion:     { oz: 8,   w: 123, h: 420 },
  cream:      { oz: 4,   w: 186, h: 170 },  // h is the ART height; this asset is already padded
  deodorant:  { oz: 2,   w: 149, h: 420 },
  toothpaste: { oz: 4,   w: 115, h: 420 },
  soap:       { oz: 3.4, w: 420, h: 420 },
  handsoap:   { oz: 8,   w: 101, h: 420 },
});

/** The lip balm asset shows a 4-pack, so aspect cannot model it: anchor on a real tube. */
export const LIPBALM_INCHES = 2.75;
export const LOTION_INCHES = 6.5;

/** Fitted to the operator's single expressed preference — see the header. */
export const GAMMA = 0.8145;

/** @returns {Record<string, number>} model height units per product kind */
export function modelHeights(products = PRODUCTS) {
  const h = {};
  for (const [k, p] of Object.entries(products)) {
    const r = p.w / p.h;
    h[k] = Math.cbrt(p.oz / (r * r));
  }
  h.lipbalm = h.lotion * (LIPBALM_INCHES / LOTION_INCHES);
  return h;
}

/** @returns {Record<string, number>} the fraction of canvas height each kind should occupy */
export function targetFractions(heights = modelHeights(), gamma = GAMMA) {
  const tallest = Math.max(...Object.values(heights));
  const out = {};
  for (const [k, v] of Object.entries(heights)) out[k] = Number((v / tallest) ** gamma).toFixed(4) * 1;
  return out;
}

/** `assets/component-<kind>-<scent>.webp` -> kind */
export function kindOf(key) {
  const m = /component-([a-z]+)-/.exec(key);
  return m ? m[1] : null;
}

export function parseArgs(argv) {
  const a = { apply: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--theme') a.theme = argv[++i];
    else if (t === '--only') a.only.push(argv[++i]);
    else if (t === '--apply') a.apply = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

export function validate(a, liveThemeId) {
  if (!a.theme) return { ok: false, reason: '--theme is required — this never guesses a target' };
  if (!liveThemeId) return { ok: false, reason: UNRESOLVED_LIVE_THEME_REASON };
  if (String(a.theme) === String(liveThemeId)) {
    return { ok: false, reason: `theme ${liveThemeId} is LIVE. This rewrites 15 assets at once; preview it first. There is no override.` };
  }
  return { ok: true };
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  if (a.help) { console.log('Usage: --theme <preview id> [--only <asset key>]... [--apply]'); return 0; }
  // Resolved from the API, never a constant. A failure yields null, which
  // makes validate() REFUSE rather than write to an unverified target.
  const liveThemeId = await resolveLiveThemeId();
  const v = validate(a, liveThemeId);
  if (!v.ok) { console.error(`REFUSED: ${v.reason}`); return 64; }

  const sharp = (await import('sharp')).default;
  const { getThemeAssetRaw, getAccessToken, listThemeAssets } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');

  const fractions = targetFractions();
  console.log('target fraction of canvas height, one global scale (tallest product = 1.0):');
  for (const [k, f] of Object.entries(fractions).sort((x, y) => y[1] - x[1])) console.log(`  ${k.padEnd(12)} ${f.toFixed(3)}`);
  console.log();

  const all = await listThemeAssets(a.theme);
  let keys = all.map((x) => x.key).filter((k) => /^assets\/component-.*\.webp$/.test(k)).sort();
  if (a.only.length) keys = keys.filter((k) => a.only.some((o) => k.includes(o)));

  const dir = join(ROOT, 'data', 'reports', 'component-image-scale');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let changed = 0, skipped = 0, refused = 0;

  for (const key of keys) {
    const kind = kindOf(key);
    const fraction = fractions[kind];
    if (!fraction) { console.log(`  UNKNOWN KIND  ${key}`); refused += 1; continue; }

    const asset = await getThemeAssetRaw(a.theme, key);
    if (!asset?.attachment) { console.log(`  NO ATTACHMENT ${key}`); refused += 1; continue; }
    const buf = Buffer.from(asset.attachment, 'base64');
    const meta = await sharp(buf).metadata();

    if (await alreadyPadded(sharp(buf))) {
      console.log(`  ALREADY PADDED ${key} — re-pad from the ORIGINAL, not from this file`);
      refused += 1;
      continue;
    }
    if (fraction >= 0.999) { console.log(`  UNCHANGED     ${key} (${kind} is the tallest product)`); skipped += 1; continue; }

    const H = meta.height;
    const targetH = Math.round(H * fraction);
    const targetW = Math.round(meta.width * (targetH / H));
    console.log(`  SCALE         ${key}  ${meta.width}x${H} -> ${targetW}x${H} (art ${targetH}px, ${fraction.toFixed(3)})`);
    if (!a.apply) { changed += 1; continue; }

    writeFileSync(join(dir, `${key.split('/').pop()}.${a.theme}.${stamp}.original`), buf);
    const scaled = await sharp(buf).resize(targetW, targetH).toBuffer();
    const out = await sharp({ create: { width: targetW, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: scaled, top: H - targetH, left: 0 }])
      .webp({ quality: 90 })
      .toBuffer();

    const store = process.env.SHOPIFY_STORE
      || (await import('node:fs')).readFileSync(join(ROOT, '.env'), 'utf8')
        .match(/^SHOPIFY_STORE=(.*)$/m)[1].replace(/["']/g, '').trim();
    const res = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${a.theme}/assets.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key, attachment: out.toString('base64') } }),
    });
    if (!res.ok) { console.error(`    upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); return 1; }
    changed += 1;
  }

  console.log(`\n${changed} scaled, ${skipped} left at full height, ${refused} refused.`);
  if (!a.apply) console.log('dry run — re-run with --apply.');
  else console.log(`originals backed up under ${dir}`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
