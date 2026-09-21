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

import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getMetaPath, ROOT, requirePostMeta } from './posts.js';
import { deleteArticle, getBlogs, getArticles, getAllRedirects, createRedirect } from './shopify.js';
import { loadCalendar, writeCalendar } from './calendar-store.js';
import { archiveBriefs } from './brief-archive.js';
import { appendRejection } from './rejected-keywords.js';

/**
 * Find a Shopify article by handle across every blog.
 *
 * Exported so it can be tested without running a kill, and so a caller that
 * needs to decide about a redirect BEFORE destroying anything can look first.
 * Returns `{ id, blogId, handle, published_at, title }` or null.
 */
export async function findArticleByHandle(handle) {
  for (const blog of await getBlogs()) {
    for (const a of await getArticles(blog.id, { limit: 250 })) {
      if (a.handle === handle) {
        return {
          id: a.id, blogId: blog.id, handle: a.handle,
          published_at: a.published_at, title: a.title, body_html: a.body_html,
        };
      }
    }
  }
  return null;
}

/**
 * The last-resort redirect target. A real, live collection — checked, not
 * assumed — so a kill can always complete rather than stranding inbound links
 * because nothing better was derivable.
 */
export const FALLBACK_REDIRECT_TARGET = '/collections/all-products';

/**
 * Where should a killed article's URL send people?
 *
 * THE PAGE'S OWN BUY PATH, because the page already answered this question.
 * `agents/featured-product-injector` puts a CTA block on every commercial post
 * pointing at the product or collection it sells; that link is the destination
 * a reader following an inbound link actually wanted. Guessing a default from
 * a cluster name would be this repo naming clusters in code, and picking the
 * blog index would send a shopper to a list of articles.
 *
 * Order: the CTA block first, then any commercial link in the body, then the
 * fallback collection. An explicit `redirectTo` always wins.
 *
 * It resolves THROUGH the redirect table, so a killed page never points at
 * another redirect — a chain loses more signal per hop and Google follows only
 * a few. Pure, so every branch is a case a test constructs.
 */
export function resolveKillRedirectTarget(bodyHtml, { explicit = null, redirects = [] } = {}) {
  const bySource = new Map(
    (redirects || [])
      .filter((r) => r && typeof r.path === 'string' && typeof r.target === 'string')
      .map((r) => [r.path.replace(/\/+$/, '').toLowerCase(), r.target]),
  );
  // Follow at most a few hops; a cycle in the table must not hang a kill.
  const resolve = (path) => {
    let cur = path;
    for (let i = 0; i < 5; i += 1) {
      const next = bySource.get(cur.replace(/\/+$/, '').toLowerCase());
      if (!next || next === cur) return cur;
      cur = next;
    }
    return cur;
  };

  if (explicit) return { target: resolve(explicit), source: 'explicit' };

  const html = typeof bodyHtml === 'string' ? bodyHtml : '';
  // Prefer the featured-product CTA block — the buy box the injector placed.
  const ctaIdx = html.indexOf('rsc-featured-product');
  const scopes = ctaIdx === -1 ? [html] : [html.slice(ctaIdx), html];
  for (const [i, scope] of scopes.entries()) {
    const m = scope.match(/href=["'][^"']*?(\/(?:products|collections)\/[A-Za-z0-9._~-]+)["'#?]/i);
    if (m) return { target: resolve(m[1]), source: i === 0 && ctaIdx !== -1 ? 'buy-box CTA' : 'first commercial link in body' };
  }
  return { target: resolve(FALLBACK_REDIRECT_TARGET), source: 'fallback collection' };
}

export async function killPost(slug, { reason = 'killed', redirectTo = null } = {}) {
  const summary = {
    slug,
    shopify_deleted: false,
    post_dir_deleted: false,
    brief_deleted: false,
    rejected_keyword_added: false,
    calendar_item_removed: false,
    rejected_images_deleted: false,
    redirect_created: null,
    warnings: [],
  };

  const metaPath = getMetaPath(slug);
  let meta = null;
  if (existsSync(metaPath)) {
    try {
      meta = requirePostMeta(metaPath);
    } catch (e) {
      summary.warnings.push(`meta unreadable: ${e.message}`);
    }
  } else {
    summary.warnings.push('no meta.json');
  }

  // ── Shopify: resolve, REDIRECT IF LIVE, then delete ────────────────────────
  //
  // Order is the whole safety property. A redirect created BEFORE the delete
  // lies dormant while the article still occupies the path and activates the
  // instant it is gone, so there is no window where the URL 404s. Created
  // after, there is one — and on a page with inbound links that window is when
  // readers and crawlers hit the miss.
  let article = null;
  if (meta?.shopify_blog_id && meta?.shopify_article_id) {
    article = {
      id: meta.shopify_article_id,
      blogId: meta.shopify_blog_id,
      handle: meta.shopify_handle || slug,
      published_at: meta.published_at ?? null,
      body_html: null,
    };
  } else {
    // NO LOCAL META IS NOT "NOTHING TO DELETE".
    //
    // The ids live in the gitignored state.json, and 52 of 93 posts are the
    // legacy corpus that never passed through agents/publisher at all — so for
    // a large fraction of the site `meta?.shopify_article_id` is simply absent
    // while a live, indexed article sits behind that handle. Until 2026-09-20
    // this branch did not exist: killPost returned `shopify_deleted: false`
    // with a one-line `no meta.json` warning, the CLI printed its summary and
    // exited 0, and the article was still live. That is exactly how a killed
    // page "comes back" — it never left.
    //
    // Shopify is the authority on whether the article exists, so ask it.
    try {
      article = await findArticleByHandle(slug);
      if (article) summary.shopify_resolved_by = 'handle lookup';
      else summary.warnings.push('no meta.json, and no Shopify article with this handle — nothing to delete');
    } catch (e) {
      summary.warnings.push(`shopify handle lookup failed: ${e.message}`);
    }
  }

  if (article) {
    const isLive = article.published_at && new Date(article.published_at) <= new Date();
    summary.was_live = Boolean(isLive);
    let mayDelete = true;

    if (isLive) {
      // A live URL has inbound links — internal ones the fleet placed, and
      // external ones nobody controls. Deleting without a destination turns
      // every one of them into a hard 404.
      const path = `/blogs/news/${article.handle || slug}`;
      try {
        const redirects = await getAllRedirects();
        const already = redirects.find((r) => r.path.replace(/\/+$/, '').toLowerCase() === path.toLowerCase());
        if (already) {
          summary.redirect_created = { path, target: already.target, source: 'already existed' };
        } else {
          let body = article.body_html;
          if (body == null) {
            // Only fetched when we actually need it to choose a destination.
            try { body = (await findArticleByHandle(article.handle || slug))?.body_html ?? ''; } catch { body = ''; }
          }
          const { target, source } = resolveKillRedirectTarget(body, { explicit: redirectTo, redirects });
          await createRedirect(path, target);
          summary.redirect_created = { path, target, source };
        }
      } catch (e) {
        // REFUSE. A live article with no redirect is worse than a live article
        // still up: the page keeps earning nothing either way, but the 404
        // breaks every link pointing at it and there is no way back.
        mayDelete = false;
        summary.warnings.push(
          `REFUSED to delete a LIVE article: could not create its redirect (${e.message}). `
          + 'Nothing was deleted. Create the redirect, then re-run.',
        );
      }
    }

    if (mayDelete) {
      try {
        await deleteArticle(article.blogId, article.id);
        summary.shopify_deleted = true;
        if (isLive) {
          summary.warnings.push(
            'article was LIVE — its redirect is in place, but inbound INTERNAL links still point at the old URL. '
            + 'Run scripts/fix-redirect-links.mjs --apply ON THE SERVER to repoint them.',
          );
        }
      } catch (e) {
        summary.warnings.push(`shopify delete failed: ${e.message}`);
      }
    }
  }

  if (meta?.target_keyword) {
    // Through lib/rejected-keywords.js: re-read + merge + atomic rename, so a
    // kill running while the dashboard or the strategist writes the same file
    // cannot lose either side. See that module's header for the audit.
    const { added } = appendRejection({
      keyword: meta.target_keyword,
      slug,
      reason,
      rejected_at: new Date().toISOString(),
      source: 'post-kill',
    });
    summary.rejected_keyword_added = added;
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

  // Archived, not unlinked. This is the SECOND path in the repo that removed a
  // brief from disk (scripts/triage-orphan-briefs.mjs was the first, and the one
  // that destroyed three of them on 2026-08-19). It is reachable from the
  // dashboard's public URL and from scripts/kill-article.mjs, so it gets the
  // same recovery route rather than being left as the one remaining way to lose
  // a paid-for brief permanently. See lib/brief-archive.js.
  const briefPath = join(ROOT, 'data', 'briefs', `${slug}.json`);
  if (existsSync(briefPath)) {
    const res = archiveBriefs({
      root: ROOT,
      drops: [{ slug, path: briefPath, keyword: meta?.target_keyword || null, reason: `post killed: ${reason || 'no reason given'}` }],
      droppedBy: 'lib/post-kill.js',
    });
    if (res.archived.length) {
      summary.brief_archived = res.archived[0].archivedFile;
      summary.brief_deleted = true;   // kept for callers that already read it
    } else {
      summary.warnings.push(`brief archive failed: ${res.failed[0]?.error || 'unknown'}`);
    }
  }

  const rejImgDir = join(ROOT, 'data', 'rejected-images', slug);
  if (existsSync(rejImgDir)) {
    rmSync(rejImgDir, { recursive: true, force: true });
    summary.rejected_images_deleted = true;
  }

  return summary;
}
