#!/usr/bin/env node

import { config } from 'dotenv';
config();

const store = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_SECRET;

if (!store || !token) {
  console.error('Missing SHOPIFY_STORE or SHOPIFY_SECRET in environment');
  process.exit(1);
}

async function fetchAllArticles() {
  let articles = [];
  let url = `https://${store}/admin/api/2025-01/articles.json?limit=250`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    articles = articles.concat(data.articles || []);

    // Check for pagination
    const linkHeader = res.headers.get('link');
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>; rel="next"/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }

  return articles;
}

async function cleanKlaviyoFromArticles() {
  console.log('Fetching all articles...');
  const articles = await fetchAllArticles();
  console.log(`Found ${articles.length} articles total.`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const article of articles) {
    const html = article.body_html || '';

    if (!html.includes('klaviyo-form-Xr4S7X')) {
      skippedCount++;
      continue;
    }

    console.log(`\nFound Klaviyo div in: "${article.title}" (ID: ${article.id})`);

    let cleaned = html;

    // Remove outer wrapper pattern: <div style="margin..."><div class="...klaviyo-form-Xr4S7X...">...</div></div>
    cleaned = cleaned.replace(
      /<div[^>]*style="[^"]*margin[^"]*"[^>]*>\s*<div[^>]*class="[^"]*klaviyo-form-Xr4S7X[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi,
      ''
    );

    // Remove just the klaviyo div if not wrapped (or if wrapper regex didn't match)
    cleaned = cleaned.replace(
      /<div[^>]*class="[^"]*klaviyo-form-Xr4S7X[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
      ''
    );

    // Clean up any empty divs that might remain
    cleaned = cleaned.replace(/<div[^>]*>\s*<\/div>/gi, '');

    if (cleaned === html) {
      console.log('  WARNING: Regex did not match — skipping to avoid data loss');
      console.log('  Snippet:', html.slice(html.indexOf('klaviyo-form-Xr4S7X') - 50, html.indexOf('klaviyo-form-Xr4S7X') + 100));
      continue;
    }

    // Update the article
    const blogId = article.blog_id;
    const updateUrl = `https://${store}/admin/api/2025-01/blogs/${blogId}/articles/${article.id}.json`;

    const updateRes = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ article: { id: article.id, body_html: cleaned } })
    });

    if (!updateRes.ok) {
      console.log(`  ERROR updating: HTTP ${updateRes.status}`);
      console.log(await updateRes.text());
    } else {
      console.log(`  UPDATED successfully`);
      updatedCount++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total articles: ${articles.length}`);
  console.log(`Articles with Klaviyo div (updated): ${updatedCount}`);
  console.log(`Articles without Klaviyo div (skipped): ${skippedCount}`);
}

cleanKlaviyoFromArticles().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
