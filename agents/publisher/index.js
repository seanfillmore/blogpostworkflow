/**
 * Publisher Agent
 *
 * Uploads a blog post to Shopify and optionally schedules it for a future publish date.
 * Uploads the hero image as the article's featured image.
 * Sets the meta description via summary_html.
 * Updates the post's .json metadata with Shopify IDs and URL.
 *
 * Usage:
 *   node agents/publisher/index.js data/posts/<slug>.json
 *   node agents/publisher/index.js data/posts/<slug>.json --publish-at "2026-03-17T08:00:00-05:00"
 *   node agents/publisher/index.js data/posts/<slug>.json --draft
 *   node agents/publisher/index.js data/posts/<slug>.json --no-verify  (skip post-publish check)
 *
 * Options:
 *   --publish-at <ISO 8601>   Schedule publish at this datetime (e.g. 2026-03-17T08:00:00-05:00)
 *   --draft                  Upload as draft (not published, no schedule)
 *   --force                  Skip editor gate (bypass approval check)
 *   (no flag)                Publish immediately
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, createArticle, updateArticle, uploadImageToShopifyCDN, STORE } from '../../lib/shopify.js';
import { getContentPath, getMetaPath, getEditorReportPath } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
} catch (e) {
  console.error(`Failed to load config/site.json: ${e.message}`); process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const metaArg = args.find((a) => !a.startsWith('--'));
const publishAtArg = (() => {
  const i = args.indexOf('--publish-at');
  return i !== -1 ? args[i + 1] : null;
})();
const isDraft = args.includes('--draft');
const forcePublish = args.includes('--force');
const skipVerify = args.includes('--no-verify');

if (!metaArg) {
  console.error('Usage: node agents/publisher/index.js data/posts/<slug>.json [--publish-at "ISO8601"] [--draft]');
  process.exit(1);
}

const metaPath = metaArg.startsWith('/') ? metaArg : join(ROOT, metaArg);
if (!existsSync(metaPath)) {
  console.error(`Post metadata not found: ${metaPath}`);
  process.exit(1);
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Pre-run: scan the performance queue for approved items and publish them
 * to Shopify by overwriting the existing article. Each approved item has a
 * refreshed HTML file and a backup. After publishing, the queue item is
 * stamped 'published' and the canonical HTML is updated.
 */
async function publishApprovedQueueItems() {
  const queueDir = join(ROOT, 'data', 'performance-queue');
  if (!existsSync(queueDir)) return 0;
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(queueDir).filter(f => f.endsWith('.json') && f !== 'indexing-submissions.json');
  const approved = [];
  for (const f of files) {
    try {
      const item = JSON.parse(readFileSync(join(queueDir, f), 'utf8'));
      if (item.status === 'approved') approved.push({ file: join(queueDir, f), item });
    } catch { /* skip */ }
  }
  if (approved.length === 0) return 0;

  console.log(`  Performance Queue: ${approved.length} approved item${approved.length === 1 ? '' : 's'} to publish.\n`);
  const blogs = await getBlogs();
  const blogId = blogs[0].id;

  let count = 0;
  for (const { file, item } of approved) {
    try {
      const postMetaPath = getMetaPath(item.slug);
      if (!existsSync(postMetaPath)) { console.warn(`    [skip] ${item.slug}: no post JSON`); continue; }
      const postMeta = JSON.parse(readFileSync(postMetaPath, 'utf8'));
      if (!postMeta.shopify_article_id) { console.warn(`    [skip] ${item.slug}: no shopify_article_id`); continue; }
      if (!existsSync(item.refreshed_html_path)) { console.warn(`    [skip] ${item.slug}: no refreshed HTML`); continue; }

      const refreshedHtml = readFileSync(item.refreshed_html_path, 'utf8');
      await updateArticle(blogId, postMeta.shopify_article_id, { body_html: refreshedHtml });

      // Copy refreshed HTML over canonical
      writeFileSync(getContentPath(item.slug), refreshedHtml);

      // Stamp the queue item
      item.status = 'published';
      item.published_at = new Date().toISOString();
      writeFileSync(file, JSON.stringify(item, null, 2));

      count++;
      console.log(`    [published] ${item.slug}`);
    } catch (err) {
      console.error(`    [fail] ${item.slug}: ${err.message}`);
    }
  }
  return count;
}

async function main() {
  console.log(`\nPublisher Agent — ${config.name}\n`);

  // Process any approved performance-queue items first
  await publishApprovedQueueItems();

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse post metadata ${metaPath}: ${e.message}`);
    process.exit(1);
  }
  const slug = meta.slug || basename(metaPath, '.json');
  const htmlPath = getContentPath(slug);

  if (!existsSync(htmlPath)) {
    console.error(`HTML file not found: ${htmlPath}`);
    process.exit(1);
  }

  // ── editor gate ─────────────────────────────────────────────────────────────
  if (!forcePublish) {
    const reportPath = getEditorReportPath(slug);
    if (!existsSync(reportPath)) {
      console.error(`  ✗ No editor report found for "${slug}".`);
      console.error(`  Run: node agents/editor/index.js data/posts/${slug}/content.html`);
      console.error(`  Or use --force to bypass this check.`);
      process.exit(1);
    }
    const report = readFileSync(reportPath, 'utf8');
    if (/VERDICT:\s*Needs Work/i.test(report)) {
      console.error(`  ✗ Editor verdict is "Needs Work" for "${slug}".`);
      console.error(`  Fix the issues in the editor report before publishing.`);
      console.error(`  Report: data/posts/${slug}/editor-report.md`);
      console.error(`  Or use --force to bypass this check.`);
      process.exit(1);
    }
  }

  const bodyHtml = readFileSync(htmlPath, 'utf8');
  console.log(`  Post:    "${meta.title}"`);
  console.log(`  Keyword: ${meta.target_keyword}`);

  // ── determine blog ──────────────────────────────────────────────────────────

  let blogId = meta.shopify_blog_id;
  let blogHandle = meta.shopify_blog_handle;
  if (!blogId) {
    process.stdout.write('  Fetching blogs... ');
    const blogs = await getBlogs();
    if (blogs.length === 0) { console.error('No blogs found in Shopify.'); process.exit(1); }
    // Prefer a blog named "news" or "blog"
    const preferred = blogs.find((b) => /news|blog/i.test(b.handle));
    if (!preferred) {
      console.error(`No blog with handle matching "news" or "blog" found.`);
      console.error(`Available blogs: ${blogs.map((b) => `"${b.handle}" (${b.title})`).join(', ')}`);
      console.error(`Pass --blog-id <id> or update the handle match in publisher/index.js.`);
      process.exit(1);
    }
    blogId = preferred.id;
    blogHandle = preferred.handle;
    console.log(`done (using "${preferred.title}", handle "${blogHandle}", ID ${blogId})`);
  } else {
    console.log(`  Blog ID: ${blogId} (from metadata)`);
  }

  // ── upload hero image to Shopify CDN ───────────────────────────────────────

  let imageField = null;
  const rawImagePath = meta.image_path;
  const imagePath = rawImagePath ? (rawImagePath.match(/^(\/|[A-Z]:)/) ? rawImagePath : join(ROOT, rawImagePath)) : null;
  if (imagePath && existsSync(imagePath)) {
    process.stdout.write('  Uploading hero image to Shopify CDN... ');
    try {
      const cdnUrl = await uploadImageToShopifyCDN(imagePath, meta.title);
      imageField = { src: cdnUrl, alt: meta.title };
      console.log(`done\n  CDN:     ${cdnUrl}`);
    } catch (err) {
      // Fall back to base64 attachment if CDN upload fails
      console.warn(`\n  CDN upload failed (${err.message}) — falling back to base64`);
      const imageBuffer = readFileSync(imagePath);
      imageField = {
        attachment: imageBuffer.toString('base64'),
        filename: basename(imagePath),
        alt: meta.title,
      };
    }
  } else {
    console.log('  No hero image found — skipping image upload.');
  }

  // ── determine publish state ─────────────────────────────────────────────────

  let published = true;
  let publishedAt = null;

  // If no --publish-at given but the JSON already has a future scheduled date, preserve it
  const effectivePublishAt = publishAtArg || (meta.shopify_publish_at && new Date(meta.shopify_publish_at) > new Date() ? meta.shopify_publish_at : null);

  if (isDraft) {
    published = false;
    console.log('  Status:  draft');
  } else if (effectivePublishAt) {
    publishedAt = new Date(effectivePublishAt).toISOString();
    const isFuture = new Date(publishedAt) > new Date();
    if (isFuture) {
      // Keep as plain draft on Shopify — do NOT send published_at to Shopify as it publishes immediately.
      // The intended date is stored in local JSON only; --publish-due reads it and publishes when due.
      published = false;
      publishedAt = null; // don't send to Shopify
      console.log(`  Status:  scheduled (draft until ${new Date(effectivePublishAt).toISOString()})`);
    } else {
      // Past or present date — publish immediately
      published = true;
      console.log(`  Status:  published immediately (past schedule date: ${publishedAt})`);
    }
  } else {
    console.log('  Status:  published immediately');
  }

  // ── build article fields ────────────────────────────────────────────────────

  const articleFields = {
    title: meta.title,
    author: (typeof config.author === 'object' ? config.author.name : config.author) || '',
    body_html: bodyHtml,
    summary_html: meta.meta_description || '',
    tags: (meta.tags || []).join(', '),
    published,
    ...(publishedAt ? { published_at: publishedAt } : {}),
    ...(imageField ? { image: imageField } : {}),
  };

  // ── create or update ────────────────────────────────────────────────────────

  let article;
  if (meta.shopify_article_id) {
    process.stdout.write(`  Updating existing article ${meta.shopify_article_id}... `);
    article = await updateArticle(blogId, meta.shopify_article_id, articleFields);
    console.log('done');
  } else {
    process.stdout.write('  Creating new article... ');
    article = await createArticle(blogId, articleFields);
    console.log('done');
  }

  // ── save metadata ───────────────────────────────────────────────────────────

  const shopifyUrl = `https://${STORE}/blogs/${blogHandle || 'news'}/${article.handle}`;

  meta.shopify_blog_id = blogId;
  meta.shopify_blog_handle = blogHandle;
  meta.shopify_article_id = article.id;
  meta.shopify_handle = article.handle;
  meta.shopify_url = shopifyUrl;
  // publishedAt is null for future schedules (not sent to Shopify); use effectivePublishAt for local state
  const intendedPublishAt = effectivePublishAt ? new Date(effectivePublishAt).toISOString() : publishedAt;
  const isFutureSchedule = effectivePublishAt && !published && new Date(effectivePublishAt) > new Date();
  meta.shopify_status = isDraft ? 'draft' : isFutureSchedule ? 'scheduled' : published ? 'published' : 'draft';
  if (intendedPublishAt && !published) meta.shopify_publish_at = intendedPublishAt;
  else if (published) delete meta.shopify_publish_at;
  if (imageField?.src) meta.shopify_image_url = imageField.src;
  meta.uploaded_at = new Date().toISOString();

  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`\n  Article ID: ${article.id}`);
  console.log(`  Handle:     ${article.handle}`);
  console.log(`  URL:        ${shopifyUrl}`);
  console.log(`  Status:     ${meta.shopify_status}`);
  if (publishedAt) console.log(`  Goes live:  ${publishedAt}`);
  console.log(`\n  Metadata updated: ${metaPath}`);

  // Post-publish verification (skippable with --no-verify)
  if (!skipVerify && meta.shopify_status === 'published') {
    console.log('\nRunning post-publish verifier...');
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'agents', 'blog-post-verifier', 'index.js'), `data/posts/${slug}/meta.json`],
      { stdio: 'inherit', cwd: ROOT }
    );
    if (result.status !== 0) {
      console.warn('⚠ Verifier found issues — check data/reports/verifier/' + slug + '-*.md');
      const { notify } = await import('../../lib/notify.js');
      await notify({
        subject: `Verifier issues: "${meta.title}"`,
        body: `Post published but verifier flagged issues.\nCheck: data/reports/verifier/${slug}-*.md`,
        status: 'error',
      });
    }
  }
}

main().then(() => {
  console.log('\nPublish complete.');
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
