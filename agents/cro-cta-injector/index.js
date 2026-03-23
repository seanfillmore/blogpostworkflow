#!/usr/bin/env node
/**
 * CRO CTA Injector
 *
 * Inserts a product CTA block into top-traffic blog posts that have
 * high impressions but zero conversions (per the CRO brief).
 *
 * Inserts at: ~300-word mark in the article body.
 * Idempotent: skips posts that already contain an rsc-cta-block.
 *
 * Usage:
 *   node agents/cro-cta-injector/index.js           # dry run (preview only)
 *   node agents/cro-cta-injector/index.js --apply   # write changes to Shopify
 */

import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const apply  = process.argv.includes('--apply');
const SITE   = 'https://www.realskincare.com';
const BLOG   = 'news';

// Priority posts identified in CRO brief → matching collection CTA
const TARGETS = [
  {
    handle:     'can-you-use-coconut-oil-as-toothpaste',
    headline:   'Try Our Coconut Oil Toothpaste',
    subhead:    'Natural, fluoride-free, and made with organic virgin coconut oil.',
    collection: 'vegan-toothpaste',
  },
  {
    handle:     'best-coconut-oil-body-lotion',   // partial match
    headline:   'Shop Coconut Oil Body Lotion',
    subhead:    'Organic, deeply hydrating, and free of harsh chemicals.',
    collection: 'coconut-oil-body-lotion',
  },
  {
    handle:     'best-fluoride-free-toothpaste',
    headline:   'Shop Fluoride-Free Toothpaste',
    subhead:    'Clean, effective oral care without fluoride or SLS.',
    collection: 'fluoride-free-toothpaste',
  },
  {
    handle:     'toxic-chemicals-in-soap',
    headline:   'Switch to Natural, Non-Toxic Bar Soap',
    subhead:    'Handmade with organic coconut oil — no SLS, parabens, or synthetic fragrance.',
    collection: 'natural-bar-soap',
  },
  {
    handle:     'coconut-oil-deodorant',
    headline:   'Try Our Natural Coconut Oil Deodorant',
    subhead:    'Aluminum-free, baking-soda-free, and made with organic coconut oil.',
    collection: 'natural-deodorant',
  },
];

function buildCta(config) {
  const url = SITE + '/collections/' + config.collection;
  return (
    '<div class="rsc-cta-block" style="border:2px solid #e5e7eb;border-radius:12px;' +
    'padding:20px 24px;margin:32px auto;background:#f9fafb;text-align:center;max-width:480px">' +
    '<p style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;' +
    'color:#6b7280;margin:0 0 6px;font-weight:700">Real Skin Care</p>' +
    '<p style="font-size:18px;font-weight:800;color:#111827;margin:0 0 6px">' + config.headline + '</p>' +
    '<p style="font-size:13px;color:#6b7280;margin:0 0 16px;line-height:1.5">' + config.subhead + '</p>' +
    '<a href="' + url + '" style="display:inline-block;background:#1e1b4b;color:#fff;' +
    'padding:10px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">' +
    'Shop Now \u2192</a>' +
    '</div>'
  );
}

/**
 * Insert ctaHtml after the </p> closest to the 300-word mark.
 * Returns null if CTA already present (idempotent).
 */
function insertCta(html, ctaHtml) {
  if (html.includes('rsc-cta-block')) return null;

  let pos = 0;
  let wordCount = 0;
  let insertPos = -1;

  while (pos < html.length) {
    const nextClose = html.indexOf('</p>', pos);
    if (nextClose === -1) break;

    const chunk = html.slice(pos, nextClose + 4);
    const words = chunk.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
    wordCount += words;
    pos = nextClose + 4;

    if (wordCount >= 300 && insertPos === -1) {
      insertPos = pos;
    }
  }

  // Fallback: insert at first </p> after midpoint
  if (insertPos === -1) {
    const mid = Math.floor(html.length / 2);
    const midClose = html.indexOf('</p>', mid);
    insertPos = midClose >= 0 ? midClose + 4 : html.length;
  }

  return html.slice(0, insertPos) + ctaHtml + html.slice(insertPos);
}

async function main() {
  console.log('CRO CTA Injector\n');
  console.log('  Mode:', apply ? 'APPLY (writing to Shopify)' : 'DRY RUN (use --apply to write changes)');
  console.log();

  const blogs = await getBlogs();
  const blog = blogs.find(b => b.handle === BLOG);
  if (!blog) throw new Error('Blog "' + BLOG + '" not found');

  const articles = await getArticles(blog.id, { limit: 250 });
  const articleMap = new Map(articles.map(a => [a.handle, a]));

  let applied = 0;
  let skipped = 0;

  for (const target of TARGETS) {
    // Find article by partial handle match
    const article = [...articleMap.entries()]
      .find(([h]) => h.includes(target.handle))?.[1];

    if (!article) {
      console.log('  ⚠️  No article found matching handle: ' + target.handle);
      skipped++;
      continue;
    }

    const ctaHtml = buildCta(target);
    const newHtml = insertCta(article.body_html || '', ctaHtml);

    if (newHtml === null) {
      console.log('  ✓  Already has CTA: ' + article.handle);
      skipped++;
      continue;
    }

    console.log('  ' + (apply ? '→' : '~') + '  ' + article.handle);
    console.log('      CTA: "' + target.headline + '" → /collections/' + target.collection);

    if (apply) {
      await updateArticle(blog.id, article.id, { body_html: newHtml });
      console.log('      Updated.');
    }
    applied++;
  }

  console.log();
  console.log('  Done — ' + applied + ' updated, ' + skipped + ' skipped.');

  if (apply) {
    await notify({
      subject: 'CRO CTA Injector completed',
      body: applied + ' posts updated with product CTA blocks.',
      status: 'success',
    }).catch(() => {});
  }
}

main().catch(async err => {
  console.error('Error:', err.message);
  await notify({ subject: 'CRO CTA Injector failed', body: err.message, status: 'error' }).catch(() => {});
  process.exit(1);
});
