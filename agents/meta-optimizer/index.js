/**
 * Meta Description Optimizer Agent
 *
 * Uses Google Search Console to find pages with high impressions but low CTR,
 * then rewrites their title tags and meta descriptions to improve click-through rate.
 *
 * Strategy:
 *   1. Query GSC for pages with > 100 impressions and < 5% CTR (90 days)
 *   2. Fetch current title + meta description from Shopify for each page
 *   3. Claude rewrites them to be more compelling and keyword-specific
 *   4. Report shows before/after with estimated CTR improvement
 *   5. With --apply, pushes changes to Shopify
 *
 * Output: data/reports/meta-optimizer-report.md
 *
 * Usage:
 *   node agents/meta-optimizer/index.js               # dry run — show proposed changes
 *   node agents/meta-optimizer/index.js --apply        # write changes to Shopify
 *   node agents/meta-optimizer/index.js --min-impr 200 # higher impression threshold
 *   node agents/meta-optimizer/index.js --max-ctr 0.03 # stricter CTR threshold
 *   node agents/meta-optimizer/index.js --limit 20                # max pages to process
 *   node agents/meta-optimizer/index.js --refresh-stale-years     # scan all posts for stale years (dry run)
 *   node agents/meta-optimizer/index.js --refresh-stale-years --apply  # scan + push refreshed titles to Shopify
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import { getPostMeta, getMetaPath } from '../../lib/posts.js';
import * as gsc from '../../lib/gsc.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { refreshStaleYears } from './lib/refresh-stale-years.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'meta-optimizer');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const apply = args.includes('--apply');
const refreshStaleYearsMode = args.includes('--refresh-stale-years');
const minImpressions = parseFloat(getArg('--min-impr') ?? '100');
const maxCTR = parseFloat(getArg('--max-ctr') ?? '0.05');
const limitArg = parseInt(getArg('--limit') ?? '25', 10);

// ── article lookup ────────────────────────────────────────────────────────────

/**
 * Build a map of URL → Shopify article for all blog articles.
 */
async function buildArticleMap() {
  const blogs = await getBlogs();
  const map = new Map(); // canonical URL → article

  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) {
      const url = `${config.url}/blogs/${blog.handle}/${a.handle}`;
      map.set(url, { ...a, blogId: blog.id, blogHandle: blog.handle });
    }
  }

  return map;
}

// ── claude rewriter ───────────────────────────────────────────────────────────

async function rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr) {
  const ctrPct = (ctr * 100).toFixed(1);
  const avgPos = Math.round(position);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are an SEO copywriter for ${config.name} (${config.url}), a natural skincare and personal care brand.

This page currently ranks at position #${avgPos} for "${keyword}" with ${impressions.toLocaleString()} impressions but only ${ctrPct}% CTR. The goal is to write a more compelling title and meta description to increase clicks.

CURRENT TITLE: ${currentTitle}
CURRENT META DESCRIPTION: ${currentMeta || '(none)'}

TARGET KEYWORD: "${keyword}"
AVG POSITION: #${avgPos}
IMPRESSIONS (90 days): ${impressions.toLocaleString()}
CURRENT CTR: ${ctrPct}%

Write an improved title and meta description that:
- Includes the target keyword naturally near the start
- Is specific, benefit-driven, and creates curiosity or urgency
- Matches the search intent (someone researching "${keyword}")
- Title: 50–60 characters
- Meta description: 140–155 characters
- Sounds like ${config.name}'s voice: clean, expert, trustworthy, not salesy

Return ONLY a JSON object with this exact structure:
{
  "title": "...",
  "meta_description": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

// ── refresh stale years ───────────────────────────────────────────────────────

/**
 * Batch-refresh stale year references across all published blog articles.
 *
 * For each article:
 *   - Check article.title and article.summary_html for stale years (2020..currentYear-1)
 *   - If any stale years found and --apply is set, update Shopify (title + summary_html)
 *     and sync the local data/posts/<slug>/meta.json so the editor sees the refreshed state
 *   - Dry-run (no --apply) prints the proposed changes and writes a report
 *
 * Deterministic regex replacement — no LLM call. This is a safe, idempotent operation
 * that can run on a schedule.
 */
async function runRefreshStaleYears({ apply }) {
  console.log(`\nMeta Optimizer — refresh stale years${apply ? ' (APPLY)' : ' (dry run)'}\n`);

  const blogs = await getBlogs();
  const changes = [];
  let scanned = 0;

  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const article of articles) {
      scanned++;
      const titleResult = refreshStaleYears(article.title || '');
      const summaryResult = refreshStaleYears(article.summary_html || '');
      if (!titleResult.changed && !summaryResult.changed) continue;

      const record = {
        blogId: blog.id,
        articleId: article.id,
        handle: article.handle,
        titleBefore: article.title,
        titleAfter: titleResult.changed ? titleResult.text : article.title,
        summaryBefore: article.summary_html || '',
        summaryAfter: summaryResult.changed ? summaryResult.text : (article.summary_html || ''),
        titleChanged: titleResult.changed,
        summaryChanged: summaryResult.changed,
        applied: false,
      };

      console.log(`  ${article.handle}`);
      if (titleResult.changed) {
        console.log(`    title: "${record.titleBefore}" → "${record.titleAfter}"`);
      }
      if (summaryResult.changed) {
        console.log(`    meta:  "${record.summaryBefore.replace(/<[^>]+>/g, '').slice(0, 80)}…" → "${record.summaryAfter.replace(/<[^>]+>/g, '').slice(0, 80)}…"`);
      }

      if (apply) {
        try {
          const fields = {};
          if (titleResult.changed) fields.title = titleResult.text;
          if (summaryResult.changed) fields.summary_html = summaryResult.text;
          await updateArticle(blog.id, article.id, fields);
          record.applied = true;

          let localMetaWritten = false;
          if (titleResult.changed) {
            localMetaWritten = syncLocalMeta(article.handle, { title: record.titleAfter });
          }

          console.log(`    ✓ Updated on Shopify${localMetaWritten ? ' (+ local meta)' : ''}`);
        } catch (e) {
          console.error(`    ✗ Shopify update failed: ${e.message}`);
        }
      }

      changes.push(record);
    }
  }

  // Second pass: refresh stale years in LOCAL meta.json fields that aren't
  // backed by Shopify (target_keyword, title when it diverges from Shopify,
  // meta_description). These are editor-visible fields the LLM uses to
  // evaluate the post — stale years here trigger false-positive blockers.
  const { listAllSlugs } = await import('../../lib/posts.js');
  const localFieldsToRefresh = ['title', 'target_keyword', 'meta_description'];
  let localMetaChanges = 0;
  for (const slug of listAllSlugs()) {
    try {
      const meta = getPostMeta(slug);
      if (!meta) continue;
      let changed = false;
      const before = {};
      for (const field of localFieldsToRefresh) {
        if (typeof meta[field] !== 'string') continue;
        const { text, changed: fieldChanged } = refreshStaleYears(meta[field]);
        if (fieldChanged) {
          before[field] = meta[field];
          meta[field] = text;
          changed = true;
        }
      }
      if (!changed) continue;
      localMetaChanges++;
      console.log(`  [local meta] ${slug}`);
      for (const field of Object.keys(before)) {
        console.log(`    ${field}: "${before[field]}" → "${meta[field]}"`);
      }
      if (apply) {
        writeFileSync(getMetaPath(slug), JSON.stringify(meta, null, 2));
      }
    } catch { /* skip */ }
  }
  if (localMetaChanges > 0) {
    console.log(`\n  Local meta: ${localMetaChanges} post(s) had stale years in local fields${apply ? ' — updated' : ' (dry run)'}`);
  }

  // Write report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'stale-years-report.md');
  const reportLines = [
    `# Stale Year Refresh — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `**Scanned:** ${scanned} article(s)`,
    `**Changed:** ${changes.length} article(s)`,
    `**Applied:** ${apply ? changes.filter((c) => c.applied).length : 0}`,
    ``,
  ];
  for (const c of changes) {
    reportLines.push(`## ${c.handle}${c.applied ? ' ✓' : ''}`);
    if (c.titleChanged) {
      reportLines.push(`- **Title:** \`${c.titleBefore}\` → \`${c.titleAfter}\``);
    }
    if (c.summaryChanged) {
      reportLines.push(`- **Meta description changed** (stripped HTML preview):`);
      reportLines.push(`  - Before: ${c.summaryBefore.replace(/<[^>]+>/g, '').slice(0, 140)}`);
      reportLines.push(`  - After:  ${c.summaryAfter.replace(/<[^>]+>/g, '').slice(0, 140)}`);
    }
    reportLines.push('');
  }
  writeFileSync(reportPath, reportLines.join('\n'));
  console.log(`\n  Report: ${reportPath}`);

  console.log(`\nDone. Scanned ${scanned} article(s), ${changes.length} had stale years${apply ? `, ${changes.filter((c) => c.applied).length} updated on Shopify.` : '.'}`);

  if (apply && changes.filter((c) => c.applied).length > 0) {
    await notify({
      subject: `Meta Optimizer: refreshed ${changes.filter((c) => c.applied).length} stale year(s)`,
      body: `Scanned ${scanned} article(s); refreshed ${changes.filter((c) => c.applied).length} with stale year references.`,
      status: 'success',
    });
  }

  return changes;
}

/**
 * Update data/posts/<handle>/meta.json title field so the editor agent sees
 * the refreshed title on next run. Silent no-op if the post dir doesn't exist
 * (posts may have been created outside the local pipeline).
 */
function syncLocalMeta(handle, updates) {
  try {
    const metaPath = getMetaPath(handle);
    if (!existsSync(metaPath)) return false;
    const meta = getPostMeta(handle);
    if (!meta) return false;
    const updated = { ...meta, ...updates };
    writeFileSync(metaPath, JSON.stringify(updated, null, 2));
    return true;
  } catch (e) {
    console.warn(`    Warning: could not sync local meta for ${handle}: ${e.message}`);
    return false;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (refreshStaleYearsMode) {
    await runRefreshStaleYears({ apply });
    return;
  }

  console.log(`\nMeta Optimizer — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will update Shopify)' : 'DRY RUN (use --apply to write changes)'}`);
  console.log(`Criteria: impressions > ${minImpressions}, CTR < ${(maxCTR * 100).toFixed(0)}%, limit ${limitArg}\n`);

  // Prefer the pre-filtered gsc-opportunity report (respects rejection list,
  // same source of truth as the dashboard and unmapped-query-promoter). Fall
  // back to a fresh GSC query if the file is missing or stale.
  // See docs/signal-manifest.md — closes the gap where meta-optimizer made
  // its own raw GSC call and bypassed the rejection list.
  let lowCtrPages = [];
  const oppPath = join(ROOT, 'data', 'reports', 'gsc-opportunity', 'latest.json');
  if (existsSync(oppPath)) {
    try {
      const opp = JSON.parse(readFileSync(oppPath, 'utf8'));
      lowCtrPages = (opp.low_ctr || []).filter((r) => r.impressions >= minImpressions && r.ctr <= maxCTR);
      console.log(`  Using gsc-opportunity/latest.json — ${lowCtrPages.length} low-CTR queries (already rejection-filtered)`);
    } catch { /* fall through to live query */ }
  }
  if (lowCtrPages.length === 0) {
    process.stdout.write('  Querying GSC for low-CTR pages... ');
    lowCtrPages = await gsc.getLowCTRKeywords(minImpressions, maxCTR, limitArg * 2, 90);
    console.log(`${lowCtrPages.length} pages found`);
  }

  if (lowCtrPages.length === 0) {
    console.log('  No low-CTR pages found with current thresholds. Try --min-impr 50 or --max-ctr 0.10');
    process.exit(0);
  }

  // Build article map for Shopify lookup
  process.stdout.write('  Fetching Shopify articles... ');
  const articleMap = await buildArticleMap();
  console.log(`${articleMap.size} articles indexed`);

  // Also get page-level GSC data to map keywords to URLs
  process.stdout.write('  Fetching page performance data from GSC... ');
  const quickWinPages = await gsc.getQuickWinPages(200, 90);
  const topPages = await gsc.getTopPages(200, 90);
  console.log('done');

  // Build keyword → page URL map from GSC
  const kwToPage = new Map();
  for (const p of quickWinPages) {
    if (!kwToPage.has(p.keyword)) kwToPage.set(p.keyword, p.url);
  }

  const results = [];
  let processed = 0;

  for (const item of lowCtrPages) {
    if (processed >= limitArg) break;

    const { keyword, impressions, ctr, position } = item;
    const pageUrl = kwToPage.get(keyword);

    if (!pageUrl) continue; // can't map keyword to a URL
    if (!pageUrl.includes('/blogs/')) continue; // only blog posts for now

    // Find the Shopify article for this URL
    const article = articleMap.get(pageUrl);
    if (!article) continue;

    // Winner protection
    try {
      const lockMeta = JSON.parse(readFileSync(join(ROOT, 'data', 'posts', `${article.handle}.json`), 'utf8'));
      if (lockMeta.legacy_locked) {
        console.log(`  [skip] "${keyword}": legacy winner (locked)`);
        continue;
      }
    } catch { /* proceed */ }

    const currentTitle = article.title || '';
    const currentMeta = article.summary_html?.replace(/<[^>]+>/g, '').trim() || '';

    process.stdout.write(`  [${processed + 1}] "${keyword}" (#${Math.round(position)}, ${(ctr * 100).toFixed(1)}% CTR)... `);

    try {
      const proposed = await rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr);
      console.log('done');

      const result = {
        keyword,
        pageUrl,
        article,
        impressions,
        ctr,
        position,
        currentTitle,
        currentMeta,
        proposedTitle: proposed.title,
        proposedMeta: proposed.meta_description,
        applied: false,
      };

      // Apply to Shopify if requested
      if (apply) {
        try {
          await updateArticle(article.blogId, article.id, {
            title: proposed.title,
            summary_html: proposed.meta_description,
          });
          result.applied = true;
          console.log(`    ✓ Updated in Shopify`);
        } catch (e) {
          console.error(`    ✗ Shopify update failed: ${e.message}`);
        }
      }

      results.push(result);
      processed++;
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  // ── Save A/B test baseline (when applied) ─────────────────────────────────

  if (apply) {
    const abTrackerPath = join(ROOT, 'data', 'reports', 'meta-ab', 'meta-ab-tracker.json');
    let tracker = [];
    if (existsSync(abTrackerPath)) {
      try { tracker = JSON.parse(readFileSync(abTrackerPath, 'utf8')); } catch {}
    }
    const testedAt = new Date().toISOString().slice(0, 10);
    for (const r of results.filter((r) => r.applied)) {
      // Replace existing entry for this URL if present
      tracker = tracker.filter((e) => e.pageUrl !== r.pageUrl);
      tracker.push({
        keyword: r.keyword,
        pageUrl: r.pageUrl,
        originalTitle: r.currentTitle,
        proposedTitle: r.proposedTitle,
        originalMeta: r.currentMeta,
        proposedMeta: r.proposedMeta,
        baselineCtr: r.ctr,
        baselineImpressions: r.impressions,
        baselinePosition: r.position,
        testedAt,
      });
    }
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(abTrackerPath, JSON.stringify(tracker, null, 2));
    console.log(`\n  A/B baseline saved: ${abTrackerPath} (${results.filter((r) => r.applied).length} entries)`);
  }

  // ── Build report ──────────────────────────────────────────────────────────

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];

  lines.push(`# Meta Description Optimizer Report — ${config.name}`);
  lines.push(`**Run date:** ${now}`);
  lines.push(`**Mode:** ${apply ? 'Applied' : 'Dry run'}`);
  lines.push(`**Criteria:** ${minImpressions}+ impressions, < ${(maxCTR * 100).toFixed(0)}% CTR (90 days)`);
  lines.push(`**Pages optimized:** ${results.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (results.length === 0) {
    lines.push('No optimizable pages found matching the criteria.');
  } else {
    lines.push('## Proposed Changes\n');

    for (const r of results) {
      const status = apply ? (r.applied ? '✅ Applied' : '⚠️ Failed') : '💡 Proposed';
      lines.push(`### ${status} — "${r.keyword}"`);
      lines.push(`**URL:** [${r.pageUrl}](${r.pageUrl})`);
      lines.push(`**GSC:** #${Math.round(r.position)} position | ${r.impressions.toLocaleString()} impressions | ${(r.ctr * 100).toFixed(1)}% CTR`);
      lines.push('');
      lines.push('| | Before | After |');
      lines.push('|---|---|---|');
      lines.push(`| **Title** | ${r.currentTitle} | ${r.proposedTitle} |`);
      lines.push(`| **Meta** | ${r.currentMeta || '*(none)*'} | ${r.proposedMeta} |`);
      lines.push('');
    }

    if (!apply) {
      lines.push('---\n');
      lines.push('## To Apply These Changes\n');
      lines.push('```bash');
      lines.push('node agents/meta-optimizer/index.js --apply');
      lines.push('```\n');
    }
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'meta-optimizer-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  console.log(`\n  Report saved: ${reportPath}`);
  console.log(`  Pages ${apply ? 'updated' : 'analyzed'}: ${results.length}`);
  if (!apply && results.length > 0) {
    console.log(`  Run with --apply to push changes to Shopify`);
  }
}

main()
  .then(() => notifyLatestReport('Meta Optimizer completed', join(ROOT, 'data', 'reports', 'meta-optimizer')))
  .catch((err) => {
    notify({ subject: 'Meta Optimizer failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
