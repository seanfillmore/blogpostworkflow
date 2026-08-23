// lib/queue-apply.js
//
// The ONE implementation of "push this optimization-queue item live", shared by
// the dashboard's Approve button (agents/dashboard/routes/performance-queue.js)
// and the unattended `agents/queue-autoapply`. It used to live only inside the
// dashboard route as a per-trigger if/else ladder; a second copy for the
// scheduled path would have meant a fix landing in one and not the other — and
// the collection-gap gate below is exactly the kind of fix that must not drift.
//
// Shopify functions are INJECTED rather than imported. lib/shopify.js reads
// .env and throws at import time without OAuth credentials, so importing it
// here would make this module — and every test of the pure planning functions
// in it — unloadable in a bare checkout.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getPostMeta, getMetaPath, getContentPath, listAllSlugs } from './posts.js';
import { validateCollectionSpec } from './collection-validation.js';
import { MIN_COLLECTION_PRODUCTS } from './queue-autoapply.js';

/**
 * True only for a "the article no longer exists" Shopify 404 — the signal that a
 * refresh target was deleted + redirected by a cannibalization consolidation.
 * Transient failures (5xx, 429, network) must NOT match, so they still surface
 * as real errors instead of silently retiring a live post's refresh.
 */
export function isArticleGoneError(err) {
  return /HTTP 404\b|Not Found/i.test(err?.message || '');
}

/** Close any unclosed block tags left by truncated AI output. */
export function fixUnclosedHtml(html) {
  const openTags = [];
  const tagRe = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
  const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase();
    if (voidTags.has(tag)) continue;
    if (m[0].startsWith('</')) {
      const idx = openTags.lastIndexOf(tag);
      if (idx !== -1) openTags.splice(idx, 1);
    } else {
      openTags.push(tag);
    }
  }
  let fixed = html;
  for (let i = openTags.length - 1; i >= 0; i--) fixed += `</${openTags[i]}>`;
  return fixed;
}

/**
 * Products a proposed collection would actually hold. Pure — the product list
 * is passed in, so `agents/queue-autoapply` can count matches for its dismissal
 * gate with the same matcher that would build the collects.
 */
export function matchProductsForGap(item, products) {
  const keyword = String(item?.signal_source?.keyword || item?.proposed_collection?.handle || '').toLowerCase();
  if (!keyword) return [];
  const words = keyword.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (products || []).filter((p) => {
    const text = `${p.title} ${p.handle} ${p.tags || ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * Decide whether a collection-gap item may be created at all, and with what.
 * Pure, so the three Prime-Directive rules it enforces are testable without a
 * Shopify call. All three were MISSING from the dashboard's approve path:
 *
 *   1. **2+ distinct products.** The old code built `collects` from the match
 *      and proceeded even when it was empty — publishing an empty collection
 *      page. A collection exists only where a category holds 2+ products.
 *   2. **Created as a DRAFT.** `published: false` was omitted, so the
 *      collection went LIVE the instant someone clicked Approve, with no
 *      products assigned and nobody having seen the page.
 *      agents/collection-creator has always created drafts; this path did not.
 *   3. **The spec is validated.** validateCollectionSpec was skipped entirely,
 *      so a sentinel title ("DISQUALIFIED"), a 300-word-thin body or an
 *      over-length SEO title went straight to Shopify. There is a dismissed
 *      `DISQUALIFIED.json` sitting in the live queue directory right now.
 *
 * @returns {{ok:boolean, errors:string[], matched:Array, spec:object|null}}
 */
export function planCollectionGap(item, products, { existingHandles } = {}) {
  const c = item?.proposed_collection;
  if (!c) return { ok: false, errors: ['No proposed_collection data'], matched: [], spec: null };

  const matched = matchProductsForGap(item, products);
  const errors = [];
  if (matched.length < MIN_COLLECTION_PRODUCTS) {
    errors.push(`only ${matched.length} distinct product${matched.length === 1 ? '' : 's'} match "${item?.signal_source?.keyword || c.handle}" — a collection exists only where a category holds ${MIN_COLLECTION_PRODUCTS}+ products`);
  }

  const spec = {
    title: c.title,
    handle: c.handle,
    seo_title: c.seo_title,
    meta_description: c.seo_description || c.meta_description,
    body_html: c.body_html,
  };
  const v = validateCollectionSpec(spec, { existingHandles });
  if (!v.ok) errors.push(...v.errors);

  return { ok: errors.length === 0, errors, matched, spec };
}

/**
 * Create the collection — as a DRAFT, with products attached, only when the
 * plan above passes. Throws otherwise; the caller renders that as a 422.
 */
export async function publishCollectionGap(item, deps, { products, existingHandles } = {}) {
  const list = products || await deps.getProducts();
  const plan = planCollectionGap(item, list, { existingHandles });
  if (!plan.ok) throw new Error(`Refusing to create collection: ${plan.errors.join('; ')}`);

  const c = item.proposed_collection;
  const collection = await deps.createCustomCollection({
    title: c.title,
    handle: c.handle,
    body_html: fixUnclosedHtml(c.body_html),
    collects: plan.matched.map((p) => ({ product_id: p.id })),
    published: false, // draft — review the page before it is indexable
  });
  if (c.seo_title) await deps.upsertMetafield('custom_collections', collection.id, 'global', 'title_tag', c.seo_title);
  if (c.seo_description) await deps.upsertMetafield('custom_collections', collection.id, 'global', 'description_tag', c.seo_description);
  return { collection, matched: plan.matched.length, draft: true };
}

export async function publishPageMetaRewrite(item, deps) {
  const meta = item.proposed_meta;
  if (!meta) throw new Error('No proposed_meta data');
  if (!item.resource_id) throw new Error('No resource_id for page');
  if (meta.seo_title) await deps.upsertMetafield('pages', item.resource_id, 'global', 'title_tag', meta.seo_title);
  if (meta.seo_description) await deps.upsertMetafield('pages', item.resource_id, 'global', 'description_tag', meta.seo_description);
}

export async function publishProductDescriptionRewrite(item, deps) {
  if (!item.resource_id) throw new Error('No resource_id for product');
  if (!item.proposed_body_html) throw new Error('No proposed_body_html');
  await deps.updateProduct(item.resource_id, { body_html: item.proposed_body_html });
}

export async function publishProductMetaRewrite(item, deps) {
  const meta = item.proposed_meta;
  if (!meta) throw new Error('No proposed_meta data');
  if (!item.resource_id) throw new Error('No resource_id for product');
  if (meta.seo_title) await deps.upsertMetafield('products', item.resource_id, 'global', 'title_tag', meta.seo_title);
  if (meta.seo_description) await deps.upsertMetafield('products', item.resource_id, 'global', 'description_tag', meta.seo_description);
}

export async function publishProductTitleRewrite(item, deps) {
  const proposed = item.proposed_title;
  if (!proposed?.new_title) throw new Error('No proposed_title.new_title');
  if (!proposed?.handle) throw new Error('No proposed_title.handle (needed to preserve URL)');
  if (!item.resource_id) throw new Error('No resource_id for product');
  await deps.updateProduct(item.resource_id, { title: proposed.new_title, handle: proposed.handle });
}

/** Resolve a queue item's slug to the post metadata that carries its Shopify IDs. */
export function findPostMeta(slug) {
  const meta = getPostMeta(slug);
  if (meta && meta.shopify_article_id) return { meta, path: getMetaPath(slug) };
  const allSlugs = listAllSlugs().filter((s) => slug.startsWith(s) || s.startsWith(slug));
  for (const s of allSlugs) {
    try {
      const m = getPostMeta(s);
      if (m && m.shopify_article_id) return { meta: m, path: getMetaPath(s) };
    } catch { /* skip */ }
  }
  return null;
}

export async function publishBlogRefresh(item, deps) {
  const found = findPostMeta(item.slug);
  if (!found) throw new Error(`No post metadata found for "${item.slug}". The post may not have been published to Shopify yet — run it through the calendar pipeline first.`);
  const { meta: postMeta } = found;
  if (!postMeta.shopify_article_id) throw new Error(`Post "${item.slug}" has no shopify_article_id — it hasn't been published to Shopify yet. Run it through the calendar pipeline first.`);
  if (!existsSync(item.refreshed_html_path)) throw new Error(`Refreshed HTML not found at ${item.refreshed_html_path}`);
  const refreshedHtml = readFileSync(item.refreshed_html_path, 'utf8');
  const blogs = await deps.getBlogs();
  const blogId = blogs[0].id;

  // A refresh can outlive its Shopify article: the cannibalization-resolver
  // deletes consolidation losers and 301-redirects them, so the queued
  // shopify_article_id may now be gone. PUTting to it returns a bare Shopify 404
  // the user can't act on. Verify the article still exists first and, if it was
  // consolidated away, retire the queue item gracefully.
  try {
    await deps.getArticle(blogId, postMeta.shopify_article_id);
  } catch (err) {
    if (isArticleGoneError(err)) {
      return { dismissed: true, reason: `Post "${item.slug}" was consolidated away — Shopify article ${postMeta.shopify_article_id} no longer exists (redirected/removed). Refresh retired.` };
    }
    throw err; // transient/unexpected — surface as a real failure
  }

  await deps.updateArticle(blogId, postMeta.shopify_article_id, { body_html: refreshedHtml });
  writeFileSync(getContentPath(postMeta.slug || item.slug), refreshedHtml);
  return { published: true };
}

/**
 * Apply any item by trigger. The dashboard and the scheduled agent both route
 * through here so a new trigger cannot be handled two different ways.
 * `seo-opportunity` and `collection-content` are NOT here — they delegate to
 * their own executor agents rather than pushing pre-made content.
 */
export async function applyItem(item, deps) {
  switch (item.trigger) {
    case 'collection-gap': return await publishCollectionGap(item, deps);
    case 'page-meta-rewrite': return await publishPageMetaRewrite(item, deps);
    case 'product-description-rewrite': return await publishProductDescriptionRewrite(item, deps);
    case 'product-meta-rewrite': return await publishProductMetaRewrite(item, deps);
    case 'product-title-rewrite': return await publishProductTitleRewrite(item, deps);
    default: return await publishBlogRefresh(item, deps);
  }
}
