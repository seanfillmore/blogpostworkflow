/**
 * Organic social posts: the pure half of agents/social-organic.
 *
 * Why this exists (measured 2026-11-03): every static posted to Instagram and the
 * Facebook Page was an AD image, and the feed treated it like one: about 1 like
 * per post and zero saves or shares across 33 posts. Sean, 2026-11-04: make
 * statics for engagement, not necessarily ad driven. Three kinds, rotated by
 * agents/social-poster:
 *
 *   carousel   5-7 slides answering a question customers really ask (Google
 *              question searches from GSC, then voice-of-customer objections),
 *              seeded first with the two Sean named: switching deodorant and
 *              toothpaste ingredients. Built to be SAVED.
 *   review     a real 5-star Judge.me review as a quote card, the customer's own
 *              words, credited "First L." (Sean, 2026-11-04).
 *   relatable  a short text post about an everyday moment, in customer language,
 *              with a caption that asks a question. Built to be commented on.
 *
 * Every word goes through the same COMMERCIAL claim gate as the rest of the fleet
 * (lib/seo-copy-health-gate.js), plus: no dashes, no competitor names, and no
 * number that is not in the grounding facts. A review is screened before it is
 * ever offered (selectQuotableReviews + the claim gate) and is quoted verbatim,
 * never edited. Nothing here posts: items land PENDING in the Social tab.
 */

import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';
import { selectQuotableReviews } from '../agents/ad-studio/health-claims.js';
import { stripHtmlForReview } from './judgeme.js';

export const W = 1080;
export const H = 1350;
export const SAND = '#EDE5D8';
export const GREEN = '#AEDEAC';
export const INK = '#000000';
export const HANDLE = '@realskincare_com';

export const MIN_SLIDES = 5;
export const MAX_SLIDES = 7;
export const REVIEW_MIN_CHARS = 60;
export const REVIEW_MAX_CHARS = 320;
export const RELATABLE_MAX_CHARS = 180;

const NUM_RE = /\d+(?:\.\d+)?/g;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── reviews ───────────────────────────────────────────────────────────────────

/** "Jane Doe" → "Jane D.", "jane" → "Jane". Anonymous, emails and handles → null (never posted). */
export function reviewerDisplayName(name) {
  const n = String(name || '').trim();
  if (!n || /anonymous|@|\d/i.test(n)) return null;
  const parts = n.split(/\s+/).filter((p) => /^[\p{L}'.-]+$/u.test(p));
  if (!parts.length) return null;
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const first = cap(parts[0].replace(/\.$/, ''));
  if (first.length < 2) return null;
  const last = parts.length > 1 ? parts[parts.length - 1].replace(/[^\p{L}]/gu, '') : '';
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

/**
 * Reviews fit for a quote card, best first: 5 stars, a real name, plain text of a
 * readable length, never used before, and passing BOTH screens the ad pipeline
 * uses (health language withheld, then the commercial claim gate). A review with
 * a dash or a competitor's name is skipped rather than edited: it is quoted
 * verbatim or not at all.
 */
export function quotableReviews(reviews = [], { usedIds = new Set(), competitors = [], products = null } = {}) {
  const out = [];
  for (const r of reviews) {
    if (Number(r.rating) !== 5 || usedIds.has(String(r.id))) continue;
    // Hidden or unpublished reviews are the fakes, duplicates and wrong-product ones: never quoted.
    if (r.hidden === true || r.published === false) continue;
    // Only reviews of a product we sell today, shown under its CURRENT name.
    const current = products ? products[r.product_handle] : null;
    if (products && !current) continue;
    const name = reviewerDisplayName(r.reviewer_name);
    if (!name) continue;
    const text = stripHtmlForReview(r.body || '').replace(/\s+/g, ' ').trim();
    if (text.length < REVIEW_MIN_CHARS || text.length > REVIEW_MAX_CHARS) continue;
    if (/[–—]/.test(text)) continue;
    if (!selectQuotableReviews([text]).length) continue;
    if (checkSeoCopyFields({ quote: text }, { surface: COMMERCIAL_SURFACE }).blocking.length) continue;
    if (competitorIn(text, competitors)) continue;
    out.push({ id: String(r.id), text, name, product_title: current || r.product_title || null, product_handle: r.product_handle || null, verified: r.verified === true, created_at: r.created_at || null });
  }
  // Verified buyers first, then newest.
  return out.sort((a, b) => Number(b.verified) - Number(a.verified) || String(b.created_at).localeCompare(String(a.created_at)));
}

// ── topics ────────────────────────────────────────────────────────────────────

const PRODUCT_WORDS = /deodor|toothpaste|lotion|moistur|body cream|lip balm|bar soap|hand soap|body wash|sls|fluoride|aluminum|coconut oil/i;
const OFF_TOPIC = /soap making|make soap|making soap|recipe|diy|homemade/i;
const QUESTION = /^(how|why|what|can|does|do|is|are|should|which|when|will)\b/i;

/**
 * Carousel topics, in order: Sean's seeds, then real question searches (GSC rows,
 * by impressions, deduped, product-related, never a competitor brand or a DIY
 * topic we do not sell), then voice-of-customer objection lines. A topic already
 * used (any item's `topic`, rejected ones included) is never offered again.
 */
export function topicCandidates({ seeds = [], gscRows = [], vocObjections = [], used = [], competitors = [] } = {}) {
  const usedSet = new Set(used.map(norm));
  const seen = new Set();
  const out = [];
  const add = (topic, source) => {
    const k = norm(topic);
    if (!k || usedSet.has(k) || seen.has(k)) return;
    seen.add(k);
    out.push({ topic: String(topic).trim(), source });
  };
  for (const s of seeds) add(s, 'seed');
  const byQuery = new Map();
  for (const r of gscRows) {
    const q = String(r.query || '').trim();
    if (!QUESTION.test(q) || !PRODUCT_WORDS.test(q) || OFF_TOPIC.test(q) || competitorIn(q, competitors)) continue;
    byQuery.set(q, (byQuery.get(q) || 0) + (Number(r.impressions) || 0));
  }
  for (const [q] of [...byQuery].sort((a, b) => b[1] - a[1])) add(q, 'search');
  for (const o of vocObjections) add(o, 'customer objection');
  return out;
}

/** The objection lines from data/context/voice-of-customer.md (bold lead of each bullet). */
export function vocObjections(md = '') {
  const section = String(md).split(/^## /m).find((s) => /^Objections/i.test(s)) || '';
  return [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].trim());
}

/** Customer phrases worth echoing in a relatable post (golden nuggets + trigger points). */
export function vocPhrases(md = '') {
  const out = [];
  for (const s of String(md).split(/^## /m)) {
    if (!/^(Golden-nugget phrases|Trigger points)/i.test(s)) continue;
    for (const m of s.matchAll(/^- \*\*(.+?)\*\*/gm)) out.push(m[1].trim());
  }
  return out;
}

// ── copy checks ───────────────────────────────────────────────────────────────

export function competitorIn(text, competitors = []) {
  const t = ` ${norm(text)} `;
  for (const c of competitors) {
    for (const n of [c?.name, String(c?.domain || '').split('.')[0]]) {
      const k = norm(n);
      if (k.length >= 4 && t.includes(` ${k} `)) return c.name;
    }
  }
  return null;
}

/**
 * Problems with generated organic copy (named fields, e.g. slide 2 body, caption).
 * Empty = it may go to the Social tab. `facts` is the grounding text: every
 * number must appear in it.
 */
export function organicCopyProblems(fields = {}, { facts = '', competitors = [] } = {}) {
  const out = [];
  const have = new Set(String(facts).match(NUM_RE) || []);
  const { blocking } = checkSeoCopyFields(fields, { surface: COMMERCIAL_SURFACE });
  for (const b of blocking) out.push(`${b.field}: claim "${b.match}" (${b.category})`);
  for (const [field, value] of Object.entries(fields)) {
    const v = String(value ?? '');
    if (/[–—]/.test(v)) out.push(`${field}: contains an em or en dash`);
    if (/https?:\/\//i.test(v)) out.push(`${field}: contains a link`);
    const comp = competitorIn(v, competitors);
    if (comp) out.push(`${field}: names a competitor (${comp})`);
    for (const n of new Set(v.match(NUM_RE) || [])) if (!have.has(n)) out.push(`${field}: the number ${n} is not in the facts`);
  }
  return out;
}

/** handle → current product name, from config/press-facts.json's product URLs. */
export function currentProducts(pressFacts = {}) {
  const out = {};
  for (const p of Object.values(pressFacts.products || {})) {
    const h = String(p.url || '').match(/\/products\/([^/?#]+)/)?.[1];
    if (h) out[h] = p.name;
  }
  return out;
}

/** Named fields for one carousel draft, for the gate. */
export function carouselFields(draft) {
  const f = {};
  (draft?.slides || []).forEach((s, i) => { f[`slide ${i + 1} title`] = s.title; if (s.body) f[`slide ${i + 1} body`] = s.body; });
  f.caption = draft?.caption;
  return f;
}

/** Shape problems a model can fix on a retry. */
export function carouselShapeProblems(draft) {
  const out = [];
  const slides = draft?.slides;
  if (!Array.isArray(slides)) return ['no slides array'];
  if (slides.length < MIN_SLIDES || slides.length > MAX_SLIDES) out.push(`has ${slides.length} slides; write ${MIN_SLIDES} to ${MAX_SLIDES}`);
  slides.forEach((s, i) => {
    if (!String(s?.title || '').trim()) out.push(`slide ${i + 1} has no title`);
    if (String(s?.title || '').length > 70) out.push(`slide ${i + 1} title is over 70 characters`);
    if (String(s?.body || '').length > 260) out.push(`slide ${i + 1} body is over 260 characters`);
  });
  if (!String(draft?.caption || '').trim()) out.push('no caption');
  return out;
}

// ── templates (1080x1350, brand faces; rendered by agents/ad-concepts/typeset.js) ──

const footer = (dark = false) => `<div style="position:absolute;left:0;right:0;bottom:44px;text-align:center;font-family:Outfit;font-weight:400;font-size:26px;letter-spacing:2px;color:${dark ? '#fff' : INK};opacity:.75">REAL SKIN CARE</div>`;

export function carouselSlideHtml({ index, total, title, body = '' }) {
  const cover = index === 0;
  const last = index === total - 1;
  const bg = cover ? INK : last ? GREEN : SAND;
  const fg = cover ? '#fff' : INK;
  return `<div style="position:relative;width:${W}px;height:${H}px;background:${bg};color:${fg}">
<div style="position:absolute;top:56px;right:64px;font-family:Cabin;font-weight:700;font-size:28px;opacity:.6">${index + 1}/${total}</div>
<div style="position:absolute;left:96px;right:96px;top:${cover ? 330 : 220}px;bottom:200px;display:flex;flex-direction:column;gap:44px">
<div data-fit data-min="40" style="height:${cover ? 520 : String(title || '').length > 26 ? 200 : 110}px;overflow:hidden;font-family:Outfit;font-weight:600;font-size:${cover ? 104 : 76}px;line-height:1.08;letter-spacing:-1px">${esc(title)}</div>
${body ? `<div data-fit data-min="26" style="height:${cover ? 220 : 620}px;overflow:hidden;font-family:Cabin;font-weight:400;font-size:${cover ? 40 : 44}px;line-height:1.38">${esc(body)}</div>` : ''}
</div>
${cover ? `<div style="position:absolute;left:96px;bottom:150px;font-family:Cabin;font-weight:700;font-size:32px;color:${GREEN}">Swipe &rarr;</div>` : ''}
${footer(cover)}
</div>`;
}

export function reviewCardHtml({ quote, name, product = '' }) {
  return `<div style="position:relative;width:${W}px;height:${H}px;background:${SAND};color:${INK}">
<div style="position:absolute;top:120px;left:96px;font-family:Outfit;font-weight:600;font-size:200px;line-height:1;color:${GREEN}">&ldquo;</div>
<div style="position:absolute;top:150px;right:96px;font-size:44px;letter-spacing:6px;color:${INK}">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
<div data-fit data-min="34" style="position:absolute;left:96px;right:96px;top:330px;height:640px;overflow:hidden;font-family:Outfit;font-weight:400;font-size:64px;line-height:1.22">${esc(quote)}</div>
<div style="position:absolute;left:96px;right:96px;top:1010px;font-family:Cabin;font-weight:700;font-size:38px">${esc(name)}</div>
${product ? `<div style="position:absolute;left:96px;right:96px;top:1062px;font-family:Cabin;font-weight:400;font-size:32px;opacity:.7">on ${esc(product)}</div>` : ''}
${footer(false)}
</div>`;
}

export function textPostHtml({ text }) {
  return `<div style="position:relative;width:${W}px;height:${H}px;background:#fff;color:${INK}">
<div style="position:absolute;left:96px;right:96px;top:330px;display:flex;align-items:center;gap:26px">
<div style="width:110px;height:110px;border-radius:50%;background:${SAND};display:flex;align-items:center;justify-content:center;font-family:Outfit;font-weight:600;font-size:40px">RSC</div>
<div><div style="font-family:Cabin;font-weight:700;font-size:40px">Real Skin Care</div><div style="font-family:Cabin;font-weight:400;font-size:32px;opacity:.6">${HANDLE}</div></div>
</div>
<div data-fit data-min="40" style="position:absolute;left:96px;right:96px;top:500px;height:560px;overflow:hidden;font-family:Cabin;font-weight:400;font-size:72px;line-height:1.25">${esc(text)}</div>
</div>`;
}
