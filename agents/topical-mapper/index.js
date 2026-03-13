/**
 * Topical Mapper Agent
 *
 * Groups blog posts into topic clusters using Shopify article tags, then
 * cross-references the internal link graph to surface missing cross-link
 * opportunities within each cluster.
 *
 * Requires: data/link-audit.json (run internal-link-auditor first)
 * Output:   data/topical-map.json + data/topical-map-report.md
 * Usage:    node agents/topical-mapper/index.js
 */

import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── helpers ───────────────────────────────────────────────────────────────────

function loadAudit() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'link-audit.json'), 'utf8'));
  } catch {
    console.error('data/link-audit.json not found. Run internal-link-auditor first.');
    process.exit(1);
  }
}

function parseTags(tagsString) {
  if (!tagsString) return [];
  return tagsString
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

// Map: sourceUrl -> Set<targetUrl> for blog_post links only
function buildLinkGraph(crawlResults) {
  const graph = {};
  for (const [source, { links }] of Object.entries(crawlResults)) {
    graph[source] = new Set(links.filter((l) => l.type === 'blog_post').map((l) => l.url));
  }
  return graph;
}

// Map: url -> inbound count
function buildInboundMap(pillarPages) {
  const map = {};
  for (const p of pillarPages) map[p.url] = p.inbound_count;
  return map;
}

// ── fetch articles ────────────────────────────────────────────────────────────

async function fetchAllArticles() {
  const blogs = await getBlogs();
  const all = [];
  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const article of articles) {
      all.push({
        id: article.id,
        blogId: blog.id,
        title: article.title,
        handle: article.handle,
        tags: parseTags(article.tags),
        url: `${config.url}/blogs/${blog.handle}/${article.handle}`,
      });
    }
  }
  return all;
}

// ── clustering ────────────────────────────────────────────────────────────────

function buildClusters(articles) {
  const tagMap = {}; // tag -> articles[]
  for (const article of articles) {
    for (const tag of article.tags) {
      if (!tagMap[tag]) tagMap[tag] = [];
      tagMap[tag].push(article);
    }
  }
  // Only keep clusters with 2+ articles
  return Object.fromEntries(Object.entries(tagMap).filter(([, arts]) => arts.length >= 2));
}

// ── analysis ──────────────────────────────────────────────────────────────────

function priorityScore(sourceUrl, targetUrl, inboundMap, orphanSet) {
  let score = 1;
  const targetInbound = inboundMap[targetUrl] || 0;
  if (targetInbound >= 8) score += 3;      // target is a top pillar
  else if (targetInbound >= 4) score += 2; // target is a strong internal page
  else if (targetInbound >= 2) score += 1; // target has some authority
  if (orphanSet.has(sourceUrl)) score += 1; // source needs links out — good for SEO
  return score;
}

function priorityLabel(score) {
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function analyzeClusters(clusters, audit) {
  const linkGraph = buildLinkGraph(audit.crawl_results);
  const inboundMap = buildInboundMap(audit.pillar_pages);
  const orphanSet = new Set(audit.orphaned_blog_posts.map((p) => p.url));

  const results = [];

  for (const [tag, articles] of Object.entries(clusters)) {
    const missing = [];

    for (const source of articles) {
      const sourceLinks = linkGraph[source.url] || new Set();

      for (const target of articles) {
        if (source.url === target.url) continue;
        if (sourceLinks.has(target.url)) continue; // link already exists

        const score = priorityScore(source.url, target.url, inboundMap, orphanSet);
        missing.push({
          from_url: source.url,
          from_title: source.title,
          to_url: target.url,
          to_title: target.title,
          suggested_anchor: target.title,
          target_inbound_links: inboundMap[target.url] || 0,
          priority: priorityLabel(score),
          score,
        });
      }
    }

    missing.sort((a, b) => b.score - a.score);

    // Count existing links within cluster
    let existingLinks = 0;
    for (const source of articles) {
      const sourceLinks = linkGraph[source.url] || new Set();
      for (const target of articles) {
        if (source.url !== target.url && sourceLinks.has(target.url)) existingLinks++;
      }
    }

    results.push({
      tag,
      article_count: articles.length,
      existing_internal_links: existingLinks,
      missing_link_count: missing.length,
      articles: articles.map((a) => ({
        url: a.url,
        title: a.title,
        inbound_links: inboundMap[a.url] || 0,
        is_orphan: orphanSet.has(a.url),
      })),
      missing_links: missing,
    });
  }

  // Sort clusters: most missing high-priority links first
  results.sort((a, b) => {
    const aHigh = a.missing_links.filter((l) => l.priority === 'high').length;
    const bHigh = b.missing_links.filter((l) => l.priority === 'high').length;
    if (bHigh !== aHigh) return bHigh - aHigh;
    return b.missing_link_count - a.missing_link_count;
  });

  return results;
}

// ── report ────────────────────────────────────────────────────────────────────

function generateReport(clusters, meta) {
  const lines = [];
  lines.push(`# Topical Map — ${config.name}`);
  lines.push(`Generated: ${new Date().toLocaleString()}\n`);

  lines.push('## Summary');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Topic clusters | ${meta.total_clusters} |`);
  lines.push(`| Articles mapped | ${meta.articles_mapped} |`);
  lines.push(`| Missing link opportunities | ${meta.total_missing_links} |`);
  lines.push(`| High priority | ${meta.high_priority} |`);
  lines.push(`| Medium priority | ${meta.medium_priority} |`);
  lines.push(`| Low priority | ${meta.low_priority} |`);
  lines.push('');

  for (const cluster of clusters) {
    const high = cluster.missing_links.filter((l) => l.priority === 'high').length;
    lines.push(`## Topic: "${cluster.tag}" (${cluster.article_count} articles, ${high} high-priority gaps)`);

    lines.push('');
    lines.push('**Articles in cluster:**');
    lines.push('| Article | Inbound Links | Orphan |');
    lines.push('|---------|---------------|--------|');
    for (const a of cluster.articles.sort((x, y) => y.inbound_links - x.inbound_links)) {
      lines.push(`| [${a.title}](${a.url}) | ${a.inbound_links} | ${a.is_orphan ? 'yes' : ''} |`);
    }
    lines.push('');

    if (cluster.missing_links.length === 0) {
      lines.push('All articles in this cluster are fully cross-linked.');
    } else {
      lines.push('**Missing link opportunities:**');
      lines.push('| Priority | Add link in... | Pointing to... | Suggested anchor |');
      lines.push('|----------|---------------|----------------|-----------------|');
      for (const l of cluster.missing_links) {
        const fromSlug = l.from_url.split('/').pop();
        const toSlug = l.to_url.split('/').pop();
        lines.push(`| **${l.priority}** | [${fromSlug}](${l.from_url}) | [${toSlug}](${l.to_url}) | ${l.suggested_anchor} |`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── run ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nTopical Mapper — ${config.name}\n`);

  const audit = loadAudit();
  console.log(`Loaded link audit (${audit.meta.blog_posts_crawled} posts crawled)\n`);

  console.log('Fetching articles from Shopify...');
  const articles = await fetchAllArticles();
  const tagged = articles.filter((a) => a.tags.length > 0);
  console.log(`${articles.length} articles fetched, ${tagged.length} with tags\n`);

  console.log('Building topic clusters...');
  const clusters = buildClusters(articles);
  console.log(`${Object.keys(clusters).length} clusters (tags with 2+ articles)\n`);

  console.log('Analyzing missing cross-links...');
  const analysis = analyzeClusters(clusters, audit);

  const totalMissing = analysis.reduce((s, c) => s + c.missing_link_count, 0);
  const high = analysis.reduce((s, c) => s + c.missing_links.filter((l) => l.priority === 'high').length, 0);
  const medium = analysis.reduce((s, c) => s + c.missing_links.filter((l) => l.priority === 'medium').length, 0);
  const low = analysis.reduce((s, c) => s + c.missing_links.filter((l) => l.priority === 'low').length, 0);

  const meta = {
    site: config.name,
    generated_at: new Date().toISOString(),
    total_clusters: analysis.length,
    articles_mapped: articles.length,
    total_missing_links: totalMissing,
    high_priority: high,
    medium_priority: medium,
    low_priority: low,
  };

  const output = { meta, clusters: analysis };

  writeFileSync(join(ROOT, 'data', 'topical-map.json'), JSON.stringify(output, null, 2));
  writeFileSync(join(ROOT, 'data', 'topical-map-report.md'), generateReport(analysis, meta));

  console.log('='.repeat(50));
  console.log('TOPICAL MAP COMPLETE');
  console.log('='.repeat(50));
  console.log(`Clusters found:          ${meta.total_clusters}`);
  console.log(`Missing link gaps:       ${totalMissing}`);
  console.log(`  High priority:         ${high}`);
  console.log(`  Medium priority:       ${medium}`);
  console.log(`  Low priority:          ${low}`);
  console.log(`\nOutputs:`);
  console.log(`  data/topical-map.json`);
  console.log(`  data/topical-map-report.md`);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
