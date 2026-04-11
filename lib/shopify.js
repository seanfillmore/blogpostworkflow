/**
 * Shared Shopify Admin API client
 * Reads credentials from .env
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Simple .env loader (no external dependency)
function loadEnv() {
  const envPath = join(ROOT, '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();

const STORE = env.SHOPIFY_STORE;
const SECRET = env.SHOPIFY_SECRET;
const API_VERSION = '2025-01';

if (!STORE || !SECRET) {
  throw new Error('Missing SHOPIFY_STORE or SHOPIFY_SECRET in .env');
}

const BASE_URL = `https://${STORE}/admin/api/${API_VERSION}`;

async function shopifyRequest(method, path, body = null, attempt = 0) {
  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      'X-Shopify-Access-Token': SECRET,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);

  if (res.status === 429 && attempt < 5) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') || '2');
    const wait = Math.max(retryAfter, 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return shopifyRequest(method, path, body, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${method} ${path} → HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

// --- Blog / Article helpers ---

export async function getBlogs() {
  const data = await shopifyRequest('GET', '/blogs.json');
  return data.blogs;
}

export async function getArticles(blogId, params = {}) {
  const qs = new URLSearchParams({ limit: 250, ...params }).toString();
  const data = await shopifyRequest('GET', `/blogs/${blogId}/articles.json?${qs}`);
  return data.articles;
}

export async function getArticle(blogId, articleId) {
  const data = await shopifyRequest('GET', `/blogs/${blogId}/articles/${articleId}.json`);
  return data.article;
}

export async function updateArticle(blogId, articleId, fields) {
  const data = await shopifyRequest('PUT', `/blogs/${blogId}/articles/${articleId}.json`, {
    article: { id: articleId, ...fields },
  });
  return data.article;
}

export async function createArticle(blogId, fields) {
  const data = await shopifyRequest('POST', `/blogs/${blogId}/articles.json`, {
    article: fields,
  });
  return data.article;
}

// --- Pages ---

export async function getPages(params = {}) {
  const qs = new URLSearchParams({ limit: 250, ...params }).toString();
  const data = await shopifyRequest('GET', `/pages.json?${qs}`);
  return data.pages;
}

export async function getPage(pageId) {
  const data = await shopifyRequest('GET', `/pages/${pageId}.json`);
  return data.page;
}

export async function createPage(fields) {
  const data = await shopifyRequest('POST', '/pages.json', { page: fields });
  return data.page;
}

export async function updatePage(pageId, fields) {
  const data = await shopifyRequest('PUT', `/pages/${pageId}.json`, {
    page: { id: pageId, ...fields },
  });
  return data.page;
}

// --- Redirects ---

export async function getRedirects(params = {}) {
  const qs = new URLSearchParams({ limit: 250, ...params }).toString();
  const data = await shopifyRequest('GET', `/redirects.json?${qs}`);
  return data.redirects;
}

export async function createRedirect(path, target) {
  const data = await shopifyRequest('POST', '/redirects.json', {
    redirect: { path, target },
  });
  return data.redirect;
}

export async function deleteRedirect(redirectId) {
  await shopifyRequest('DELETE', `/redirects/${redirectId}.json`);
}

// --- Metafields ---

export async function getMetafields(resource, resourceId) {
  const data = await shopifyRequest('GET', `/${resource}/${resourceId}/metafields.json`);
  return data.metafields;
}

export async function upsertMetafield(resource, resourceId, namespace, key, value, type = 'single_line_text_field') {
  const existing = await getMetafields(resource, resourceId);
  const found = existing.find((m) => m.namespace === namespace && m.key === key);
  if (found) {
    const data = await shopifyRequest('PUT', `/${resource}/${resourceId}/metafields/${found.id}.json`, {
      metafield: { id: found.id, value, type },
    });
    return data.metafield;
  }
  const data = await shopifyRequest('POST', `/${resource}/${resourceId}/metafields.json`, {
    metafield: { namespace, key, value, type },
  });
  return data.metafield;
}

// --- Collections (requires read_products / write_products scope) ---

export async function getCustomCollections(params = {}) {
  const qs = new URLSearchParams({ limit: 250, ...params }).toString();
  const data = await shopifyRequest('GET', `/custom_collections.json?${qs}`);
  return data.custom_collections;
}

export async function getSmartCollections(params = {}) {
  const qs = new URLSearchParams({ limit: 250, ...params }).toString();
  const data = await shopifyRequest('GET', `/smart_collections.json?${qs}`);
  return data.smart_collections;
}

export async function createCustomCollection(fields) {
  const data = await shopifyRequest('POST', '/custom_collections.json', {
    custom_collection: fields,
  });
  return data.custom_collection;
}

export async function updateCustomCollection(collectionId, fields) {
  const data = await shopifyRequest('PUT', `/custom_collections/${collectionId}.json`, {
    custom_collection: { id: collectionId, ...fields },
  });
  return data.custom_collection;
}

export async function updateSmartCollection(collectionId, fields) {
  const data = await shopifyRequest('PUT', `/smart_collections/${collectionId}.json`, {
    smart_collection: { id: collectionId, ...fields },
  });
  return data.smart_collection;
}

// --- Products (requires read_products / write_products scope) ---

export async function getProducts(params = {}) {
  const qs = new URLSearchParams({ limit: 250, ...params }).toString();
  const data = await shopifyRequest('GET', `/products.json?${qs}`);
  return data.products;
}

export async function getProduct(productId) {
  const data = await shopifyRequest('GET', `/products/${productId}.json`);
  return data.product;
}

export async function updateProduct(productId, fields) {
  const data = await shopifyRequest('PUT', `/products/${productId}.json`, {
    product: { id: productId, ...fields },
  });
  return data.product;
}

export async function updateProductImage(productId, imageId, fields) {
  const data = await shopifyRequest('PUT', `/products/${productId}/images/${imageId}.json`, {
    image: { id: imageId, ...fields },
  });
  return data.image;
}

// --- GraphQL ---

const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL → HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data;
}

// --- Files API ---

async function stagedUploadsCreate(filename, mimeType, fileSize) {
  const data = await shopifyGraphQL(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      input: [{
        filename,
        mimeType,
        fileSize: String(fileSize),
        resource: 'IMAGE',
        httpMethod: 'POST',
      }],
    }
  );
  const errs = data.stagedUploadsCreate.userErrors;
  if (errs.length) throw new Error(`stagedUploadsCreate: ${errs.map((e) => e.message).join(', ')}`);
  return data.stagedUploadsCreate.stagedTargets[0];
}

async function uploadToStagedUrl(target, buffer, filename, mimeType) {
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Staged upload failed: HTTP ${res.status}: ${text}`);
  }
}

async function fileCreate(resourceUrl, alt) {
  const data = await shopifyGraphQL(
    `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage { image { url } }
        }
        userErrors { field message }
      }
    }`,
    { files: [{ originalSource: resourceUrl, alt, contentType: 'IMAGE' }] }
  );
  const errs = data.fileCreate.userErrors;
  if (errs.length) throw new Error(`fileCreate: ${errs.map((e) => e.message).join(', ')}`);
  return data.fileCreate.files[0];
}

async function pollFileReady(fileId, maxAttempts = 12, delayMs = 2500) {
  for (let i = 0; i < maxAttempts; i++) {
    const data = await shopifyGraphQL(
      `query getFile($id: ID!) {
        node(id: $id) {
          ... on MediaImage { fileStatus image { url } }
        }
      }`,
      { id: fileId }
    );
    const f = data.node;
    if (f?.fileStatus === 'READY' && f?.image?.url) return f.image.url;
    if (f?.fileStatus === 'FAILED') throw new Error(`File processing failed: ${fileId}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`File not ready after ${maxAttempts} attempts`);
}

/**
 * Fetch all images from Shopify Files, paginated.
 * Returns array of { id, alt, url } objects.
 */
export async function getAllFiles() {
  const files = [];
  let cursor = null;

  do {
    const data = await shopifyGraphQL(
      `query getFiles($cursor: String) {
        files(first: 100, after: $cursor, query: "media_type:Image") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            alt
            ... on MediaImage { image { url } }
          }
        }
      }`,
      { cursor }
    );
    const page = data.files;
    for (const node of page.nodes) {
      if (node.image?.url) files.push({ id: node.id, alt: node.alt || '', url: node.image.url });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return files;
}

/**
 * Update alt text on an existing Shopify file by its GID.
 * fileId: "gid://shopify/MediaImage/123456789"
 */
export async function updateFileAlt(fileId, alt) {
  const data = await shopifyGraphQL(
    `mutation fileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files {
          id
          ... on MediaImage { image { url } }
        }
        userErrors { field message }
      }
    }`,
    { files: [{ id: fileId, alt }] }
  );
  const errs = data.fileUpdate.userErrors;
  if (errs.length) throw new Error(`fileUpdate: ${errs.map((e) => e.message).join(', ')}`);
  return data.fileUpdate.files[0];
}

/**
 * Upload a local image to Shopify's CDN via the Files API.
 * Returns the CDN URL (cdn.shopify.com/...).
 */
export async function uploadImageToShopifyCDN(imagePath, alt = '') {
  const { readFileSync, statSync } = await import('fs');
  const { basename } = await import('path');

  const filename = basename(imagePath);
  const buffer   = readFileSync(imagePath);
  const fileSize = statSync(imagePath).size;
  const mimeType = filename.endsWith('.webp') ? 'image/webp'
                 : filename.endsWith('.png')  ? 'image/png'
                 : 'image/jpeg';

  const staged = await stagedUploadsCreate(filename, mimeType, fileSize);
  await uploadToStagedUrl(staged, buffer, filename, mimeType);
  const file   = await fileCreate(staged.resourceUrl, alt);
  return pollFileReady(file.id);
}

export { STORE, API_VERSION };

/**
 * Fetch all orders within a date range.
 * Returns { count, revenue, aov, rawOrders }.
 * rawOrders is included so callers can compute topProducts from line_items.
 * Uses limit=250 (Shopify max). Sufficient for daily snapshots on this store.
 */
export async function getOrders(dateFrom, dateTo) {
  const res = await shopifyRequest('GET', `/orders.json?status=any&created_at_min=${dateFrom}&created_at_max=${dateTo}&limit=250`);
  const orders = res.orders ?? [];
  const count = orders.length;
  const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const aov = count > 0 ? revenue / count : 0;
  return { count, revenue: Math.round(revenue * 100) / 100, aov: Math.round(aov * 100) / 100, rawOrders: orders };
}

/**
 * Fetch all abandoned checkouts within a date range.
 * Returns { count }.
 */
export async function getAbandonedCheckouts(dateFrom, dateTo) {
  const res = await shopifyRequest('GET', `/checkouts.json?created_at_min=${dateFrom}&created_at_max=${dateTo}&limit=250`);
  const checkouts = res.checkouts ?? [];
  const incomplete = checkouts.filter(c => !c.completed_at);
  return { count: incomplete.length };
}

// --- Themes ---

export async function getThemes() {
  const data = await shopifyRequest('GET', '/themes.json');
  return data.themes;
}

export async function getMainThemeId() {
  const themes = await getThemes();
  const main = themes.find(t => t.role === 'main');
  return main?.id;
}

export async function getThemeAsset(themeId, key) {
  const data = await shopifyRequest('GET', `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  return data.asset?.value ?? null;
}

export async function updateThemeAsset(themeId, key, value) {
  const data = await shopifyRequest('PUT', `/themes/${themeId}/assets.json`, {
    asset: { key, value },
  });
  return data.asset;
}
