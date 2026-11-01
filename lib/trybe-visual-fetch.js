// lib/trybe-visual-fetch.js
//
// The I/O half of the Trybe visual review: fetch the live PDPs and photographs,
// fetch the submission image, call the vision model, and cache each verdict by
// submission id + version. Every dependency is injectable; the decisions live
// in lib/trybe-visual-review.js.
//
// The cache exists because a pending submission stays pending until Sean
// answers it, and re-reviewing the same image every morning buys nothing. It is
// keyed on the submission VERSION, so a revised upload is reviewed fresh. Only a
// parsed verdict is cached; a failure is retried tomorrow.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildVisualRequest, parseVisualVerdict, finalizeVerdict, factsFromPdp, untaggedShownHandle,
  matchShopifyProduct, submissionImageUrl, cacheKey,
  MAX_IMAGE_BYTES, MAX_REFERENCE_IMAGES,
} from './trybe-visual-review.js';

export const STORE_URL = 'https://www.realskincare.com';
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Every product on the storefront, from the public products.json. */
export async function loadShopifyProducts({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${STORE_URL}/products.json?limit=250`);
  if (!res.ok) throw new Error(`products.json HTTP ${res.status}`);
  const json = await res.json();
  return json.products || [];
}

/** Fetch one image as a base64 block. Throws on anything the API would refuse. */
export async function fetchImageBlock(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const media_type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!SUPPORTED.has(media_type)) throw new Error(`unsupported image type "${media_type || 'none'}"`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image is ${(buf.length / 1048576).toFixed(1)} MB, over the API limit`);
  return { media_type, data: buf.toString('base64') };
}

/** A resized CDN URL for a Shopify product image, so references stay small. */
export function sizedShopifyImage(src, width = 800) {
  const u = new URL(src.startsWith('//') ? `https:${src}` : src);
  u.searchParams.set('width', String(width));
  return u.toString();
}

/**
 * Build a reviewer bound to its dependencies.
 *
 * @returns {(submission) => Promise<{verdict?: object, error?: string, cached?: boolean}>}
 */
export function createVisualReviewer({
  client,
  cacheDir,
  fetchImpl = fetch,
  shopifyProducts,
  loadProducts = null,
  catalogue = '',
  log = () => {},
} = {}) {
  // Products are read once per run. `loadProducts` (the Admin API, on the
  // server) goes first because the public storefront sits behind Cloudflare,
  // which answered products.json with a 429 during testing; the storefront is
  // the fallback. With neither, the review still runs and the digest says
  // packaging was not compared.
  let productsPromise = shopifyProducts ? Promise.resolve(shopifyProducts) : null;
  const products = () => {
    if (!productsPromise) {
      productsPromise = (async () => {
        if (loadProducts) {
          try { return await loadProducts(); } catch (err) { log(`  Admin API products unavailable (${err.message}); trying the storefront`); }
        }
        try { return await loadShopifyProducts({ fetchImpl }); } catch (err) { log(`  PDP facts unavailable: ${err.message}`); return []; }
      })();
    }
    return productsPromise;
  };

  return async function reviewVisual(submission) {
    const key = cacheKey(submission);
    const cachePath = cacheDir ? join(cacheDir, `${key}.json`) : null;
    if (cachePath && existsSync(cachePath)) {
      try { return { verdict: JSON.parse(readFileSync(cachePath, 'utf8')).verdict, cached: true }; } catch { /* re-review */ }
    }

    const url = submissionImageUrl(submission);
    if (!url) return { error: 'no image or thumbnail on the submission' };

    try {
      const image = await fetchImageBlock(url, { fetchImpl });
      const shop = await products();
      const matched = (submission.products || []).map((p) => matchShopifyProduct(p, shop)).filter(Boolean);
      const references = [];
      for (const p of matched) {
        for (const img of (p.images || []).slice(0, MAX_REFERENCE_IMAGES)) {
          if (references.length >= MAX_REFERENCE_IMAGES) break;
          try { references.push(await fetchImageBlock(sizedShopifyImage(img.src), { fetchImpl })); } catch { /* one missing reference is not fatal */ }
        }
      }
      const facts = matched.map((p) => ({ title: p.title, facts: factsFromPdp(p.body_html) }));

      const ask = async (req) => {
        const msg = await client.messages.create(req);
        if (msg.stop_reason === 'max_tokens') return { error: 'vision reply was truncated' };
        const parsed = parseVisualVerdict(msg.content?.find((b) => b.type === 'text')?.text);
        return parsed ? { parsed } : { error: 'vision reply was not the expected JSON' };
      };
      const loadRefs = async (prods) => {
        const out = [];
        for (const p of prods) {
          for (const img of (p.images || []).slice(0, MAX_REFERENCE_IMAGES)) {
            if (out.length >= MAX_REFERENCE_IMAGES) break;
            try { out.push(await fetchImageBlock(sizedShopifyImage(img.src), { fetchImpl })); } catch { /* one missing reference is not fatal */ }
          }
        }
        return out;
      };

      const first = await ask(buildVisualRequest({ submission, products: facts, references, image, catalogue }));
      if (first.error) return first;
      let parsed = first.parsed;
      let usedRefs = references.length;
      let comparedAgainst = matched.map((p) => p.handle);

      // The image shows a product the tag did not cover (2026-10-04: Coconut
      // Breeze cream jars tagged as the lotion). The first pass could check
      // labels and claims but had no photos of the jar, so packaging went
      // unchecked. Review once more against the SHOWN product. At most one
      // extra call; if it fails, the first verdict stands and says so.
      const shownHandle = untaggedShownHandle(parsed, comparedAgainst, shop);
      if (shownHandle) {
        const shown = shop.find((p) => p.handle === shownHandle);
        const shownRefs = await loadRefs([shown]);
        const second = await ask(buildVisualRequest({
          submission, image, catalogue,
          products: [{ title: shown.title, facts: factsFromPdp(shown.body_html) }],
          references: shownRefs,
          retaggedFrom: matched.map((p) => p.title).join(', ') || 'no product',
        }));
        if (second.parsed) {
          const tagIssue = parsed.issues.find((i) => i.type === 'tag');
          parsed = second.parsed;
          if (tagIssue && !parsed.issues.some((i) => i.type === 'tag')) parsed.issues.unshift(tagIssue);
          usedRefs = shownRefs.length;
          comparedAgainst = [shownHandle];
        } else {
          parsed.issues.push({ type: 'other', detail: `packaging was not compared with ${shown.title}: the second review failed (${second.error})` });
        }
      }

      const verdict = {
        ...finalizeVerdict(parsed),
        references: usedRefs,
        matched_products: matched.map((p) => p.handle),
        compared_against: comparedAgainst,
        frame: submission.media_type === 'video' ? 'thumbnail' : 'image',
      };
      if (cachePath) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ reviewed_at: new Date().toISOString(), submission_id: submission.id, version: submission.version ?? 1, verdict }, null, 2));
      }
      return { verdict };
    } catch (err) {
      return { error: err.message };
    }
  };
}
