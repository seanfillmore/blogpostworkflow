/**
 * Amazon keyword coverage — monthly, REPORT ONLY.
 *
 * Compares every RSC listing's live title, bullets and backend search terms against the
 * searches Amazon says showed that listing (Search Query Performance, the weekly dumps in
 * data/amazon-explore/ written by scripts/amazon/explore-search-query-performance-rsc.mjs),
 * and reports the highest-volume searches containing a word the listing does not index.
 * Logic lives in lib/amazon/keyword-coverage.js. Operator asked for this on 2026-10-10
 * after an audit found the listing copy had never been checked against Amazon's own
 * search data.
 *
 * NEVER WRITES TO AMAZON. It only GETs listings. Applying a gap is a human decision,
 * because some query words are competitor brands not yet on the exclusion list and some
 * are claims; config/amazon-keyword-exclusions.json is where those get recorded.
 *
 * Output: data/reports/amazon-keyword-coverage/<date>.md and latest.json (gitignored,
 * server-written), plus ONE deferred digest row. A finding is `info`; only a broken input
 * (no SQP data, stale SQP data, unreadable listings) is `error`, because then the check
 * did not run and nothing else in the fleet would say so.
 *
 * Usage:
 *   node agents/amazon-keyword-coverage/index.js            # 6 most recent weekly dumps
 *   node agents/amazon-keyword-coverage/index.js --weeks 8
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { buildCoverage, renderMarkdown, renderDigest, gapCount } from '../../lib/amazon/keyword-coverage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DUMP_DIR = join(ROOT, 'data', 'amazon-explore');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-keyword-coverage');
/** The SQP pull is weekly; a newest dump older than this means that pull has stopped. */
export const MAX_SQP_AGE_DAYS = 15;

/** Newest `n` weekly SQP dumps, by their YYYY-MM-DD filename prefix. */
export function pickSqpFiles(names, n) {
  return names.filter((f) => /^\d{4}-\d{2}-\d{2}-search-query-performance-production\.json$/.test(f)).sort().slice(-n);
}

/** CLAUDE.md's brand rule: a title naming Culina or cast iron is Culina; everything else is RSC. */
export function isRsc(title) {
  return !/culina|cast iron/i.test(String(title ?? ''));
}

/** One listing per ASIN: the SKU carrying bullets wins (FBM twins carry none; the page uses the main SKU). */
export function listingsByAsin(items, marketplaceId) {
  const val = (attrs, k) => (attrs?.[k] ?? [])
    .filter((v) => (v.marketplace_id ?? marketplaceId) === marketplaceId && (v.language_tag ?? 'en_US') === 'en_US')
    .map((v) => v.value);
  const best = new Map();
  for (const it of items ?? []) {
    const s = it.summaries?.[0] ?? {};
    const title = val(it.attributes, 'item_name')[0] ?? s.itemName;
    if (!s.asin || !isRsc(title)) continue;
    const row = { asin: s.asin, sku: it.sku, title, bullets: val(it.attributes, 'bullet_point'), keywords: val(it.attributes, 'generic_keyword')[0] ?? '' };
    const prev = best.get(s.asin);
    if (!prev || row.bullets.length > prev.bullets.length) best.set(s.asin, row);
  }
  return [...best.values()];
}

async function fetchListings(sp) {
  const client = await sp.getClient();
  const marketplaceId = sp.getMarketplaceId();
  const seller = process.env.AMAZON_SPAPI_SELLER_ID ?? (() => {
    try { return readFileSync(join(ROOT, '.env'), 'utf8').match(/^AMAZON_SPAPI_SELLER_ID=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, ''); } catch { return null; }
  })();
  if (!seller) throw new Error('AMAZON_SPAPI_SELLER_ID not set');
  const items = [];
  let pageToken = null;
  do {
    const params = { marketplaceIds: marketplaceId, includedData: 'summaries,attributes', pageSize: 20 };
    if (pageToken) params.pageToken = pageToken;
    const d = await sp.request(client, 'GET', `/listings/2021-08-01/items/${encodeURIComponent(seller)}`, params);
    items.push(...(d.items ?? []));
    pageToken = d.pagination?.nextToken;
  } while (pageToken);
  return listingsByAsin(items, marketplaceId);
}

export async function main({ argv = process.argv.slice(2), spapi, notify, now = new Date(), dumpDir = DUMP_DIR, outDir = OUT_DIR, log = console.log } = {}) {
  const say = notify ?? (await import('../../lib/notify.js')).notify;
  const weeksArg = argv.indexOf('--weeks');
  const n = weeksArg >= 0 ? Math.max(1, Number(argv[weeksArg + 1]) || 6) : 6;

  const files = pickSqpFiles(readdirSync(dumpDir), n);
  if (!files.length) {
    await say({ subject: 'Amazon keyword coverage did not run: no search data', body: `No search-query-performance dumps in ${dumpDir}. The weekly amazon-explore-sqp step has never written one, or they were removed.`, status: 'error', category: 'amazon-keyword-coverage' });
    return { ran: false, reason: 'no-sqp' };
  }
  const newest = files.at(-1);
  const ageDays = (now - new Date(`${newest.slice(0, 10)}T00:00:00Z`)) / 86400000;
  if (ageDays > MAX_SQP_AGE_DAYS) {
    await say({ subject: 'Amazon keyword coverage did not run: search data is stale', body: `Newest dump is ${newest} (${Math.round(ageDays)} days old, limit ${MAX_SQP_AGE_DAYS}). The weekly amazon-explore-sqp step has stopped writing. Coverage was not computed, because a gap list from old data reads exactly like a current one.`, status: 'error', category: 'amazon-keyword-coverage' });
    return { ran: false, reason: 'stale-sqp', newest };
  }

  const rows = files.flatMap((f) => JSON.parse(readFileSync(join(dumpDir, f), 'utf8')).rows ?? []);
  const sp = spapi ?? await import('../../lib/amazon/sp-api-client.js');
  const listings = await fetchListings(sp);
  const exclusions = JSON.parse(readFileSync(join(ROOT, 'config', 'amazon-keyword-exclusions.json'), 'utf8'));
  const report = buildCoverage({ rows, listings, exclusions });

  const date = now.toISOString().slice(0, 10);
  mkdirSync(outDir, { recursive: true });
  const md = renderMarkdown(report, { generatedAt: now.toISOString() });
  const mdPath = join(outDir, `${date}.md`);
  writeFileSync(mdPath, md);
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify({ generated_at: now.toISOString(), files, ...report }, null, 2));
  log(md);

  const gaps = gapCount(report);
  await say({
    subject: `Amazon keyword coverage: ${gaps} gap(s) across ${Object.keys(report.lines).length} product line(s)`,
    body: `${renderDigest(report)}\n\nFull report: ${mdPath}\nReport only; nothing on Amazon was changed.`,
    status: 'info',
    category: 'amazon-keyword-coverage',
  });
  return { ran: true, gaps, report, mdPath };
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    try {
      const { notify } = await import('../../lib/notify.js');
      await notify({ subject: 'Amazon keyword coverage FAILED', body: String(err?.stack ?? err), status: 'error', category: 'amazon-keyword-coverage' });
    } catch { /* notify itself failed; the cron log has the stack */ }
    process.exit(1);
  });
}
