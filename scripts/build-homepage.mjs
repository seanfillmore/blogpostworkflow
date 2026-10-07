#!/usr/bin/env node
/**
 * Build the homepage from config/homepage.json.
 *
 *   node scripts/build-homepage.mjs                       # dry run (prints the new section order)
 *   node scripts/build-homepage.mjs --preview --apply     # writes templates/index.preview.json (?view=preview)
 *   node scripts/build-homepage.mjs --apply               # writes the live templates/index.json
 *
 * What it changes on the live index.json, and nothing else:
 *   - `hero` + `hero-overrides`  -> `hero-split` (sections/home-hero-split.liquid)
 *   - `product-line` (multicolumn, no prices) -> `product-grid` (prices, stars, pack offer, button)
 *   - `featured-testimonial` (one quote, links off-site to judge.me) -> `review-strip`
 *     (three approved verbatim reviews from config/bundles.json, links on-site)
 *
 * Every customer-facing line is gated first (ad health gate, commercial claim
 * gate, product-category gate, no em dash); one failure refuses the run.
 * Prices and ratings are never baked: the Liquid reads all_products and the
 * Judge.me metafields at render time. The section file is uploaded before the
 * template that references it. Live template backed up, read back, mirrored.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './build-product-templates.mjs';
import { bulletProblems } from './apply-pdp-outcome-bullets.mjs';
import { assertReview } from './build-quantity-ladder.mjs';
import { loadRoster } from '../lib/bundle-roster.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config', 'homepage.json'), 'utf8'));
}

/** Pure: every line a shopper reads, for the gate. */
export function copyLines(cfg) {
  const h = cfg.hero;
  return [h.heading, h.kicker, h.product_heading, h.subheading, h.cta_label, h.guarantee, ...h.bullets,
    ...cfg.grid.flatMap((c) => [c.title, c.line]), cfg.reviews.heading, cfg.reviews.link_label];
}

export function gateFailures(cfg) {
  return copyLines(cfg).flatMap((l) => bulletProblems(l).map((p) => `"${l}" — ${p}`));
}

/** Pure: the product grid custom_liquid. Prices, offers and ratings resolve in Liquid. */
export function renderGrid(cards) {
  const card = (c) => `
  {%- assign p = all_products['${c.base}'] -%}{%- assign pk = all_products['${c.pack}'] -%}
  {%- assign r = p.metafields.reviews.rating.value.rating | default: 0 -%}{%- assign rc = p.metafields.reviews.rating_count | default: 0 -%}
  {%- assign offer = '' -%}
  {%- if pk != blank and pk.available and p.price > 0 -%}
    {%- assign paid = pk.price | divided_by: p.price -%}{%- assign rem = pk.price | modulo: p.price -%}
    {%- if rem == 0 and paid > 0 and paid < ${c.units} -%}
      {%- assign free = ${c.units} | minus: paid -%}
      {%- assign offer = 'Buy ' | append: paid | append: ', get ' | append: free | append: ' free' -%}
    {%- else -%}
      {%- assign singly = p.price | times: ${c.units} -%}
      {%- if singly > pk.price -%}{%- assign pct = singly | minus: pk.price | times: 100 | divided_by: singly -%}{%- assign offer = 'Save ' | append: pct | append: '% on the ${c.units}-pack' -%}{%- endif -%}
    {%- endif -%}
  {%- endif -%}
  <a class="hpg__card" href="${esc(c.url)}">
    {%- assign img = images['${c.image.replace('shopify://shop_images/', '')}'] -%}
    {%- if img -%}<img class="hpg__img" src="{{ img | image_url: width: 600 }}" srcset="{{ img | image_url: width: 400 }} 400w, {{ img | image_url: width: 600 }} 600w" sizes="(max-width: 749px) 50vw, 33vw" alt="${esc(c.title)}" width="600" height="600" loading="lazy">{%- endif -%}
    <span class="hpg__body">
      <span class="hpg__title">${esc(c.title)}</span>
      {%- if rc > 0 -%}<span class="hpg__rating"><span class="hpg__stars" role="img" aria-label="{{ r | round: 1 }} out of 5 stars">★★★★★</span> {{ r | round: 1 }} ({{ rc }})</span>{%- endif -%}
      <span class="hpg__line">${esc(c.line)}</span>
      <span class="hpg__price">From {{ p.price | money_without_trailing_zeros }}</span>
      {%- if offer != '' -%}<span class="hpg__offer">{{ offer }}</span>{%- endif -%}
      <span class="hpg__btn button">Shop now</span>
    </span>
  </a>`;
  return `<div class="hpg"><div class="hpg__grid">${cards.map(card).join('')}
</div></div>
<style>
  .hpg{padding:8px 16px 48px}
  .hpg__grid{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
  .hpg__card{display:flex;flex-direction:column;background:#fff;border:1px solid #e6e4df;border-radius:12px;overflow:hidden;text-decoration:none;color:#151515}
  .hpg__img{display:block;width:100%;height:auto;aspect-ratio:1/1;object-fit:cover;background:#f4f2ee}
  .hpg__body{display:flex;flex-direction:column;gap:6px;padding:16px 16px 18px;flex:1}
  .hpg__title{font-weight:700;font-size:1.1em}
  .hpg__rating{font-size:13px;color:#4a4d52}
  .hpg__stars{color:#151515;letter-spacing:1px}
  .hpg__line{font-size:14px;line-height:1.45;color:#2f3133;flex:1}
  .hpg__price{font-weight:700;margin-top:4px}
  .hpg__offer{font-size:13px;font-weight:700;color:#3f7a33}
  .hpg__btn{margin-top:10px;width:100%;max-width:100%;min-width:0;box-sizing:border-box;display:flex;justify-content:center;text-align:center}
  @media screen and (max-width:749px){
    .hpg__grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .hpg__body{padding:12px 12px 14px}
    .hpg__line{font-size:13px}
    .hpg__btn{font-size:12px;padding-left:6px;padding-right:6px;letter-spacing:.08em}
    .hpg__offer{font-size:12px}
  }
</style>`;
}

/** Pure: the review strip, from the approved, gated ladder reviews. */
export function renderReviews(cfg, roster) {
  const picks = cfg.reviews.from_ladders.map((base) => {
    const l = roster.ladders.find((x) => x.base === base);
    if (!l?.review) throw new Error(`no approved review on ladder "${base}"`);
    assertReview(l.review, base);
    return { ...l.review, base };
  });
  const cards = picks.map((r) => `
    <figure class="hrs__card">
      <span class="hrs__stars" role="img" aria-label="5 out of 5 stars">★★★★★</span>
      <blockquote class="hrs__text">“${esc(r.text)}”</blockquote>
      <figcaption class="hrs__name">${esc(r.name)} · Verified buyer</figcaption>
    </figure>`).join('');
  return `<div class="hrs"><div class="hrs__inner">
  <h2 class="hrs__h">${esc(cfg.reviews.heading)}</h2>
  <div class="hrs__grid">${cards}
  </div>
  <a class="hrs__link" href="${esc(cfg.reviews.link_url)}">${esc(cfg.reviews.link_label)} →</a>
</div></div>
<style>
  .hrs{background:#eef3e8;padding:56px 16px}
  .hrs__inner{max-width:1100px;margin:0 auto;text-align:center}
  .hrs__h{margin:0 0 24px}
  .hrs__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;text-align:left}
  .hrs__card{margin:0;background:#fff;border-radius:12px;padding:20px}
  .hrs__stars{color:#151515;letter-spacing:2px}
  .hrs__text{margin:10px 0;padding:0;border:0;font-style:normal;line-height:1.5;color:#151515}
  .hrs__name{font-size:13px;color:#4a4d52}
  .hrs__link{display:inline-block;margin-top:22px;font-weight:600;color:#151515;text-decoration:underline}
  @media screen and (max-width:749px){.hrs__grid{grid-template-columns:1fr}}
</style>`;
}

/** Pure: apply the three swaps to a parsed index.json. Returns notes; throws if an anchor is missing. */
export function transform(parsed, cfg, roster) {
  const notes = [];
  const swap = (oldKey, newKey, section) => {
    const at = parsed.order.indexOf(oldKey);
    if (at < 0) {
      if (parsed.order.includes(newKey)) { parsed.sections[newKey] = section; notes.push(`refreshed ${newKey}`); return; }
      throw new Error(`index.json has neither "${oldKey}" nor "${newKey}"`);
    }
    parsed.order.splice(at, 1, newKey);
    delete parsed.sections[oldKey];
    parsed.sections[newKey] = section;
    notes.push(`${oldKey} -> ${newKey}`);
  };
  const h = cfg.hero;
  const blocks = Object.fromEntries(h.bullets.map((t, i) => [`b${i + 1}`, { type: 'bullet', settings: { text: t } }]));
  swap('hero', 'hero-split', {
    type: 'home-hero-split',
    blocks, block_order: Object.keys(blocks),
    settings: { heading: h.heading, kicker: h.kicker, product_heading: h.product_heading, subheading: h.subheading,
      product_handle: h.product_handle, pack_handle: h.pack_handle, pack_units: h.pack_units, cta_label: h.cta_label,
      guarantee: h.guarantee, image_desktop: h.image_desktop, image_mobile: h.image_mobile, image_alt: h.image_alt },
  });
  if (parsed.order.includes('hero-overrides')) {
    parsed.order = parsed.order.filter((k) => k !== 'hero-overrides');
    delete parsed.sections['hero-overrides'];
    notes.push('removed hero-overrides (CSS for the old hero)');
  }
  swap('product-line', 'product-grid', { type: 'custom-liquid', settings: { custom_liquid: renderGrid(cfg.grid) } });
  swap('featured-testimonial', 'review-strip', { type: 'custom-liquid', settings: { custom_liquid: renderReviews(cfg, roster) } });
  return notes;
}

if (isDirectRun(import.meta.url)) {
  const APPLY = process.argv.includes('--apply');
  const PREVIEW = process.argv.includes('--preview');
  const cfg = loadConfig();
  const fails = gateFailures(cfg);
  if (fails.length) { console.error(`Refusing — ${fails.length} line(s) fail a gate:\n  ${fails.join('\n  ')}`); process.exit(1); }
  const roster = loadRoster();

  const { getAccessToken } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const token = await getAccessToken();
  const H = (path, init = {}) => fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/${path}`,
    { ...init, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
  const theme = (await (await H('themes.json')).json()).themes.find((t) => t.role === 'main');
  // A missing asset is a 404 with an EMPTY body, so .json() would throw; read it as absent.
  const get = async (key) => {
    const r = await H(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${key} → ${r.status}`);
    return (await r.json()).asset?.value ?? null;
  };
  const put = async (key, value) => {
    const r = await H(`themes/${theme.id}/assets.json`, { method: 'PUT', body: JSON.stringify({ asset: { key, value } }) });
    if (!r.ok) throw new Error(`PUT ${key} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
    // A freshly written asset can read back stale for a second or two; poll before calling it a failure.
    for (let i = 0; i < 6; i += 1) {
      if ((await get(key)) === value) return;
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`${key}: read-back still differs from what was written after ~9s`);
  };

  const live = await get('templates/index.json');
  const stripped = live.replace(/^\/\*[\s\S]*?\*\/\s*/, '');
  const parsed = JSON.parse(stripped);
  const notes = transform(parsed, cfg, roster);
  console.log(`theme ${theme.name} (${theme.id})\n  ${notes.join('\n  ')}\n  order: ${parsed.order.join(' ')}`);
  if (!APPLY) { console.log('\nDry run. --preview --apply for ?view=preview, --apply for live.'); process.exit(0); }

  const sectionSrc = readFileSync(join(ROOT, 'theme', 'sections', 'home-hero-split.liquid'), 'utf8');
  if ((await get('sections/home-hero-split.liquid')) !== sectionSrc) { await put('sections/home-hero-split.liquid', sectionSrc); console.log('  uploaded sections/home-hero-split.liquid'); }

  const out = serialize(parsed);
  const key = PREVIEW ? 'templates/index.preview.json' : 'templates/index.json';
  if (!PREVIEW) {
    mkdirSync(join(ROOT, 'data', 'template-backup'), { recursive: true });
    writeFileSync(join(ROOT, 'data', 'template-backup', 'index.json'), live);
  }
  await put(key, out);
  console.log(`  wrote ${key} (read back identical)`);
  if (!PREVIEW) writeFileSync(join(ROOT, 'theme', 'templates', 'index.json'), out);
}
