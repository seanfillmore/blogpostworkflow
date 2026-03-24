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
    ? `<div style="flex-shrink:0;padding:5px"><img src="${escHtml(imageUrl)}" style="width:120px;object-fit:contain;border-radius:10px;display:block" alt="${escHtml(title)}"></div>`
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
    '<div class="rsc-featured-product" style="border:2px solid #e5e7eb;border-radius:14px;overflow:hidden;margin:28px 0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06);max-width:50%">' +
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

async function injectIntoHtml(rawHtml, avgScrollDepth, judgemeToken, judgemeShopDomain) {
  const html = extractArticleContent(rawHtml);

  // Idempotency check — must be first
  if (html.includes('rsc-featured-product')) {
    return { html: rawHtml, skipped: true, reason: 'already has rsc-featured-product' };
  }

  const productHandle = findPrimaryProduct(html);
  if (!productHandle) {
    return { html: rawHtml, skipped: true, reason: 'no /products/ links found' };
  }

  // Fetch product from Shopify
  const { getProducts } = await import('../../lib/shopify.js');
  const products = await getProducts({ handle: productHandle });
  const product = products?.[0];
  if (!product) {
    return { html: rawHtml, skipped: true, reason: `product not found: ${productHandle}` };
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

  return { html: result, skipped: false, productHandle, productTitle: product.title };
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
    const filePath = join(ROOT, 'data', 'posts', `${handle}.html`);
    if (!existsSync(filePath)) {
      throw new Error(`No HTML file found at ${filePath}. Run the blog post writer first.`);
    }
    const rawHtml = readFileSync(filePath, 'utf8');
    const result = await injectIntoHtml(rawHtml, avgScrollDepth, judgemeToken, judgemeShopDomain);

    if (result.skipped) {
      console.log(`  Skipped: ${result.reason}`);
    } else {
      writeFileSync(filePath, result.html);
      console.log(`  Injected featured product: "${result.productTitle}" → ${filePath}`);
    }

    await notify({
      subject: `Featured Product Injector: ${handle}`,
      body: result.skipped ? `Skipped — ${result.reason}` : `Injected "${result.productTitle}" into ${handle}`,
      status: 'success',
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
    const result = await injectIntoHtml(article.body_html || '', avgScrollDepth, judgemeToken, judgemeShopDomain);

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
