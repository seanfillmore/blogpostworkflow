/**
 * Schema Markup Injector Agent
 *
 * Injects JSON-LD structured data into published blog post HTML files.
 * Always injects Article schema. Detects and injects:
 *   - FAQPage  — when the post contains question-format headings with answers
 *   - HowTo    — when the post contains ordered list steps (≥3 items)
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
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

// ── schema builders ───────────────────────────────────────────────────────────

function buildArticleSchema(meta, url) {
  const author = config.author;
  const authorName = typeof author === 'object' ? author.name : author;
  const authorUrl = typeof author === 'object'
    ? `${config.url}/pages/${author.slug}`
    : config.url;

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    'headline': (meta.title || meta.recommended_title || '').slice(0, 110),
    'description': (meta.meta_description || meta.summary || '').slice(0, 300),
    'author': {
      '@type': 'Person',
      'name': authorName,
      'url': authorUrl,
    },
    'publisher': {
      '@type': 'Organization',
      'name': config.name,
      'url': config.url,
    },
    'url': url,
    'mainEntityOfPage': url,
  };
  if (meta.image_url) schema.image = [meta.image_url];
  return schema;
}

function buildFAQSchema(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'mainEntity': faqs.map(({ q, a }) => ({
      '@type': 'Question',
      'name': q,
      'acceptedAnswer': { '@type': 'Answer', 'text': a },
    })),
  };
}

function buildHowToSchema(title, steps) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    'name': title,
    'step': steps.map((text, i) => ({
      '@type': 'HowToStep',
      'position': i + 1,
      'text': text,
    })),
  };
}

// ── content detection ─────────────────────────────────────────────────────────

function extractFAQs(html) {
  const faqs = [];
  // Match headings that end with '?' followed by a paragraph
  const pattern = /<h[23][^>]*>([^<]*\?[^<]*)<\/h[23]>\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const q = match[1].replace(/<[^>]+>/g, '').trim();
    const raw = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Truncate at last sentence boundary (max 600 chars) to avoid mid-sentence cuts in schema
    const MAX = 600;
    const a = raw.length <= MAX ? raw : (raw.slice(0, MAX).match(/^[\s\S]*[.!?]/)?.[0] || raw.slice(0, MAX)).trim();
    if (q && a) faqs.push({ q, a });
    if (faqs.length >= 10) break;
  }
  return faqs;
}

function extractHowToSteps(html) {
  const steps = [];
  // Look for ordered lists
  const olPattern = /<ol[^>]*>([\s\S]*?)<\/ol>/gi;
  let olMatch;
  while ((olMatch = olPattern.exec(html)) !== null) {
    const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    const batch = [];
    while ((liMatch = liPattern.exec(olMatch[1])) !== null) {
      const text = liMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 15) batch.push(text.slice(0, 200));
    }
    if (batch.length >= 3) {
      steps.push(...batch);
      break; // use the first qualifying OL
    }
  }
  return steps;
}

// ── injection ─────────────────────────────────────────────────────────────────

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
  const htmlPath = join(POSTS_DIR, `${slug}.html`);
  const metaPath = join(POSTS_DIR, `${slug}.json`);

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
  const url = `${config.url}/blogs/news/${slug}`;

  const schemas = [];
  const schemaTypes = [];

  // Article — always
  schemas.push(buildArticleSchema(meta, url));
  schemaTypes.push('Article');

  // FAQPage — if question headings with answers detected
  const faqs = extractFAQs(html);
  if (faqs.length >= 2) {
    schemas.push(buildFAQSchema(faqs));
    schemaTypes.push(`FAQPage(${faqs.length})`);
  }

  // HowTo — if ordered list with 3+ steps detected
  const steps = extractHowToSteps(html);
  if (steps.length >= 3) {
    schemas.push(buildHowToSchema(title, steps));
    schemaTypes.push(`HowTo(${steps.length})`);
  }

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

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
