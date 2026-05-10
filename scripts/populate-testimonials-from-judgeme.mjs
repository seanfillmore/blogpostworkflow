#!/usr/bin/env node
/**
 * Pulls real Judge.me reviews for each cluster's main product, populates
 * the testimonial-quotes section in the corresponding theme template,
 * re-enables the section (disabled:false), and injects slider CSS so
 * the section becomes a horizontal scroll/swipe carousel with 3 cards
 * visible at once.
 *
 * Cluster → main product handle:
 *   deodorant     → coconut-oil-deodorant
 *   lotion        → coconut-lotion
 *   cream         → coconut-moisturizer
 *   bar-soap      → coconut-soap
 *   liquid-soap   → organic-foaming-hand-soap
 *   lip-balm      → coconut-oil-lip-balm
 *
 * Filter: ≥4 stars, reviewer first name present, body 30-400 chars.
 * Picks up to 6 (5-star prioritized; falls back to 4-star to fill).
 *
 * Usage: node scripts/populate-testimonials-from-judgeme.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveExternalId,
  stripHtmlForReview,
  truncateToWord,
} from '../lib/judgeme.js';

const JUDGEME_BASE = 'https://judge.me/api/v1';

/**
 * Paginated fetch of ALL shop reviews, then filter for matching product.
 * Judge.me's /reviews endpoint rejects per-product filtering server-side
 * (HTTP 422), so we have to walk the whole shop. Cached at module scope
 * so we only paginate once across all clusters.
 */
let _allShopReviews = null;
async function getAllShopReviews(shopDomain, apiToken, maxPages = 50) {
  if (_allShopReviews) return _allShopReviews;
  const collected = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      api_token: apiToken,
      shop_domain: shopDomain,
      per_page: '100',
      page: String(page),
    });
    const res = await fetch(`${JUDGEME_BASE}/reviews?${qs}`);
    if (!res.ok) { console.warn(`  page ${page} HTTP ${res.status}`); break; }
    const data = await res.json();
    const reviews = data.reviews || [];
    if (reviews.length === 0) break;
    collected.push(...reviews);
    if (reviews.length < 100) break;
  }
  _allShopReviews = collected;
  console.log(`  (cached ${collected.length} shop-wide reviews)`);
  return collected;
}

async function fetchAllProductReviews(externalId, shopDomain, apiToken) {
  const all = await getAllShopReviews(shopDomain, apiToken);
  return all.filter((r) => r.product_external_id == externalId);
}

function cleanBody(rawBody) {
  if (!rawBody) return '';
  return truncateToWord(stripHtmlForReview(rawBody), 300);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const THEME_TEMPLATES = '/Users/seanfillmore/Code/realskincare-theme/templates';

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}
const env = loadEnv();
const SHOP_DOMAIN = env.SHOPIFY_STORE;
const JM_TOKEN = env.JUDGEME_API_TOKEN;
if (!SHOP_DOMAIN || !JM_TOKEN) { console.error('Missing SHOPIFY_STORE or JUDGEME_API_TOKEN'); process.exit(1); }

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_CARDS = 6;

const CLUSTER_TO_PRODUCT = {
  'deodorant':    'coconut-oil-deodorant',
  'lotion':       'coconut-lotion',
  'cream':        'coconut-moisturizer',
  'bar-soap':     'coconut-soap',
  'liquid-soap':  'organic-foaming-hand-soap',
  'lip-balm':     'coconut-oil-lip-balm',
};

function looksLikeUsername(name) {
  // Reject if contains digits OR has no vowels OR is mixed letters/numbers without spaces.
  if (/\d/.test(name)) return true;
  if (!/[aeiouy]/i.test(name)) return true;
  // Reject if entire name is camel/pascal-case with consecutive caps in middle (e.g. "PghXie")
  if (/[a-z][A-Z]/.test(name)) return true;
  return false;
}

function titleCase(s) {
  return s.replace(/\b([A-Z]{2,})\b/g, (m) => m.charAt(0) + m.slice(1).toLowerCase());
}

const ANON_LABEL = 'Verified Buyer';

function reviewerName(r) {
  // Prefer "First L." style. Anonymous and username-only entries fall back
  // to "Verified Buyer" (matches Sean's pattern for Amazon-imported reviews).
  const raw = (r.reviewer?.name || r.name || '').trim();
  if (!raw || /^anonymous$/i.test(raw)) return ANON_LABEL;
  const normalized = titleCase(raw);
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ANON_LABEL;
  if (looksLikeUsername(parts[0])) return ANON_LABEL;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}

function isNegativeReview(body) {
  const lower = body.toLowerCase();
  // Filter complaints / non-delivery / refund mentions even on 4-5 star reviews
  const negPatterns = [
    /didn'?t receive/, /haven'?t received/, /never received/, /still waiting/,
    /wrong item/, /wrong product/, /returned/, /refund/, /missing/,
  ];
  return negPatterns.some((re) => re.test(lower));
}

function rejectionReason(r) {
  if ((r.rating || 0) < 4) return `rating ${r.rating}`;
  if (r.hidden) return 'hidden';
  if (r.curated === 'rejected') return 'curated:rejected';
  const name = reviewerName(r);
  if (!name) return `no-name (raw=${JSON.stringify(r.reviewer?.name || r.name || '')})`;
  const body = cleanBody(r.body);
  if (body.length < 15) return `body too short (${body.length})`;
  if (isNegativeReview(body)) return 'negative-pattern';
  return null;
}

function isQualityReview(r) {
  return rejectionReason(r) === null;
}

function bodyKey(r) {
  // Normalized prefix used to detect duplicate review text.
  return cleanBody(r.body).toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim().slice(0, 120);
}

function pickReviews(reviews) {
  const seenNames = new Set();
  const seenBodies = new Set();
  const eligible = [];
  // Sort: 5-star first, then 4-star. Within each rating, prefer NAMED reviewers
  // (so named ones show first; Verified Buyer fills remaining slots).
  const sorted = [...reviews].sort((a, b) => {
    const rd = (b.rating || 0) - (a.rating || 0);
    if (rd !== 0) return rd;
    const aNamed = reviewerName(a) !== ANON_LABEL ? 0 : 1;
    const bNamed = reviewerName(b) !== ANON_LABEL ? 0 : 1;
    return aNamed - bNamed;
  });
  for (const r of sorted) {
    if (!isQualityReview(r)) continue;
    const name = reviewerName(r);
    // Dedupe named reviewers (one card per real person)
    if (name !== ANON_LABEL && seenNames.has(name)) continue;
    // Dedupe duplicate body text (catches re-imported / duplicate-content reviews)
    const bk = bodyKey(r);
    if (seenBodies.has(bk)) continue;
    seenNames.add(name);
    seenBodies.add(bk);
    eligible.push(r);
    if (eligible.length >= MAX_CARDS) break;
  }
  return eligible;
}

function reviewPicture(r) {
  // Judge.me review pictures: r.pictures[].urls.{original, huge, compact, small}
  const pics = r.pictures || [];
  if (!pics.length) return null;
  const p = pics[0];
  const url = p.urls?.original || p.urls?.huge || p.urls?.compact || null;
  if (!url) return null;
  // Append imgix sizing if it's an imgix URL — keeps cards lightweight.
  if (url.includes('imgix.net')) {
    return url + (url.includes('?') ? '&' : '?') + 'w=600&fit=clip&auto=format';
  }
  return url;
}

function buildBlocks(reviews) {
  const blocks = {};
  const block_order = [];
  reviews.forEach((r, i) => {
    const id = `testimonial-${i + 1}`;
    block_order.push(id);
    const stars = '★'.repeat(r.rating);
    const body = cleanBody(r.body).replace(/"/g, '\\"');
    const pic = reviewPicture(r);
    // Multicolumn's `image` setting only works for Shopify-hosted images
    // (uses Liquid's image_url filter under the hood). External Judge.me
    // URLs render as nothing. Embedding the picture as an <img> inside
    // the `text` HTML works because text accepts arbitrary inline HTML.
    const picHtml = pic
      ? `<p><img src="${pic.replace(/"/g, '&quot;')}" alt="Customer photo from ${reviewerName(r).replace(/"/g, '&quot;')}" style="width:100%;height:auto;border-radius:6px;margin-bottom:8px;" loading="lazy"></p>`
      : '';
    blocks[id] = {
      type: 'column',
      settings: {
        title: reviewerName(r),
        title_size: 'small',
        text: `${picHtml}<p><strong>${stars}</strong></p><p>"${body}"</p>`,
        button_label: '',
      },
    };
  });
  return { blocks, block_order };
}

const SLIDER_CSS = ` [id$="testimonial-quotes"] .multicolumn-list { display: flex !important; flex-wrap: nowrap !important; overflow-x: auto; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; gap: 1.5rem; padding-bottom: 1rem; scrollbar-width: thin; } [id$="testimonial-quotes"] .multicolumn-list > .grid__item { flex: 0 0 calc((100% - 3rem) / 3) !important; max-width: calc((100% - 3rem) / 3) !important; scroll-snap-align: start; } @media (max-width: 749px) { [id$="testimonial-quotes"] .multicolumn-list > .grid__item { flex: 0 0 85% !important; max-width: 85% !important; } }`;

function readTemplate(cluster) {
  const path = `${THEME_TEMPLATES}/product.landing-page-${cluster}.json`;
  const raw = readFileSync(path, 'utf8');
  const headerMatch = raw.match(/^(\/\*[\s\S]*?\*\/\s*)/);
  const header = headerMatch ? headerMatch[1] : '';
  const j = JSON.parse(raw.slice(header.length));
  return { path, header, j };
}

function writeTemplate({ path, header, j }) {
  writeFileSync(path, header + JSON.stringify(j, null, 2));
}

async function processCluster(cluster, productHandle) {
  console.log(`\n=== ${cluster} (${productHandle}) ===`);
  const externalId = await resolveExternalId(productHandle, SHOP_DOMAIN, JM_TOKEN);
  console.log(`  external_id: ${externalId}`);
  const allReviews = await fetchAllProductReviews(externalId, SHOP_DOMAIN, JM_TOKEN);
  console.log(`  total reviews fetched: ${allReviews.length}`);
  if (process.argv.includes('--debug')) {
    const reasons = {};
    for (const r of allReviews) {
      const reason = rejectionReason(r) || '✓ accepted';
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    console.log('  rejection reasons:', JSON.stringify(reasons, null, 2).split('\n').join('\n    '));
  }
  const picks = pickReviews(allReviews);
  console.log(`  quality picks: ${picks.length}`);
  for (const r of picks) console.log(`    ★${r.rating} ${reviewerName(r)} — ${cleanBody(r.body).slice(0, 60)}…`);

  if (picks.length === 0) {
    console.log('  (no quality reviews — leaving section disabled)');
    return;
  }

  const { path, header, j } = readTemplate(cluster);
  const sec = j.sections['testimonial-quotes'];
  if (!sec) { console.log('  (section missing — skipping)'); return; }

  // Replace blocks
  const { blocks, block_order } = buildBlocks(picks);
  sec.blocks = blocks;
  sec.block_order = block_order;

  // Re-enable + slider settings
  sec.disabled = false;
  sec.settings.swipe_on_mobile = true;
  sec.settings.columns_mobile = '2'; // bypass the page-level grid--1-col-mobile stacking CSS
  sec.settings.columns_desktop = 3;

  // Inject slider CSS into discount-callout's style block (idempotent)
  const dc = j.sections.main.blocks['discount-callout'];
  if (dc && !dc.settings.custom_liquid.includes('[id$="testimonial-quotes"]')) {
    dc.settings.custom_liquid = dc.settings.custom_liquid.replace('</style>', SLIDER_CSS + '</style>');
  }

  if (DRY_RUN) {
    console.log(`  (dry-run — would write ${picks.length} cards + slider CSS)`);
    return;
  }
  writeTemplate({ path, header, j });
  console.log(`  ✓ wrote ${picks.length} cards, re-enabled section, injected slider CSS`);
}

async function main() {
  console.log(`Shop: ${SHOP_DOMAIN}`);
  console.log(DRY_RUN ? '[DRY RUN]' : '[WRITES]');
  for (const [cluster, handle] of Object.entries(CLUSTER_TO_PRODUCT)) {
    try {
      await processCluster(cluster, handle);
    } catch (e) {
      console.error(`  ✗ ${cluster}: ${e.message}`);
    }
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
