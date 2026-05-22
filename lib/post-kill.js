/**
 * Kill an article end-to-end:
 *   1. Delete from Shopify if the article was uploaded (any status)
 *   2. Append the target keyword to data/rejected-keywords.json so the
 *      strategist never re-proposes it
 *   3. Remove the calendar item if present
 *   4. Delete data/posts/<slug>/ directory
 *   5. Delete data/briefs/<slug>.json if present
 *   6. Delete data/rejected-images/<slug>/ if present
 *
 * Returns a summary of what was actually done so the caller can show it.
 * Best-effort: if Shopify delete fails (e.g. article already gone) the local
 * cleanup still proceeds — we don't want a half-killed post hanging around.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getMetaPath, ROOT } from './posts.js';
import { deleteArticle } from './shopify.js';
import { loadCalendar, writeCalendar } from './calendar-store.js';

export async function killPost(slug, { reason = 'killed' } = {}) {
  const summary = {
    slug,
    shopify_deleted: false,
    post_dir_deleted: false,
    brief_deleted: false,
    rejected_keyword_added: false,
    calendar_item_removed: false,
    rejected_images_deleted: false,
    warnings: [],
  };

  const metaPath = getMetaPath(slug);
  let meta = null;
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch (e) {
      summary.warnings.push(`meta unreadable: ${e.message}`);
    }
  } else {
    summary.warnings.push('no meta.json');
  }

  if (meta?.shopify_blog_id && meta?.shopify_article_id) {
    try {
      await deleteArticle(meta.shopify_blog_id, meta.shopify_article_id);
      summary.shopify_deleted = true;
    } catch (e) {
      summary.warnings.push(`shopify delete failed: ${e.message}`);
    }
  }

  if (meta?.target_keyword) {
    const path = join(ROOT, 'data', 'rejected-keywords.json');
    const list = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const kwLower = meta.target_keyword.toLowerCase();
    if (!list.find((r) => (r.keyword || '').toLowerCase() === kwLower)) {
      list.push({
        keyword: meta.target_keyword,
        slug,
        reason,
        rejected_at: new Date().toISOString(),
        source: 'post-kill',
      });
      writeFileSync(path, JSON.stringify(list, null, 2));
      summary.rejected_keyword_added = true;
    }
  }

  try {
    const cal = loadCalendar();
    const filtered = cal.items.filter((i) => i.slug !== slug);
    if (filtered.length < cal.items.length) {
      writeCalendar({ items: filtered, preserve_metadata: true });
      summary.calendar_item_removed = true;
    }
  } catch (e) {
    summary.warnings.push(`calendar update failed: ${e.message}`);
  }

  const postDir = join(ROOT, 'data', 'posts', slug);
  if (existsSync(postDir)) {
    rmSync(postDir, { recursive: true, force: true });
    summary.post_dir_deleted = true;
  }

  const briefPath = join(ROOT, 'data', 'briefs', `${slug}.json`);
  if (existsSync(briefPath)) {
    unlinkSync(briefPath);
    summary.brief_deleted = true;
  }

  const rejImgDir = join(ROOT, 'data', 'rejected-images', slug);
  if (existsSync(rejImgDir)) {
    rmSync(rejImgDir, { recursive: true, force: true });
    summary.rejected_images_deleted = true;
  }

  return summary;
}
