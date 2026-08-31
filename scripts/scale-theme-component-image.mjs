#!/usr/bin/env node
/**
 * Re-scale a bundle component image so a grid of them reads at true relative size.
 *
 *   node scripts/scale-theme-component-image.mjs --key assets/component-cream-coconut-breeze.webp \
 *          --fraction 0.405 --theme 148422066346
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * `whats-in-it` renders every component through
 * `.wib__card img{height:<box>;object-fit:contain}`. `contain` scales each image
 * to fit ITS OWN box, so the rendered size is decided entirely by how much of its
 * canvas the product fills — not by how big the product really is.
 *
 * On the Coconut Reset both files were 420px tall with the product filling 100%
 * of the height, so an 8oz bottle (~6.5in) and a 4oz jar (~2.2in) rendered at
 * IDENTICAL height. The jar, being 3.7x wider, then dominated the row and the
 * bottle read as miniature — the opposite of the truth, since the bottle holds
 * twice the volume.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * Pad the shorter product's canvas with transparency above it, so it occupies
 * only `--fraction` of the shared canvas height. The CSS stays generic (one rule
 * for every component) and the physical proportion lives in the asset, where it
 * belongs. No re-shoot and no regeneration — the artwork is untouched, it just
 * sits in a taller frame.
 *
 * ── WHY THE FRACTION IS AN ARGUMENT AND NOT A CONSTANT ──────────────────────
 * It is a JUDGEMENT, not a measurement. It began as an estimate from standard
 * container heights (6.5in / 2.2in = 0.34) and was then set by eye to 0.405,
 * because the operator looked at it and said the first ratio "just didn't look
 * right". Nobody has put a tape measure to these products. Baking that number
 * into the code would disguise a preference as a fact.
 *
 * ── TWO GUARDS ──────────────────────────────────────────────────────────────
 * 1. REFUSES AN ALREADY-PADDED SOURCE. Scaling a scaled image compounds
 *    encoding artefacts, and worse, silently compounds the RATIO — run it twice
 *    at 0.4 and the product is at 0.16 with nothing to say so. If the top band
 *    is already transparent, this stops.
 * 2. REFUSES THE LIVE THEME without --allow-live-theme, and backs the original
 *    up before any write. Same shape as scripts/theme-cli.mjs.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_THEME_ID = '147480051882';

export function parseArgs(argv) {
  const a = { allowLive: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--key') a.key = argv[++i];
    else if (t === '--fraction') a.fraction = Number(argv[++i]);
    else if (t === '--theme') a.theme = argv[++i];
    else if (t === '--allow-live-theme') a.allowLive = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

/** @returns {{ok:true}|{ok:false, reason:string}} */
export function validate(a) {
  if (!a.key) return { ok: false, reason: '--key is required' };
  if (!Number.isFinite(a.fraction)) return { ok: false, reason: '--fraction is required' };
  if (a.fraction <= 0 || a.fraction > 1) return { ok: false, reason: '--fraction must be in (0, 1]' };
  if (!a.theme) return { ok: false, reason: '--theme is required — this never guesses a target' };
  if (String(a.theme) === LIVE_THEME_ID && !a.allowLive) {
    return { ok: false, reason: `theme ${LIVE_THEME_ID} is LIVE; pass --allow-live-theme if you mean it` };
  }
  return { ok: true };
}

/**
 * Is this canvas already padded? True when the top row is fully transparent,
 * which a tight product crop never is.
 */
export async function alreadyPadded(sharpInstance) {
  const { data, info } = await sharpInstance.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let x = 0; x < info.width; x += 1) {
    if (data[x * info.channels + 3] > 8) return false;
  }
  return true;
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  if (a.help) {
    console.log('Usage: --key <asset> --fraction <0..1> --theme <id> [--allow-live-theme]');
    return 0;
  }
  const v = validate(a);
  if (!v.ok) { console.error(`REFUSED: ${v.reason}`); return 64; }

  const sharp = (await import('sharp')).default;
  const { getThemeAssetRaw, getAccessToken } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');

  // A binary theme asset comes back as base64 `attachment`; `public_url` is only
  // on the LIST response, not the single-asset fetch. Preferring the attachment
  // also avoids a CDN round-trip that can serve a stale cached copy.
  const asset = await getThemeAssetRaw(a.theme, a.key);
  let buf;
  if (asset?.attachment) buf = Buffer.from(asset.attachment, 'base64');
  else if (asset?.public_url) buf = Buffer.from(await (await fetch(asset.public_url)).arrayBuffer());
  else { console.error(`REFUSED: ${a.key} returned neither an attachment nor a public_url on theme ${a.theme}`); return 1; }

  const src = sharp(buf);
  const meta = await src.metadata();
  if (await alreadyPadded(sharp(buf))) {
    console.error(`REFUSED: ${a.key} is already padded (its top row is transparent).`);
    console.error('Scaling a scaled image compounds both the artefacts and the RATIO. Re-pull the original first.');
    return 65;
  }

  const H = meta.height;
  const targetH = Math.round(H * a.fraction);
  const targetW = Math.round(meta.width * (targetH / H));
  const scaled = await sharp(buf).resize(targetW, targetH).toBuffer();
  const out = await sharp({ create: { width: targetW, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: scaled, top: H - targetH, left: 0 }])
    .webp({ quality: 90 })
    .toBuffer();

  const dir = join(ROOT, 'data', 'reports', 'component-image-scale');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(dir, `${a.key.split('/').pop()}.${a.theme}.${stamp}.original`);
  writeFileSync(backup, buf);

  console.log(`${a.key}`);
  console.log(`  source   ${meta.width}x${meta.height}  (product fills the full height)`);
  console.log(`  padded   ${targetW}x${H}  (art ${targetH}px, ${H - targetH}px transparent above)`);
  console.log(`  fraction ${a.fraction}`);
  console.log(`  original backed up -> ${backup}`);

  const store = process.env.SHOPIFY_STORE
    || (await import('node:fs')).readFileSync(join(ROOT, '.env'), 'utf8')
      .match(/^SHOPIFY_STORE=(.*)$/m)[1].replace(/["']/g, '').trim();
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${a.theme}/assets.json`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset: { key: a.key, attachment: out.toString('base64') } }),
  });
  if (!res.ok) { console.error(`upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); return 1; }
  console.log(`  uploaded to theme ${a.theme}`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
