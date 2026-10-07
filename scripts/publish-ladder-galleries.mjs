#!/usr/bin/env node
/**
 * Publish the ladder-tier galleries rendered by scripts/build-ladder-galleries.mjs.
 *
 *   node scripts/publish-ladder-galleries.mjs [--only <handle>] [--apply]
 *
 * Dry by default. For each tier it builds this gallery, in order:
 *   1. one generated hero per variant, ATTACHED to that variant — the default
 *      product template runs with hide_variants: true, so an attached image shows
 *      only for its own variant and is the cart / checkout thumbnail for it;
 *   2. the generated offer frame;          3. the generated in-home scene;
 *   4. the base PDP's approved frames (mechanism, proof, not-in-it, benefits,
 *      compare, how-to, real lifestyle photos) — same physical product, already
 *      reviewed. The base OFFER frame is never copied: it prices a different pack.
 *
 * Rendered frames are read from every run under the MAIN checkout's
 * data/creatives/ladder-galleries/ (the newest passing file per frame wins), and
 * only top-level files are read — a render that failed its vision check lives in
 * _rejected/ and cannot be published from here.
 *
 * SAFETY, each from a rule that has cost real work:
 *   - A product is skipped unless EVERY frame is present. A half gallery with one
 *     variant's hero missing would show the previous variant's image in the cart.
 *   - Existing media is downloaded full-size to data/archive/ BEFORE it is deleted:
 *     deleting a Shopify product image destroys the CDN file (2026-08-12).
 *   - Alt text goes through the commercial-surface claim gate and the ruled-word
 *     list before anything is written.
 *   - coconut-deodorant-4-pack moves off `scoped-gallery` onto the default template
 *     in the same run that removes its gang-scoped (#scent_) media, never before:
 *     those images would render for no variant on a hide_variants: true template.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { getAccessToken, getProducts } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';
import { checkSeoCopyFields, COMMERCIAL_SURFACE } from '../lib/seo-copy-health-gate.js';
import { TIERS, UNIT, unitsFor, offerCopy, representativeVariant, sceneUnits, composition, slugify } from '../lib/ladder-gallery.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const RULED = /mineral oil|petrolatum|dimethicone|antiperspirant/i;
const INHERIT = /(mechanism|one-ingredient|ingredients-pdp|proof|not-in-it|whats-not-in-it|benefits|compare|how-to|lifestyle|in-use-real|beach-real)/i;
const STAMP = '2026-10-07';

const MAIN = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim());
const RENDERS = join(MAIN, 'data', 'creatives', 'ladder-galleries');
const ARCHIVE = join(ROOT, 'data', 'archive', `ladder-galleries-${STAMP}`);
const OUTBOX = join(MAIN, 'data', 'creatives', 'ladder-galleries', '_publish');

const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const BASE = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (src) => src.split('/').pop().split('?')[0];
const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));

/** Newest passing render of one frame across every run directory. */
function newestRender(handle, name) {
  if (!existsSync(RENDERS)) return null;
  const runs = readdirSync(RENDERS).filter((d) => /^\d{4}-/.test(d)).sort().reverse();
  for (const run of runs) {
    const p = join(RENDERS, run, handle, `${name}.png`);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

async function toJpeg(png, name) {
  mkdirSync(OUTBOX, { recursive: true });
  const out = join(OUTBOX, `${name}.jpg`);
  await sharp(png).resize(2048, 2048, { fit: 'inside' }).jpeg({ quality: 90, mozjpeg: true }).toFile(out);
  return out;
}

function gateAlt(alt, where) {
  if (RULED.test(alt)) throw new Error(`${where}: alt carries a ruled word — "${alt}"`);
  const g = checkSeoCopyFields({ alt }, { surface: COMMERCIAL_SURFACE });
  if (g.blocking?.length) throw new Error(`${where}: alt fails the claim gate (${g.blocking.map((b) => b.match).join(', ')})`);
  return alt.replace(/\s+/g, ' ').trim().slice(0, 512);
}

async function rest(method, path, body) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    const j = method === 'DELETE' ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }
  throw new Error(`${method} ${path} → rate limited`);
}

for (const [handle, tier] of Object.entries(TIERS)) {
  if (ONLY && ONLY !== handle) continue;
  const bundle = bundles.find((b) => b.handle === handle);
  const unit = UNIT[tier.base];
  const product = (await getProducts({ handle }))?.[0];
  const base = (await getProducts({ handle: tier.base }))?.[0];
  if (!product || !base) throw new Error(`${handle} or ${tier.base} not found`);
  const basePrice = Number(base.variants[0].price);
  console.log(`\n══ ${handle} — ${product.images.length} images live, template ${product.template_suffix || '(default)'}`);

  // ── Assemble the gallery, refusing a partial one ──
  const plan = [];
  const missing = [];
  for (const v of bundle.variants) {
    const title = v.options[tier.option];
    const lv = product.variants.find((x) => x.title === title || x.option1 === title);
    if (!lv) throw new Error(`${handle}: no live variant "${title}"`);
    const name = `hero-${slugify(title)}`;
    const png = newestRender(handle, name);
    if (!png) { missing.push(name); continue; }
    const units = unitsFor(tier, v);
    plan.push({ kind: 'hero', name, png, variant_ids: [lv.id],
      alt: gateAlt(`${bundle.title}, ${title}: ${units.length} ${unit.plural} — ${composition(units)}`, `${handle}/${name}`) });
  }
  const rep = representativeVariant(bundle);
  const copy = offerCopy({ tier, unit, variant: rep, basePrice });
  const offer = newestRender(handle, 'offer');
  if (!offer) missing.push('offer');
  else plan.push({ kind: 'offer', name: 'offer', png: offer,
    alt: gateAlt(`${bundle.title} — ${copy.headline.toLowerCase()}, ${copy.price}, ${copy.sub}`, `${handle}/offer`) });
  const scene = newestRender(handle, 'scene');
  if (!scene) missing.push('scene');
  else plan.push({ kind: 'scene', name: 'scene', png: scene,
    alt: gateAlt(`${bundle.title} at home — ${composition(sceneUnits(tier, bundle))}`, `${handle}/scene`) });
  if (missing.length) { console.log(`  SKIP — gallery incomplete, missing ${missing.join(', ')}`); continue; }

  for (const im of [...base.images].sort((a, b) => a.position - b.position)) {
    const f = fileOf(im.src);
    if (!INHERIT.test(f) || /offer/i.test(f)) continue;
    plan.push({ kind: 'inherit', name: f, src: im.src, alt: gateAlt(im.alt || '', `${handle}/inherit ${f}`) });
  }

  for (const [i, p] of plan.entries()) console.log(`  ${String(i + 1).padStart(2)} ${p.kind.padEnd(7)} ${p.name}${p.variant_ids ? ` → variant ${p.variant_ids[0]}` : ''}`);
  const old = [...product.images].sort((a, b) => a.position - b.position);
  console.log(`  replaces ${old.length} existing image(s): ${old.map((o) => fileOf(o.src)).join(', ') || 'none'}`);
  if (product.template_suffix === 'scoped-gallery') console.log('  template scoped-gallery → default (gang-scoped media are all being replaced)');
  if (!APPLY) continue;

  // ── Archive, then clear ──
  if (old.length) {
    const dir = join(ARCHIVE, handle);
    mkdirSync(dir, { recursive: true });
    for (const o of old) {
      const r = await fetch(o.src.split('?')[0]);
      if (!r.ok) throw new Error(`REFUSE: could not archive ${o.src} (${r.status}) — nothing deleted`);
      writeFileSync(join(dir, fileOf(o.src)), Buffer.from(await r.arrayBuffer()));
    }
    writeFileSync(join(dir, 'images.json'), JSON.stringify(old.map((o) => ({ id: o.id, position: o.position, alt: o.alt, src: o.src, variant_ids: o.variant_ids })), null, 2));
    console.log(`  archived ${old.length} → ${dir}`);
  }

  // ── Upload new frames first, so the product is never left imageless ──
  let pos = 1;
  for (const p of plan) {
    const bytes = p.png ? readFileSync(await toJpeg(p.png, `${handle}-${p.name}`)) : Buffer.from(await (await fetch(p.src.split('?')[0])).arrayBuffer());
    const filename = p.png ? `${handle}-${p.name}.jpg` : p.name;
    const body = { image: { attachment: bytes.toString('base64'), filename, alt: p.alt, position: pos++, ...(p.variant_ids ? { variant_ids: p.variant_ids } : {}) } };
    const j = await rest('POST', `/products/${product.id}/images.json`, body);
    console.log(`  ✓ ${p.name} → id ${j.image.id}`);
    await sleep(700);
  }
  for (const o of old) { await rest('DELETE', `/products/${product.id}/images/${o.id}.json`); await sleep(500); }
  if (old.length) console.log(`  ✓ removed ${old.length} old image(s)`);

  if (product.template_suffix === 'scoped-gallery') {
    await rest('PUT', `/products/${product.id}.json`, { product: { id: product.id, template_suffix: '' } });
    console.log('  ✓ template → default');
  }

  // ── Verify ──
  await sleep(1500);
  const after = (await getProducts({ handle }))[0];
  const heroIds = new Map(after.images.map((im) => [im.id, fileOf(im.src)]));
  for (const v of after.variants) {
    const img = v.image_id ? heroIds.get(v.image_id) : null;
    if (!img || !img.startsWith(`${handle}-hero-`)) throw new Error(`VERIFY: variant "${v.title}" has image ${img || 'none'}`);
  }
  console.log(`  verified: ${after.images.length} images, every variant on its own hero, template ${after.template_suffix || '(default)'}`);
}
if (!APPLY) console.log('\nDry run. Re-run with --apply to write.');
