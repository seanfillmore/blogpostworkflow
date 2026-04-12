// agents/dashboard/routes/performance-queue.js
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listQueueItems, writeItem } from '../../performance-engine/lib/queue.js';
import { getBlogs, updateArticle, createCustomCollection, upsertMetafield } from '../../../lib/shopify.js';

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

async function publishCollectionGap(item) {
  const c = item.proposed_collection;
  if (!c) throw new Error('No proposed_collection data');
  const collection = await createCustomCollection({
    title: c.title,
    handle: c.handle,
    body_html: c.body_html,
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

async function publishBlogRefresh(item, ctx) {
  const postMetaPath = join(ctx.POSTS_DIR, `${item.slug}.json`);
  if (!existsSync(postMetaPath)) throw new Error(`No post metadata found for "${item.slug}"`);
  let postMeta;
  try { postMeta = JSON.parse(readFileSync(postMetaPath, 'utf8')); }
  catch (err) { throw new Error(`Invalid post metadata: ${err.message}`); }
  if (!postMeta.shopify_article_id) throw new Error(`No shopify_article_id for "${item.slug}"`);
  if (!existsSync(item.refreshed_html_path)) throw new Error(`Refreshed HTML not found at ${item.refreshed_html_path}`);
  const refreshedHtml = readFileSync(item.refreshed_html_path, 'utf8');
  const blogs = await getBlogs();
  await updateArticle(blogs[0].id, postMeta.shopify_article_id, { body_html: refreshedHtml });
  writeFileSync(join(ctx.POSTS_DIR, `${item.slug}.html`), refreshedHtml);
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
        } else {
          await publishBlogRefresh(item, ctx);
        }
      } catch (err) {
        return respondJson(res, { ok: false, error: `Publish failed: ${err.message}` }, 502);
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
      const postsHtml = join(ctx.POSTS_DIR, `${slug}.html`);
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
