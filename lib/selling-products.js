// lib/selling-products.js
//
// "Which product categories actually sell?" — answered from Shopify order
// snapshots rather than from intent.
//
// Exists so optimization spend follows revenue. The content pipeline used to pick
// refresh targets purely on GSC impressions and position, which meant it happily
// spent LLM tokens rewriting pages for categories the store does not sell. Every
// refresh costs real money (content-refresher is output-dominated — roughly $4.50
// of every $6.20 it spends is generated tokens), so a page with no product behind
// it is spend with no path to a sale.
//
// Snapshots are gitignored and written by cron on the server, so a local checkout
// has none. Every function here therefore fails OPEN: no data means "do not
// filter", never "nothing sells". A collector outage must not silently halt the
// content pipeline.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCT_SCOPE_TERMS } from './product-scope.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');

/** Trailing window. 90 days matches the AOV baseline the rest of the fleet reasons over. */
export const DEFAULT_WINDOW_DAYS = 90;

/**
 * Revenue per product-scope term over the trailing window, as a Map.
 *
 * A single product title can carry several terms — "Coconut Oil Deodorant" counts
 * toward both `coconut oil` and `deodorant` — because a keyword matching either
 * one does describe a product that sells. Terms with no revenue are absent rather
 * than zero, so callers can distinguish "did not sell" from "not a category".
 */
export function productRevenueByTerm({ snapshotsDir = DEFAULT_SNAPSHOTS_DIR, days = DEFAULT_WINDOW_DAYS } = {}) {
  const byTerm = new Map();
  if (!existsSync(snapshotsDir)) return byTerm;

  let files;
  try {
    files = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json')).sort().slice(-days);
  } catch { return byTerm; }

  for (const f of files) {
    let snap;
    try { snap = JSON.parse(readFileSync(join(snapshotsDir, f), 'utf8')); } catch { continue; }
    for (const p of snap.topProducts ?? []) {
      const title = String(p.title ?? '').toLowerCase();
      const revenue = Number(p.revenue) || 0;
      if (!title || revenue <= 0) continue;
      for (const term of PRODUCT_SCOPE_TERMS) {
        if (title.includes(term)) byTerm.set(term, (byTerm.get(term) ?? 0) + revenue);
      }
    }
  }
  return byTerm;
}

/**
 * The product-scope terms worth spending optimization budget on.
 *
 * Returns null — not an empty set — when there is no revenue data at all. Null is
 * the fail-open signal every consumer must honour; an empty set would read as
 * "nothing sells" and stop the pipeline dead on a local checkout or a collector
 * outage.
 *
 * `minRevenue` defaults to 0 (exclusive), i.e. the literal rule: the category has
 * to have sold something. Raise it to concentrate spend on the categories carrying
 * real money.
 */
export function sellingScopeTerms({ snapshotsDir, days, minRevenue = 0 } = {}) {
  const byTerm = productRevenueByTerm({ snapshotsDir, days });
  if (byTerm.size === 0) return null;

  const terms = new Set();
  for (const [term, revenue] of byTerm) {
    if (revenue > minRevenue) terms.add(term);
  }
  // Data existed but nothing cleared the bar — that is a real answer, not a gap,
  // so an empty set here is returned as-is rather than converted to fail-open.
  return terms;
}

const SCOPE_CONFIG_PATH = join(ROOT, 'config', 'optimization-scope.json');

function loadScopeConfig(path = SCOPE_CONFIG_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { terms: null }; }
}

/**
 * The categories optimization spend is allowed to touch, plus what to warn about.
 *
 * `config.terms` is an explicit operator allowlist — currently `["lotion"]`, set
 * 2026-08-03 for a 60-day trial because lotion is 62% of trailing-90d product
 * revenue. An allowlist rather than a revenue threshold on purpose: a threshold
 * silently re-admits a category the moment its revenue drifts across the line, and
 * widening scope should be a decision someone makes, not a side effect of a good
 * month. Set `terms` to null to fall back to every category with any revenue.
 *
 * Returns `{ terms, unsold, config }`. `terms` is null when there is no revenue
 * data at all — the fail-open signal (see sellingScopeTerms). `unsold` lists
 * allowlisted terms with no recorded revenue: the allowlist still wins, but a
 * category that has stopped selling should not go unnoticed.
 */
export function optimizationScopeTerms({ snapshotsDir, days, config = loadScopeConfig() } = {}) {
  const selling = sellingScopeTerms({ snapshotsDir, days });
  if (selling === null) return { terms: null, unsold: [], config };

  const allow = Array.isArray(config?.terms) ? config.terms : null;
  if (!allow) return { terms: selling, unsold: [], config };

  const unsold = allow.filter((t) => !selling.has(t));
  return { terms: new Set(allow), unsold, config };
}

/**
 * Does this keyword describe a product category that sells?
 *
 * A keyword matching no category at all ("natural skincare routine") is false: it
 * corresponds to no product, so it corresponds to no product that sells. Passing
 * `null` for `sellingTerms` is the fail-open case and returns true.
 */
export function isKeywordSelling(keyword, sellingTerms) {
  if (sellingTerms === null || sellingTerms === undefined) return true;
  const kw = String(keyword ?? '').toLowerCase();
  if (!kw) return false;
  for (const term of sellingTerms) {
    if (kw.includes(term)) return true;
  }
  return false;
}
