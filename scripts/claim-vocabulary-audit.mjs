#!/usr/bin/env node
/**
 * Claim audit — count how often the brand's own vocabulary appears in customer language.
 *
 * The gap between what we assert and what buyers actually say is what makes copy
 * fail invisibly: a claim that appears zero times across hundreds of pieces of
 * customer evidence is filtering out the people most likely to buy and come back.
 *
 * Two directions, and the second is the more useful one:
 *
 *   OVERCLAIMED  — frequent in our copy, absent or near-absent in customer language.
 *                  This is the kill list for PDP copy, Amazon bullets and ad text.
 *   UNDERCLAIMED — frequent in customer language, absent from our copy.
 *                  This is what buyers say the product is for, that we never say back.
 *
 * Sources are deliberately asymmetric and that is the point. BRAND side is what we
 * publish: live Shopify product titles, product bodies, SEO title/description
 * metafields, and published collection titles and bodies. CUSTOMER side is what
 * buyers wrote unprompted: Judge.me review bodies. Ad performance data is
 * deliberately excluded from both sides — metrics record what happened, never why,
 * and ranking language by last month's ROAS only ever returns "say it again".
 *
 * Read-only. Shopify GETs, one Judge.me GET per page, stdout.
 *
 * Usage:
 *   node scripts/claim-vocabulary-audit.mjs
 *     --min-brand <n>   Only audit terms used at least n times in our copy. Default 3.
 *     --top <n>         How many rows per direction. Default 30.
 *     --json / --out <path>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProducts, getCustomCollections, getSmartCollections, getMetafields } from '../lib/shopify.js';
import { fetchAllReviews } from '../lib/judgeme.js';

// Same local-object .env read the rest of the fleet uses — deliberately not
// merged into process.env.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = (() => {
  try {
    const out = {};
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  } catch { return {}; }
})();
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const MIN_BRAND = Number(flag('min-brand', 3));
const TOP = Number(flag('top', 30));
const OUT = flag('out', null);
const AS_JSON = has('json');

/**
 * Words that carry no claim. Deliberately does NOT include product nouns
 * (lotion, soap, deodorant) — a product noun appearing in our copy and never in
 * customer language would be a real finding, so it must stay auditable.
 */
const STOP = new Set(`a about above after again against all am an and any are aren as at be because been
before being below between both but by can cannot could couldn did didn do does doesn doing don down during
each few for from further had hadn has hasn have haven having he her here hers herself him himself his how
i if in into is isn it its itself just me more most must my myself no nor not now of off on once only or
other ought our ours ourselves out over own same shan she should shouldn so some such than that the their
theirs them themselves then there these they this those through to too under until up very was wasn we
were weren what when where which while who whom why will with won would wouldn you your yours yourself
yourselves get got also one two three make made use used using will can may might really much many well
new like get go going come came take took give gave know knew think thought see saw want wanted need needed
day days week weeks month months year years time times thing things way ways lot lots bit little big small
love loved loves great good best better nice amazing awesome perfect excellent wonderful happy pleased
product products item items order ordered ordering purchase purchased buy bought buying price prices
review reviews star stars rating recommend recommended recommending try tried trying first second
oz ml fl size sizes pack packs count ct free shipping ship ships shipped delivery arrived
real skin care realskincare brand company shop store online website site com www http https
it's i'm i've don't doesn't didn't can't won't that's there's they're you're we're isn't wasn't
`.split(/\s+/).filter(Boolean));

const normalize = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** 1- and 2-grams, stopword-filtered, crudely singularised so "lotions" folds into "lotion". */
function terms(text) {
  const words = normalize(text).split(' ').filter((w) => w && w.length > 2 && !/^\d+$/.test(w));
  const out = [];
  const kept = [];
  for (const w of words) {
    const s = singular(w);
    if (STOP.has(w) || STOP.has(s)) { kept.push(null); continue; }
    kept.push(s);
    out.push(s);
  }
  for (let i = 0; i < kept.length - 1; i++) {
    if (kept[i] && kept[i + 1]) out.push(`${kept[i]} ${kept[i + 1]}`);
  }
  return out;
}

/** Term counts plus, for each term, how many distinct documents mention it. */
function tally(docs) {
  const total = new Map();
  const docFreq = new Map();
  for (const d of docs) {
    const seen = new Set();
    for (const t of terms(d)) {
      total.set(t, (total.get(t) || 0) + 1);
      seen.add(t);
    }
    for (const t of seen) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }
  return { total, docFreq };
}

async function brandDocs() {
  const docs = [];
  const detail = { products: 0, collections: 0, metafields: 0 };

  const products = await getProducts({ limit: 250 });
  for (const p of products) {
    if (p.status && p.status !== 'active') continue;
    docs.push(p.title);
    docs.push(p.body_html || '');
    detail.products += 1;
    try {
      const mf = await getMetafields('products', p.id);
      for (const m of mf || []) {
        if (m.namespace === 'global' && ['title_tag', 'description_tag'].includes(m.key)) {
          docs.push(String(m.value || ''));
          detail.metafields += 1;
        }
      }
    } catch { /* metafields are optional evidence; a failure must not sink the audit */ }
  }

  const cols = [...(await getCustomCollections({ limit: 250 })), ...(await getSmartCollections({ limit: 250 }))];
  for (const c of cols) {
    if (!c.published_at) continue; // an unpublished collection is not a claim we are making
    docs.push(c.title);
    docs.push(c.body_html || '');
    detail.collections += 1;
  }

  return { docs: docs.filter((d) => String(d).trim()), detail };
}

async function main() {
  const shopDomain = env.SHOPIFY_STORE;
  if (!shopDomain) throw new Error('SHOPIFY_STORE missing from .env — Judge.me needs it as shop_domain.');
  const token = env.JUDGEME_API_TOKEN;
  if (!token) throw new Error('JUDGEME_API_TOKEN missing from .env — the customer side of this audit cannot be built without it.');

  const reviews = await fetchAllReviews(shopDomain, token, { maxPages: 50 });
  const customerDocs = reviews.map((r) => r.body).filter(Boolean);

  const { docs: brand, detail } = await brandDocs();

  const B = tally(brand);
  const C = tally(customerDocs);

  const rows = [];
  for (const [term, brandCount] of B.total) {
    if (brandCount < MIN_BRAND) continue;
    rows.push({
      term,
      brand: brandCount,
      brandDocs: B.docFreq.get(term) || 0,
      customer: C.total.get(term) || 0,
      customerDocs: C.docFreq.get(term) || 0,
    });
  }

  const overclaimed = rows
    .filter((r) => r.customer === 0)
    .sort((a, b) => b.brand - a.brand)
    .slice(0, TOP);

  const nearZero = rows
    .filter((r) => r.customer > 0 && r.customerDocs <= 2 && r.brandDocs >= 3)
    .sort((a, b) => b.brand - a.brand)
    .slice(0, TOP);

  const underclaimed = [...C.total]
    .filter(([term]) => !B.total.has(term))
    .map(([term, customer]) => ({ term, customer, customerDocs: C.docFreq.get(term) || 0, brand: 0 }))
    .filter((r) => r.customerDocs >= 3)
    .sort((a, b) => b.customerDocs - a.customerDocs)
    .slice(0, TOP);

  const result = {
    generated_at: new Date().toISOString(),
    sources: {
      customer: { judgeme_reviews: customerDocs.length, chars: customerDocs.join(' ').length },
      brand: { ...detail, docs: brand.length },
    },
    min_brand: MIN_BRAND,
    overclaimed,
    near_zero: nearZero,
    underclaimed,
  };

  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
  if (AS_JSON) { console.log(JSON.stringify(result, null, 2)); return; }

  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);

  console.log(`\nClaim audit — brand vocabulary vs customer language`);
  console.log(`Customer side: ${customerDocs.length} Judge.me reviews (${result.sources.customer.chars.toLocaleString()} chars)`);
  console.log(`Brand side: ${detail.products} live products, ${detail.collections} published collections, ${detail.metafields} SEO metafields\n`);

  console.log(`OVERCLAIMED — we say it ${MIN_BRAND}+ times, customers say it ZERO times`);
  console.log(`${pad('term', 34)} ${lpad('ours', 6)} ${lpad('theirs', 7)}`);
  console.log('-'.repeat(50));
  for (const r of overclaimed) console.log(`${pad(r.term, 34)} ${lpad(r.brand, 6)} ${lpad(r.customer, 7)}`);

  console.log(`\nNEAR-ZERO — we lean on it, at most 2 customers ever mentioned it`);
  console.log(`${pad('term', 34)} ${lpad('ours', 6)} ${lpad('theirs', 7)} ${lpad('in n', 5)}`);
  console.log('-'.repeat(56));
  for (const r of nearZero) console.log(`${pad(r.term, 34)} ${lpad(r.brand, 6)} ${lpad(r.customer, 7)} ${lpad(r.customerDocs, 5)}`);

  console.log(`\nUNDERCLAIMED — customers say it, our copy never does`);
  console.log(`${pad('term', 34)} ${lpad('theirs', 7)} ${lpad('in n', 5)}`);
  console.log('-'.repeat(50));
  for (const r of underclaimed) console.log(`${pad(r.term, 34)} ${lpad(r.customer, 7)} ${lpad(r.customerDocs, 5)}`);
  console.log('');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
