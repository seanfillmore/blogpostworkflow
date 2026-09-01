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
 *   --allow-divergent-mirror Push even when content.html is a DIFFERENT ARTICLE
 *                            from what is live. See the mirror gate below.
 *   (no flag)                Publish immediately
 *
 * THE MIRROR GATE (2026-08-23)
 * ────────────────────────────
 * Updating an existing article REPLACES its body with local content.html. On
 * 2026-08-23, 27 of the 89 comparable local mirrors were not stale copies of
 * their live article — they were DIFFERENT, OLDER ARTICLES, sharing under a
 * quarter of their text blocks with what is live. `scheduler.js`'s daily
 * link-repair step republishes any such post with `--force`, unattended, so
 * this was a live fuse rather than a theoretical one.
 *
 * So the update path now reads the live body first and refuses when the push
 * would replace the page rather than edit it. `--force` does NOT disarm it —
 * `--force` is what the unattended caller already passes, and a gate its
 * routine caller turns off is not a gate. The override is `--allow-divergent-
 * mirror`, typed by a human who has looked at the two bodies (see
 * `node scripts/check-content-mirrors.mjs --snapshot-live --apply`).
 *
 * `publishApprovedQueueItems()` below is DELIBERATELY not gated. It publishes a
 * queue item's `refreshed_html_path`, not the mirror, and the live path for
 * that work is `lib/queue-apply.js`, which already captures a pre-write backup
 * and stamps a `revert_plan`. Stating that is better than extending this change
 * into a seam CLAUDE.md documents as near-dead.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticle, createArticle, updateArticle, uploadImageToShopifyCDN, STORE } from '../../lib/shopify.js';
import { getContentPath, getMetaPath, getEditorReportPath, slugFromMetaPath, replacePostMeta, requirePostMeta } from '../../lib/posts.js';
import { isPassing } from '../../lib/editor-remediation.js';
import { positionalArg } from '../../lib/positional-arg.js';
import { assessRepublish } from '../../lib/content-mirror.js';
import { EXIT_MIRROR_DIVERGED } from '../../lib/refresh-writeoff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
} catch (e) {
  console.error(`Failed to load config/site.json: ${e.message}`); process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────────────


// Declared here rather than beside main(): the usage check below calls
// process.exit(1) at module scope, so an import would take the host process down
// before reaching main.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const args = process.argv.slice(2);
// positionalArg, not args.find: `--publish-at <ts>` would otherwise let the
// TIMESTAMP be read as the meta path on any flag-first invocation.
// See lib/positional-arg.js — the same shape broke blog-post-verifier for 4 months.
const metaArg = positionalArg(args, ['--publish-at']);
const publishAtArg = (() => {
  const i = args.indexOf('--publish-at');
  return i !== -1 ? args[i + 1] : null;
})();
const isDraft = args.includes('--draft');
const forcePublish = args.includes('--force');
const skipVerify = args.includes('--no-verify');
const allowDivergentMirror = args.includes('--allow-divergent-mirror');

if (isDirectRun && !metaArg) {
  console.error('Usage: node agents/publisher/index.js data/posts/<slug>.json [--publish-at "ISO8601"] [--draft]');
  process.exit(1);
}

// Guarded on metaArg as well as isDirectRun: on an import there are no CLI args at
// all, and dereferencing undefined here would throw before the guard below matters.
const metaPath = metaArg ? (metaArg.startsWith('/') ? metaArg : join(ROOT, metaArg)) : null;
if (isDirectRun && !existsSync(metaPath)) {
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
    meta = requirePostMeta(metaPath);
  } catch (e) {
    console.error(`Failed to parse post metadata ${metaPath}: ${e.message}`);
    process.exit(1);
  }
  const slug = slugFromMetaPath(metaPath, meta);
  const htmlPath = getContentPath(slug);

  if (!existsSync(htmlPath)) {
    console.error(`HTML file not found: ${htmlPath}`);
    process.exit(1);
  }

  // ── pipeline gate (publisher_block) ─────────────────────────────────────────
  // Upstream agents (featured-product-injector, and potentially others) can
  // refuse to publish a post by stamping meta.publisher_block. Most common
  // case: no /products/ links found, which signals the article is off
  // product scope. Hard-fail unless --force.
  if (!forcePublish && meta.publisher_block) {
    const b = meta.publisher_block;
    console.error(`  ✗ Publisher block set on "${slug}".`);
    console.error(`  Blocked by: ${b.flagged_by || 'unknown'}`);
    console.error(`  Reason: ${b.reason || '(no reason given)'}`);
    console.error(`  Flagged at: ${b.flagged_at || 'unknown'}`);
    console.error(`  Resolve via the dashboard (Kill or re-scope the post) or use --force to bypass.`);
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
    if (!isPassing(report)) {
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
      imageField = { src: cdnUrl, alt: meta.image_alt || meta.title };
      console.log(`done\n  CDN:     ${cdnUrl}`);
    } catch (err) {
      // Fall back to base64 attachment if CDN upload fails
      console.warn(`\n  CDN upload failed (${err.message}) — falling back to base64`);
      const imageBuffer = readFileSync(imagePath);
      imageField = {
        attachment: imageBuffer.toString('base64'),
        filename: basename(imagePath),
        alt: meta.image_alt || meta.title,
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
    // ── mirror gate ───────────────────────────────────────────────────────────
    // Read what is live BEFORE overwriting it. A failed read is a refusal, not a
    // shrug: the evidence exists and cannot be read, which is exactly when "this
    // might be a different article" has to win — the same call lib/post-lock.js
    // makes for an unreadable lock. The refusal is loud (non-zero exit), so it
    // surfaces as a publish failure rather than as silence.
    let liveHtml = null;
    let liveReadable = true;
    try {
      const liveArticle = await getArticle(blogId, meta.shopify_article_id);
      liveHtml = liveArticle?.body_html ?? '';
    } catch (err) {
      liveReadable = false;
      console.error(`\n  ⚠ Could not read live article ${meta.shopify_article_id}: ${err.message}`);
    }

    const verdict = assessRepublish({
      localHtml: bodyHtml,
      liveHtml,
      liveReadable,
      hasLiveArticle: true,
      force: forcePublish,
      allowDivergentMirror,
    });

    if (!verdict.allow) {
      console.error(`\n  ✗ Mirror gate: refusing to republish "${slug}".`);
      console.error(`  ${verdict.reason}`);
      console.error(`  Local:  ${getContentPath(slug)}`);
      console.error(`  Live:   https://${STORE}/blogs/${blogHandle || 'news'}/${meta.shopify_handle || slug}`);
      console.error('  Inspect both: node scripts/check-content-mirrors.mjs --slug ' + slug + ' --snapshot-live --apply');
      console.error('  --force does NOT bypass this. Pass --allow-divergent-mirror once you have looked.');
      // A DISTINCT exit code, not a generic 1. Every caller (scheduler.js:121,
      // pipeline.js:150, agents/refresh-runner) treats any nonzero as failure and
      // branches on none of them, so this is additive for all of them — and it is
      // the only thing that lets refresh-runner tell a DETERMINISTIC refusal (no
      // tomorrow makes the same rewrite publishable) from a transient Shopify
      // error, which must never bench a live page. See lib/refresh-writeoff.js.
      process.exit(EXIT_MIRROR_DIVERGED);
    }
    if (verdict.severity !== 'ok') {
      console.warn(`\n  ⚠ Mirror gate (${verdict.severity}): ${verdict.reason}`);
    }

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

  replacePostMeta(metaPath, meta);

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
      [join(ROOT, 'agents', 'blog-post-verifier', 'index.js'), slug],
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

// isDirectRun is declared up with the arg parsing — the usage check there exits
// the process, so the guard has to exist before it.
if (isDirectRun) {
  main().then(() => {
    console.log('\nPublish complete.');
  }).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
