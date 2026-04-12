// agents/dashboard/routes/performance-queue.js
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listQueueItems, writeItem } from '../../performance-engine/lib/queue.js';
import { getBlogs, updateArticle } from '../../../lib/shopify.js';

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

export default [
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/approve$/.test(url),
    async handler(req, res, ctx) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);

      // Look up Shopify article ID from post metadata
      const postMetaPath = join(ctx.POSTS_DIR, `${slug}.json`);
      if (!existsSync(postMetaPath)) {
        return respondJson(res, { ok: false, error: `No post metadata found for "${slug}"` }, 400);
      }
      let postMeta;
      try { postMeta = JSON.parse(readFileSync(postMetaPath, 'utf8')); }
      catch (err) { return respondJson(res, { ok: false, error: `Invalid post metadata: ${err.message}` }, 400); }
      if (!postMeta.shopify_article_id) {
        return respondJson(res, { ok: false, error: `No shopify_article_id in post metadata for "${slug}"` }, 400);
      }

      // Read refreshed HTML
      if (!existsSync(item.refreshed_html_path)) {
        return respondJson(res, { ok: false, error: `Refreshed HTML not found at ${item.refreshed_html_path}` }, 400);
      }
      const refreshedHtml = readFileSync(item.refreshed_html_path, 'utf8');

      // Publish to Shopify
      try {
        const blogs = await getBlogs();
        const blogId = blogs[0].id;
        await updateArticle(blogId, postMeta.shopify_article_id, { body_html: refreshedHtml });
      } catch (err) {
        return respondJson(res, { ok: false, error: `Shopify publish failed: ${err.message}` }, 502);
      }

      // Copy refreshed HTML over canonical local file
      writeFileSync(join(ctx.POSTS_DIR, `${slug}.html`), refreshedHtml);

      // Stamp item as published
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
