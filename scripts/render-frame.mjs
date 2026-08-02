#!/usr/bin/env node
/**
 * Render a typographic / composited product-gallery frame to a JPEG.
 *
 *   node scripts/render-frame.mjs <frame.mjs> [--out DIR] [--open]
 *
 * Why this exists rather than sending every frame to the image model:
 * `docs/bundle-media-plan.md` §3 routes typographic frames to GENERATE, but a
 * generative model approximates the typeface, cannot be trusted to spell "4.84",
 * and bakes the number in permanently. Several bundle frames carry figures that
 * live in Shopify metafields and genuinely move — three bundles repriced on
 * 2026-07-31, and the plan's own note is that a price baked into a JPEG is the
 * one thing a metafield edit cannot correct.
 *
 * So: frames whose content is type over a brand field are rendered here, from
 * the live data, in the real brand faces, reproducibly. Re-run after a metafield
 * change and the asset is correct again. The image model stays for the frames
 * that need a photographic scene (media plan frames 4, 6, 7).
 *
 * A frame module exports:
 *   {
 *     product: 'shopify-handle',      // metafields + variants are fetched and passed in
 *     name:    'frame-05-reviews',
 *     related: ['handle', ...],       // optional; other products this frame makes a claim about,
 *                                     // reachable as ctx.related[handle].priceOf('Variant')
 *     width, height,                  // px; 2048² matches the shipped heroes
 *     alt(ctx):  string,              // REQUIRED — the uploader refuses to ship without it
 *     html(ctx): string,              // full <body> content; fonts are injected
 *     verify(ctx): void,              // REQUIRED — throw if live data contradicts the frame
 *   }
 *
 * `verify` is the point of the whole design. A frame that states a fact must
 * assert that fact against live data before it renders, so the failure mode is a
 * crashed build rather than a confident wrong claim sitting in a gallery.
 *
 * Output is written next to a sidecar .json recording the model-free provenance:
 * which metafields were read, their values, and when. Upload with
 * scripts/upload-product-images.mjs, which enforces alt text.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import puppeteer from 'puppeteer';
import { getAccessToken } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(ROOT, 'data', 'brand', 'fonts');
const site = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const argv = process.argv.slice(2);
const framePath = argv.find((a) => !a.startsWith('--'));
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(ROOT, 'data', 'brand', 'bundle-images');
if (!framePath) { console.error('usage: render-frame.mjs <frame.mjs> [--out DIR]'); process.exit(2); }

const frame = (await import(pathToFileURL(resolve(framePath)).href)).default;
for (const k of ['product', 'name', 'html', 'alt', 'verify']) {
  if (!frame[k]) throw new Error(`${basename(framePath)}: frame module must export "${k}"`);
}

/** Brand faces, inlined so the render never depends on a network font or a locally installed one. */
function fontFaceCss() {
  const faces = {
    'cabin-400.woff2': ['Cabin', 400], 'cabin-700.woff2': ['Cabin', 700],
    'outfit-300.woff2': ['Outfit', 300], 'outfit-400.woff2': ['Outfit', 400], 'outfit-600.woff2': ['Outfit', 600],
  };
  const present = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2'));
  const missing = Object.keys(faces).filter((f) => !present.includes(f));
  if (missing.length) throw new Error(`missing brand fonts in data/brand/fonts: ${missing.join(', ')}`);
  return Object.entries(faces).map(([file, [family, weight]]) => {
    const b64 = readFileSync(join(FONT_DIR, file)).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;`
      + `src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  }).join('\n');
}

const gql = async (query, variables) => {
  const token = await getAccessToken();
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
};

// ── live data ────────────────────────────────────────────────────────────────
const PRODUCT_Q = `id title handle status descriptionHtml
     variants(first:50){edges{node{ id title price }}}
     metafields(first:50,namespace:"bundle"){edges{node{key value}}}`;

const product = (await gql(
  `query($h:String!){ productByHandle(handle:$h){ ${PRODUCT_Q} } }`,
  { h: frame.product },
)).productByHandle;
if (!product) throw new Error(`no product with handle ${frame.product}`);

/**
 * A frame may declare `related: ['handle', ...]` when it states a fact about a
 * product other than the one it hangs on — a component's price, or a gift the
 * bundle does not itself contain. Without this a frame can only assert what is
 * on its own product, which is how a claim about someone else's price ends up
 * hard-coded and unverified. Fetched with the same shape so verify() reads them
 * identically.
 */
const related = {};
for (const handle of frame.related ?? []) {
  const p = (await gql(`query($h:String!){ productByHandle(handle:$h){ ${PRODUCT_Q} } }`, { h: handle })).productByHandle;
  if (!p) throw new Error(`${frame.name}: related product "${handle}" does not exist`);
  related[handle] = {
    ...p,
    variants: p.variants.edges.map((e) => e.node),
    mf: Object.fromEntries(p.metafields.edges.map((e) => [e.node.key, e.node.value])),
    /** Price of one named variant, as a Number. Throws rather than returning NaN. */
    priceOf(variantTitle) {
      const v = this.variants.find((x) => x.title === variantTitle);
      if (!v) throw new Error(`${frame.name}: ${handle} has no variant "${variantTitle}"`);
      return Number(v.price);
    },
  };
}

const mf = Object.fromEntries(product.metafields.edges.map((e) => [e.node.key, e.node.value]));
const ctx = {
  product,
  mf,
  related,
  /** Plain-text product description, for frames whose claim is made in the PDP copy. */
  description: product.descriptionHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  /**
   * The rendered storefront page for this product, as plain text.
   *
   * Not every claim lives in product data. An offer written into a theme section
   * — the Sensitive Skin Set's first-subscription gift is one — appears nowhere
   * in descriptionHtml or in a metafield, so a frame that states it can only be
   * checked against the page itself. That is also the stronger check: it asserts
   * against the surface the buyer actually reads, not against a field that may
   * have stopped driving the template. Fetched at most once per render.
   */
  async livePage() {
    if (!this._page) {
      const url = `${site.url}/products/${product.handle}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`${frame.name}: ${url} returned HTTP ${r.status} — cannot verify against the live page`);
      this._page = (await r.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    }
    return this._page;
  },
  variants: product.variants.edges.map((e) => e.node),
  /** Read a metafield that MUST exist. Frames state facts; a missing fact is a build failure. */
  need(key) {
    if (mf[key] === undefined) throw new Error(`${frame.name}: required metafield bundle.${key} is not set on ${frame.product}`);
    return mf[key];
  },
  /**
   * Inline a repo asset as a data URI, so a composited frame carries real
   * photography without the render depending on the network. Path is relative to
   * the repo root. Only ever point this at a photograph of the actual product —
   * media plan §3: anything depicting what arrives in the box must be real.
   */
  asset(relPath) {
    const abs = join(ROOT, relPath);
    if (!existsSync(abs)) throw new Error(`${frame.name}: asset not found: ${relPath}`);
    const ext = relPath.split('.').pop().toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext];
    if (!mime) throw new Error(`${frame.name}: unsupported asset type .${ext}`);
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
  },
};

console.log(`${product.title}  (${product.handle}, ${product.status})`);
await frame.verify(ctx);
console.log(`  verify: ok`);

// ── render ───────────────────────────────────────────────────────────────────
const { width, height } = frame;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaceCss()}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
</style></head><body>${frame.html(ctx)}</body></html>`;

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ type: 'png' });
await browser.close();

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${frame.name}.jpg`);
const outProvenance = join(outDir, `${frame.name}.provenance.json`);

/**
 * Frame names share one flat output directory, so two products can silently
 * claim the same file. That is not hypothetical: the Sensitive Skin Set's review
 * frame was first called `frame-05-reviews`, which is also the Reset's, and
 * rendering it overwrote a shipped asset with no warning at all — it surfaced
 * only because git reported the file as modified rather than added.
 *
 * A name is allowed to be reused across renders of the SAME product (that is how
 * a frame is re-rendered); it is never allowed to cross products.
 */
if (existsSync(outProvenance)) {
  const prior = JSON.parse(readFileSync(outProvenance, 'utf8'));
  if (prior.product && prior.product !== frame.product) {
    throw new Error(
      `${frame.name}.jpg already belongs to "${prior.product}" — this frame is for "${frame.product}". `
      + `Two frames cannot share an output name. Rename this frame before rendering.`);
  }
}
// Same treatment as the shipped heroes: quality 85, full resolution. Shopify
// derives its own responsive sizes and WebP/AVIF from the original, so
// downscaling here would only discard zoom detail.
await sharp(png).jpeg({ quality: 85, chromaSubsampling: '4:2:0', progressive: true }).toFile(outFile);

const alt = frame.alt(ctx);
if (!alt?.trim()) throw new Error(`${frame.name}: alt() returned nothing`);
// Shopify hard-rejects alt text over 512 characters, and it does so at upload —
// i.e. after the frame is rendered, committed and queued, with part of a gallery
// already live. A derived alt that lists ingredients drifts past the limit the
// moment a formulation gains one, so the ceiling belongs here, at authoring time.
if (alt.length > 512) {
  throw new Error(
    `${frame.name}: alt() is ${alt.length} characters; Shopify's limit is 512. `
    + `Shorten it here rather than at upload — the uploader fails mid-gallery.`);
}
writeFileSync(join(outDir, `${frame.name}.provenance.json`), JSON.stringify({
  frame: frame.name,
  product: frame.product,
  renderedBy: 'scripts/render-frame.mjs',
  generative: false,
  dimensions: `${width}x${height}`,
  alt,
  metafieldsRead: Object.fromEntries(Object.entries(mf).filter(([k]) => (frame.reads ?? []).includes(k))),
}, null, 2) + '\n');

const kb = Math.round(statSync(outFile).size / 1024);
console.log(`  → ${outFile.replace(ROOT + '/', '')}  ${width}×${height}  ${kb} KB`);
console.log(`  alt: ${alt}`);
