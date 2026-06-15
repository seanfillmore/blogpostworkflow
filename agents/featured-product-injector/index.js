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
import { getContentPath, getMetaPath, ROOT } from '../../lib/posts.js';

export { ROOT };
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Find the most-linked /products/<handle> in the HTML.
 * Returns the handle string or null if none found.
 * Kept for back-compat — new code uses linkedProductCounts + rankLinkedProducts.
 */
export function findPrimaryProduct(html) {
  const counts = {};
  const re = /href="(?:https?:\/\/[^"]*)?\/products\/([^"/?#]+)"/g;
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
 * Return all linked product handles with link counts, sorted descending.
 * Each entry: { handle, count }
 */
export function linkedProductCounts(html) {
  const counts = {};
  const re = /href="(?:https?:\/\/[^"]*)?\/products\/([^"/?#]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) counts[m[1]] = (counts[m[1]] || 0) + 1;
  return Object.entries(counts).map(([handle, count]) => ({ handle, count })).sort((a, b) => b.count - a.count);
}

function _tokens(s) { return new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []); }

/**
 * Rank linked products by relevance to the post's keyword+title, tie-broken by link count.
 * linked: Array<{ handle, count }>
 * products: Array<Shopify product objects> (may have title, handle, tags, product_type)
 * Returns the same entries enriched with { product, relevance }, most relevant first.
 * Note: Shopify REST returns tags as a comma-separated string; split before passing,
 * or pass the raw string — _tokens handles both.
 */
export function rankLinkedProducts(linked, products, { keyword, title }) {
  const want = new Set([..._tokens(keyword), ..._tokens(title)]);
  const byHandle = new Map((products || []).map((p) => [p.handle, p]));
  const scored = (linked || []).map((l) => {
    const p = byHandle.get(l.handle) || {};
    const tagsStr = Array.isArray(p.tags) ? p.tags.join(' ') : (p.tags || '');
    const hay = _tokens(`${p.title || ''} ${p.handle || l.handle} ${tagsStr} ${p.product_type || ''}`);
    let overlap = 0;
    for (const t of want) if (hay.has(t)) overlap++;
    return { ...l, product: p, relevance: overlap };
  });
  scored.sort((a, b) => (b.relevance - a.relevance) || (b.count - a.count));
  return scored;
}

// Tokens that carry NO discriminating signal for matching a post to a product.
// Two groups: (1) generic English/marketing filler, and (2) brand-ubiquitous
// terms — every RSC product is "coconut oil"/"natural"/"organic", so those words
// match everything and must be ignored, leaving only the CATEGORY tokens
// (deodorant, toothpaste, lotion, soap, lip balm…) to discriminate.
const RELEVANCE_STOPWORDS = new Set([
  // generic / marketing
  'best', 'top', 'good', 'great', 'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'with', 'in', 'on',
  'is', 'are', 'how', 'what', 'why', 'vs', 'your', 'you', 'my', 'our', 'that', 'this', 'use', 'using',
  'guide', 'review', 'reviews', 'benefits', 'formula', 'all', 'new', '2024', '2025', '2026',
  'oz', '1oz', '2oz', '3oz', '4oz', 'ounce', 'ounces',
  // brand-ubiquitous (present across the whole catalog → non-discriminating)
  'real', 'skin', 'skincare', 'care', 'natural', 'organic', 'clean', 'coconut', 'oil', 'pure', 'based',
]);

function _contentTokens(s) {
  const out = new Set();
  for (const t of _tokens(s)) if (!RELEVANCE_STOPWORDS.has(t)) out.add(t);
  return out;
}

/**
 * Rank the WHOLE catalog by relevance to the post's keyword+title. Scores only on
 * DISCRIMINATING tokens (stopwords + brand-ubiquitous terms removed) so a post
 * matches on its product CATEGORY, not on filler like "best"/"coconut oil" that
 * every product shares. Used to choose a buy-box product when the writer linked
 * none, so an off-scope-leaning article still carries a relevant product instead
 * of dead-ending at the publisher gate.
 * Returns [{ product, relevance }], most relevant first (relevance-0 retained).
 */
export function rankProductsByRelevance(products, { keyword, title }) {
  const want = _contentTokens(`${keyword || ''} ${title || ''}`);
  const scored = (products || []).map((p) => {
    const tagsStr = Array.isArray(p.tags) ? p.tags.join(' ') : (p.tags || '');
    const hay = _contentTokens(`${p.title || ''} ${p.handle || ''} ${tagsStr} ${p.product_type || ''}`);
    let overlap = 0;
    for (const t of want) if (hay.has(t)) overlap++;
    return { product: p, relevance: overlap };
  });
  scored.sort((a, b) => b.relevance - a.relevance);
  return scored;
}

/**
 * Pick the single best buy-box product for a post that linked none. Returns the
 * product object, or null when nothing is genuinely relevant (relevance 0) —
 * the caller then HOLDS the post for review rather than forcing a random product.
 */
export function pickRelevantProduct(products, { keyword, title }) {
  const best = rankProductsByRelevance(products, { keyword, title })[0];
  return best && best.relevance > 0 && best.product && best.product.title ? best.product : null;
}

/**
 * Build conversion-oriented CTA copy for the featured product card.
 * Returns { headline, buttonText }.
 */
export function buildCtaCopy({ product, keyword }) {
  const name = (product && product.title) || 'this pick';
  const kw = keyword || 'what you need';
  return { headline: `Our pick for ${kw}: ${name}`, buttonText: `Shop ${name}`.slice(0, 60) };
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
 * ctaHeadline — conversion-oriented benefit headline above the card (from buildCtaCopy)
 * ctaButtonText — CTA button label (from buildCtaCopy); defaults to "Add to Cart"
 */
export function buildFeaturedProductHtml({ title, handle, imageUrl, price, quote, verified, stars, reviewCount, ctaHeadline, ctaButtonText }) {
  const imgHtml = imageUrl
    ? `<div style="flex-shrink:0;align-self:stretch;padding:5px;display:flex;align-items:center"><img src="${escHtml(imageUrl)}" style="width:130px;height:100%;object-fit:contain;border-radius:10px;display:block" alt="${escHtml(title)}"></div>`
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

  const headlineHtml = ctaHeadline
    ? `<div style="font-size:11px;color:#4b5563;font-family:sans-serif;font-style:italic;margin-bottom:6px">${escHtml(ctaHeadline)}</div>`
    : '';

  const buttonLabel = ctaButtonText || 'Add to Cart';

  return (
    '<style>.rsc-featured-product{max-width:80%}@media(max-width:768px){.rsc-featured-product{max-width:100%}}</style>' +
    '<div class="rsc-featured-product" style="border:2px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:28px 0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)">' +
    '<div style="display:flex;gap:0">' +
    imgHtml +
    '<div style="padding:16px 18px;flex:1">' +
    '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;font-family:sans-serif;margin-bottom:4px">Featured Pick</div>' +
    `<div style="font-size:15px;font-weight:800;color:#111;font-family:sans-serif;margin-bottom:6px;line-height:1.3">${escHtml(title)}</div>` +
    headlineHtml +
    quoteHtml +
    reviewLineHtml +
    '<div style="display:flex;align-items:center;gap:10px;font-family:sans-serif">' +
    priceHtml +
    `<a href="https://www.realskincare.com/products/${handle}" style="background:#1e1b4b;color:#fff;padding:8px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700">${escHtml(buttonLabel)} &#x2192;</a>` +
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

function loadEnv() {
  try {
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
  } catch { return {}; }
}

function extractArticleContent(html) {
  const start = html.indexOf('<article');
  const end = html.lastIndexOf('</article>');
  if (start !== -1 && end > start) {
    return html.slice(html.indexOf('>', start) + 1, end);
  }
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]*\/?>/gi, '')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
}

function loadAvgScrollDepth() {
  const dir = join(ROOT, 'data', 'snapshots', 'clarity');
  if (!existsSync(dir)) return 40;
  const files = readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-60);
  const depths = files
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8'))?.scrollDepth; } catch { return null; } })
    .filter(d => typeof d === 'number');
  return depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : 40;
}

function stripText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── per-article injection ─────────────────────────────────────────────────────

/**
 * @param {string} rawHtml
 * @param {number} avgScrollDepth
 * @param {string|null} judgemeToken
 * @param {string|null} judgemeShopDomain
 * @param {{ target_keyword?: string, title?: string }} [postMeta] — from meta.json; used for relevance ranking
 */
async function injectIntoHtml(rawHtml, avgScrollDepth, judgemeToken, judgemeShopDomain, postMeta = {}) {
  const html = extractArticleContent(rawHtml);

  // Idempotency check — must be first
  if (html.includes('rsc-featured-product')) {
    return { html: rawHtml, skipped: true, reason: 'already has rsc-featured-product' };
  }

  const keyword = postMeta.target_keyword || '';
  const postTitle = postMeta.title || '';
  const { getProducts } = await import('../../lib/shopify.js');

  // Find all linked products (handle + link count), sorted by count descending
  const linked = linkedProductCounts(html);

  let product = null;
  let productHandle = null;
  let fallbackInjected = false;

  if (linked.length === 0) {
    // The writer linked no product. Rather than dead-ending the post at the
    // publisher gate (the old "no /products/ links found" block → Kill/re-scope),
    // pick the most relevant product from the catalog and embed a buy box for it.
    // Only HOLD the post for review if nothing in the catalog is relevant.
    const all = await getProducts().catch(() => []);
    product = pickRelevantProduct(all, { keyword, title: postTitle });
    if (!product) {
      return { html: rawHtml, skipped: true, reason: 'no relevant product' };
    }
    productHandle = product.handle;
    fallbackInjected = true;
  } else {
    // Fetch Shopify product data for each linked handle (≤ ~3 usually)
    const fetchedProducts = (
      await Promise.all(
        linked.map(({ handle }) =>
          getProducts({ handle }).then((res) => res?.[0] ?? null).catch(() => null)
        )
      )
    ).filter(Boolean);

    // Rank by relevance to post keyword + title; tie-break by link count
    const ranked = rankLinkedProducts(linked, fetchedProducts, { keyword, title: postTitle });

    // Pick the top-ranked product; fall back through the list if fetch failed
    for (const entry of ranked) {
      if (entry.product && entry.product.title) {
        product = entry.product;
        productHandle = entry.handle;
        break;
      }
    }
    if (!product) {
      return { html: rawHtml, skipped: true, reason: 'no linked product data found in Shopify' };
    }
  }

  const imageUrl = product.images?.[0]?.src ?? null;
  const price = product.variants?.[0]?.price ?? null;

  // Fetch Judge.me data (both calls in parallel)
  const { fetchTopReview, fetchProductStats } = await import('../../lib/judgeme.js');
  const [reviewData, statsData] = await Promise.all([
    judgemeToken ? fetchTopReview(productHandle, judgemeShopDomain, judgemeToken).catch(() => null) : Promise.resolve(null),
    judgemeToken ? fetchProductStats(productHandle, judgemeShopDomain, judgemeToken).catch(() => null) : Promise.resolve(null),
  ]);

  const stars = statsData ? renderStars(statsData.rating) : null;
  const reviewCount = statsData?.reviewCount ?? null;

  // Build CTA copy from relevance context
  const ctaCopy = buildCtaCopy({ product, keyword: keyword || null });

  // Build featured product block
  const block = buildFeaturedProductHtml({
    title: product.title,
    handle: productHandle,
    imageUrl,
    price,
    quote: reviewData?.quote ?? null,
    verified: reviewData?.verified ?? false,
    stars,
    reviewCount,
    ctaHeadline: ctaCopy.headline,
    ctaButtonText: ctaCopy.buttonText,
  });

  // Remove mid-article dashed CTA, then insert block at scroll-depth position
  let processed = removeMidArticleCta(rawHtml);
  const articleStart = processed.indexOf('<article');
  const contentStart = articleStart !== -1 ? processed.indexOf('>', articleStart) + 1 : 0;
  const innerHtml = articleStart !== -1 ? processed.slice(contentStart, processed.lastIndexOf('</article>')) : processed;
  const plainText = stripText(innerHtml);
  const total = wordCount(plainText);
  const targetWords = Math.floor(avgScrollDepth / 100 * total * 0.9);
  const insertIdx = findInsertionPoint(innerHtml, targetWords);
  const absoluteIdx = contentStart + insertIdx;

  const result = processed.slice(0, absoluteIdx) + block + processed.slice(absoluteIdx);

  return { html: result, skipped: false, productHandle, productTitle: product.title, fallbackInjected };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const judgemeToken = process.env.JUDGEME_API_TOKEN || env.JUDGEME_API_TOKEN || null;
  const judgemeShopDomain = process.env.SHOPIFY_STORE || env.SHOPIFY_STORE || null;

  if (!judgemeToken || !judgemeShopDomain) {
    throw new Error('Missing JUDGEME_API_TOKEN or SHOPIFY_STORE in .env');
  }

  const args = process.argv.slice(2);
  const handleIdx = args.indexOf('--handle');
  const topIdx = args.indexOf('--top');
  const handle = handleIdx !== -1 ? args[handleIdx + 1] : null;
  const topN = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : null;

  if (!handle && (!topN || !Number.isInteger(topN) || topN < 1)) {
    console.error('Usage: node index.js --handle <slug>  OR  --top <n>');
    process.exit(1);
  }

  const avgScrollDepth = loadAvgScrollDepth();
  console.log(`Featured Product Injector\n`);
  console.log(`  Avg scroll depth: ${avgScrollDepth.toFixed(1)}% (target insertion: ${(avgScrollDepth * 0.9).toFixed(1)}%)`);

  const { notify } = await import('../../lib/notify.js');

  // ── Pipeline mode: update local HTML file ──────────────────────────────────
  if (handle) {
    console.log(`  Mode: pipeline\n  Handle: ${handle}`);
    const filePath = getContentPath(handle);
    if (!existsSync(filePath)) {
      throw new Error(`No HTML file found at ${filePath}. Run the blog post writer first.`);
    }
    const rawHtml = readFileSync(filePath, 'utf8');
    // Load meta for relevance ranking (target_keyword + title)
    const metaPath = getMetaPath(handle);
    let pipelineMeta = {};
    if (existsSync(metaPath)) {
      try { pipelineMeta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { /* ignore */ }
    }
    const result = await injectIntoHtml(rawHtml, avgScrollDepth, judgemeToken, judgemeShopDomain, pipelineMeta);

    if (result.skipped) {
      console.log(`  Skipped: ${result.reason}`);
    } else {
      writeFileSync(filePath, result.html);
      const how = result.fallbackInjected ? ' (auto-selected — writer linked none)' : '';
      console.log(`  Injected featured product: "${result.productTitle}"${how} → ${filePath}`);
    }

    // Auto-remediation: when the writer linked no product we now pick the most
    // relevant one and embed a buy box (above), so a near-on-scope article still
    // ships with a commercial CTA instead of dead-ending. We only block — and
    // only to HOLD for review, never to auto-kill — when nothing in the catalog
    // is relevant at all (genuinely off scope, e.g. headphones). The strategist's
    // product-scope filter remains the primary guard; this is the last-mile catch.
    if (result.skipped && result.reason === 'no relevant product') {
      const metaPath = getMetaPath(handle);
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          meta.publisher_block = {
            flagged_at: new Date().toISOString(),
            flagged_by: 'featured-product-injector',
            reason: 'no relevant product to feature — off product scope; holding for review',
          };
          writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          console.log('  ⚠ publisher_block set — no relevant product (held for review)');
        } catch (e) {
          console.log(`  ⚠ Could not set publisher_block: ${e.message}`);
        }
      }
    }

    await notify({
      subject: `Featured Product Injector: ${handle}`,
      body: result.skipped
        ? `Skipped — ${result.reason}`
        : `Injected "${result.productTitle}"${result.fallbackInjected ? ' (auto-selected)' : ''} into ${handle}`,
      status: result.skipped && result.reason === 'no relevant product' ? 'error' : 'success',
    }).catch(() => {});
    return;
  }

  // ── Retroactive mode: update top-N Shopify posts ───────────────────────────
  console.log(`  Mode: retroactive (top ${topN})`);

  // Find top-N blog posts from GSC snapshot
  const gscDir = join(ROOT, 'data', 'snapshots', 'gsc');
  const gscFiles = readdirSync(gscDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (gscFiles.length === 0) throw new Error('No GSC snapshots found in data/snapshots/gsc/');
  const gscSnap = JSON.parse(readFileSync(join(gscDir, gscFiles.at(-1)), 'utf8'));
  const blogPages = (gscSnap.topPages || gscSnap.pages || [])
    .filter(p => (p.page || p.url || '').includes('/blogs/news/'))
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .slice(0, topN);

  if (blogPages.length === 0) throw new Error('No blog pages found in GSC snapshot');
  console.log(`  Top ${blogPages.length} pages: ${blogPages.map(p => (p.page || p.url).split('/').at(-1)).join(', ')}`);

  // Fetch all articles from Shopify once
  const { getBlogs, getArticles, updateArticle } = await import('../../lib/shopify.js');
  const blogs = await getBlogs();
  const newsBlog = blogs.find(b => b.handle === 'news');
  if (!newsBlog) throw new Error('Blog "news" not found');
  const articles = await getArticles(newsBlog.id, { limit: 250 });
  const articleMap = new Map(articles.map(a => [a.handle, a]));

  const results = [];
  for (const page of blogPages) {
    const pageHandle = (page.page || page.url).split('/').at(-1);
    const article = articleMap.get(pageHandle);
    if (!article) {
      console.log(`  ⚠  Article not found in Shopify: ${pageHandle}`);
      results.push({ handle: pageHandle, status: 'not_found' });
      continue;
    }

    console.log(`  Processing: ${pageHandle}`);
    // Load local meta for relevance ranking if available; fall back to article title as keyword proxy
    const retroMetaPath = getMetaPath(pageHandle);
    let retroMeta = {};
    if (existsSync(retroMetaPath)) {
      try { retroMeta = JSON.parse(readFileSync(retroMetaPath, 'utf8')); } catch { /* ignore */ }
    }
    if (!retroMeta.target_keyword) retroMeta.target_keyword = (article.title || pageHandle).toLowerCase();
    if (!retroMeta.title) retroMeta.title = article.title || pageHandle;
    const result = await injectIntoHtml(article.body_html || '', avgScrollDepth, judgemeToken, judgemeShopDomain, retroMeta);

    if (result.skipped) {
      console.log(`    Skipped: ${result.reason}`);
      results.push({ handle: pageHandle, status: 'skipped', reason: result.reason });
      continue;
    }

    await updateArticle(newsBlog.id, article.id, { body_html: result.html });
    console.log(`    Injected: "${result.productTitle}"`);
    results.push({ handle: pageHandle, status: 'injected', product: result.productTitle });
  }

  // Save report
  const reportsDir = join(ROOT, 'data', 'reports', 'featured-product');
  mkdirSync(reportsDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const reportLines = [
    `# Featured Product Injector Report — ${today}`,
    '',
    `Mode: retroactive (top ${topN})`,
    `Avg scroll depth: ${avgScrollDepth.toFixed(1)}%`,
    '',
    '## Results',
    ...results.map(r => `- **${r.handle}**: ${r.status}${r.product ? ` — "${r.product}"` : ''}${r.reason ? ` — ${r.reason}` : ''}`),
  ];
  writeFileSync(join(reportsDir, `${today}.md`), reportLines.join('\n'));
  console.log(`\n  Report saved to data/reports/featured-product/${today}.md`);

  const injected = results.filter(r => r.status === 'injected').length;
  await notify({
    subject: `Featured Product Injector: ${injected}/${results.length} posts updated`,
    body: reportLines.join('\n'),
    status: 'success',
  }).catch(() => {});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(async err => {
    console.error('Error:', err.message);
    const { notify } = await import('../../lib/notify.js');
    await notify({ subject: 'Featured Product Injector failed', body: err.message, status: 'error' }).catch(() => {});
    process.exit(1);
  });
}
