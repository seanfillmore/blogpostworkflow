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
    ...cfg.grid.flatMap((c) => [c.title, c.line]), cfg.reviews.heading, cfg.reviews.link_label,
    ...(cfg.set_offer ? [cfg.set_offer.kicker, cfg.set_offer.heading, cfg.set_offer.subheading, ...cfg.set_offer.bullets, cfg.set_offer.cta_label, cfg.set_offer.link_label, cfg.set_offer.guarantee] : []),
    ...(cfg.text_overrides ?? []).map((o) => o.value.replace(/<[^>]+>/g, ' ')),
    ...(cfg.ugc ? [cfg.ugc.heading, cfg.ugc.subheading, cfg.ugc.disclosure, ...cfg.ugc.videos.flatMap((v) => [v.creator, v.product])] : [])];
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

/**
 * Pure: the UGC strip. Vertical creator videos in a swipeable row; each plays
 * muted while on screen and pauses off screen (IntersectionObserver), tap for
 * sound, preload="none" so nothing downloads until it scrolls into view. Only
 * videos listed in config/homepage.json ugc.videos render, and the material-
 * connection disclosure is always shown (FTC: creators get product and commission).
 */
export function renderUgc(ugc) {
  if (!ugc.videos?.length) throw new Error('ugc: no videos configured');
  if (!ugc.disclosure) throw new Error('ugc: the creator disclosure line is required');
  const cards = ugc.videos.map((v) => {
    if (!/^https:\/\/cdn\.shopify\.com\//.test(v.src)) throw new Error(`ugc: ${v.trybe_id} src must be a Shopify CDN URL`);
    return `
    <figure class="ugc__card">
      <div class="ugc__frame">
        <video class="ugc__video" src="${esc(v.src)}" poster="${esc(v.poster)}" muted loop playsinline preload="none" aria-label="${esc(v.creator)} on Real Skin Care ${esc(v.product)}"></video>
        <button type="button" class="ugc__sound" aria-label="Turn sound on">Tap for sound</button>
      </div>
    </figure>`;
  }).join('');
  return `<div class="ugc"><div class="ugc__inner">
  <h2 class="ugc__h">${esc(ugc.heading)}</h2>
  <p class="ugc__sub">${esc(ugc.subheading)}</p>
  <div class="ugc__row">${cards}
  </div>
  <p class="ugc__disc">${esc(ugc.disclosure)}</p>
</div></div>
<style>
  .ugc{padding:56px 0 40px;background:#fff}
  .ugc__inner{max-width:1240px;margin:0 auto;text-align:center}
  .ugc__h{margin:0 16px 6px}
  .ugc__sub{margin:0 16px 22px;color:#4a4d52}
  .ugc__row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,1fr);gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 16px 8px;-webkit-overflow-scrolling:touch}
  .ugc__card{margin:0;scroll-snap-align:start;text-align:left}
  .ugc__frame{position:relative;aspect-ratio:9/16;border-radius:14px;overflow:hidden;background:#eee}
  .ugc__video{width:100%;height:100%;object-fit:cover;display:block}
  .ugc__sound{position:absolute;left:10px;bottom:10px;border:0;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:600;background:rgba(0,0,0,.55);color:#fff;cursor:pointer}
  .ugc__sound[aria-pressed="true"]{background:rgba(0,0,0,.25)}
  .ugc__disc{margin:14px 16px 0;font-size:12px;color:#6d7175}
  @media screen and (max-width:749px){.ugc__row{grid-auto-columns:62%}}
</style>
<script>
(function () {
  var root = document.currentScript && document.currentScript.parentElement;
  var vids = (root || document).querySelectorAll('.ugc__video');
  if (!vids.length) return;
  function setSound(v, on) {
    vids.forEach(function (o) { if (o !== v) { o.muted = true; var b = o.parentElement.querySelector('.ugc__sound'); if (b) { b.textContent = 'Tap for sound'; b.setAttribute('aria-pressed', 'false'); } } });
    v.muted = !on;
    var btn = v.parentElement.querySelector('.ugc__sound');
    if (btn) { btn.textContent = on ? 'Sound on' : 'Tap for sound'; btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (on) v.play().catch(function () {});
  }
  vids.forEach(function (v) {
    var btn = v.parentElement.querySelector('.ugc__sound');
    var toggle = function () { setSound(v, v.muted); };
    if (btn) btn.addEventListener('click', toggle);
    v.addEventListener('click', toggle);
  });
  if (!('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting && e.intersectionRatio > 0.6) { v.play().catch(function () {}); }
      else { v.pause(); }
    });
  }, { threshold: [0, 0.6, 1] });
  vids.forEach(function (v) { io.observe(v); });
})();
</script>`;
}

/**
 * Pure: the Sensitive Skin Set product section (replaces the old closing CTA).
 * Results bullets, live rating, live price with the compare-at struck through
 * and the saving computed in Liquid, and an Add to cart that uses the theme's
 * own drawer handshake (<mini-cart>: getSectionsToRender/renderContents), with
 * every post-add failure falling back to /cart so an add that succeeded is
 * never reported as failed.
 */
export function renderSetOffer(o) {
  const bullets = o.bullets.map((b) => `<li><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>${esc(b)}</span></li>`).join('');
  return `{%- assign sp = all_products['${o.handle}'] -%}
{%- if sp != blank and sp.available -%}
{%- assign sv = sp.selected_or_first_available_variant -%}
{%- assign sr = sp.metafields.reviews.rating.value.rating | default: 0 -%}{%- assign src = sp.metafields.reviews.rating_count | default: 0 -%}
<div class="hso"><div class="hso__inner">
  <div class="hso__media"><img src="${esc(o.image_url)}?width=900" srcset="${esc(o.image_url)}?width=600 600w, ${esc(o.image_url)}?width=900 900w, ${esc(o.image_url)}?width=1200 1200w" sizes="(max-width: 749px) 100vw, 50vw" alt="${esc(o.image_alt)}" width="900" height="900" loading="lazy"></div>
  <div class="hso__body">
    <p class="hso__kicker">${esc(o.kicker)}</p>
    <h2 class="hso__h">${esc(o.heading)}</h2>
    <p class="hso__sub">${esc(o.subheading)}</p>
    {%- if src > 0 -%}<p class="hso__rating"><span class="hso__stars" role="img" aria-label="{{ sr | round: 1 }} out of 5 stars">★★★★★</span> {{ sr | round: 1 }} · {{ src }} reviews</p>{%- endif -%}
    <ul class="hso__bullets">${bullets}</ul>
    <p class="hso__price">
      {%- if sv.compare_at_price > sv.price -%}<s>{{ sv.compare_at_price | money }}</s> {% endif -%}
      <strong>{{ sv.price | money }}</strong>
      {%- if sv.compare_at_price > sv.price -%} <span class="hso__save">Save {{ sv.compare_at_price | minus: sv.price | money }}</span>{%- endif -%}
    </p>
    <button type="button" class="hso__cta button button--full-width" data-hso-add data-variant="{{ sv.id }}">${esc(o.cta_label)} · {{ sv.price | money }}</button>
    <p class="hso__error" data-hso-error hidden></p>
    <a class="hso__link" href="{{ sp.url }}">${esc(o.link_label)} →</a>
    <p class="hso__guarantee"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/></svg> ${esc(o.guarantee)}</p>
  </div>
</div></div>
<style>
  #shopify-section-{{ section.id }}{background:#1a1b18}
  .hso{background:#1a1b18;color:#f4f2ee;padding:64px 16px}
  .hso__inner{max-width:1120px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center}
  .hso__media img{display:block;width:100%;height:auto;aspect-ratio:1/1;object-fit:cover;border-radius:16px}
  .hso__kicker{margin:0 0 8px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;color:#aedeac}
  .hso__h{margin:0 0 10px;color:#fff;font-size:clamp(28px,3vw,40px);line-height:1.12}
  .hso__sub{margin:0 0 14px;color:#d6d4cf}
  .hso__rating{margin:0 0 16px;font-size:14px;color:#d6d4cf}
  .hso__stars{color:#fff;letter-spacing:2px}
  .hso__bullets{list-style:none;margin:0 0 20px;padding:0;display:grid;gap:10px}
  .hso__bullets li{display:flex;gap:10px;align-items:flex-start;line-height:1.4}
  .hso__bullets svg{flex:0 0 auto;margin-top:3px;color:#aedeac}
  .hso__price{margin:0 0 14px;font-size:20px}
  .hso__price s{color:#a7a5a0;font-size:.8em;margin-right:6px}
  .hso__save{margin-left:8px;font-size:13px;font-weight:700;color:#aedeac}
  .hso__error{color:#ffb4ab;font-size:.9em;margin:8px 0 0}
  .hso__link{display:block;width:fit-content;margin:14px auto 0;color:#fff;text-decoration:underline;font-size:14px}
  .hso__guarantee{display:flex;align-items:center;justify-content:center;gap:6px;margin:10px 0 0;font-size:13px;color:#d6d4cf}
  @media screen and (max-width:749px){
    .hso{padding:40px 16px}
    .hso__inner{grid-template-columns:1fr;gap:24px}
  }
</style>
<script>
(function () {
  var btn = document.querySelector('[data-hso-add]');
  if (!btn) return;
  var err = document.querySelector('[data-hso-error]');
  btn.addEventListener('click', function (evt) {
    btn.disabled = true; err.hidden = true;
    var el = document.querySelector('mini-cart');
    var drawer = el && typeof el.getSectionsToRender === 'function' && typeof el.renderContents === 'function' ? el : null;
    var payload = { items: [{ id: Number(btn.getAttribute('data-variant')), quantity: 1 }] };
    if (drawer) {
      payload.sections = drawer.getSectionsToRender().map(function (s) { return s.id; }).join(',');
      payload.sections_url = window.location.pathname;
      if (typeof drawer.setActiveElement === 'function') drawer.setActiveElement(evt.currentTarget);
    }
    fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { if (!r.ok) throw new Error('Could not add to cart'); return r.json(); })
      .then(function (state) {
        // Past here the set IS in the cart: never surface an error, fall back to /cart.
        if (!drawer || !state || !state.sections) { window.location.href = '/cart'; return; }
        try { drawer.renderContents(state); } catch (e) { window.location.href = '/cart'; return; }
        btn.disabled = false;
      })
      .catch(function (e) { err.textContent = e.message + '. Please try again.'; err.hidden = false; btn.disabled = false; });
  });
})();
</script>
{%- endif -%}`;
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
  // A rich-text section paints its color on a box inside page-width, so it
  // stops short of the edges. A style block scoped to the section's own id
  // makes the band full width (Sean, 2026-10-06: intro + "natural" thesis).
  for (const band of cfg.bands ?? []) {
    const sec = parsed.sections[band.section];
    if (!sec) throw new Error(`index.json has no "${band.section}" section`);
    const css = `<style>#shopify-section-{{ section.id }}{background:${band.background};margin-top:${band.margin_top_px ?? 0}px}`
      + `#shopify-section-{{ section.id }} .rich-text{background:transparent}</style>`;
    sec.blocks ??= {};
    sec.block_order ??= [];
    sec.blocks['band-style'] = { type: 'custom_liquid', settings: { custom_liquid: css } };
    if (!sec.block_order.includes('band-style')) sec.block_order.push('band-style');
    notes.push(`${band.section}: full-width band`);
  }
  // Per-section CSS in the template's own custom_css (merchant-owned, so it
  // survives the theme updater). One array entry per rule: Shopify scopes each
  // entry by prefixing the section id. It caps a section at 500 characters.
  for (const sc of cfg.section_css ?? []) {
    const sec = parsed.sections[sc.section];
    if (!sec) throw new Error(`index.json has no "${sc.section}" section`);
    const rules = [].concat(sc.css);
    const len = rules.join('').length;
    if (len > 500) throw new Error(`${sc.section}: custom_css is ${len} chars, Shopify allows 500`);
    if (JSON.stringify(sec.custom_css) !== JSON.stringify(rules)) { sec.custom_css = rules; notes.push(`${sc.section}: custom_css`); }
  }
  for (const o of cfg.text_overrides ?? []) {
    const blk = parsed.sections[o.section]?.blocks?.[o.block];
    if (!blk) throw new Error(`index.json has no block ${o.section}/${o.block}`);
    if (blk.settings[o.setting] !== o.value) { blk.settings[o.setting] = o.value; notes.push(`updated ${o.section}/${o.block}`); }
  }
  if (cfg.ugc) {
    const sec = { type: 'custom-liquid', settings: { custom_liquid: renderUgc(cfg.ugc) } };
    if (parsed.order.includes('ugc-strip')) { parsed.sections['ugc-strip'] = sec; notes.push('refreshed ugc-strip'); }
    else {
      const at = parsed.order.indexOf(cfg.ugc.before_section);
      if (at < 0) throw new Error(`index.json has no "${cfg.ugc.before_section}" to place the UGC strip before`);
      parsed.order.splice(at, 0, 'ugc-strip');
      parsed.sections['ugc-strip'] = sec;
      notes.push(`inserted ugc-strip before ${cfg.ugc.before_section}`);
    }
  }
  swap('product-line', 'product-grid', { type: 'custom-liquid', settings: { custom_liquid: renderGrid(cfg.grid) } });
  if (cfg.set_offer) {
    swap(cfg.set_offer.replaces, 'set-offer', { type: 'custom-liquid', settings: { custom_liquid: renderSetOffer(cfg.set_offer) } });
    // Pinned position (Sean, 2026-10-06: directly after "What's not in any of our products").
    const after = cfg.set_offer.after_section;
    if (after) {
      if (!parsed.order.includes(after)) throw new Error(`index.json has no "${after}" to place the set offer after`);
      parsed.order = parsed.order.filter((k) => k !== 'set-offer');
      parsed.order.splice(parsed.order.indexOf(after) + 1, 0, 'set-offer');
      notes.push(`set-offer placed after ${after}`);
    }
  }
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
