// lib/ensure-local-post.js
//
// The SEO pipeline (seo-opportunity-analyzer → opportunity-trigger → refresh-runner,
// and the dashboard "Approve & Run"/"Fix blockers" actions) operates on LOCAL post
// slugs under data/posts/<slug>/. But plenty of LIVE Shopify posts have no local
// tracking — older posts, posts created outside the pipeline, ones whose local dir
// was never made. For those, resolvePostSlug() returns null and the action dies
// with "No local post found for URL … — cannot refresh".
//
// This bootstraps local tracking on demand: if a live URL/handle resolves to a real
// Shopify article, mirror it into data/posts/<handle>/ (meta.json + content.html)
// so every downstream agent can operate on it. Idempotent — returns the existing
// slug if one already tracks the article.

import { writeFileSync } from 'node:fs';
import { getBlogs, getArticles, STORE } from './shopify.js';
import { resolvePostSlug, handleFromUrl, getContentPath, getMetaPath, ensurePostDir } from './posts.js';

/**
 * Build the meta.json object for a bootstrapped post from a live Shopify article.
 * Pure — separated so it's unit-testable without Shopify access.
 */
export function buildBootstrapMeta(article, blog) {
  return {
    title: article.title || '',
    shopify_blog_id: blog.id,
    shopify_blog_handle: blog.handle || 'news',
    shopify_article_id: article.id,
    shopify_handle: article.handle,
    handle: article.handle,
    shopify_url: `https://${STORE}/blogs/${blog.handle || 'news'}/${article.handle}`,
    url: `https://${STORE}/blogs/${blog.handle || 'news'}/${article.handle}`,
    shopify_status: article.published_at ? 'published' : 'draft',
    bootstrapped_from_live: true,
  };
}

/**
 * Ensure a LIVE post is tracked locally and return its slug. If already tracked,
 * returns the existing slug (no Shopify call avoided — resolvePostSlug is local).
 * If untracked but live on Shopify, mirrors it into data/posts/<handle>/ and
 * returns the handle. Returns null only if the URL/handle matches no Shopify article.
 *
 * @param {string} urlOrHandle
 * @returns {Promise<string|null>} resolved local slug, or null if no such article
 */
export async function ensureLocalPostForUrl(urlOrHandle) {
  const existing = resolvePostSlug(urlOrHandle);
  if (existing) return existing;

  const handle = handleFromUrl(urlOrHandle);
  if (!handle) return null;

  for (const blog of await getBlogs()) {
    const article = (await getArticles(blog.id, 250)).find((a) => a.handle === handle);
    if (!article) continue;
    ensurePostDir(handle);
    writeFileSync(getContentPath(handle), article.body_html || '');
    writeFileSync(getMetaPath(handle), JSON.stringify(buildBootstrapMeta(article, blog), null, 2));
    return handle;
  }
  return null;
}
