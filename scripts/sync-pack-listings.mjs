#!/usr/bin/env node
/**
 * List Shopify packs in Google Merchant Center, and keep them in step with the store.
 *
 *   node scripts/sync-pack-listings.mjs            # dry run: what would be written
 *   node scripts/sync-pack-listings.mjs --apply    # write, delete stale items, report
 *
 * Shopify's Google & YouTube channel refuses componentized bundles, so packs are
 * written to our OWN Merchant API data source ("RSC packs (API)" in
 * config/pack-listings.json), never to Shopify's: Shopify's sync would delete or
 * overwrite anything it does not own. Runs daily from cron so price and stock
 * follow the store; an out-of-stock pack is listed OUT_OF_STOCK and simply does
 * not serve. Deletes only items carrying our `rsc_pack_` prefix, inside our
 * data source. Pure building lives in lib/pack-listings.js.
 *
 * Needs the `auth/content` Google scope (scripts/reauth-google.js) and a GCP
 * project registered with the Merchant Center account (done 2026-10-24).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { notify } from '../lib/notify.js';
import { getAccessToken } from '../lib/google-ads.js';
import { buildPackProductInput, singleOfferId, staleOfferIds, OFFER_PREFIX } from '../lib/pack-listings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://merchantapi.googleapis.com';

const PACK_QUERY = `query($h: String!) {
  productByIdentifier(identifier: {handle: $h}) {
    id title handle status description featuredImage { url }
    variants(first: 20) { nodes {
      id title price compareAtPrice availableForSale image { url }
      productVariantComponents(first: 10) { nodes { quantity productVariant { id barcode product { id } } } }
    } }
  }
}`;

async function api(token, method, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function listAll(token, path, key) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await api(token, 'GET', `${path}${sep}pageSize=250${pageToken ? `&pageToken=${pageToken}` : ''}`);
    out.push(...(r[key] || []));
    if (!r.nextPageToken) return out;
    pageToken = r.nextPageToken;
  }
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const config = JSON.parse(readFileSync(join(ROOT, 'config/pack-listings.json'), 'utf8'));
  const account = `accounts/${config.merchantId}`;
  const token = await getAccessToken();
  const { shopifyGraphQL } = await import('../lib/shopify.js');

  // 1. Our data source (created on first --apply).
  const sources = await listAll(token, `datasources/v1/${account}/dataSources`, 'dataSources');
  let source = sources.find((s) => s.displayName === config.dataSourceName);
  if (!source) {
    if (!apply) {
      console.log(`would create data source "${config.dataSourceName}"`);
    } else {
      source = await api(token, 'POST', `datasources/v1/${account}/dataSources`, {
        displayName: config.dataSourceName,
        primaryProductDataSource: { contentLanguage: 'en', feedLabel: 'US', countries: ['US'] },
      });
      console.log(`created data source ${source.name}`);
    }
  }

  // 2. Build every desired item from Shopify + the single unit's live record.
  const inputs = [];
  const problems = [];
  const templates = new Map();
  for (const handle of config.handles) {
    const r = await shopifyGraphQL(PACK_QUERY, { h: handle });
    const product = r.productByIdentifier || r.data?.productByIdentifier;
    if (!product) { problems.push(`${handle}: not found in Shopify`); continue; }
    if (product.status !== 'ACTIVE') { problems.push(`${handle}: ${product.status}, not listed`); continue; }
    for (const v of product.variants.nodes) {
      const comps = v.productVariantComponents.nodes;
      const first = comps[0]?.productVariant;
      let template = null;
      if (first) {
        const key = singleOfferId(first.product.id, first.id);
        if (!templates.has(key)) {
          try {
            const p = await api(token, 'GET', `products/v1/${account}/products/en~US~${key}`);
            templates.set(key, p.productAttributes || null);
          } catch { templates.set(key, null); }
        }
        template = templates.get(key);
      }
      try {
        inputs.push(buildPackProductInput({
          product,
          variant: { ...v, components: comps.map((c) => ({ quantity: c.quantity, barcode: c.productVariant.barcode })) },
          template,
        }));
      } catch (err) { problems.push(err.message); }
    }
  }

  for (const i of inputs) {
    const a = i.productAttributes;
    const price = (Number(a.price.amountMicros) / 1e6).toFixed(2);
    const sale = a.salePrice ? ` sale ${(Number(a.salePrice.amountMicros) / 1e6).toFixed(2)}` : '';
    console.log(`  ${i.offerId}  ${a.availability.padEnd(12)} $${price}${sale}  ${a.multipack ? `multipack ${a.multipack}` : 'bundle'}  ${a.title}`);
  }
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  if (!apply) { console.log(`dry run: ${inputs.length} items, ${problems.length} problems; add --apply to write`); return; }
  if (!source) throw new Error('no data source');

  // 3. Write (insert is an upsert keyed on offerId), then delete what we no longer list.
  let written = 0;
  const failed = [];
  for (const i of inputs) {
    try {
      await api(token, 'POST', `products/v1/${account}/productInputs:insert?dataSource=${encodeURIComponent(source.name)}`, i);
      written += 1;
    } catch (err) { failed.push(`${i.offerId}: ${err.message}`); }
  }
  const ours = (await listAll(token, `products/v1/${account}/products`, 'products'))
    .filter((p) => p.dataSource === source.name && String(p.offerId).startsWith(OFFER_PREFIX));
  const stale = staleOfferIds(ours.map((p) => p.offerId), inputs.map((i) => i.offerId));
  for (const id of stale) {
    try {
      await api(token, 'DELETE', `products/v1/${account}/productInputs/en~US~${id}?dataSource=${encodeURIComponent(source.name)}`);
    } catch (err) { failed.push(`delete ${id}: ${err.message}`); }
  }

  // 4. Report Google's verdict on what is already processed (new items take minutes to hours).
  const issues = [];
  for (const p of ours) {
    for (const iss of p.productStatus?.itemLevelIssues || []) {
      if (iss.severity !== 'NOT_IMPACTED') issues.push(`${p.offerId}: ${iss.description || iss.code} (${iss.severity})`);
    }
  }
  const summary = `${written} written, ${stale.length} deleted, ${failed.length} failed, ${problems.length} not built, ${issues.length} Google issues`;
  console.log(summary);
  for (const f of [...failed, ...issues]) console.log(`  ${f}`);
  const bad = failed.length || problems.length || issues.length;
  if (bad) {
    await notify({
      subject: `Pack listings: ${summary}`,
      body: [...failed, ...problems, ...issues].join('\n'),
      status: failed.length ? 'error' : 'info',
      category: 'ads',
    }).catch(() => {});
  }
  if (failed.length) process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
