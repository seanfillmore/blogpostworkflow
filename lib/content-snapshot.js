// lib/content-snapshot.js
// Pure helpers for the change-diff-detector's content-attribution snapshots.
//
// The detector needs to notice when an article/product/page's title, meta, or
// body changes so it can log a change event for the outcome-attribution loop.
// Storing full body_html for every page daily would bloat the snapshot tree, so
// body content is reduced to a hash — enough to detect a change, cheap to store.
// title and summary_html (meta description) are kept raw because they're small
// and their before/after values are useful in the event audit trail.

import { createHash } from 'node:crypto';

/** SHA-256 hex of a string; null/undefined/'' all hash identically. */
export function hashContent(s) {
  return createHash('sha256').update(String(s ?? '')).digest('hex');
}

const ARTICLE_FIELDS = ['title', 'summary_html', 'body_hash'];
const PRODUCT_FIELDS = ['title', 'body_hash'];
const PAGE_FIELDS = ['title', 'body_hash'];

export const FIELD_TO_CHANGE_TYPE = {
  title: 'title',
  summary_html: 'meta_description',
  body_hash: 'content_body',
};

function normArticle(a) {
  return {
    id: a.id,
    handle: a.handle,
    title: a.title ?? '',
    summary_html: a.summary_html ?? '',
    body_hash: hashContent(a.body_html),
  };
}

function normSimple(p) {
  return { id: p.id, handle: p.handle, title: p.title ?? '', body_hash: hashContent(p.body_html) };
}

/**
 * Reduce raw Shopify articles/products/pages to a compact, diffable state.
 * @returns {{articles:Array, products:Array, pages:Array}}
 */
export function buildContentState({ articles = [], products = [], pages = [] } = {}) {
  return {
    articles: (articles || []).map(normArticle),
    products: (products || []).map(normSimple),
    pages: (pages || []).map(normSimple),
  };
}

function indexById(items) {
  const m = new Map();
  for (const it of items || []) m.set(it.id, it);
  return m;
}

function urlFor(resourceType, item) {
  if (resourceType === 'article') return `/blogs/news/${item.handle}`;
  if (resourceType === 'product') return `/products/${item.handle}`;
  if (resourceType === 'page') return `/pages/${item.handle}`;
  return null;
}

function diffGroup(resourceType, prevItems, currItems, fields, out) {
  const prevIdx = indexById(prevItems);
  for (const cur of currItems || []) {
    const prev = prevIdx.get(cur.id);
    if (!prev) continue; // a brand-new item is not a "change"
    for (const f of fields) {
      if ((prev[f] ?? '') !== (cur[f] ?? '')) {
        out.push({
          resourceType,
          id: cur.id,
          handle: cur.handle,
          slug: cur.handle,
          url: urlFor(resourceType, cur),
          changeType: FIELD_TO_CHANGE_TYPE[f],
          field: f,
          before: prev[f] ?? '',
          after: cur[f] ?? '',
        });
      }
    }
  }
}

/**
 * Diff two content states (as produced by buildContentState).
 * @returns {Array<{resourceType,id,handle,slug,url,changeType,field,before,after}>}
 */
export function diffContentStates(prev, curr) {
  const out = [];
  diffGroup('article', prev?.articles, curr?.articles, ARTICLE_FIELDS, out);
  diffGroup('product', prev?.products, curr?.products, PRODUCT_FIELDS, out);
  diffGroup('page', prev?.pages, curr?.pages, PAGE_FIELDS, out);
  return out;
}
