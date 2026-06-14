/**
 * Change Diff Detector
 *
 * Daily cron. Fetches the live Shopify content (articles, products, pages),
 * reduces it to a compact content-state (title + meta raw, body_html hashed),
 * and diffs against the previous run's saved state. Any tracked-field change
 * becomes a synthetic change event feeding the outcome-attribution loop.
 *
 * Self-contained by design: it reads live content directly rather than relying
 * on the shopify-collector snapshot (which only carries commerce metrics —
 * orders/checkouts, never article/product/page content). The previous broken
 * dependency on those snapshots meant the detector saw `curr.articles ===
 * undefined` and logged ZERO events for months.
 *
 * Tracked fields per resource:
 *   article: title, summary_html (= meta_description), body_html (hashed)
 *   product: title, body_html (hashed)
 *   page:    title, body_html (hashed)
 *
 * Synthetic events get source: "manual_diff", target_query: null,
 * category: "experimental". The state file persists at
 * data/snapshots/shopify-content/latest.json.
 *
 * NOTE: does not de-duplicate against agent-logged events; if a diff is detected
 * for a change an agent already logged, the verdict computation absorbs the
 * duplicate without misclassifying.
 *
 * Usage:
 *   node agents/change-diff-detector/index.js
 *   node agents/change-diff-detector/index.js --dry-run
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logChangeEvent } from '../../lib/change-log.js';
import { notify } from '../../lib/notify.js';
import { getBlogs, getArticles, getProducts, getPages } from '../../lib/shopify.js';
import { buildContentState, diffContentStates } from '../../lib/content-snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CONTENT_DIR = join(ROOT, 'data', 'snapshots', 'shopify-content');
const STATE_FILE = join(CONTENT_DIR, 'latest.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// Fetch all live content. Shopify fetchers default to limit=250; RSC has ~215
// articles so a single page covers it. If the blog ever exceeds 250 posts this
// will need cursor pagination.
async function fetchLiveContent() {
  const blogs = await getBlogs();
  const articles = [];
  for (const blog of blogs || []) {
    const items = await getArticles(blog.id);
    for (const a of items || []) articles.push(a);
  }
  const [products, pages] = await Promise.all([getProducts(), getPages()]);
  return { articles, products, pages };
}

function loadPrevState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function saveState(state) {
  mkdirSync(CONTENT_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, captured_at: new Date().toISOString() }, null, 2));
}

async function main() {
  console.log(`\nChange Diff Detector — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);

  const live = await fetchLiveContent();
  const currState = buildContentState(live);
  console.log(`  Live content: ${currState.articles.length} articles, ${currState.products.length} products, ${currState.pages.length} pages`);

  const prevState = loadPrevState();
  if (!prevState) {
    console.log('  No previous content state — capturing baseline, no diffs this run.');
    if (!dryRun) saveState(currState);
    return;
  }

  const diffs = diffContentStates(prevState, currState);
  const stats = { detected: diffs.length, logged: 0 };

  for (const d of diffs) {
    if (dryRun) {
      console.log(`    [diff] ${d.url} ${d.changeType}`);
      continue;
    }
    const eid = await logChangeEvent({
      url: d.url,
      slug: d.slug,
      changeType: d.changeType,
      category: 'experimental',
      before: d.before,
      after: d.after,
      source: 'manual_diff',
      targetQuery: null,
      intent: null,
    });
    stats.logged++;
    console.log(`    [logged] ${eid} ${d.url} ${d.changeType}`);
  }

  // Persist the new state so the next run diffs against it (only on a real run).
  if (!dryRun) saveState(currState);

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
