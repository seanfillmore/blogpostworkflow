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

import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { soapFormatFromText } from './product-format.js';
// The ownership table is a derived inventory of all 27 meta.json writers and is
// the same authority the deploy reconcile arbitrates on. Safe to import: that
// module reads nothing and has no side effects.
import { FIELD_OWNERS } from './post-meta-reconcile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// SEO_CLAUDE_ROOT exists purely for test isolation — it lets a test point this module
// at a scratch directory instead of the real repo so a stray call (e.g. killPost())
// can't reach live data. Production never sets it, so the fallback below is what
// every real run resolves to. RESERVED NAME: lib/notify.js and
// agents/dashboard/lib/env.js both parse .env generically into process.env with no
// allowlist, so an unrelated SEO_CLAUDE_ROOT=... line added to .env for any other
// reason would silently redirect this module's POSTS_DIR, lib/calendar-store.js's
// CALENDAR_DIR, and every directory agents/dashboard/lib/paths.js derives, with no
// error. Never set SEO_CLAUDE_ROOT in production or in .env.
export const ROOT = process.env.SEO_CLAUDE_ROOT || join(__dirname, '..');
export const POSTS_DIR = join(ROOT, 'data', 'posts');

// ── Path helpers ─────────────────────────────────────────────────────────────

/**
 * The post slug for a meta.json path — or for something that is already a slug.
 *
 * Lives here rather than in an agent because it is a layout concern, and because
 * two agents got it wrong independently: publisher derived "meta" as the slug from
 * `data/posts/<slug>/meta.json` (its fallback predated the per-directory layout),
 * and blog-post-verifier was then handed that same path where it expected a bare
 * slug and reported "No article found matching slug: data/posts/.../meta.json".
 *
 * Accepts all three shapes callers actually pass:
 *   data/posts/<slug>/meta.json  → <slug>   (current layout)
 *   data/posts/<slug>.json       → <slug>   (legacy flat layout)
 *   <slug>                       → <slug>   (already a slug)
 */
export function slugFromMetaPath(metaPath, meta) {
  if (meta?.slug) return meta.slug;
  const raw = String(metaPath ?? '');
  if (!raw) return '';
  if (!raw.includes('/') && !raw.endsWith('.json')) return raw; // already a slug
  const base = raw.split('/').pop().replace(/\.json$/, '');
  if (base !== 'meta') return base;
  const parts = raw.split('/').filter(Boolean);
  return parts[parts.length - 2] ?? base;
}

export function getPostDir(slug) {
  return join(POSTS_DIR, slug);
}

export function getContentPath(slug) {
  return join(POSTS_DIR, slug, 'content.html');
}

export function getMetaPath(slug) {
  return join(POSTS_DIR, slug, 'meta.json');
}

/**
 * The server-owned half of a post's metadata — GITIGNORED, machine-written.
 *
 * `meta.json` mixes ~6 authored fields with ~51 machine-written ones (measured on
 * production 2026-08-31: 207 posts, 59 distinct fields) in one file that is BOTH
 * tracked in git AND rewritten continuously by cron. On 2026-08-23 that collision
 * fired twice in one day and both times left INVALID JSON live, because
 * `git stash pop` runs a line-based TEXT merge over a pretty-printed object.
 * `lib/post-meta-reconcile.js` is the patch for that; this split is the fix.
 */
export function getStatePath(slug) {
  return join(POSTS_DIR, slug, 'state.json');
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
/**
 * A post's metadata as one merged object — authored copy plus machine state.
 *
 * THE SHIM. All 31 reader files call this and none of them change: they keep
 * seeing exactly the object they saw before, assembled from two files instead of
 * one. That is what makes the split shippable in stages against a corpus cron is
 * actively writing.
 *
 * STATE WINS on a field present in both, and the direction is load-bearing.
 * During the migration `meta.json` still carries stale copies of server fields
 * (nothing has split them out yet) while every write goes to `state.json`. If
 * meta won, a migrated writer's value would be masked by the stale copy it was
 * supposed to replace.
 *
 * An unparseable `state.json` degrades to meta alone rather than returning null:
 * every reader in the fleet `catch {}`s a parse failure and carries on as though
 * the file were empty, so returning null would make one corrupt state file look,
 * to all 31 of them, exactly like a post that does not exist.
 */
export function getPostMeta(slug) {
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(getMetaPath(slug), 'utf8'));
  } catch { return null; }

  let state = null;
  try {
    state = JSON.parse(readFileSync(getStatePath(slug), 'utf8'));
  } catch { /* absent (the pre-migration norm) or unreadable — meta alone */ }

  return state && typeof state === 'object' ? { ...meta, ...state } : meta;
}

/**
 * The merged view, THROWING when the post has no metadata.
 *
 * The drop-in for `JSON.parse(readFileSync(metaPath, 'utf8'))`, which is what ~40
 * sites across ~25 files did before the meta/state split — bypassing `getPostMeta`
 * entirely and therefore seeing only the authored half once the machine fields
 * moved out. Three of those were live hazards the moment the data migrated:
 * `lib/post-lock.js` stopped seeing `legacy_locked` (winner protection silently
 * OFF), `agents/publisher` stopped seeing `shopify_article_id` (it would CREATE a
 * duplicate Shopify article instead of updating), and `agents/blog-post-writer`
 * would have composed a state-free object and had `replacePostMeta` write an empty
 * `state.json` over a post's entire machine history.
 *
 * It throws rather than returning null so the substitution preserves each call
 * site's existing control flow exactly — every one of them sat inside a try/catch
 * or an early-return that a silent null would have walked straight past.
 */
export function requirePostMeta(slugOrMetaPath) {
  const slug = slugFromMetaPath(slugOrMetaPath);
  const meta = getPostMeta(slug);
  if (!meta) throw new Error(`No metadata for post "${slug}"`);
  return meta;
}

/**
 * Route a flat metadata object to the two files it now lives in.
 *
 * Pure. The split is `FIELD_OWNERS` and nothing else — never a guess about the
 * field's name, because that table is a derived inventory of all 27 writers and
 * is the authority the deploy reconcile already arbitrates on.
 *
 * AN UNCLASSIFIED FIELD GOES TO STATE, and the direction is the safe one. The
 * repo-owned set is a CLOSED list of six fields a human authors; anything new is
 * written by code and is therefore machine state. A machine field wrongly in
 * `state.json` is merely untracked (and backed up offsite); an authored field
 * wrongly there would vanish from PR review. `unclassified` is returned so a
 * caller can say so out loud, and `DAILY_POST_META_GATE` already exits 2 on one.
 */
export function partitionMetaFields(obj) {
  const meta = {};
  const state = {};
  const unclassified = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const owner = FIELD_OWNERS[k];
    if (owner === 'repo') meta[k] = v;
    else {
      state[k] = v;
      if (!owner) unclassified.push(k);
    }
  }
  return { meta, state, unclassified };
}

function writeJsonAtomic(path, obj) {
  // Temp file + rename. A crash mid-write leaves a truncated object, and every
  // reader's catch{} reads that as "this post has no metadata" — the same
  // reasoning as lib/rejected-keywords.js.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * THE WRITE CHOKEPOINT. Merge `changes` onto what is already on disk and route
 * each field to its own file.
 *
 * Before this existed there was no write chokepoint at all — `lib/posts.js`
 * exported a reader and a path builder, so 20 files called `writeFileSync` on a
 * meta path directly. That absence is what let `agents/blog-post-writer` rebuild
 * the object from a literal and destroy 23 distinct fields on every redraft,
 * including `legacy_locked` on 21 posts. A chokepoint that MERGES makes that
 * class of bug unwritable rather than merely fixed once.
 *
 * Pass `undefined` as a value to DELETE a field — `needs_rebuild` is cleared by
 * six writers, and without an explicit delete each would fall back to a raw
 * `writeFileSync`, which is the chokepoint leaking on the very field that most
 * needs to pass through it.
 *
 * @returns {object} the merged view, so a caller can keep using the result.
 */
/**
 * Write a COMPLETE metadata object, routing each field to its own file.
 *
 * The migration target for the 35 pre-existing write sites, every one of which
 * already held the whole object and wrote it whole. This is exactly equivalent
 * to what they did — including DELETE-BY-OMISSION, which is how six writers
 * clear `needs_rebuild` (`const { needs_rebuild: _drop, ...rest } = meta`).
 * Routing those through the merging `writePostMeta` instead would silently
 * resurrect the field they were dropping, so the two functions are deliberately
 * separate rather than one with a flag.
 *
 * Prefer `writePostMeta` in NEW code: it merges, so it cannot destroy a field
 * the caller never knew about — the defect that cost 23 fields per redraft.
 *
 * Accepts a slug or a meta.json path, because callers hold both shapes
 * (`agents/publisher` is handed a path as its argument).
 */
export function replacePostMeta(slugOrMetaPath, full = {}) {
  const slug = slugFromMetaPath(slugOrMetaPath, full);
  const { meta, state } = partitionMetaFields(full);
  mkdirSync(getPostDir(slug), { recursive: true });
  writeJsonAtomic(getMetaPath(slug), meta);
  if (Object.keys(state).length || existsSync(getStatePath(slug))) {
    writeJsonAtomic(getStatePath(slug), state);
  }
  return full;
}

export function writePostMeta(slug, changes = {}) {
  // Read the two files INDEPENDENTLY rather than through getPostMeta, which
  // returns null when meta.json is absent. A post that has state.json and no
  // meta.json is a real shape — the migration creates it, and a crash between
  // the two writes below leaves it — and going through the merged reader there
  // would silently discard every server field on the next write.
  const readJson = (path) => {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  };
  const existingMeta = readJson(getMetaPath(slug)) || {};
  const existingState = readJson(getStatePath(slug)) || {};

  const merged = { ...existingMeta, ...existingState, ...changes };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete merged[k];
  }

  const { meta, state } = partitionMetaFields(merged);
  mkdirSync(getPostDir(slug), { recursive: true });
  writeJsonAtomic(getMetaPath(slug), meta);

  // Write state.json when there is state to write, OR when one already exists —
  // otherwise deleting the last server field would leave the old file behind and
  // getPostMeta would keep merging the value that was just cleared. Skipping the
  // write only when BOTH are empty is what keeps 207 empty files from appearing
  // in a tree somebody greps by hand.
  if (Object.keys(state).length || existsSync(getStatePath(slug))) {
    writeJsonAtomic(getStatePath(slug), state);
  }

  return merged;
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
 *   2. By handle/URL: a post whose stored `meta.handle` (or `meta.url` last
 *      segment) equals the handle — the authoritative match against the post's
 *      real Shopify article.
 *   2b. Same, against `meta.shopify_handle` / `meta.shopify_url`. Only posts
 *      bootstrapped by `lib/ensure-local-post.js` carry `handle`/`url` at all —
 *      93 of 94 local metas have neither and record the article as
 *      `shopify_handle`, so without this step almost every real post fell
 *      through to the heuristic in step 3, which only works when the local slug
 *      happens to be a prefix of the Shopify handle.
 *   3. Truncation fallback: a slug that is a PREFIX of the handle (i.e. the post
 *      is stored under a shortened slug) AND has a `shopify_article_id`. Longest
 *      prefix wins (most specific). The reverse direction is deliberately NOT
 *      allowed: a candidate like `<handle>-2` is a Shopify dedup DUPLICATE — a
 *      different article — not a better match, so matching `slug.startsWith(handle)`
 *      would wrongly grab the duplicate.
 *
 * @returns {string|null} the resolved post slug, or null if nothing matches.
 */
export function resolvePostSlug(urlOrHandle) {
  const handle = handleFromUrl(urlOrHandle);
  if (!handle) return null;

  // 1. Exact dir match.
  if (getPostMeta(handle)) return handle;

  const slugs = listAllSlugs();
  const metas = slugs.map((slug) => [slug, getPostMeta(slug)]).filter(([, m]) => m);

  // 2. Match by the post's real Shopify article handle / URL.
  for (const [slug, meta] of metas) {
    if (meta.handle === handle || handleFromUrl(meta.url) === handle) return slug;
  }

  // 2b. Same, on the field the corpus actually uses. Kept as a second pass so a
  //     post carrying an explicit `handle` still wins over one that only has
  //     `shopify_handle`, rather than depending on directory sort order.
  for (const [slug, meta] of metas) {
    if (meta.shopify_handle === handle || handleFromUrl(meta.shopify_url) === handle) return slug;
  }

  // 3. Truncation fallback: slug is a prefix of the handle, published only,
  //    longest (most specific) prefix wins. Never the `<handle>-N` dedup dir.
  const variants = metas
    .filter(([s, m]) => (handle === s || handle.startsWith(`${s}-`)) && m.shopify_article_id)
    .map(([s]) => s)
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
  // RSC sells a BAR and a FOAMING PUMP and they are different products. This
  // used to return 'bar_soap' for any text containing "soap", so `liquid_soap`
  // was unreachable and every liquid post was validated against the bar spec.
  // soapFormatFromText also normalizes hyphens, so a phrase can match a SLUG —
  // "hand soap" could never match "liquid-hand-soap" before. Generic "soap"
  // still resolves to bar_soap, so nothing previously correct moves.
  const soapFormat = soapFormatFromText(text);
  if (soapFormat)                                                      return soapFormat;
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
