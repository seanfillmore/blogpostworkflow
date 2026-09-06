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
 *   4. HEALTH-CLAIM GATE (lib/seo-copy-health-gate.js + lib/gate.js) — a rewrite
 *      that makes a claim a cosmetic may not make is regenerated ONCE with the
 *      offending words named, and skipped only if the retry trips too. Every
 *      skip is counted, named and carried into the digest body.
 *   5. Report shows before/after with estimated CTR improvement
 *   6. With --apply, pushes changes to Shopify
 *
 * Output: data/reports/meta-optimizer-report.md
 *
 * Usage:
 *   node agents/meta-optimizer/index.js               # dry run — show proposed changes
 *   node agents/meta-optimizer/index.js --apply        # write changes to Shopify
 *   node agents/meta-optimizer/index.js --min-impr 200 # higher impression threshold
 *   node agents/meta-optimizer/index.js --max-ctr 0.03 # stricter CTR threshold
 *   node agents/meta-optimizer/index.js --limit 20                # max pages to process
 *   node agents/meta-optimizer/index.js --include-held            # also rewrite $0-cluster queries
 *                                                                 # (held by lib/cluster-hold.js; the
 *                                                                 #  hold is applied BEFORE --limit)
 *   node agents/meta-optimizer/index.js --refresh-stale-years     # scan all posts for stale years (dry run)
 *   node agents/meta-optimizer/index.js --refresh-stale-years --apply  # scan + push refreshed titles to Shopify
 */

import Anthropic from '../../lib/anthropic.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import { getPostMeta, getMetaPath, replacePostMeta } from '../../lib/posts.js';
import { mayTestMetadata } from '../../lib/post-lock.js';
import { upsertTrackerEntry, buildTrackerEntry } from './lib/ab-tracker.js';
import * as gsc from '../../lib/gsc.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { refreshStaleYears } from './lib/refresh-stale-years.js';
import { loadIndex, lookupByKeyword, clusterMatesFor } from '../../lib/keyword-index/consumer.js';
import { sortByValidation } from './lib/sort.js';
import { assessDistinctness } from '../../lib/ctr-copy-distinctness.js';
import { holdMetaCandidates, excludeHoldout, prioritiseTreatment } from './lib/hold.js';
import {
  rankClusters, renderEfficiencyLines, efficiencyBanner,
} from '../../lib/cluster-efficiency.js';
import {
  loadClusterHold, holdBanner, renderHoldLines, renderDisagreementLines,
  holdSummaryFragment, HOLD_FLAG,
} from '../../lib/cluster-hold.js';
import { buildPromptGrounding } from './lib/grounding.js';
import { gateProposedCopy } from './lib/gate.js';
import {
  SEO_COPY_COMPLIANCE_RULE, renderGateSkipLines, gateSkipSummaryFragment,
} from '../../lib/seo-copy-health-gate.js';
import { SEO_COPY_LENGTH_RULE } from '../../lib/seo-copy-length.js';

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
const INCLUDE_HELD = args.includes(HOLD_FLAG);
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

/**
 * `constraint` is appended verbatim when a previous attempt tripped the
 * health-claim gate (see lib/gate.js). It is empty on the first attempt — the
 * standing SEO_COPY_COMPLIANCE_RULE is in the prompt either way, because
 * preventing the claim is cheaper than detecting it and retrying.
 */
async function rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr, ground, constraint = '') {
  const ctrPct = (ctr * 100).toFixed(1);
  const avgPos = Math.round(position);

  const groundingLines = [];
  if (ground?.validationTag === 'amazon') {
    const conv = ground.conversionShare != null
      ? ` (Amazon conversion share: ${(ground.conversionShare * 100).toFixed(1)}%)`
      : '';
    groundingLines.push(`This query is Amazon-validated — verified commercial demand${conv}.`);
  } else if (ground?.validationTag === 'gsc_ga4') {
    groundingLines.push(`This query has GSC + GA4 conversion signal — proven to convert on this site.`);
  }
  if (ground?.clusterMateKeywords?.length) {
    groundingLines.push(`Cluster-mate queries this page should also surface for: ${ground.clusterMateKeywords.join(', ')}.`);
  }
  const groundingBlock = groundingLines.length ? `\n${groundingLines.join('\n')}\n` : '';

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
${groundingBlock}
Write an improved title and meta description that:
- Includes the target keyword naturally near the start
- Is specific, benefit-driven, and creates curiosity or urgency
- Matches the search intent (someone researching "${keyword}")
- Title and meta description: see the LENGTH LIMITS below — they are hard.
- Sounds like ${config.name}'s voice: clean, expert, trustworthy, not salesy

${SEO_COPY_COMPLIANCE_RULE}

${SEO_COPY_LENGTH_RULE}
${constraint ? `\n${constraint}\n` : ''}
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
        replacePostMeta(slug, meta);
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
    replacePostMeta(metaPath, updated);
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

  const sortedCandidates = sortByValidation(lowCtrPages);
  const idx = loadIndex(ROOT);
  if (idx) {
    const amazonCount = sortedCandidates.filter((r) => r.validation_source === 'amazon').length;
    console.log(`  ${amazonCount} of ${sortedCandidates.length} candidates are Amazon-validated`);
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

  // ── $0-cluster hold, applied to the pick list BEFORE the --limit cap ───────
  // The cap is the whole reason this has to happen here. The weekly cron is
  // `--apply --limit 5`, spent in sortByValidation order, and on the real
  // 2026-08-23 pool four of those five slots fell in the held cluster while the
  // biggest CTR opportunity on the site ranked SIXTH and was never reached at
  // all (it moves to second once the held queries step aside). Holding after the cap would
  // "skip" them and still let them eat the budget — the bug this rule exists to
  // prevent, wearing different clothes. A missing or stale seo-impact report
  // holds nothing (lib/seo-impact-freshness.js); the banner says which.
  const hold = loadClusterHold({ root: ROOT });
  const banner = holdBanner(hold);
  if (banner) console.log(`${banner}\n`);

  // ── efficiency ranking, applied in the same place and BEFORE the same cap ──
  // The hold now fires almost never (every category RSC sells, sells), but the
  // cap is still spent in sortByValidation order, which is blind to what a
  // cluster earns. Ranking DEMOTES the inefficient ones rather than blocking
  // them, and reserves the last in-cap slot so the bottom cluster is never
  // starved to zero. No ranking (missing/stale report, or one with no product
  // revenue) leaves the order exactly as sortByValidation built it.
  const ranking = rankClusters(hold);
  const rankBanner = efficiencyBanner(ranking);
  if (rankBanner) console.log(`${rankBanner}\n`);

  // ── CTR-program holdout, applied to the pick list BEFORE the cap ───────────
  // Same placement and same reasoning as the $0-cluster hold below it: a
  // holdout page filtered after the cap has already eaten a slot. But the
  // consequence of missing it is worse than a wasted slot — rewriting one
  // holdout page removes the control for the whole wave, and there is no way to
  // reconstruct it afterwards. Fails open when no wave has been planned.
  const { kept: notHeldOut, excluded: holdoutExcluded } = excludeHoldout(sortedCandidates, {
    root: ROOT,
    pageForKeyword: (kw) => kwToPage.get(kw) || null,
  });
  if (holdoutExcluded.length) {
    console.log(`  CTR-program holdout: ${holdoutExcluded.length} candidate(s) withheld as controls`);
    for (const e of holdoutExcluded.slice(0, 10)) console.log(`    · "${e.keyword}" → ${e.url}`);
    console.log('');
  }

  // ── CTR-program TREATMENT arm, applied BEFORE the cap and before the ──────
  // cluster-efficiency sort. The wave's treatment arm is what the experiment
  // exists to rewrite, and until 2026-09-05 nothing read it: measured against
  // the 2026-08-31 wave, ONE of its ten treatment pages was treated, and only
  // one was even selectable, because candidates are QUERIES from
  // gsc-opportunity while the wave designates PAGES. An untreated arm makes the
  // difference-in-differences report "no effect" whatever the rewrites did.
  //
  // This is not a bypass of the efficiency ordering below: agents/ctr-program
  // built the arm with lib/ctr-opportunity.js, which already ranks by
  // recoverable clicks x what the cluster earns using the same ordinals.
  // Sorting it by cluster a second time is what displaced it out of the cap.
  const { ordered: waveOrdered, designated } = prioritiseTreatment(notHeldOut, {
    root: ROOT,
    pageForKeyword: (kw) => kwToPage.get(kw) || null,
    pool: quickWinPages,
  });
  if (designated.length) {
    const synth = designated.filter((d) => d.synthesised).length;
    console.log(`  CTR-program wave: ${designated.length} candidate(s) prioritised as designated work`
      + (synth ? ` (${synth} synthesised — the page is in the wave but no candidate query reached it)` : ''));
    for (const d of designated.slice(0, 10)) {
      console.log(`    · [${d.arm}] "${d.keyword}" → ${String(d.url || '').split('/').pop()}${d.synthesised ? '  (synthesised)' : ''}`);
    }
    console.log('');
  }

  const { kept: eligibleCandidates, held, efficiency } = holdMetaCandidates(waveOrdered, hold, {
    includeHeld: INCLUDE_HELD,
    pageForKeyword: (kw) => kwToPage.get(kw) || null,
    ranking,
    limit: limitArg,
  });
  for (const line of renderHoldLines(held)) console.log(`  ${line}`);
  if (held.length) console.log('');
  const rankLines = renderEfficiencyLines(ranking, efficiency);
  for (const line of rankLines) console.log(`  ${line}`);
  if (rankLines.length) console.log('');

  const results = [];
  const gateSkipped = [];
  let processed = 0;

  // ── A/B tracker, loaded up front and written after EVERY applied change ────
  // It used to be written once, after the whole loop. A crash or a failed later
  // step therefore left Shopify already mutated with no baseline recorded — and
  // an unrecorded mutation is one meta-ab-checker will never evaluate and never
  // revert. That is tolerable on an ordinary page and not tolerable on a locked
  // winner, whose whole safety case is auto-revert, so the write moved inside.
  // NOTE the directory: the tracker lives under data/reports/meta-ab/, which is
  // where agents/meta-ab-checker reads it from — NOT this agent's own
  // REPORTS_DIR. The old code mkdir'd REPORTS_DIR and then wrote here, which
  // worked only because something else had already created meta-ab/.
  const abTrackerDir = join(ROOT, 'data', 'reports', 'meta-ab');
  const abTrackerPath = join(abTrackerDir, 'meta-ab-tracker.json');
  let tracker = [];
  if (existsSync(abTrackerPath)) {
    try { tracker = JSON.parse(readFileSync(abTrackerPath, 'utf8')); } catch {}
  }
  const testedAt = new Date().toISOString().slice(0, 10);
  let trackerWrites = 0;

  for (const item of eligibleCandidates) {
    if (processed >= limitArg) break;

    const { keyword, impressions, ctr, position } = item;
    // A SYNTHESISED wave candidate carries its own target page and that must
    // win. `kwToPage` is first-wins over the GSC quick-win rows, so a query can
    // resolve to a DIFFERENT page than the one the synthesiser meant: measured
    // 2026-09-05, the query "sls free toothpaste" resolves to
    // toothpaste-without-sls-what-to-know-best-options while the wave wanted it
    // as the entry point for best-toothpaste-without-sls-2025. Trusting the map
    // there would rewrite the wrong page — and one already being treated.
    const pageUrl = item.url || kwToPage.get(keyword);

    if (!pageUrl) continue; // can't map keyword to a URL
    if (!pageUrl.includes('/blogs/')) continue; // only blog posts for now

    // Find the Shopify article for this URL
    const article = articleMap.get(pageUrl);
    if (!article) continue;

    // Winner protection — deliberately does NOT block here. `legacy_locked`
    // guards the BODY; a title/meta rewrite leaves the body untouched, is two
    // reversible fields, and is auto-reverted by meta-ab-checker if CTR
    // regresses. Blocking it meant a winner could never have its CTR improved,
    // which is the main lever a winner has left. See lib/post-lock.js.
    //
    // (This block used to read a FLAT data/posts/<handle>.json, a path that has
    // never existed in this layout, so it threw on every post and the guard was
    // inert. The lock is real now — it is just pointed at body rewrites.)
    const metaLock = mayTestMetadata(pageUrl);
    if (metaLock.state === 'locked') {
      console.log(`  [winner] "${keyword}": ${metaLock.slug} is a locked winner — metadata test allowed, body untouched`);
    }

    const currentTitle = article.title || '';
    const currentMeta = article.summary_html?.replace(/<[^>]+>/g, '').trim() || '';

    const indexEntry = lookupByKeyword(idx, keyword);
    const ground = buildPromptGrounding(indexEntry, clusterMatesFor(idx, indexEntry, { limit: 6 }));

    const tagPrefix = ground?.validationTag === 'amazon' ? '★ ' : ground?.validationTag === 'gsc_ga4' ? '✓ ' : '';
    process.stdout.write(`  [${processed + 1}] ${tagPrefix}"${keyword}" (#${Math.round(position)}, ${(ctr * 100).toFixed(1)}% CTR)... `);

    try {
      // ── health-claim gate ───────────────────────────────────────────────
      // This agent writes live page titles and meta descriptions — the SERP
      // snippet a cosmetic brand shows next to its own name — and until
      // 2026-08-23 it had no claims gate at all. On 2026-08-22 it published
      // "Best Soap for Tattoos: Clean Ingredients That Heal" with a matching
      // meta. See lib/seo-copy-health-gate.js for why the ad-copy gate is not
      // reused wholesale here (its toxicity vocabulary IS this site's editorial
      // position and would remove those pages from CTR work permanently).
      //
      // A blocked first attempt is regenerated ONCE with the offending words
      // named. Only a second failure skips the candidate — visibly.
      const gated = await gateProposedCopy((constraint) =>
        rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr, ground, constraint));

      if (!gated.ok) {
        console.log('gated');
        const words = [...new Set(gated.violations.map((v) => `${v.field}: "${v.match}"`))].join(', ');
        console.log(`    ⊘ health-claim gate: ${words} — skipped after ${gated.attempts} attempt(s), page unchanged`);
        gateSkipped.push({
          keyword, pageUrl, violations: gated.violations, attempts: gated.attempts,
          rejectedTitle: gated.rejected?.title || '', rejectedMeta: gated.rejected?.meta_description || '',
        });
        // NOT counted against `processed`: the limit is a budget for pages
        // optimised, and a gated page was not optimised. Counting it would let
        // a run of bad luck silently spend the whole weekly cap on nothing.
        //
        // But it needs its OWN bound, or "doesn't count" becomes unbounded: a
        // pool where everything trips would walk the entire candidate list at
        // two model calls each. Capped at the same number, so worst-case spend
        // is 2× the intended run and never a function of pool size.
        if (gateSkipped.length >= limitArg) {
          console.log(`  Health-claim gate: ${gateSkipped.length} skips — at the skip budget, stopping.`);
          break;
        }
        continue;
      }

      // ── distinctness gate ───────────────────────────────────────────────
      // The health gate asks whether the copy is ALLOWED. This asks whether it
      // is a CHANGE. On 2026-08-24 this agent rewrote "Best Soap for Tattoos:
      // Clean, Gentle, Fragrance-Free" to "Best Soap for Tattoos: Gentle, Clean
      // & Fragrance-Free" — the same three adjectives reordered — and spent a
      // live Shopify mutation, an A/B tracker slot and 28 days of the store's
      // only measurement capacity on it. Across the eight most recent rewrites
      // not one introduced a number, a year, a count or any new concrete
      // specific. Measurement fixes are worthless against a treatment that does
      // not treat anything: no instrument reads a synonym shuffle.
      //
      // One retry, naming what is missing, exactly as the health gate does and
      // for the same reason — dropping the candidate on the first miss deletes
      // CTR work silently, and an unbounded loop is how an unattended run burns
      // a budget on one page.
      let proposed = gated.proposed;
      let distinct = assessDistinctness({
        originalTitle: currentTitle,
        proposedTitle: proposed.title,
        originalMeta: currentMeta,
        proposedMeta: proposed.meta_description,
      });
      let distinctAttempts = 1;

      if (!distinct.ok) {
        const constraint = `The previous attempt was rejected as a cosmetic rewrite: ${distinct.reasons.join('; ')}. `
          + `Produce a materially DIFFERENT title, not a reordering or a synonym swap. It must introduce at least one `
          + `concrete new element the current title lacks — a count ("7 Picks"), a year, a bracketed qualifier, a named `
          + `audience ("for Sensitive Skin"), a timeframe, or an explicit exclusion ("Without SLS"). Keep the target `
          + `keyword intact and keep it under 60 characters.`;
        const retry = await gateProposedCopy((c) =>
          rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr, ground,
            [constraint, c].filter(Boolean).join(' ')));
        distinctAttempts = 2;
        if (retry.ok) {
          const retryDistinct = assessDistinctness({
            originalTitle: currentTitle,
            proposedTitle: retry.proposed.title,
            originalMeta: currentMeta,
            proposedMeta: retry.proposed.meta_description,
          });
          if (retryDistinct.ok) {
            proposed = retry.proposed;
            distinct = retryDistinct;
          }
        }
      }

      if (!distinct.ok) {
        console.log('not distinct');
        console.log(`    ⊘ distinctness gate: ${distinct.reasons.join('; ')} — skipped after ${distinctAttempts} attempt(s), page unchanged`);
        // Counted against the same skip budget as the health gate, for the same
        // reason: "doesn't count against the limit" must still be bounded.
        gateSkipped.push({
          keyword, pageUrl, violations: [], attempts: distinctAttempts,
          distinctness: distinct.reasons,
          rejectedTitle: proposed.title || '', rejectedMeta: proposed.meta_description || '',
        });
        if (gateSkipped.length >= limitArg) {
          console.log(`  Gate skips: ${gateSkipped.length} — at the skip budget, stopping.`);
          break;
        }
        continue;
      }

      console.log(gated.attempts > 1 ? 'done (regenerated once — health-claim gate)' : 'done');
      if (distinctAttempts > 1) console.log('    · regenerated once — distinctness gate');
      if (distinct.advisory.length) {
        console.log(`    · distinctness advisory: ${distinct.advisory.join('; ')}`);
      }
      if (gated.advisory.length) {
        const words = [...new Set(gated.advisory.map((v) => `${v.field}: "${v.match}"`))].join(', ');
        console.log(`    · advisory (not blocked): ${words}`);
      }

      const result = {
        gateAttempts: gated.attempts,
        gateAdvisory: gated.advisory,
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
        validation_source: ground?.validationTag ?? null,
      };

      // Apply to Shopify if requested
      if (apply) {
        // Capture the baseline on the SAME basis meta-ab-checker will measure
        // (page-level, 28 days) and BEFORE the mutation, or the "before" number
        // is already contaminated by the change. Best-effort: a failure here
        // leaves the checker on the legacy keyword-level baseline rather than
        // blocking the run.
        let pageCtr = null; let pagePosition = null; let pageImpressions = null;
        try {
          const perf = await gsc.getPagePerformance(pageUrl, 28);
          pageCtr = perf?.ctr ?? null;
          pagePosition = perf?.position ?? null;
          pageImpressions = perf?.impressions ?? null;
        } catch (e) {
          console.warn(`    ! baseline page CTR unavailable (${e.message}) — falling back to keyword CTR`);
        }

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

        // Persist the baseline immediately — see the note where `tracker` is
        // loaded. mayTestMetadata().requiresAbTracking is true for a locked
        // winner (and when the lock could not be read); a failure to record it
        // there is loud, because auto-revert is the reason the change was
        // permitted at all.
        if (result.applied) {
          tracker = upsertTrackerEntry(tracker, buildTrackerEntry(result, testedAt, {
            pageCtr,
            pagePosition,
            pageImpressions,
            locked: metaLock.state === 'locked',
          }));
          try {
            mkdirSync(abTrackerDir, { recursive: true });
            writeFileSync(abTrackerPath, JSON.stringify(tracker, null, 2));
            trackerWrites++;
          } catch (e) {
            const msg = `A/B baseline NOT recorded for ${pageUrl}: ${e.message}`;
            if (metaLock.requiresAbTracking) {
              console.error(`    ✗ ${msg} — this change on a protected page will never be auto-reverted`);
              notify({
                subject: 'Meta Optimizer: unrecorded change on a locked winner',
                body: msg,
                status: 'error',
                immediate: true,
              });
            } else {
              console.error(`    ✗ ${msg}`);
            }
          }
        }
      }

      results.push(result);
      processed++;
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  if (apply) {
    const appliedCount = results.filter((r) => r.applied).length;
    console.log(`\n  A/B baselines saved: ${abTrackerPath} (${trackerWrites}/${appliedCount} applied changes recorded)`);
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

  // The digest body IS this report (notifyLatestReport → notifyWithReport), so
  // the hold and any attribution disagreement have to be here or they reach
  // nobody — this agent runs unattended from cron and its stdout is read by no
  // one. Both blocks vanish entirely on a clean run.
  const holdLines = [...renderHoldLines(held), ...rankLines, ...renderDisagreementLines(hold)];
  if (holdLines.length) {
    lines.push('## Cluster hold');
    lines.push('');
    for (const l of holdLines) lines.push(`- ${l.trim()}`);
    lines.push('');
  }

  // Same reasoning as the hold block above: the digest body IS this report, so a
  // skip that is not written here reaches nobody. A skip is the gate working, so
  // it renders as a normal section on the deferred success path — never
  // `immediate: true`, never `status: 'error'`. It vanishes on a clean run.
  const skipLines = renderGateSkipLines(gateSkipped);
  if (skipLines.length) {
    lines.push('## Health-claim gate — skipped');
    lines.push('');
    for (const l of skipLines) lines.push(`- ${l.trim()}`);
    lines.push('');
    lines.push('The rejected copy, for review:');
    lines.push('');
    for (const s of gateSkipped) {
      lines.push(`- **${s.keyword}** — title: \`${s.rejectedTitle}\` · meta: \`${s.rejectedMeta}\``);
    }
    lines.push('');
  }

  // Advisory: reported, never blocking. See lib/seo-copy-health-gate.js — this is
  // the ingredient-avoidance vocabulary that is this brand's editorial position,
  // not a claim that the product treats anything.
  const advisoryResults = results.filter((r) => r.gateAdvisory?.length);
  if (advisoryResults.length) {
    lines.push('## Health-claim gate — advisory (published, not blocked)');
    lines.push('');
    for (const r of advisoryResults) {
      const words = [...new Set(r.gateAdvisory.map((v) => `${v.field}: "${v.match}"`))].join(', ');
      lines.push(`- **${r.keyword}** — ${words}`);
    }
    lines.push('');
  }

  const regenerated = results.filter((r) => r.gateAttempts > 1).length;
  if (regenerated) {
    lines.push(`_${regenerated} rewrite(s) tripped the health-claim gate on the first attempt and were regenerated once, successfully._`);
    lines.push('');
  }

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
  if (gateSkipped.length) {
    console.log(`  Health-claim gate: ${gateSkipped.length} candidate(s) skipped (page unchanged)`);
  }
  if (!apply && results.length > 0) {
    console.log(`  Run with --apply to push changes to Shopify`);
  }

  // Returned so the caller can put the held count in the notify subject. A hold
  // is the policy working, so it stays on the normal deferred success path —
  // never `immediate: true`, never `status: 'error'`.
  return { held, gateSkipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((outcome) => notifyLatestReport(
      `Meta Optimizer completed${holdSummaryFragment(outcome?.held || [])}` +
        gateSkipSummaryFragment(outcome?.gateSkipped || []),
      join(ROOT, 'data', 'reports', 'meta-optimizer'),
    ))
    .catch((err) => {
      notify({ subject: 'Meta Optimizer failed', body: err.message || String(err), status: 'error' });
      console.error('Error:', err.message);
      process.exit(1);
    });
}
