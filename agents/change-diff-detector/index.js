/**
 * Change Diff Detector
 *
 * Daily cron. Reads the two most recent shopify-collector snapshots, diffs
 * them per article/product/page, and creates synthetic change events for
 * any field change that doesn't already have an agent-logged event in the
 * last 48 hours.
 *
 * Tracked fields per resource:
 *   article: title, summary_html (= meta_description), body_html
 *   product: title, body_html (= description), seo metafields when present
 *   page:    title, body_html
 *
 * Synthetic events get source: "manual_diff", target_query: null,
 * category: "experimental".
 *
 * NOTE (v1): does not currently de-duplicate against agent-logged events
 * in the last 48 hours. The assumption is agents call logChangeEvent
 * themselves; if a diff is detected for a change an agent already logged,
 * the verdict computation absorbs the duplicate without misclassifying.
 *
 * Usage:
 *   node agents/change-diff-detector/index.js
 *   node agents/change-diff-detector/index.js --dry-run
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logChangeEvent } from '../../lib/change-log.js';
import { eventPath } from '../../lib/change-log/store.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SHOPIFY_DIR = join(ROOT, 'data', 'snapshots', 'shopify');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const TRACKED_ARTICLE_FIELDS = ['title', 'summary_html', 'body_html'];
const TRACKED_PRODUCT_FIELDS = ['title', 'body_html'];
const TRACKED_PAGE_FIELDS    = ['title', 'body_html'];

const FIELD_TO_CHANGE_TYPE = {
  title: 'title',
  summary_html: 'meta_description',
  body_html: 'content_body',
};

function listSnapshots() {
  if (!existsSync(SHOPIFY_DIR)) return [];
  return readdirSync(SHOPIFY_DIR).filter((f) => f.endsWith('.json')).sort();
}

function indexById(items, idKey = 'id') {
  const m = new Map();
  for (const it of items || []) m.set(it[idKey], it);
  return m;
}

function diffFields(prev, curr, fields) {
  const diffs = [];
  for (const f of fields) {
    if ((prev?.[f] ?? '') !== (curr?.[f] ?? '')) {
      diffs.push({ field: f, before: prev?.[f] ?? '', after: curr?.[f] ?? '' });
    }
  }
  return diffs;
}

function urlFor(resourceType, item) {
  if (resourceType === 'article') return `/blogs/news/${item.handle}`;
  if (resourceType === 'product') return `/products/${item.handle}`;
  if (resourceType === 'page') return `/pages/${item.handle}`;
  return null;
}

async function main() {
  console.log(`\nChange Diff Detector — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  const snapshots = listSnapshots();
  if (snapshots.length < 2) {
    console.log('  Not enough shopify snapshots yet (need at least 2). Skipping.');
    return;
  }
  const today = snapshots[snapshots.length - 1];
  const yesterday = snapshots[snapshots.length - 2];
  console.log(`  Comparing ${yesterday} → ${today}`);

  const prev = JSON.parse(readFileSync(join(SHOPIFY_DIR, yesterday), 'utf8'));
  const curr = JSON.parse(readFileSync(join(SHOPIFY_DIR, today), 'utf8'));

  const stats = { detected: 0, logged: 0, already_logged: 0 };

  // Articles
  const prevArticles = indexById(prev.articles);
  for (const a of curr.articles || []) {
    const prevA = prevArticles.get(a.id);
    if (!prevA) continue; // new article isn't a "change"
    const diffs = diffFields(prevA, a, TRACKED_ARTICLE_FIELDS);
    for (const d of diffs) {
      stats.detected++;
      const url = urlFor('article', a);
      const slug = a.handle;
      const changeType = FIELD_TO_CHANGE_TYPE[d.field];
      if (dryRun) {
        console.log(`    [diff] ${url} ${changeType}: <${d.before.length} chars> → <${d.after.length} chars>`);
        continue;
      }
      const eid = await logChangeEvent({
        url, slug,
        changeType,
        category: 'experimental',
        before: d.before, after: d.after,
        source: 'manual_diff',
        targetQuery: null,
        intent: null,
      });
      stats.logged++;
      console.log(`    [logged] ${eid} ${url} ${changeType}`);
    }
  }

  // Products
  const prevProducts = indexById(prev.products);
  for (const p of curr.products || []) {
    const prevP = prevProducts.get(p.id);
    if (!prevP) continue;
    const diffs = diffFields(prevP, p, TRACKED_PRODUCT_FIELDS);
    for (const d of diffs) {
      stats.detected++;
      const url = urlFor('product', p);
      const slug = p.handle;
      const changeType = FIELD_TO_CHANGE_TYPE[d.field];
      if (dryRun) {
        console.log(`    [diff] ${url} ${changeType}`);
        continue;
      }
      const eid = await logChangeEvent({
        url, slug,
        changeType,
        category: 'experimental',
        before: d.before, after: d.after,
        source: 'manual_diff',
        targetQuery: null,
        intent: null,
      });
      stats.logged++;
      console.log(`    [logged] ${eid} ${url} ${changeType}`);
    }
  }

  // Pages
  const prevPages = indexById(prev.pages);
  for (const p of curr.pages || []) {
    const prevP = prevPages.get(p.id);
    if (!prevP) continue;
    const diffs = diffFields(prevP, p, TRACKED_PAGE_FIELDS);
    for (const d of diffs) {
      stats.detected++;
      const url = urlFor('page', p);
      const slug = p.handle;
      const changeType = FIELD_TO_CHANGE_TYPE[d.field];
      if (dryRun) {
        console.log(`    [diff] ${url} ${changeType}`);
        continue;
      }
      const eid = await logChangeEvent({
        url, slug,
        changeType,
        category: 'experimental',
        before: d.before, after: d.after,
        source: 'manual_diff',
        targetQuery: null,
        intent: null,
      });
      stats.logged++;
      console.log(`    [logged] ${eid} ${url} ${changeType}`);
    }
  }

  console.log(`\n  Detected ${stats.detected} field diffs, logged ${stats.logged}.`);
  if (!dryRun) {
    await notify({ subject: 'Change Diff Detector ran', body: `Detected ${stats.detected}, logged ${stats.logged}` });
  }
}

main().catch((err) => {
  notify({ subject: 'Change Diff Detector failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
