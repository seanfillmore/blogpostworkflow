/**
 * Internal Link Auditor Agent
 *
 * Crawls every blog post on the site and maps all internal links.
 * Identifies:
 *   - Pillar pages (most inbound internal links)
 *   - Orphaned blog posts (no inbound links from other posts)
 *   - Link distribution across products, collections, and other posts
 *
 * Requires: data/sitemap-index.json (run sitemap-indexer first)
 * Output:   data/link-audit.json + data/link-audit-report.md
 * Usage:    node agents/internal-link-auditor/index.js
 */

import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// Rate limit: pause between requests to be a polite crawler
const DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSitemapIndex() {
  const path = join(ROOT, 'data', 'sitemap-index.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.error('sitemap-index.json not found. Run sitemap-indexer first.');
    process.exit(1);
  }
}

function normalizeSiteUrl(href, siteUrl) {
  if (!href) return null;
  try {
    const base = new URL(siteUrl);
    // Skip anchors, mailto, tel, javascript
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return null;
    const resolved = new URL(href, siteUrl);
    // Only keep same-domain links
    if (resolved.hostname !== base.hostname) return null;
    // Normalize: strip hash and trailing slash
    resolved.hash = '';
    let path = resolved.pathname.replace(/\/$/, '') || '/';
    return base.origin + path;
  } catch {
    return null;
  }
}

function classifyUrl(url, siteUrl) {
  try {
    const path = new URL(url).pathname;
    if (path.startsWith('/products/')) return 'product';
    if (path.startsWith('/collections/')) return 'collection';
    if (path.startsWith('/blogs/') && path.split('/').length > 3) return 'blog_post';
    if (path.startsWith('/blogs/')) return 'blog_index';
    if (path.startsWith('/pages/')) return 'page';
    if (path === '/' || path === '') return 'homepage';
    return 'other';
  } catch {
    return 'other';
  }
}

async function fetchLinks(url, siteUrl) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SEO-Audit-Bot/1.0 (internal use)' },
  });
  if (!res.ok) {
    return { status: res.status, links: [] };
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  // Extract links only from main content area (exclude nav, header, footer)
  // Shopify blog posts typically use article or main tags
  const contentSelectors = ['article', 'main', '.article-template', '.blog-post', '[role="main"]'];
  let $content = null;
  for (const sel of contentSelectors) {
    if ($(sel).length) {
      $content = $(sel);
      break;
    }
  }
  // Fallback to body if no content area found
  if (!$content) $content = $('body');

  const links = [];
  $content.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    const normalized = normalizeSiteUrl(href, siteUrl);
    if (normalized) {
      links.push({
        url: normalized,
        text: text.substring(0, 100),
        type: classifyUrl(normalized, siteUrl),
      });
    }
  });

  // Deduplicate by URL (keep first occurrence with its anchor text)
  const seen = new Set();
  const unique = links.filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  return { status: res.status, links: unique };
}

async function run() {
  const sitemapIndex = loadSitemapIndex();
  const { url: siteUrl } = sitemapIndex.meta;
  const blogPosts = sitemapIndex.pages.filter((p) => p.type === 'blog_post');
  const allIndexedUrls = new Set(sitemapIndex.pages.map((p) => p.url.replace(/\/$/, '')));

  console.log(`\nInternal Link Auditor — ${sitemapIndex.meta.site}`);
  console.log(`Crawling ${blogPosts.length} blog posts...\n`);

  // Map: sourceUrl -> { status, links[] }
  const crawlResults = {};
  // Map: targetUrl -> [{ from, anchorText }]
  const inboundLinks = {};

  for (let i = 0; i < blogPosts.length; i++) {
    const post = blogPosts[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${blogPosts.length}] ${post.slug} ... `);

    try {
      const { status, links } = await fetchLinks(post.url, siteUrl);
      crawlResults[post.url] = { status, links };

      if (status !== 200) {
        console.log(`HTTP ${status}`);
      } else {
        console.log(`${links.length} links`);
        for (const link of links) {
          if (!inboundLinks[link.url]) inboundLinks[link.url] = [];
          inboundLinks[link.url].push({ from: post.url, from_slug: post.slug, anchor_text: link.text });
        }
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      crawlResults[post.url] = { status: 'error', error: err.message, links: [] };
    }

    if (i < blogPosts.length - 1) await sleep(DELAY_MS);
  }

  // --- Build analysis ---

  // Pillar pages: all targets sorted by inbound link count
  const pillarPages = Object.entries(inboundLinks)
    .map(([url, links]) => ({
      url,
      type: classifyUrl(url, siteUrl),
      slug: url.split('/').filter(Boolean).pop() || '/',
      inbound_count: links.length,
      linked_from: links.map((l) => l.from_slug),
      anchor_texts: [...new Set(links.map((l) => l.anchor_text).filter(Boolean))],
    }))
    .sort((a, b) => b.inbound_count - a.inbound_count);

  // Orphaned blog posts: blog posts with zero inbound links from other blog posts
  const blogPostUrls = new Set(blogPosts.map((p) => p.url.replace(/\/$/, '')));
  const orphanedPosts = blogPosts.filter((post) => {
    const normalized = post.url.replace(/\/$/, '');
    const inbound = inboundLinks[normalized] || inboundLinks[post.url] || [];
    return inbound.length === 0;
  });

  // Broken internal links: links to URLs not in sitemap index
  const brokenLinks = [];
  for (const [sourceUrl, { links }] of Object.entries(crawlResults)) {
    for (const link of links) {
      const normalized = link.url.replace(/\/$/, '');
      if (!allIndexedUrls.has(normalized)) {
        brokenLinks.push({
          source: sourceUrl,
          source_slug: sourceUrl.split('/').filter(Boolean).pop(),
          target: link.url,
          anchor_text: link.text,
          target_type: link.type,
        });
      }
    }
  }

  // Link distribution by type
  const linksByType = {};
  for (const { links } of Object.values(crawlResults)) {
    for (const link of links) {
      linksByType[link.type] = (linksByType[link.type] || 0) + 1;
    }
  }

  // --- Assemble full output ---
  const output = {
    meta: {
      site: sitemapIndex.meta.site,
      generated_at: new Date().toISOString(),
      blog_posts_crawled: blogPosts.length,
      total_internal_links_found: Object.values(crawlResults).reduce((s, r) => s + r.links.length, 0),
      broken_internal_links: brokenLinks.length,
      orphaned_blog_posts: orphanedPosts.length,
    },
    pillar_pages: pillarPages.slice(0, 20),
    orphaned_blog_posts: orphanedPosts.map((p) => ({ url: p.url, slug: p.slug, lastmod: p.lastmod })),
    broken_internal_links: brokenLinks,
    link_distribution_by_type: linksByType,
    crawl_results: crawlResults,
  };

  writeFileSync(join(ROOT, 'data', 'link-audit.json'), JSON.stringify(output, null, 2));

  // --- Generate Markdown report ---
  const lines = [];
  lines.push(`# Internal Link Audit — ${sitemapIndex.meta.site}`);
  lines.push(`Generated: ${new Date().toLocaleString()}\n`);

  lines.push('## Summary');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Blog posts crawled | ${output.meta.blog_posts_crawled} |`);
  lines.push(`| Total internal links found | ${output.meta.total_internal_links_found} |`);
  lines.push(`| Broken internal links | ${output.meta.broken_internal_links} |`);
  lines.push(`| Orphaned blog posts | ${output.meta.orphaned_blog_posts} |`);
  lines.push('');

  lines.push('## Pillar Pages (Top 20 by Inbound Links)');
  lines.push(`| Rank | Page | Type | Inbound Links | Linked From |`);
  lines.push(`|------|------|------|---------------|-------------|`);
  pillarPages.slice(0, 20).forEach((p, i) => {
    lines.push(`| ${i + 1} | [${p.slug}](${p.url}) | ${p.type} | ${p.inbound_count} | ${p.linked_from.slice(0, 3).join(', ')}${p.linked_from.length > 3 ? ` +${p.linked_from.length - 3} more` : ''} |`);
  });
  lines.push('');

  // Quick-win under-linked section: posts currently at positions 11-20 with
  // fewer inbound links than the median. These are the single best targets
  // for new internal links — a rank boost is one extra link away. See
  // docs/signal-manifest.md.
  lines.push('## Quick-Win Under-Linked Posts (Highest Leverage)');
  try {
    const qwPath = join(ROOT, 'data', 'reports', 'quick-wins', 'latest.json');
    const qw = JSON.parse(readFileSync(qwPath, 'utf8'));
    const qwTop = qw.top || [];
    if (qwTop.length === 0) {
      lines.push('No quick-win candidates currently. Run agents/quick-win-targeter/index.js.');
    } else {
      lines.push('These posts are at positions 11-20 per the latest quick-win report. Prioritize adding links TO them from the pillar pages above.');
      lines.push('');
      lines.push(`| Quick-Win Slug | Pos | Inbound Links | Top Query |`);
      lines.push(`|----------------|-----|---------------|-----------|`);
      for (const c of qwTop) {
        const inboundMatch = pillarPages.find((p) => (p.slug || '').includes(c.slug)) || { inbound_count: 0 };
        lines.push(`| ${c.slug} | ${c.position} | ${inboundMatch.inbound_count} | ${c.top_query || '—'} |`);
      }
    }
  } catch {
    lines.push('(quick-wins/latest.json unavailable)');
  }
  lines.push('');

  lines.push('## Orphaned Blog Posts (No Inbound Links)');
  if (orphanedPosts.length === 0) {
    lines.push('No orphaned blog posts found.');
  } else {
    lines.push(`| Post | Last Modified |`);
    lines.push(`|------|---------------|`);
    orphanedPosts.forEach((p) => {
      lines.push(`| [${p.slug}](${p.url}) | ${p.lastmod || 'unknown'} |`);
    });
  }
  lines.push('');

  lines.push('## Broken Internal Links');
  if (brokenLinks.length === 0) {
    lines.push('No broken internal links found.');
  } else {
    lines.push(`| Source Post | Broken Link | Anchor Text |`);
    lines.push(`|-------------|-------------|-------------|`);
    brokenLinks.forEach((b) => {
      lines.push(`| [${b.source_slug}](${b.source}) | ${b.target} | ${b.anchor_text} |`);
    });
  }
  lines.push('');

  lines.push('## Link Distribution by Page Type');
  lines.push(`| Type | Links |`);
  lines.push(`|------|-------|`);
  Object.entries(linksByType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => lines.push(`| ${type} | ${count} |`));

  const reportPath = join(ROOT, 'data', 'link-audit-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  console.log('\n' + '='.repeat(50));
  console.log('LINK AUDIT COMPLETE');
  console.log('='.repeat(50));
  console.log(`Blog posts crawled:       ${output.meta.blog_posts_crawled}`);
  console.log(`Total internal links:     ${output.meta.total_internal_links_found}`);
  console.log(`Broken internal links:    ${output.meta.broken_internal_links}`);
  console.log(`Orphaned blog posts:      ${output.meta.orphaned_blog_posts}`);
  console.log(`\nOutputs:`);
  console.log(`  data/link-audit.json`);
  console.log(`  data/link-audit-report.md`);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
