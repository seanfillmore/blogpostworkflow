/**
 * Blog Content Agent
 *
 * Pull, edit, and push blog article content from/to Shopify.
 *
 * Usage:
 *   node agents/blog-content/index.js list
 *     List all blogs and articles. Saves to data/blog-index.json
 *
 *   node agents/blog-content/index.js get <blog-id> <article-id>
 *     Fetch a single article. Saves to data/articles/<article-id>.json
 *
 *   node agents/blog-content/index.js update <blog-id> <article-id> <file>
 *     Upload updated article from a JSON file.
 *     The file may contain any subset of: title, body_html, tags, summary_html
 *
 *   node agents/blog-content/index.js fix-links [--dry-run]
 *     Read data/link-audit.json, strip broken internal links from all affected
 *     articles (anchor text is preserved), and upload the repaired HTML.
 *     --dry-run  Show what would change without uploading anything.
 */

import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, getArticle, updateArticle } from '../../lib/shopify.js';

const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'site.json'), 'utf8'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data');
const ARTICLES_DIR = join(DATA_DIR, 'articles');

function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(ARTICLES_DIR, { recursive: true });
}

// ── list ──────────────────────────────────────────────────────────────────────

async function list() {
  console.log('\nBlog Content Agent — list\n');

  const blogs = await getBlogs();
  console.log(`Found ${blogs.length} blog(s)\n`);

  const index = [];

  for (const blog of blogs) {
    console.log(`Blog: "${blog.title}" (id: ${blog.id})`);
    const articles = await getArticles(blog.id);
    console.log(`  ${articles.length} article(s)`);

    for (const a of articles) {
      console.log(`    [${a.id}] ${a.title}`);
    }

    index.push({
      id: blog.id,
      title: blog.title,
      handle: blog.handle,
      articles: articles.map((a) => ({
        id: a.id,
        title: a.title,
        handle: a.handle,
        author: a.author,
        tags: a.tags,
        published_at: a.published_at,
        updated_at: a.updated_at,
      })),
    });
  }

  ensureDirs();
  const outputPath = join(DATA_DIR, 'blog-index.json');
  writeFileSync(outputPath, JSON.stringify(index, null, 2));

  console.log(`\nSaved to: ${outputPath}`);
}

// ── get ───────────────────────────────────────────────────────────────────────

async function get(blogId, articleId) {
  console.log(`\nBlog Content Agent — get article ${articleId} from blog ${blogId}\n`);

  const article = await getArticle(blogId, articleId);

  console.log(`Title:   ${article.title}`);
  console.log(`Author:  ${article.author}`);
  console.log(`Tags:    ${article.tags}`);
  console.log(`Updated: ${article.updated_at}`);
  console.log(`Body:    ${article.body_html.length} chars`);

  ensureDirs();
  const outputPath = join(ARTICLES_DIR, `${articleId}.json`);
  writeFileSync(outputPath, JSON.stringify(article, null, 2));

  console.log(`\nSaved to: ${outputPath}`);
}

// ── update ────────────────────────────────────────────────────────────────────

async function update(blogId, articleId, filePath) {
  console.log(`\nBlog Content Agent — update article ${articleId} in blog ${blogId}\n`);

  const raw = readFileSync(filePath, 'utf8');
  const fields = JSON.parse(raw);

  const allowed = ['title', 'body_html', 'summary_html', 'tags', 'author'];
  const payload = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) payload[key] = fields[key];
  }

  if (Object.keys(payload).length === 0) {
    console.error(`No recognized fields found in ${filePath}`);
    console.error(`Allowed fields: ${allowed.join(', ')}`);
    process.exit(1);
  }

  console.log(`Updating fields: ${Object.keys(payload).join(', ')}`);

  const updated = await updateArticle(blogId, articleId, payload);

  console.log(`\nUpdated: "${updated.title}"`);
  console.log(`Updated at: ${updated.updated_at}`);

  // Save updated copy locally
  ensureDirs();
  const outputPath = join(ARTICLES_DIR, `${articleId}.json`);
  writeFileSync(outputPath, JSON.stringify(updated, null, 2));
  console.log(`Local copy refreshed: ${outputPath}`);
}

// ── fix-links ─────────────────────────────────────────────────────────────────

async function fixLinks({ dryRun = false } = {}) {
  console.log(`\nBlog Content Agent — fix-links${dryRun ? ' (dry run)' : ''}\n`);

  const auditPath = join(DATA_DIR, 'link-audit.json');
  let audit;
  try {
    audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  } catch {
    console.error('data/link-audit.json not found. Run the internal-link-auditor first.');
    process.exit(1);
  }

  const brokenLinks = audit.broken_internal_links;
  if (brokenLinks.length === 0) {
    console.log('No broken links found in audit. Nothing to fix.');
    return;
  }
  console.log(`${brokenLinks.length} broken link(s) across the site.\n`);

  // Group broken target URLs by source article URL
  const bySource = {};
  for (const link of brokenLinks) {
    if (!bySource[link.source]) bySource[link.source] = new Set();
    bySource[link.source].add(link.target);
  }

  // Build lookup maps from Shopify
  console.log('Fetching article index from Shopify...');
  const blogs = await getBlogs();
  // path -> { blogId, articleId }
  const articleMap = {};
  // normalized title -> canonical URL (for remapping by anchor text)
  const titleMap = {};

  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const article of articles) {
      const path = `/blogs/${blog.handle}/${article.handle}`;
      articleMap[path] = { blogId: blog.id, articleId: article.id };
      titleMap[article.title.trim().toLowerCase()] = `${config.url}${path}`;
    }
  }

  ensureDirs();

  const sourceUrls = Object.keys(bySource);
  console.log(`\nProcessing ${sourceUrls.length} article(s)...\n`);

  let totalFixed = 0;
  let skipped = 0;

  for (const sourceUrl of sourceUrls) {
    const urlPath = new URL(sourceUrl).pathname.replace(/\/$/, '');
    const entry = articleMap[urlPath];

    if (!entry) {
      console.log(`  [SKIP] No Shopify article found for: ${urlPath}`);
      skipped++;
      continue;
    }

    const article = await getArticle(entry.blogId, entry.articleId);
    const brokenTargets = bySource[sourceUrl];

    const $ = cheerio.load(article.body_html);
    let remapped = 0;
    let removed = 0;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!brokenTargets.has(href)) return;

      const anchorText = $(el).text().trim();
      const correctUrl = titleMap[anchorText.toLowerCase()];

      if (correctUrl) {
        $(el).attr('href', correctUrl);
        remapped++;
      } else {
        $(el).replaceWith(anchorText);
        removed++;
      }
    });

    const fixedHtml = $('body').html() || article.body_html;
    const slug = urlPath.split('/').pop();
    const fixCount = remapped + removed;

    if (fixCount === 0) {
      console.log(`  [OK]   ${slug} — links already clean`);
      continue;
    }

    console.log(`  [FIX]  ${slug} — ${remapped} remapped, ${removed} removed`);
    totalFixed += remapped + removed;

    if (!dryRun) {
      await updateArticle(entry.blogId, entry.articleId, { body_html: fixedHtml });
      const refreshed = { ...article, body_html: fixedHtml };
      writeFileSync(join(ARTICLES_DIR, `${entry.articleId}.json`), JSON.stringify(refreshed, null, 2));
    }
  }

  console.log('\n' + '='.repeat(50));
  if (dryRun) {
    console.log('DRY RUN COMPLETE — no changes uploaded');
  } else {
    console.log('FIX-LINKS COMPLETE');
  }
  console.log('='.repeat(50));
  console.log(`Broken links removed: ${totalFixed}`);
  console.log(`Articles skipped:     ${skipped}`);
  if (dryRun) console.log('\nRe-run without --dry-run to apply changes.');
}

// ── main ──────────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

const USAGE = `
Usage:
  node agents/blog-content/index.js list
  node agents/blog-content/index.js get <blog-id> <article-id>
  node agents/blog-content/index.js update <blog-id> <article-id> <file>
  node agents/blog-content/index.js fix-links [--dry-run]
`.trim();

async function main() {
  switch (command) {
    case 'list':
      await list();
      break;

    case 'get': {
      const [blogId, articleId] = args;
      if (!blogId || !articleId) {
        console.error('Usage: get <blog-id> <article-id>');
        process.exit(1);
      }
      await get(blogId, articleId);
      break;
    }

    case 'update': {
      const [blogId, articleId, file] = args;
      if (!blogId || !articleId || !file) {
        console.error('Usage: update <blog-id> <article-id> <file>');
        process.exit(1);
      }
      await update(blogId, articleId, file);
      break;
    }

    case 'fix-links':
      await fixLinks({ dryRun: args.includes('--dry-run') });
      break;

    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
