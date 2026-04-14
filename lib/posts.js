/**
 * Shared post path resolution module.
 *
 * Every agent that reads or writes post files should import from here
 * instead of constructing paths from slugs. This prevents the class of bugs
 * where one agent introduces a suffix or naming convention that others miss.
 *
 * Layout:
 *   data/posts/{slug}/
 *     content.html            — post body
 *     meta.json               — metadata (Shopify IDs, keywords, etc.)
 *     content-refreshed.html  — draft from content-refresher
 *     editor-report.md        — latest editor report
 *     internal-links.md       — internal linking report
 *     answer-first.md         — answer-first rewrite suggestion
 *     image.webp              — hero image
 *     backups/                — timestamped backups of content.html
 */

import { readFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const POSTS_DIR = join(ROOT, 'data', 'posts');

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getPostDir(slug) {
  return join(POSTS_DIR, slug);
}

export function getContentPath(slug) {
  return join(POSTS_DIR, slug, 'content.html');
}

export function getMetaPath(slug) {
  return join(POSTS_DIR, slug, 'meta.json');
}

export function getRefreshedPath(slug) {
  return join(POSTS_DIR, slug, 'content-refreshed.html');
}

export function getEditorReportPath(slug) {
  return join(POSTS_DIR, slug, 'editor-report.md');
}

export function getInternalLinksPath(slug) {
  return join(POSTS_DIR, slug, 'internal-links.md');
}

export function getAnswerFirstPath(slug) {
  return join(POSTS_DIR, slug, 'answer-first.md');
}

export function getImagePath(slug) {
  return join(POSTS_DIR, slug, 'image.webp');
}

export function getBackupsDir(slug) {
  return join(POSTS_DIR, slug, 'backups');
}

// ── Higher-level helpers ─────────────────────────────────────────────────────

/**
 * List all post slugs (directory names that contain meta.json).
 */
export function listAllSlugs() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter(name => {
      const dir = join(POSTS_DIR, name);
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, 'meta.json'));
      } catch { return false; }
    })
    .sort();
}

/**
 * Read and parse a post's meta.json. Returns the object or null on error.
 */
export function getPostMeta(slug) {
  try {
    return JSON.parse(readFileSync(getMetaPath(slug), 'utf8'));
  } catch { return null; }
}

/**
 * Ensure the post directory and backups subdirectory exist.
 */
export function ensurePostDir(slug) {
  mkdirSync(getBackupsDir(slug), { recursive: true });
}

/**
 * Classify a post against the products we sell. Returns the matching key from
 * config/ingredients.json (`'deodorant'`, `'toothpaste'`, `'lotion'`, etc.)
 * when the keyword/slug clearly maps to one of our SKUs, or `null` for
 * topical-authority content (DIY tutorials, ingredient education, generic
 * "what is castile soap" explainers — posts that aren't about a product
 * we sell).
 *
 * The editor uses this to (1) pick the right ingredient spec when running
 * its INGREDIENT ACCURACY check and (2) skip that check entirely on
 * topical-authority posts, where comparing against a product spec
 * produces meaningless false-positive blockers.
 *
 * Single source of truth — sync-legacy-posts and the meta backfill script
 * use the same function so tags stay consistent across the catalog.
 */
export function classifyPostProduct(keyword, slug) {
  const text = ((keyword || '') + ' ' + (slug || '')).toLowerCase();
  if (text.includes('deodorant') || text.includes('antiperspirant')) return 'deodorant';
  if (text.includes('toothpaste') || text.includes('oral'))           return 'toothpaste';
  if (text.includes('lotion')     || text.includes('moisturizer'))    return 'lotion';
  if (text.includes('cream'))                                          return 'cream';
  if (text.includes('soap'))                                           return 'bar_soap';
  if (text.includes('lip'))                                            return 'lip_balm';
  return null;
}

/**
 * Convenience wrapper: returns 'product' when the post maps to a SKU we
 * sell, 'topical_authority' otherwise. This is what gets stored in
 * meta.post_type so dashboards and pipeline filters can reason about
 * commercial intent at a glance.
 */
export function classifyPostType(keyword, slug) {
  return classifyPostProduct(keyword, slug) ? 'product' : 'topical_authority';
}

/**
 * Build an index of unpublished/scheduled posts keyed by every URL variant
 * they could be linked by. Used by editor and link-repair to make smart
 * cross-link decisions:
 *   - Linked post scheduled BEFORE parent → not a blocker (will be live in time)
 *   - Linked post is a draft with no schedule → auto-remove the link
 *   - Linked post scheduled AFTER parent → auto-remove (would 404 at publish)
 *   - Linked post not in the index → presumed live; verify separately
 *
 * Returns Map<url, { slug, publish_at, title, status }>.
 */
export function loadUnpublishedPostIndex() {
  const map = new Map();
  try {
    for (const f of readdirSync(POSTS_DIR)) {
      const metaPath = join(POSTS_DIR, f, 'meta.json');
      if (!existsSync(metaPath)) {
        // Legacy layout — meta.json directly in posts/
        if (!f.endsWith('.json')) continue;
        const legacyPath = join(POSTS_DIR, f);
        try {
          const meta = JSON.parse(readFileSync(legacyPath, 'utf8'));
          indexEntry(map, meta, f.replace('.json', ''));
        } catch {}
        continue;
      }
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        indexEntry(map, meta, f);
      } catch {}
    }
  } catch {}
  return map;
}

function indexEntry(map, meta, fallbackSlug) {
  // Only index posts that are NOT currently live (scheduled, draft, or written)
  const isLive = meta.shopify_status === 'published' ||
    (meta.shopify_publish_at && new Date(meta.shopify_publish_at) <= new Date());
  if (isLive) return;
  if (!meta.shopify_handle && !meta.shopify_url) return;

  const slug = meta.slug || fallbackSlug;
  const entry = {
    slug,
    publish_at: meta.shopify_publish_at || null,
    title: meta.title || slug,
    status: meta.shopify_status || 'draft',
  };
  if (meta.shopify_url) {
    map.set(meta.shopify_url, entry);
    const publicUrl = meta.shopify_url.replace(/realskincare-com\.myshopify\.com/, 'www.realskincare.com');
    if (publicUrl !== meta.shopify_url) map.set(publicUrl, entry);
  }
  if (meta.shopify_handle) {
    map.set(`https://www.realskincare.com/blogs/news/${meta.shopify_handle}`, entry);
  }
}
