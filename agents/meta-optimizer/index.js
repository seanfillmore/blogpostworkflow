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
 *   node agents/meta-optimizer/index.js --limit 20     # max pages to process
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';

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

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nMeta Optimizer — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will update Shopify)' : 'DRY RUN (use --apply to write changes)'}`);
  console.log(`Criteria: impressions > ${minImpressions}, CTR < ${(maxCTR * 100).toFixed(0)}%, limit ${limitArg}\n`);

  // Fetch low-CTR pages from GSC
  process.stdout.write('  Querying GSC for low-CTR pages... ');
  const lowCtrPages = await gsc.getLowCTRKeywords(minImpressions, maxCTR, limitArg * 2, 90);
  console.log(`${lowCtrPages.length} pages found`);

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
