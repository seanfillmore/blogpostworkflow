#!/usr/bin/env node
/**
 * Featured Product Injector
 *
 * Replaces the mid-article dashed CTA with a review-forward product card.
 * Sources: Shopify (product image/price), Judge.me (review quote + rating),
 *          Clarity snapshots (scroll depth positioning).
 *
 * Usage:
 *   node agents/featured-product-injector/index.js --handle <slug>   # pipeline: update local HTML file
 *   node agents/featured-product-injector/index.js --top <n>         # retroactive: update top-N Shopify posts
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Find the most-linked /products/<handle> in the HTML.
 * Returns the handle string or null if none found.
 */
export function findPrimaryProduct(html) {
  const counts = {};
  const re = /href="\/products\/([^"/?#]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const handle = m[1];
    counts[handle] = (counts[handle] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/**
 * Render a decimal rating as filled/empty star characters.
 * Uses Math.round — 4.8 → 5 stars, 4.2 → 4 stars.
 */
export function renderStars(rating) {
  const filled = Math.round(rating);
  const clamped = Math.max(0, Math.min(5, filled));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

/**
 * Remove the writer's mid-article dashed <section> CTA.
 * Pattern: <section ...border:1px dashed...>...</section>
 */
export function removeMidArticleCta(html) {
  return html.replace(/<section[^>]*border:1px dashed[^>]*>[\s\S]*?<\/section>/gi, '');
}

/**
 * Find the index to insert after, targeting the </p> whose cumulative word
 * count first meets or exceeds targetWords. Falls back to end of content.
 */
export function findInsertionPoint(html, targetWords) {
  let pos = 0;
  let cumulative = 0;
  while (pos < html.length) {
    const next = html.indexOf('</p>', pos);
    if (next === -1) break;
    const chunk = html.slice(pos, next + 4);
    const words = chunk.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    cumulative += words;
    pos = next + 4;
    if (cumulative >= targetWords) return pos;
  }
  // Fallback: before </article> or at end
  const articleEnd = html.lastIndexOf('</article>');
  return articleEnd > 0 ? articleEnd : html.length;
}

/**
 * Build the rsc-featured-product HTML block.
 * All fields are optional except title and handle — missing fields are omitted gracefully.
 */
export function buildFeaturedProductHtml({ title, handle, imageUrl, price, quote, verified, stars, reviewCount }) {
  const imgHtml = imageUrl
    ? `<img src="${escHtml(imageUrl)}" style="width:130px;object-fit:cover;flex-shrink:0" alt="${escHtml(title)}">`
    : '';

  const quoteHtml = quote
    ? `<div style="font-size:13px;color:#374151;font-family:sans-serif;font-style:italic;line-height:1.5;margin-bottom:10px;padding-left:10px;border-left:3px solid #AEDEAC">&ldquo;${escHtml(quote)}&rdquo;</div>`
    : '';

  const reviewLineHtml = (stars && reviewCount != null)
    ? `<div style="font-size:11px;color:#6b7280;font-family:sans-serif;margin-bottom:12px">&#8212; Verified Buyer &nbsp;&middot;&nbsp; <span style="color:#f59e0b">${stars}</span> &nbsp;&middot;&nbsp; ${reviewCount} reviews</div>`
    : '';

  const priceHtml = price != null
    ? `<span style="font-size:18px;font-weight:800;color:#111">$${escHtml(String(price))}</span>`
    : '';

  return (
    '<div class="rsc-featured-product" style="border:2px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:28px 0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)">' +
    '<div style="display:flex;gap:0">' +
    imgHtml +
    '<div style="padding:16px 18px;flex:1">' +
    '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;font-family:sans-serif;margin-bottom:4px">Featured Pick</div>' +
    `<div style="font-size:15px;font-weight:800;color:#111;font-family:sans-serif;margin-bottom:6px;line-height:1.3">${escHtml(title)}</div>` +
    quoteHtml +
    reviewLineHtml +
    '<div style="display:flex;align-items:center;gap:10px;font-family:sans-serif">' +
    priceHtml +
    `<a href="https://www.realskincare.com/products/${handle}" style="background:#1e1b4b;color:#fff;padding:8px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700">Add to Cart &#x2192;</a>` +
    '</div>' +
    '</div>' +
    '</div>' +
    '</div>'
  );
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── main() will be added in Task 3 ───────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error('main() not yet implemented — see Task 3');
  process.exit(1);
}
