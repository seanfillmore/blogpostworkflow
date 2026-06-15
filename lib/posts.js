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

/** Last non-empty path segment of a URL or handle (no query/hash). */
export function handleFromUrl(urlOrHandle) {
  const s = String(urlOrHandle || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const seg = s.split('/').filter(Boolean).pop();
  return seg || null;
}

/**
 * Resolve a live URL (or handle) to the actual post slug it's stored under.
 *
 * The Shopify article handle in a URL does NOT always equal the local post-dir
 * slug: posts can be stored under a shortened slug (e.g. the article
 * `/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing` lives in
 * `data/posts/best-soap-for-tattoos/`). Naively passing the URL's last segment
 * as a slug makes downstream agents (refresh-runner, etc.) fail to find the
 * post and silently no-op.
 *
 * Resolution order:
 *   1. Exact: a post dir named for the handle (with meta.json) exists.
 *   2. By URL: a post whose `meta.url` last segment equals the handle — the
 *      authoritative match against the post's real Shopify URL.
 *   3. Prefix fallback: a slug that's a prefix/suffix variant of the handle AND
 *      has a `shopify_article_id` (it's actually published). Prefer the longest
 *      such match to avoid grabbing an unrelated shorter sibling.
 *
 * @returns {string|null} the resolved post slug, or null if nothing matches.
 */
export function resolvePostSlug(urlOrHandle) {
  const handle = handleFromUrl(urlOrHandle);
  if (!handle) return null;

  // 1. Exact dir match.
  if (getPostMeta(handle)) return handle;

  const slugs = listAllSlugs();

  // 2. Match by the post's real Shopify URL.
  for (const slug of slugs) {
    const meta = getPostMeta(slug);
    if (meta && handleFromUrl(meta.url) === handle) return slug;
  }

  // 3. Prefix/suffix fallback, published posts only, longest match wins.
  const variants = slugs
    .filter((s) => (handle.startsWith(s) || s.startsWith(handle)) && getPostMeta(s)?.shopify_article_id)
    .sort((a, b) => b.length - a.length);
  return variants[0] || null;
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
