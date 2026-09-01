#!/usr/bin/env node
/**
 * Backfill `shopify_status` into data/posts/<slug>/meta.json from LIVE Shopify.
 *
 * 52 of 93 posts carry a `shopify_article_id` and NO `shopify_status` key at all
 * — the legacy corpus, synced in by scripts/sync-legacy-posts.js without ever
 * passing through agents/publisher (which is what stamps the field). Every agent
 * that required a strict `shopify_status === 'published'` therefore treated those
 * live, indexed, traffic-earning pages as unpublished: the 5 AM digest reported
 * them "hard-blocked" every morning while they returned HTTP 200, and
 * post-performance / refresh-runner / publish-drift / draft-refresher could not
 * see them at all.
 *
 * lib/post-publish-state.js infers the answer for anything still missing it.
 * THIS script is the real fix: it asks Shopify what each article actually is and
 * writes that down, so nothing downstream has to infer.
 *
 * Shopify has no `status` field on an article — `published_at` is the whole
 * story (null = draft, future = scheduled, past = live), so that is what we read.
 *
 * Usage:
 *   node scripts/backfill-shopify-status.mjs                 # DRY RUN — report only
 *   node scripts/backfill-shopify-status.mjs --apply         # write meta.json
 *   node scripts/backfill-shopify-status.mjs --all --apply   # re-verify every post
 *   node scripts/backfill-shopify-status.mjs --slug <slug> --apply
 *   node scripts/backfill-shopify-status.mjs --limit 10
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getPostMeta, getMetaPath, replacePostMeta } from '../lib/posts.js';
import { statusFromShopifyArticle, hasExplicitStatus } from '../lib/post-publish-state.js';

/**
 * Which posts this run touches. Pure so the selection rules are testable without
 * reading data/posts/ or calling Shopify.
 *
 * @param {Array<{slug:string, meta:object}>} posts
 * @param {{all?:boolean, slug?:string, limit?:number}} opts
 */
export function planBackfill(posts, { all = false, slug = null, limit = null } = {}) {
  let out = (posts || [])
    .filter((p) => p.meta && p.meta.shopify_article_id)
    .filter((p) => all || !hasExplicitStatus(p.meta));
  if (slug) out = out.filter((p) => p.slug === slug);
  if (limit) out = out.slice(0, limit);
  return out;
}

/**
 * Merge what Shopify said into a post's meta.
 *
 * Shopify is the authority: a local past publish date does NOT override a live
 * article that is actually a draft. A MISSING article (404 → `article` is null)
 * writes nothing at all — a deleted post is not a draft, and stamping it as one
 * would bury the real problem under a plausible-looking field.
 *
 * @returns {{meta: object, changed: boolean, missing: boolean, status: string|null}}
 */
export function backfillMeta(meta, article, { at, now = Date.now() } = {}) {
  const status = statusFromShopifyArticle(article, { now });
  if (!status) return { meta, changed: false, missing: true, status: null };

  const next = { ...meta, shopify_status: status, shopify_status_verified_at: at };
  // Fill a MISSING publish date from the live article; never overwrite one the
  // post already has (the local value is what the publisher scheduled against).
  if (!meta?.shopify_publish_at && article.published_at) next.shopify_publish_at = article.published_at;

  const changed = meta?.shopify_status !== status
    || next.shopify_publish_at !== meta?.shopify_publish_at;
  return { meta: next, changed, missing: false, status };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');
  const slug = arg('--slug');
  const limitRaw = arg('--limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : null;

  // Imported lazily: lib/shopify.js reads .env and throws at import time without
  // OAuth credentials, and the pure helpers above must stay importable in tests.
  const { getArticle, getBlogs } = await import('../lib/shopify.js');

  const posts = listAllSlugs().map((s) => ({ slug: s, meta: getPostMeta(s) }));
  const targets = planBackfill(posts, { all, slug, limit });

  console.log(`\nBackfill shopify_status — ${targets.length} post(s)${apply ? '' : ' (DRY RUN)'}\n`);
  if (!targets.length) { console.log('  Nothing to do.'); return; }

  let defaultBlogId = null;
  const at = new Date().toISOString();
  const counts = { published: 0, scheduled: 0, draft: 0, missing: 0, errored: 0, written: 0 };

  for (const { slug: s, meta } of targets) {
    let blogId = meta.shopify_blog_id;
    if (!blogId) {
      if (defaultBlogId === null) defaultBlogId = (await getBlogs())[0].id;
      blogId = defaultBlogId;
    }

    let article = null;
    try {
      article = await getArticle(blogId, meta.shopify_article_id);
    } catch (err) {
      // A 404 means the article is gone — that is the `missing` case below, not
      // an error. Anything else is a real failure and must not be written down.
      if (!/\b404\b|not found/i.test(err.message || '')) {
        counts.errored++;
        console.log(`  ! ${s}: ${err.message}`);
        continue;
      }
    }

    const { meta: next, changed, missing, status } = backfillMeta(meta, article, { at });
    if (missing) {
      counts.missing++;
      console.log(`  ? ${s}: article ${meta.shopify_article_id} not found on Shopify — NOT stamped, needs a human`);
      continue;
    }

    counts[status]++;
    const was = hasExplicitStatus(meta) ? meta.shopify_status : '(unset)';
    console.log(`  ${changed ? '~' : '='} ${s}: ${was} → ${status}`);
    if (apply) { replacePostMeta(s, next); counts.written++; }
  }

  console.log(
    `\n  published ${counts.published} · scheduled ${counts.scheduled} · draft ${counts.draft}`
    + ` · missing ${counts.missing} · errored ${counts.errored}`,
  );
  console.log(apply ? `  Wrote ${counts.written} meta.json file(s).` : '  Dry run — pass --apply to write.');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => { console.error('Error:', err.message); process.exit(1); });
}
