/**
 * Meta A/B Tracker Agent
 *
 * Runs weekly (Mondays). For each active meta test, computes CTR delta
 * from GSC snapshots (pre-test baseline mean vs test-period mean).
 * After 28 days, concludes the test: reverts Shopify metafield if Variant B lost.
 *
 * Usage:
 *   node agents/meta-ab-tracker/index.js
 *   node agents/meta-ab-tracker/index.js --dry-run
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const META_TESTS_DIR = join(ROOT, 'data', 'meta-tests');
const GSC_DIR        = join(ROOT, 'data', 'snapshots', 'gsc');
const RESULTS_DIR    = join(ROOT, 'data', 'reports', 'meta-tests');

// ── pure exports (for tests) ───────────────────────────────────────────────

export function computeCTRDelta(testMean, baselineMean) {
  if (testMean == null || baselineMean == null) return null;
  return testMean - baselineMean; // absolute percentage points
}

// ── GSC helpers ────────────────────────────────────────────────────────────

function getCTRsForPage(pagePath, fromDate, toDate) {
  if (!existsSync(GSC_DIR)) return [];
  const start = new Date(fromDate + 'T12:00:00Z');
  const end   = new Date(toDate   + 'T12:00:00Z');
  const ctrs  = [];

  readdirSync(GSC_DIR)
    .filter(f => f.endsWith('.json'))
    .forEach(f => {
      const d = new Date(f.replace('.json', '') + 'T12:00:00Z');
      if (d < start || d > end) return;
      try {
        const snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8'));
        const pg = (snap.topPages || []).find(p => p.page && p.page.endsWith(pagePath));
        if (pg?.ctr != null) ctrs.push(pg.ctr);
      } catch { /* skip */ }
    });

  return ctrs;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

// ── Shopify helper ─────────────────────────────────────────────────────────

async function revertMetafield(articleId, blogId, originalTitle) {
  function loadEnv() {
    try {
      const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
      const e = {};
      for (const l of lines) {
        const t = l.trim(); if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('='); if (i === -1) continue;
        e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      return e;
    } catch { return {}; }
  }
  const env = loadEnv();
  const token = process.env.SHOPIFY_ACCESS_TOKEN || env.SHOPIFY_ACCESS_TOKEN;
  const store = process.env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_STORE_DOMAIN;
  if (!token || !store) { console.warn('Shopify credentials not set, skipping revert.'); return; }
  if (!blogId) { console.warn('Skipping revert: shopify_blog_id missing from post meta.'); return; }

  const url = `https://${store}/admin/api/2024-01/blogs/${blogId}/articles/${articleId}/metafields.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ metafield: { namespace: 'global', key: 'title_tag', value: originalTitle, type: 'single_line_text_field' } }),
  });
  if (!res.ok) console.warn(`Revert failed: ${res.status}`);
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('Meta A/B Tracker' + (dryRun ? ' (dry run)' : ''));

  if (!existsSync(META_TESTS_DIR)) { console.log('No meta tests directory.'); return; }

  const testFiles = readdirSync(META_TESTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  const activeTests = testFiles
    .map(f => { try { return { f, t: JSON.parse(readFileSync(join(META_TESTS_DIR, f), 'utf8')) }; } catch { return null; } })
    .filter(x => x && x.t.status === 'active');

  if (!activeTests.length) { console.log('No active tests.'); return; }

  for (const { f, t } of activeTests) {
    console.log(`\nProcessing: ${t.slug}`);
    const today    = new Date().toISOString().slice(0, 10);
    const start    = new Date(t.startDate + 'T12:00:00Z');
    const conclude = new Date(t.concludeDate + 'T12:00:00Z');
    const daysRemaining = Math.max(0, Math.ceil((conclude - new Date()) / 86400000));

    // Get page path from slug
    const metaPath = join(ROOT, 'data', 'posts', `${t.slug}.json`);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
    let pagePath;
    try {
      pagePath = meta?.shopify_url ? new URL(meta.shopify_url).pathname : `/${t.slug}`;
    } catch {
      pagePath = `/${t.slug}`;
    }

    // Compute baseline (28 days before startDate)
    const baselineStart = new Date(start.getTime() - 28 * 86400000).toISOString().slice(0, 10);
    const baselineEnd   = t.startDate;
    const baselineCTRs  = getCTRsForPage(pagePath, baselineStart, baselineEnd);
    const baselineMean  = t.baselineMean ?? mean(baselineCTRs);

    // Compute test period mean
    const testCTRs = getCTRsForPage(pagePath, t.startDate, today);
    const testMean = mean(testCTRs);
    const delta    = computeCTRDelta(testMean, baselineMean);

    console.log(`  Baseline mean: ${baselineMean != null ? (baselineMean * 100).toFixed(3) + '%' : 'n/a'}`);
    console.log(`  Test mean:     ${testMean     != null ? (testMean     * 100).toFixed(3) + '%' : 'n/a (insufficient data)'}`);
    console.log(`  Delta:         ${delta != null ? (delta * 100).toFixed(3) + 'pp' : 'n/a'}`);
    console.log(`  Days remaining: ${daysRemaining}`);

    t.baselineMean  = baselineMean;
    t.testMean      = testMean;
    t.currentDelta  = delta;
    t.daysRemaining = daysRemaining;

    // Conclude if past 28 days (equivalent to daysRemaining === 0)
    if (new Date() >= conclude) {
      const winner = delta != null && delta > 0 ? 'B' : 'A';
      t.status  = 'concluded';
      t.winner  = winner;
      t.concludedDate = today;
      console.log(`  → Test concluded. Winner: Variant ${winner}`);

      if (!dryRun) {
        // Revert to A if B lost
        if (winner === 'A' && meta?.shopify_article_id) {
          console.log('  Reverting to Variant A...');
          await revertMetafield(meta.shopify_article_id, meta.shopify_blog_id, t.variantA);
        }

        // Write result report
        mkdirSync(RESULTS_DIR, { recursive: true });
        const report = [
          `# A/B Test Result: ${t.slug}`,
          `**Period:** ${t.startDate} → ${today}`,
          `**Winner:** Variant ${winner}`,
          `**Variant A:** ${t.variantA}`,
          `**Variant B:** ${t.variantB}`,
          `**Baseline CTR:** ${baselineMean != null ? (baselineMean * 100).toFixed(3) + '%' : 'n/a'}`,
          `**Test CTR:**     ${testMean     != null ? (testMean     * 100).toFixed(3) + '%' : 'n/a'}`,
          `**Delta:**        ${delta != null ? (delta >= 0 ? '+' : '') + (delta * 100).toFixed(3) + 'pp' : 'n/a'}`,
          winner === 'A' ? '\nVariant A title restored on Shopify.' : '\nVariant B title retained on Shopify.',
        ].join('\n');
        writeFileSync(join(RESULTS_DIR, `${t.slug}-result.md`), report);

        await notify({
          subject: `A/B Test concluded: ${t.slug} — Variant ${winner} wins`,
          body: report,
          status: 'success',
        });
      }
    }

    if (!dryRun) {
      writeFileSync(join(META_TESTS_DIR, f), JSON.stringify(t, null, 2));
      console.log(`  Test file updated.`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
