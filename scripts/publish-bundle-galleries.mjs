#!/usr/bin/env node
/**
 * Publish the generated bundle frames (scripts/build-bundle-galleries.mjs).
 *
 *   node scripts/publish-bundle-galleries.mjs [--only <handle>] [--apply]
 *
 * Dry by default. Per bundle and per kit the gallery becomes ORDER below: the new
 * generated frames, then the existing frames worth KEEPING because they carry
 * checked facts (review scores read live, ingredient lists, kit-difference tables,
 * the Reset's digital guides) or are real photographs. Everything else — the
 * cut-out composites and price tables the generated frames replace — is archived
 * full-size to data/archive/ and then deleted (deleting destroys the CDN file).
 *
 * The bundle-landing template GANG-SCOPES media by alt suffix (#kit_gentle) and an
 * unscoped image after a scoped one hides for every variant, so every new image
 * carries its kit's suffix and the publish refuses if any media ends up unscoped.
 * Kept media is never re-uploaded, only re-ordered.
 *
 * A bundle is skipped unless every kit has every new frame — a half-replaced
 * gallery would leave one kit showing the old composites.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { getAccessToken, getProducts } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';
import { checkSeoCopyFields, COMMERCIAL_SURFACE } from '../lib/seo-copy-health-gate.js';
import { BUNDLES, kitUnits, sceneUnitsOf, offerCopy, composition, handleize, scopeSuffix } from '../lib/bundle-gallery.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const STAMP = '2026-10-08';

/** Gallery order per kit. `new:` is a generated frame; anything else is a filename pattern to keep. */
export const ORDER = {
  'clean-swap': ['new:hero', 'new:offer', 'new:scene', /frame-05-swapping-out/, /frame-07-one-oil/, /frame-08-reviews/],
  '90-day-clean-swap': ['new:hero', 'new:offer', 'new:scene', /frame-07-kit-differences/, /frame-06-ingredients/, /frame-04-what-to-expect/, /frame-08-reviews/],
  'head-to-toe': ['new:hero', 'new:offer', 'new:scene', /soap-lotion-cream-bed-real/, /frame-02-routine/, /frame-04-kits/, /frame-05-reviews/],
  'gift-box': ['new:hero', 'new:offer', 'new:scene', /frame-06-box-open/, /frame-04-gentle-gb/, /frame-05-reviews/],
  '99-coconut-reset-digital': [/90-day-reset-/, 'new:offer', /lotion-cream-lounge-real/, 'new:scene', /frame-04-digital-goods/, /frame-07-body-not-face/, /frame-06-ingredients/, /frame-05-reviews/],
};

const MAIN = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim());
const RENDERS = join(MAIN, 'data', 'creatives', 'bundle-galleries');
const OUTBOX = join(RENDERS, '_publish');
const ARCHIVE = join(ROOT, 'data', 'archive', `bundle-galleries-${STAMP}`);

const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const BASE = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}`;
const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOf = (src) => src.split('/').pop().split('?')[0];
const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));

function newestRender(handle, name) {
  if (!existsSync(RENDERS)) return null;
  for (const run of readdirSync(RENDERS).filter((d) => /^\d{4}-/.test(d)).sort().reverse()) {
    const p = join(RENDERS, run, handle, `${name}.png`);
    if (existsSync(p)) return p;
  }
  return null;
}

function gateAlt(alt, where) {
  if (/mineral oil|petrolatum|dimethicone|antiperspirant/i.test(alt)) throw new Error(`${where}: ruled word in alt`);
  const g = checkSeoCopyFields({ alt }, { surface: COMMERCIAL_SURFACE });
  if (g.blocking?.length) throw new Error(`${where}: alt fails the claim gate (${g.blocking.map((b) => b.match).join(', ')})`);
  return alt.replace(/\s+/g, ' ').trim();
}

async function rest(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    const j = method === 'DELETE' ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }
  throw new Error(`${method} ${path} → rate limited`);
}

for (const [handle, cfg] of Object.entries(BUNDLES)) {
  if (ONLY && ONLY !== handle) continue;
  const bundle = bundles.find((b) => b.handle === handle);
  const product = (await getProducts({ handle }))?.[0];
  if (!product) throw new Error(`${handle} not found`);
  const media = [...product.images].sort((a, b) => a.position - b.position);
  console.log(`\n══ ${handle} — ${media.length} images live`);
  if (media.some((m) => !(m.alt || '').includes('#'))) throw new Error(`${handle}: live media already unscoped — investigate before touching`);

  // ── Plan, per kit, refusing a partial gallery ──
  const order = ORDER[handle];
  const plan = []; // { kitSlug, kind:'new'|'keep', ... } in final order (frame type, then kit)
  const missing = [];
  const kits = bundle.variants.map((k) => ({ kit: k, value: k.options[cfg.option], slug: handleize(k.options[cfg.option]) }));
  for (const step of order) {
    for (const { kit, value, slug } of kits) {
      const suffix = scopeSuffix(cfg.option, value);
      if (typeof step === 'string') {
        const frame = step.slice(4);
        const png = newestRender(handle, `${slug}-${frame}`);
        if (!png) { missing.push(`${slug}-${frame}`); continue; }
        const units = frame === 'scene' ? sceneUnitsOf(kit) : kitUnits(kit);
        let alt;
        if (frame === 'offer') {
          const c = offerCopy(kit, { kitLabel: cfg.option === 'Kit' ? `${value} kit` : value });
          alt = `${bundle.title}, ${value}: ${c.headline.toLowerCase()} for ${c.price}, ${c.sub} — ${composition(units)}`;
        } else if (frame === 'scene') {
          alt = `${bundle.title}, ${value}, at home: ${composition(units)}`;
        } else {
          alt = `${bundle.title}, ${value}: everything in the box — ${composition(units)}`;
        }
        plan.push({ kind: 'new', name: `${handle}-${slug}-${frame}`, png, alt: gateAlt(alt, `${handle}/${slug}-${frame}`) + suffix });
      } else {
        const m = media.find((x) => step.test(fileOf(x.src)) && (x.alt || '').endsWith(suffix));
        if (m) plan.push({ kind: 'keep', id: m.id, name: fileOf(m.src) });
      }
    }
  }
  if (missing.length) { console.log(`  SKIP — missing ${missing.join(', ')}`); continue; }
  const keepIds = new Set(plan.filter((p) => p.kind === 'keep').map((p) => p.id));
  const remove = media.filter((m) => !keepIds.has(m.id));
  plan.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)} ${p.kind.padEnd(4)} ${p.name}`));
  console.log(`  removes ${remove.length}: ${remove.map((m) => fileOf(m.src)).join(', ')}`);
  if (!APPLY) continue;

  // ── Archive what goes ──
  const dir = join(ARCHIVE, handle);
  mkdirSync(dir, { recursive: true });
  for (const o of remove) {
    const r = await fetch(o.src.split('?')[0]);
    if (!r.ok) throw new Error(`REFUSE: could not archive ${o.src} (${r.status}) — nothing changed`);
    writeFileSync(join(dir, fileOf(o.src)), Buffer.from(await r.arrayBuffer()));
  }
  writeFileSync(join(dir, 'images.json'), JSON.stringify(media.map((o) => ({ id: o.id, position: o.position, alt: o.alt, src: o.src })), null, 2));
  console.log(`  archived ${remove.length} → ${dir}`);

  // ── Upload new, then delete old, then order ──
  mkdirSync(OUTBOX, { recursive: true });
  for (const p of plan.filter((x) => x.kind === 'new')) {
    const jpg = join(OUTBOX, `${p.name}.jpg`);
    await sharp(p.png).resize(2048, 2048, { fit: 'inside' }).jpeg({ quality: 90, mozjpeg: true }).toFile(jpg);
    const j = await rest('POST', `/products/${product.id}/images.json`, { image: { attachment: readFileSync(jpg).toString('base64'), filename: `${p.name}.jpg`, alt: p.alt } });
    p.id = j.image.id;
    console.log(`  ✓ ${p.name} → ${p.id}`);
    await sleep(700);
  }
  for (const o of remove) { await rest('DELETE', `/products/${product.id}/images/${o.id}.json`); await sleep(400); }
  console.log(`  ✓ removed ${remove.length}`);
  for (const [i, p] of plan.entries()) { await rest('PUT', `/products/${product.id}/images/${p.id}.json`, { image: { id: p.id, position: i + 1 } }); await sleep(350); }

  // ── Verify ──
  await sleep(1500);
  const after = (await getProducts({ handle }))[0];
  const ids = [...after.images].sort((a, b) => a.position - b.position).map((x) => x.id);
  if (ids.join() !== plan.map((p) => p.id).join()) throw new Error(`VERIFY: ${handle} order or contents differ from plan`);
  if (after.images.some((m) => !(m.alt || '').includes('#'))) throw new Error(`VERIFY: ${handle} has unscoped media`);
  console.log(`  verified: ${after.images.length} images in plan order, all kit-scoped`);
}
if (!APPLY) console.log('\nDry run. Re-run with --apply to write.');
