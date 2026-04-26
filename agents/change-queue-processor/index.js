/**
 * Change Queue Processor
 *
 * Daily cron. For each verdict-landed window where the page has no
 * active measurement, releases queued changes (FIFO by proposed_at) by
 * applying the stored `after` value via Shopify and logging the change
 * with source "<original_source>+queue-released".
 *
 * Items older than 60 days are dropped as stale.
 *
 * Usage:
 *   node agents/change-queue-processor/index.js
 *   node agents/change-queue-processor/index.js --dry-run
 */

import { readdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonOrNull, queueItemPath } from '../../lib/change-log/store.js';
import { CHANGES_ROOT, getActiveWindow, logChangeEvent } from '../../lib/change-log.js';
import { updateArticle, getBlogs, getArticles } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const STALE_DAYS = 60;
const FIELD_TO_SHOPIFY = {
  title: (after) => ({ title: after }),
  meta_description: (after) => ({ summary_html: after }),
  schema: (after) => ({ body_html: after }), // typical pattern: schema lives in body_html
  faq_added: (after) => ({ body_html: after }),
  internal_link_added: (after) => ({ body_html: after }),
  content_body: (after) => ({ body_html: after }),
  image: (after) => ({ image: { src: after } }),
};

async function buildArticleIndex() {
  const blogs = await getBlogs();
  const byHandle = new Map();
  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) byHandle.set(a.handle, { blogId: blog.id, articleId: a.id, handle: a.handle });
  }
  return byHandle;
}

function listQueuedSlugs() {
  const dir = join(CHANGES_ROOT, 'queue');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => {
    const slugDir = join(dir, d);
    try {
      // Skip non-directory entries like .gitkeep
      if (!statSync(slugDir).isDirectory()) return false;
      return readdirSync(slugDir).some((f) => f.endsWith('.json'));
    } catch { return false; }
  });
}

function listQueueItemsForSlug(slug) {
  const dir = join(CHANGES_ROOT, 'queue', slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonOrNull(join(dir, f)))
    .filter(Boolean)
    .sort((a, b) => (a.proposed_at || '').localeCompare(b.proposed_at || ''));
}

async function main() {
  console.log(`\nChange Queue Processor — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  const slugs = listQueuedSlugs();
  if (slugs.length === 0) {
    console.log('  No queued items. Skipping.');
    return;
  }
  const articleIndex = !dryRun ? await buildArticleIndex() : new Map();

  let released = 0, dropped = 0, failed = 0;
  const failures = [];

  for (const slug of slugs) {
    const active = getActiveWindow(slug);
    if (active) {
      console.log(`  ${slug}: active window — leaving queue intact`);
      continue;
    }
    const items = listQueueItemsForSlug(slug);
    for (const item of items) {
      const ageMs = Date.now() - new Date(item.proposed_at).getTime();
      const ageDays = ageMs / 86400000;
      const itemPath = queueItemPath(slug, item.id);

      if (ageDays > STALE_DAYS) {
        console.log(`  ${slug}/${item.id}: stale (${Math.floor(ageDays)}d) — dropping`);
        if (!dryRun) unlinkSync(itemPath);
        dropped++;
        continue;
      }

      console.log(`  ${slug}/${item.id}: applying (${item.change_type})`);
      if (dryRun) { released++; continue; }

      const article = articleIndex.get(slug);
      if (!article) {
        console.log(`    skip — article not found`);
        failures.push({ slug, item: item.id, error: 'article_not_found' });
        failed++;
        continue;
      }
      const fieldFn = FIELD_TO_SHOPIFY[item.change_type];
      if (!fieldFn) {
        console.log(`    skip — unsupported change_type ${item.change_type}`);
        failures.push({ slug, item: item.id, error: `unsupported_change_type:${item.change_type}` });
        failed++;
        continue;
      }
      try {
        await updateArticle(article.blogId, article.articleId, fieldFn(item.after));
        // Log a fresh event opening a new window
        await logChangeEvent({
          url: `/blogs/news/${slug}`, slug,
          changeType: item.change_type,
          category: 'experimental',
          before: '(queued — original before captured at proposal time)',
          after: item.after,
          source: `${item.source}+queue-released`,
          targetQuery: item.target_query,
          intent: 'released from queue after window closure',
        });
        unlinkSync(itemPath);
        released++;
      } catch (err) {
        console.log(`    error: ${err.message}`);
        failures.push({ slug, item: item.id, error: err.message });
        failed++;
      }
    }
  }

  const lines = [`Queue processor: released ${released}, dropped (stale) ${dropped}, failed ${failed}`];
  if (failures.length > 0) {
    lines.push('Failures:');
    for (const f of failures.slice(0, 10)) lines.push(`  ${f.slug}/${f.item}: ${f.error}`);
  }
  if (!dryRun) await notify({ subject: 'Change Queue Processor ran', body: lines.join('\n') });
  console.log('\n' + lines.join('\n'));
}

main().catch((err) => {
  notify({ subject: 'Change Queue Processor failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
