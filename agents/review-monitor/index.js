#!/usr/bin/env node
/**
 * Review Monitor Agent
 *
 * Daily pull of recent reviews from Judge.me API. Classifies by sentiment,
 * extracts complaint themes from negative reviews, computes per-product
 * aggregate stats. Surfaces in the morning digest for response tracking.
 *
 * Usage:
 *   node agents/review-monitor/index.js           # pull last 1 day
 *   node agents/review-monitor/index.js --days 7  # pull last 7 days
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getProducts } from '../../lib/shopify.js';
import { fetchRecentReviews, fetchProductStats, resolveExternalId } from '../../lib/judgeme.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── .env loader ──────────────────────────────────────────────────────────────

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

const env = loadEnv();
const JUDGEME_API_TOKEN = process.env.JUDGEME_API_TOKEN || env.JUDGEME_API_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || env.SHOPIFY_STORE;

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 1;

// ── Classification helpers ───────────────────────────────────────────────────

function classifyReview(rating) {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'neutral';
  return 'negative';
}

const COMPLAINT_PATTERNS = ['thick', 'greasy', 'smell', 'irritat', 'burn', 'broke out', 'rash', 'sticky', 'dry', 'oily'];

function extractComplaintThemes(body) {
  const lower = body.toLowerCase();
  return COMPLAINT_PATTERNS.filter((p) => lower.includes(p));
}

// ── Output dir ───────────────────────────────────────────────────────────────

const REPORTS_DIR = join(ROOT, 'data', 'reports', 'reviews');

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!JUDGEME_API_TOKEN || !SHOPIFY_STORE) {
    console.error('Missing JUDGEME_API_TOKEN or SHOPIFY_STORE in .env');
    process.exit(1);
  }

  console.log(`Review Monitor — fetching reviews from last ${days} day(s)…`);

  // 1. Fetch all products from Shopify to build handle → title lookup
  console.log('Fetching products from Shopify…');
  const products = await getProducts();
  const productsByHandle = new Map();
  for (const p of products) {
    productsByHandle.set(p.handle, { title: p.title, id: p.id });
  }
  console.log(`  ${products.length} products loaded`);

  // 2. Resolve external IDs for each product via Judge.me
  console.log('Resolving Judge.me external IDs…');
  const externalIdMap = new Map(); // externalId → { handle, title }
  for (const [handle, { title }] of productsByHandle) {
    const externalId = await resolveExternalId(handle, SHOPIFY_STORE, JUDGEME_API_TOKEN);
    if (externalId) {
      externalIdMap.set(externalId, { handle, title });
    }
  }
  console.log(`  ${externalIdMap.size} products resolved in Judge.me`);

  // 3. Fetch recent reviews
  console.log('Fetching recent reviews…');
  const recentReviews = await fetchRecentReviews(days, SHOPIFY_STORE, JUDGEME_API_TOKEN);
  console.log(`  ${recentReviews.length} reviews in the last ${days} day(s)`);

  // 4. Classify reviews and map to products
  const newReviews = [];
  const flaggedForResponse = [];
  const productHandlesWithReviews = new Set();
  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;

  for (const review of recentReviews) {
    const productInfo = externalIdMap.get(review.product_external_id);
    const handle = productInfo?.handle || 'unknown';
    const title = productInfo?.title || 'Unknown Product';
    const sentiment = classifyReview(review.rating);

    if (sentiment === 'positive') positiveCount++;
    else if (sentiment === 'neutral') neutralCount++;
    else negativeCount++;

    productHandlesWithReviews.add(handle);

    const bodyTruncated = review.body.length > 200 ? review.body.slice(0, 200) : review.body;

    newReviews.push({
      product_handle: handle,
      product_title: title,
      rating: review.rating,
      reviewer: review.reviewer,
      body: bodyTruncated,
      verified: review.verified,
      sentiment,
    });

    // Flag negative reviews for response
    if (sentiment === 'negative') {
      const themes = extractComplaintThemes(review.body);
      flaggedForResponse.push({
        product_handle: handle,
        rating: review.rating,
        complaint: bodyTruncated,
        themes,
      });
    }
  }

  // 5. Fetch aggregate stats for products that had reviews
  console.log('Fetching per-product aggregate stats…');
  const productSentiment = {};

  for (const handle of productHandlesWithReviews) {
    if (handle === 'unknown') continue;
    const stats = await fetchProductStats(handle, SHOPIFY_STORE, JUDGEME_API_TOKEN);
    // Collect negative themes across all new reviews for this product
    const negativeThemes = [];
    for (const review of recentReviews) {
      const info = externalIdMap.get(review.product_external_id);
      if (info?.handle === handle && classifyReview(review.rating) === 'negative') {
        negativeThemes.push(...extractComplaintThemes(review.body));
      }
    }
    const uniqueThemes = [...new Set(negativeThemes)];

    productSentiment[handle] = {
      avg_rating: stats ? Math.round(stats.rating * 10) / 10 : null,
      review_count: stats?.reviewCount || 0,
      negative_themes: uniqueThemes,
    };
  }

  // 6. Build and write report
  const report = {
    generated_at: new Date().toISOString(),
    period_days: days,
    new_reviews: newReviews,
    summary: {
      total_new: recentReviews.length,
      positive: positiveCount,
      neutral: neutralCount,
      negative: negativeCount,
      flagged_for_response: flaggedForResponse,
    },
    product_sentiment: productSentiment,
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const outputPath = join(REPORTS_DIR, 'latest.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${outputPath}`);

  // Summary
  console.log(`\nSummary: ${report.summary.total_new} reviews — ${positiveCount} positive, ${neutralCount} neutral, ${negativeCount} negative`);
  if (flaggedForResponse.length > 0) {
    console.log(`⚠ ${flaggedForResponse.length} review(s) flagged for response`);
  }

  // Notify
  await notify({
    subject: `Review Monitor: ${report.summary.total_new} new reviews (${days}d)`,
    body: `Positive: ${positiveCount}, Neutral: ${neutralCount}, Negative: ${negativeCount}\nFlagged for response: ${flaggedForResponse.length}`,
    status: negativeCount > 0 ? 'info' : 'success',
    category: 'reviews',
  });
}

main().catch((err) => {
  console.error('Review Monitor failed:', err);
  notify({ subject: 'Review Monitor failed', body: err.message, status: 'error', category: 'reviews' });
  process.exit(1);
});
