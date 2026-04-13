#!/usr/bin/env node
/**
 * GSC Opportunity Agent
 *
 * Daily report of search queries that represent the highest-leverage SEO
 * opportunities visible in Google Search Console:
 *
 *   1. Low-CTR queries  — impressions ≥ 100, CTR ≤ 2%. Title/meta rewrite candidates.
 *   2. Page-2 queries   — positions 11–30. Quick-win candidates (feeds Task 2).
 *   3. Unmapped queries — high impressions, no internal page targets the keyword.
 *                          New-topic candidates (feeds the strategist).
 *
 * Outputs:
 *   data/reports/gsc-opportunity/YYYY-MM-DD.md — human-readable report
 *   data/reports/gsc-opportunity/latest.json   — machine-readable for digest +
 *                                                 strategist consumption
 *
 * Cron: daily 6:30 AM PT (after gsc-collector runs).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { getLowCTRKeywords, getPage2Keywords } from '../../lib/gsc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const REPORTS_DIR = join(ROOT, 'data', 'reports', 'gsc-opportunity');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');

import { listAllSlugs, getPostMeta } from '../../lib/posts.js';

const LOW_CTR_MIN_IMPRESSIONS = 100;
const LOW_CTR_MAX_CTR = 0.02;
const UNMAPPED_MIN_IMPRESSIONS = 50;

/**
 * Load the shared rejected-keywords list. Rows matching any rejection are
 * filtered out of every section of the report. Uses the same matching
 * semantics as the content-strategist / calendar-runner.
 */
function loadRejections() {
  const p = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

function isRejected(keyword, rejections) {
  const kw = (keyword || '').toLowerCase().trim();
  if (!kw) return false;
  return rejections.some((r) => {
    const term = (r.keyword || '').toLowerCase().trim();
    if (!term) return false;
    if (r.matchType === 'exact') return kw === term;
    return kw.includes(term);
  });
}

function loadKeywordIndex() {
  // Build a set of keywords already targeted by an existing brief or post.
  const keywords = new Set();
  if (existsSync(BRIEFS_DIR)) {
    for (const f of readdirSync(BRIEFS_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const b = JSON.parse(readFileSync(join(BRIEFS_DIR, f), 'utf8'));
        if (b.target_keyword) keywords.add(b.target_keyword.toLowerCase());
      } catch { /* ignore */ }
    }
  }
  for (const slug of listAllSlugs()) {
    try {
      const p = getPostMeta(slug);
      if (p?.target_keyword) keywords.add(p.target_keyword.toLowerCase());
    } catch { /* ignore */ }
  }
  return keywords;
}

function isMapped(keyword, index) {
  const kw = keyword.toLowerCase().trim();
  if (index.has(kw)) return true;
  // Soft mapping: any indexed keyword that contains the query, or vice versa
  for (const target of index) {
    if (target.includes(kw) || kw.includes(target)) return true;
  }
  return false;
}

async function main() {
  console.log('\nGSC Opportunity Agent\n');

  mkdirSync(REPORTS_DIR, { recursive: true });

  const rejections = loadRejections();
  if (rejections.length) console.log(`  Loaded ${rejections.length} keyword rejection${rejections.length === 1 ? '' : 's'}`);

  console.log('  Fetching low-CTR queries...');
  const lowCTRRaw = await getLowCTRKeywords(LOW_CTR_MIN_IMPRESSIONS, LOW_CTR_MAX_CTR, 50, 90);
  const lowCTR = lowCTRRaw.filter((r) => !isRejected(r.keyword, rejections));
  console.log(`    ${lowCTR.length} low-CTR queries (impressions ≥ ${LOW_CTR_MIN_IMPRESSIONS}, CTR ≤ ${LOW_CTR_MAX_CTR * 100}%)${lowCTRRaw.length !== lowCTR.length ? ` — ${lowCTRRaw.length - lowCTR.length} filtered by rejection list` : ''}`);

  console.log('  Fetching page-2 queries...');
  const page2Raw = await getPage2Keywords(50, 90);
  const page2 = page2Raw.filter((r) => !isRejected(r.keyword, rejections));
  console.log(`    ${page2.length} page-2 queries (positions 11-20)${page2Raw.length !== page2.length ? ` — ${page2Raw.length - page2.length} filtered` : ''}`);

  console.log('  Computing unmapped opportunities...');
  const index = loadKeywordIndex();
  // Unmapped = any low-CTR query above the impression floor that no
  // existing brief/post targets. These are net-new topic candidates.
  const unmapped = lowCTR
    .filter((r) => r.impressions >= UNMAPPED_MIN_IMPRESSIONS && !isMapped(r.keyword, index))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 25);
  console.log(`    ${unmapped.length} unmapped high-impression queries`);

  const dateStr = new Date().toISOString().slice(0, 10);

  // ── Markdown report ─────────────────────────────────────────────────────────
  const lines = [];
  lines.push(`# GSC Opportunity Report — ${dateStr}`);
  lines.push('');
  lines.push(`Last 90 days of Google Search Console data. The three sections below represent the cheapest wins available right now.`);
  lines.push('');

  lines.push(`## Low-CTR Queries (rewrite title/meta)`);
  lines.push(`Queries getting ≥${LOW_CTR_MIN_IMPRESSIONS} impressions but CTR ≤${LOW_CTR_MAX_CTR * 100}%.`);
  lines.push('');
  if (lowCTR.length === 0) {
    lines.push('_No low-CTR queries above threshold._');
  } else {
    lines.push('| Query | Impressions | Clicks | CTR | Position |');
    lines.push('|-------|-------------|--------|-----|----------|');
    for (const r of lowCTR.slice(0, 20)) {
      lines.push(`| ${r.keyword} | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(1)}% | ${r.position.toFixed(1)} |`);
    }
  }
  lines.push('');

  lines.push(`## Page-2 Queries (quick-win candidates)`);
  lines.push(`Positions 11–20. Feed these into the quick-win-targeter for rewrite + internal-link pushes.`);
  lines.push('');
  if (page2.length === 0) {
    lines.push('_No page-2 queries above threshold._');
  } else {
    lines.push('| Query | Impressions | Clicks | CTR | Position |');
    lines.push('|-------|-------------|--------|-----|----------|');
    for (const r of page2.slice(0, 20)) {
      lines.push(`| ${r.keyword} | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(1)}% | ${r.position.toFixed(1)} |`);
    }
  }
  lines.push('');

  lines.push(`## Unmapped Queries (new-topic candidates)`);
  lines.push(`Queries with ≥${UNMAPPED_MIN_IMPRESSIONS} impressions where no existing brief/post targets the keyword. Strategist input.`);
  lines.push('');
  if (unmapped.length === 0) {
    lines.push('_All high-impression queries are already targeted._');
  } else {
    lines.push('| Query | Impressions | Position |');
    lines.push('|-------|-------------|----------|');
    for (const r of unmapped) {
      lines.push(`| ${r.keyword} | ${r.impressions} | ${r.position.toFixed(1)} |`);
    }
  }
  lines.push('');

  writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), lines.join('\n'));
  console.log(`\n  Report saved: data/reports/gsc-opportunity/${dateStr}.md`);

  // ── Machine-readable latest ─────────────────────────────────────────────────
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    low_ctr: lowCTR.slice(0, 20),
    page_2: page2.slice(0, 20),
    unmapped,
  }, null, 2));

  await notify({
    subject: `GSC Opportunities: ${lowCTR.length} low-CTR, ${page2.length} page-2, ${unmapped.length} unmapped`,
    body: `Top low-CTR queries:\n${lowCTR.slice(0, 5).map((r) => `  ${r.keyword} — ${r.impressions} impr, ${(r.ctr * 100).toFixed(1)}% CTR`).join('\n')}\n\nTop unmapped queries:\n${unmapped.slice(0, 5).map((r) => `  ${r.keyword} — ${r.impressions} impr`).join('\n')}`,
    status: 'info',
    category: 'seo',
  }).catch(() => {});

  console.log('\nGSC opportunity report complete.');
}

main().catch((err) => {
  console.error('GSC opportunity agent failed:', err);
  process.exit(1);
});
