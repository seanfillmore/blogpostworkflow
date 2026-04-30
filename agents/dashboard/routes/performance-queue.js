// agents/dashboard/routes/performance-queue.js
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listQueueItems, writeItem } from '../../performance-engine/lib/queue.js';
import { getBlogs, updateArticle, getProducts, updateProduct, createCustomCollection, upsertMetafield } from '../../../lib/shopify.js';
import { getPostMeta, getMetaPath, getContentPath, listAllSlugs } from '../../../lib/posts.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function findItem(slug) {
  return listQueueItems().find((i) => i.slug === slug) || null;
}

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res) { respondJson(res, { ok: false, error: 'Not found' }, 404); }

function fixUnclosedHtml(html) {
  // Close any unclosed block tags left by truncated AI output
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

async function publishCollectionGap(item) {
  const c = item.proposed_collection;
  if (!c) throw new Error('No proposed_collection data');

  // Find products matching the target keyword
  const keyword = (item.signal_source?.keyword || c.handle).toLowerCase();
  const products = await getProducts();
  const matched = products.filter((p) => {
    const text = `${p.title} ${p.handle} ${p.tags || ''}`.toLowerCase();
    return keyword.split(/\s+/).every((w) => text.includes(w));
  });

  const collects = matched.map((p) => ({ product_id: p.id }));
  const collection = await createCustomCollection({
    title: c.title,
    handle: c.handle,
    body_html: fixUnclosedHtml(c.body_html),
    collects,
  });
  if (c.seo_title) await upsertMetafield('custom_collections', collection.id, 'global', 'title_tag', c.seo_title);
  if (c.seo_description) await upsertMetafield('custom_collections', collection.id, 'global', 'description_tag', c.seo_description);
}

async function publishPageMetaRewrite(item) {
  const meta = item.proposed_meta;
  if (!meta) throw new Error('No proposed_meta data');
  if (!item.resource_id) throw new Error('No resource_id for page');
  if (meta.seo_title) await upsertMetafield('pages', item.resource_id, 'global', 'title_tag', meta.seo_title);
  if (meta.seo_description) await upsertMetafield('pages', item.resource_id, 'global', 'description_tag', meta.seo_description);
}

async function publishProductDescriptionRewrite(item) {
  if (!item.resource_id) throw new Error('No resource_id for product');
  if (!item.proposed_body_html) throw new Error('No proposed_body_html');
  await updateProduct(item.resource_id, { body_html: item.proposed_body_html });
}

async function publishProductMetaRewrite(item) {
  const meta = item.proposed_meta;
  if (!meta) throw new Error('No proposed_meta data');
  if (!item.resource_id) throw new Error('No resource_id for product');
  if (meta.seo_title) await upsertMetafield('products', item.resource_id, 'global', 'title_tag', meta.seo_title);
  if (meta.seo_description) await upsertMetafield('products', item.resource_id, 'global', 'description_tag', meta.seo_description);
}

async function publishProductTitleRewrite(item) {
  const proposed = item.proposed_title;
  if (!proposed?.new_title) throw new Error('No proposed_title.new_title');
  if (!proposed?.handle) throw new Error('No proposed_title.handle (needed to preserve URL)');
  if (!item.resource_id) throw new Error('No resource_id for product');
  await updateProduct(item.resource_id, {
    title: proposed.new_title,
    handle: proposed.handle,
  });
}

function findPostMeta(slug, _postsDir) {
  // Try exact slug first
  const meta = getPostMeta(slug);
  if (meta && meta.shopify_article_id) return { meta, path: getMetaPath(slug) };
  // Fall back: scan for a slug whose name is a prefix/suffix variant
  const allSlugs = listAllSlugs().filter((s) => slug.startsWith(s) || s.startsWith(slug));
  for (const s of allSlugs) {
    try {
      const m = getPostMeta(s);
      if (m && m.shopify_article_id) return { meta: m, path: getMetaPath(s) };
    } catch { /* skip */ }
  }
  return null;
}

async function publishBlogRefresh(item, ctx) {
  const found = findPostMeta(item.slug, ctx.POSTS_DIR);
  if (!found) throw new Error(`No post metadata found for "${item.slug}". The post may not have been published to Shopify yet — run it through the calendar pipeline first.`);
  const { meta: postMeta } = found;
  if (!postMeta.shopify_article_id) throw new Error(`Post "${item.slug}" has no shopify_article_id — it hasn't been published to Shopify yet. Run it through the calendar pipeline first.`);
  if (!existsSync(item.refreshed_html_path)) throw new Error(`Refreshed HTML not found at ${item.refreshed_html_path}`);
  const refreshedHtml = readFileSync(item.refreshed_html_path, 'utf8');
  const blogs = await getBlogs();
  await updateArticle(blogs[0].id, postMeta.shopify_article_id, { body_html: refreshedHtml });
  // Update canonical HTML using the post's own slug (may differ from queue item slug)
  writeFileSync(getContentPath(postMeta.slug || item.slug), refreshedHtml);
}

export default [
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/approve$/.test(url),
    async handler(req, res, ctx) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);

      try {
        if (item.trigger === 'collection-gap') {
          await publishCollectionGap(item);
        } else if (item.trigger === 'page-meta-rewrite') {
          await publishPageMetaRewrite(item);
        } else if (item.trigger === 'product-description-rewrite') {
          await publishProductDescriptionRewrite(item);
        } else if (item.trigger === 'product-meta-rewrite') {
          await publishProductMetaRewrite(item);
        } else if (item.trigger === 'product-title-rewrite') {
          await publishProductTitleRewrite(item);
        } else {
          await publishBlogRefresh(item, ctx);
        }
      } catch (err) {
        // 422 (not 502) — these are user-state errors (post not on Shopify yet,
        // refreshed HTML missing, etc.). Cloudflare/proxies in front of the
        // tunnel intercept 5xx responses and serve their own HTML error page,
        // which the dashboard then fails to JSON.parse. 4xx passes through.
        return respondJson(res, { ok: false, error: `Publish failed: ${err.message}` }, 422);
      }

      item.status = 'published';
      item.approved_at = new Date().toISOString();
      item.published_at = new Date().toISOString();
      writeItem(item);

      respondJson(res, { ok: true, published: true });
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/feedback$/.test(url),
    async handler(req, res) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);
      try {
        const { feedback } = await readJsonBody(req);
        if (typeof feedback !== 'string' || !feedback.trim()) {
          return respondJson(res, { ok: false, error: 'feedback must be a non-empty string' }, 400);
        }
        item.feedback = feedback.trim();
        item.status = 'pending';
        item.approved_at = null;
        writeItem(item);
        respondJson(res, { ok: true });
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 400);
      }
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/dismiss$/.test(url),
    handler(req, res) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);
      item.status = 'dismissed';
      writeItem(item);
      respondJson(res, { ok: true });
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/rollback$/.test(url),
    handler(req, res, ctx) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);
      if (!existsSync(item.backup_html_path)) {
        return respondJson(res, { ok: false, error: 'No backup HTML' }, 400);
      }
      const { writeFileSync } = require('node:fs');
      const postsHtml = getContentPath(slug);
      writeFileSync(postsHtml, readFileSync(item.backup_html_path, 'utf8'));
      item.status = 'dismissed';
      item.rolled_back_at = new Date().toISOString();
      writeItem(item);
      respondJson(res, { ok: true });
    },
  },
  {
    method: 'GET',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/html$/.test(url),
    handler(req, res) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item || !existsSync(item.refreshed_html_path)) return notFound(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(item.refreshed_html_path));
    },
  },
];
