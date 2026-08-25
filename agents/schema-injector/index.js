/**
 * Schema Markup Injector Agent
 *
 * Injects JSON-LD structured data into published blog post HTML files.
 * It emits exactly ONE node: BreadcrumbList. See lib/schema-builders.js's
 * `buildPostSchemas` for the list and the reasoning.
 *
 * THREE TYPES WERE RETIRED ON 2026-08-24 AND MUST NOT COME BACK
 * ────────────────────────────────────────────────────────────
 * FAQPage — Google REMOVED the FAQ rich result from Search. Not the 2023
 *   narrowing; outright removal. Verified: the docs page
 *   `developers.google.com/search/docs/appearance/structured-data/faqpage`
 *   returns 301 → `/search/updates#removing-faq-rich-result` (the page is gone)
 *   and FAQ is absent from the rich results gallery.
 * HowTo — removed the same way in September 2023. `.../structured-data/howto`
 *   returns 404.
 * Article — a DUPLICATE. Measured off the rendered live pages (not the repo's
 *   partial `theme/` mirror): the theme already publishes Article +
 *   BreadcrumbList + Organization + WebPage + Person on 182 of 182 blog article
 *   pages. This agent's Article node was a second copy layered on top.
 *
 * Existing blocks on live pages are NOT swept — they are inert (Google ignores
 * unsupported types) and rewriting `body_html` on ~74 live ranking pages buys
 * nothing. They drain on their own instead: `stripExistingSchemas` below removes
 * every JSON-LD block before writing, so any post that passes through this agent
 * again loses its dead schema as a side effect of work already happening on it.
 *
 * Saves updated HTML locally. With --apply, pushes to Shopify as draft.
 *
 * Usage:
 *   node agents/schema-injector/index.js --slug <slug>          # single post (local save)
 *   node agents/schema-injector/index.js --slug <slug> --apply  # push to Shopify
 *   node agents/schema-injector/index.js --all                  # all posts (local save)
 *   node agents/schema-injector/index.js --all --apply          # push all to Shopify
 *
 * In the pipeline, this runs after edit and before verify (no --apply needed;
 * publish step will push the updated HTML).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import { getContentPath, getMetaPath, POSTS_DIR } from '../../lib/posts.js';
import { buildPostSchemas } from '../../lib/schema-builders.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'schema');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const slugArg = getArg('--slug');
const apply = args.includes('--apply');
const all = args.includes('--all');

if (!slugArg && !all) {
  console.error('Usage:');
  console.error('  node agents/schema-injector/index.js --slug <slug> [--apply]');
  console.error('  node agents/schema-injector/index.js --all [--apply]');
  process.exit(1);
}

// ── injection ─────────────────────────────────────────────────────────────────
//
// There is no content-detection step any more. The two types whose emission was
// conditional on the prose — FAQPage (2+ question headings) and HowTo (3+
// ordered steps) — are retired, so nothing here reads the body to decide what to
// write. The heading heuristic that fed FAQPage lives on in `lib/faq-blocks.js`,
// where `agents/editor` and `agents/faq-rewriter` use it to find FAQ Q&As in the
// PROSE; it is no longer a schema decision.

function stripExistingSchemas(html) {
  return html.replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>\s*/gi, '');
}

function injectSchemas(html, schemas) {
  const cleaned = stripExistingSchemas(html).trim();
  const blocks = schemas
    .map((s) => `<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>`)
    .join('\n');
  return blocks + '\n' + cleaned;
}

// ── per-slug processing ───────────────────────────────────────────────────────

function processSlug(slug) {
  const htmlPath = getContentPath(slug);
  const metaPath = getMetaPath(slug);

  if (!existsSync(htmlPath)) {
    console.log(`  ⚠️  ${slug} — no HTML file, skipping`);
    return null;
  }

  let meta = {};
  if (existsSync(metaPath)) {
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
  }

  const html = readFileSync(htmlPath, 'utf8');
  const title = meta.title || meta.recommended_title || slug.replace(/-/g, ' ');
  const handle = meta.shopify_handle || slug;
  const url = `${config.url}/blogs/news/${handle}`;

  // The whole emission list, from the one shared builder. See its docstring for
  // why three types were retired and why the breadcrumb was not.
  const schemas = buildPostSchemas(meta, url, config);
  const schemaTypes = schemas.map((s) => s['@type']);

  const updatedHtml = injectSchemas(html, schemas);
  writeFileSync(htmlPath, updatedHtml);

  return {
    slug,
    schemaTypes,
    updatedHtml,
    title,
    url,
    shopifyArticleId: meta.shopify_article_id || null,
    shopifyBlogId: meta.shopify_blog_id || null,
    shopifyHandle: meta.shopify_handle || null,
  };
}

// ── shopify push ──────────────────────────────────────────────────────────────

async function pushToShopify(results) {
  const blogs = await getBlogs();
  // Build handle → article map (fallback for posts without stored IDs)
  const articleMap = new Map();
  const blogMap = new Map();
  for (const blog of blogs) {
    blogMap.set(blog.id, blog);
    const articles = await getArticles(blog.id);
    for (const a of articles) {
      articleMap.set(a.handle, { article: a, blogId: blog.id });
    }
  }

  for (const r of results) {
    let blogId = r.shopifyBlogId;
    let articleId = r.shopifyArticleId;

    if (!blogId || !articleId) {
      // Fallback: look up by handle (shopify handle or local slug)
      const found = articleMap.get(r.shopifyHandle) || articleMap.get(r.slug);
      if (!found) {
        console.log(`    ⚠️  ${r.slug} — not found in Shopify`);
        continue;
      }
      blogId = found.blogId;
      articleId = found.article.id;
    }

    try {
      await updateArticle(blogId, articleId, {
        body_html: r.updatedHtml,
        published: false,
      });
      console.log(`    ✓ ${r.slug} — updated in Shopify (draft)`);
    } catch (e) {
      console.error(`    ✗ ${r.slug} — Shopify error: ${e.message}`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSchema Injector — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will push to Shopify as draft)' : 'LOCAL (saves HTML only)'}\n`);

  const slugs = all
    ? readdirSync(POSTS_DIR)
        .filter((f) => f.endsWith('.html') && !f.includes('-refreshed'))
        .map((f) => f.replace('.html', ''))
    : [slugArg];

  console.log(`Processing ${slugs.length} post(s)...\n`);

  const results = [];
  for (const slug of slugs) {
    process.stdout.write(`  ${slug.padEnd(50)} `);
    const result = processSlug(slug);
    if (!result) continue;
    console.log(result.schemaTypes.join(', '));
    results.push(result);
  }

  if (apply && results.length > 0) {
    console.log('\n  Pushing to Shopify...');
    await pushToShopify(results);
  }

  // Save report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [
    `# Schema Injection Report — ${config.name}`,
    `**Run date:** ${now}`,
    `**Mode:** ${apply ? 'Applied (pushed to Shopify as drafts)' : 'Local save only'}`,
    `**Posts processed:** ${results.length}`,
    '',
    '| Post | Schema Types |',
    '|---|---|',
    ...results.map((r) => `| [${r.slug}](${r.url}) | ${r.schemaTypes.join(', ')} |`),
    '',
  ];
  if (!apply && results.length > 0) {
    lines.push('Run with `--apply` to push schema updates to Shopify.');
  }

  const reportPath = join(REPORTS_DIR, 'schema-injection-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  console.log(`\n  Report: ${reportPath}`);
  console.log(`  Posts processed: ${results.length}`);
}

// Guarded: importing this module must not run the agent (live writes, paid
// API calls, process.exit). See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
