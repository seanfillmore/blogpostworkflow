/**
 * Cannibalization Resolver Agent
 *
 * Detects keyword cannibalization between blog posts using live GSC data,
 * then automatically resolves HIGH-confidence cases without human bottleneck.
 *
 * Detection:
 *   Only flags blog-vs-blog cannibalization (the only type we can fully automate).
 *   Homepage/collection/product appearances for the same query are normal and ignored.
 *
 * Resolution actions (applied automatically for HIGH confidence):
 *   REDIRECT    — loser 301-redirected to winner immediately. Use when content is
 *                 near-duplicate and the loser adds no unique value.
 *   CONSOLIDATE — Claude fetches both articles, merges the best content into winner
 *                 (saved as draft for review), then creates the redirect. Use when
 *                 loser has sections worth preserving.
 *   MONITOR     — No action. Logged for next review cycle. Use when pages serve
 *                 genuinely different sub-intents.
 *
 * Safety:
 *   - Dry run by default. No changes without --apply.
 *   - Only acts on HIGH-confidence decisions.
 *   - Only touches /blogs/news/ URLs — never products, collections, or pages.
 *   - Consolidated posts saved as Shopify drafts (not auto-published).
 *   - Redirect is created immediately on consolidation so link equity is preserved
 *     even before the merged draft is reviewed and published.
 *   - All decisions persisted to cannibalization-decisions.json for audit trail.
 *
 * Usage:
 *   node agents/cannibalization-resolver/index.js              # dry run
 *   node agents/cannibalization-resolver/index.js --apply      # resolve HIGH-confidence cases
 *   node agents/cannibalization-resolver/index.js --days 28    # shorter GSC window
 *   node agents/cannibalization-resolver/index.js --min-impr 30
 *
 * Output:
 *   data/reports/cannibalization-report.md
 *   data/reports/cannibalization-decisions.json
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getAllQueryPageRows } from '../../lib/gsc.js';
import {
import { notify, notifyLatestReport } from '../../lib/notify.js';
  getBlogs, getArticles, updateArticle,
  getRedirects, createRedirect,
} from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'cannibalization');

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

function stripCodeFences(text) {
  return text.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; }

const apply = args.includes('--apply');
const days = parseInt(getArg('--days') || '90', 10);
const minImpr = parseInt(getArg('--min-impr') || '50', 10);

// ── URL helpers ───────────────────────────────────────────────────────────────

function urlPath(fullUrl) {
  try { return new URL(fullUrl).pathname; } catch { return fullUrl; }
}

function isBlogPost(url) {
  return urlPath(url).startsWith('/blogs/');
}

function slugFromPath(path) {
  return path.split('/').pop();
}

// ── blog article index ────────────────────────────────────────────────────────

async function buildArticleIndex() {
  const blogs = await getBlogs();
  const byHandle = new Map(); // handle → { blogId, articleId, title, body_html }

  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) {
      byHandle.set(a.handle, { blogId: blog.id, articleId: a.id, handle: a.handle, title: a.title, body_html: a.body_html || '' });
    }
  }
  return byHandle;
}

// ── cannibalization detection (blog-only) ─────────────────────────────────────

function detectCannibalization(queryPageRows) {
  const byQuery = new Map();

  for (const row of queryPageRows) {
    if (!isBlogPost(row.page)) continue; // only care about blog posts
    if (!byQuery.has(row.query)) byQuery.set(row.query, []);
    byQuery.get(row.query).push(row);
  }

  return [...byQuery.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => {
      const sorted = [...pages].sort((a, b) => b.impressions - a.impressions);
      return {
        query,
        totalImpressions: pages.reduce((s, p) => s + p.impressions, 0),
        totalClicks: pages.reduce((s, p) => s + p.clicks, 0),
        pages: sorted.map((p) => ({
          url: p.page,
          path: urlPath(p.page),
          handle: slugFromPath(urlPath(p.page)),
          impressions: p.impressions,
          clicks: p.clicks,
          position: Math.round(p.position * 10) / 10,
          ctr: Math.round(p.ctr * 1000) / 10,
        })),
      };
    })
    .filter((g) => g.totalImpressions >= minImpr)
    .sort((a, b) => b.totalImpressions - a.totalImpressions);
}

// ── claude: triage decisions ──────────────────────────────────────────────────

async function triageWithClaude(groups) {
  const top = groups.slice(0, 20);

  const groupText = top.map((g, i) => {
    const pageLines = g.pages.map((p) =>
      `    - ${p.path} pos:${p.position} impr:${p.impressions} clicks:${p.clicks} ctr:${p.ctr}%`
    ).join('\n');
    return `${i + 1}. Query: "${g.query}" (${g.totalImpressions} total impressions)\n${pageLines}`;
  }).join('\n\n');

  const prompt = `You are an SEO strategist for ${config.name} (${config.url}), a ${config.brand_description}.

These ${top.length} queries each have 2+ blog posts competing in Google, splitting ranking signals.

For each group, decide:
- **winner**: the path that should be the canonical URL (best clicks, best position, cleanest URL)
- **losers**: array of other paths with their action:
  - "REDIRECT": content is near-duplicate, loser adds nothing new → redirect immediately
  - "CONSOLIDATE": loser has unique sections worth keeping → merge content into winner, then redirect
  - "MONITOR": pages target genuinely different sub-intents → leave alone for now
- **confidence**: "HIGH" (act immediately), "MEDIUM" (likely right, double-check), "LOW" (needs manual review)
- **summary**: one sentence rationale

${groupText}

Return ONLY a JSON array, no other text:
[
  {
    "query": "...",
    "winner": "/blogs/news/winner-slug",
    "losers": [{ "path": "/blogs/news/loser-slug", "action": "REDIRECT|CONSOLIDATE|MONITOR", "reason": "one sentence" }],
    "confidence": "HIGH|MEDIUM|LOW",
    "summary": "one sentence"
  }
]`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text.trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in Claude response');
  return JSON.parse(text.slice(start, end + 1));
}

// ── claude: content consolidation ────────────────────────────────────────────

async function consolidateContent(winnerArticle, loserArticle, query, articleIndex) {
  // Build a compact list of other posts available for internal linking
  const otherPosts = [...articleIndex.entries()]
    .filter(([handle]) => handle !== winnerArticle.handle && handle !== loserArticle.handle)
    .map(([handle, a]) => `- ${a.title}: /blogs/news/${handle}`)
    .join('\n');

  const prompt = `You are a content editor for ${config.name}, a ${config.brand_description}.

Two blog posts are competing for the same keyword: "${query}"

**WINNER** (keep this URL, will become the canonical page):
Title: ${winnerArticle.title}
Content:
${winnerArticle.body_html}

**LOSER** (will be redirected after merge):
Title: ${loserArticle.title}
Content:
${loserArticle.body_html}

**Other blog posts available for internal linking:**
${otherPosts}

Your job: produce a single, improved version of the WINNER that incorporates any unique valuable sections from the LOSER that are not already covered, and includes relevant internal links to related blog posts.

Rules:
- Keep the winner's URL slug, title, and overall structure
- Add sections from the loser only if they add genuine value not already covered
- Do not increase length by more than 30% — be selective
- Maintain the same HTML structure and formatting style
- Do not add a note about the merger or mention the other article
- Add 2–4 internal links to related posts from the list above where they fit naturally in the text (use the full path as the href, e.g. <a href="/blogs/news/best-natural-toothpaste-2025">natural toothpaste</a>)
- Do not link to the loser post — it will be redirected
- Output ONLY the merged HTML body content, nothing else`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  return stripCodeFences(msg.content[0].text.trim());
}

// ── apply resolutions ─────────────────────────────────────────────────────────

async function applyResolutions(decisions, articleIndex, existingRedirects) {
  const existingPaths = new Set(existingRedirects.map((r) => r.path));
  const results = [];

  for (const decision of decisions) {
    if (decision.confidence !== 'HIGH') continue;

    for (const loser of decision.losers) {
      if (loser.action === 'MONITOR') continue;

      const loserPath = loser.path;
      const winnerPath = decision.winner;

      // Only act on blog posts
      if (!isBlogPost(loserPath) || !isBlogPost(winnerPath)) {
        results.push({ query: decision.query, loserPath, action: loser.action, status: 'skipped_not_blog' });
        continue;
      }

      const loserHandle = slugFromPath(loserPath);
      const winnerHandle = slugFromPath(winnerPath);
      const loserArticle = articleIndex.get(loserHandle);
      const winnerArticle = articleIndex.get(winnerHandle);

      if (!winnerArticle) {
        results.push({ query: decision.query, loserPath, action: loser.action, status: 'winner_not_found' });
        continue;
      }

      // CONSOLIDATE: merge content, run editor review, save to Shopify as draft
      if (loser.action === 'CONSOLIDATE' && loserArticle) {
        try {
          process.stdout.write(`\n    Merging "${loserHandle}" → "${winnerHandle}"... `);
          const mergedHtml = await consolidateContent(winnerArticle, loserArticle, decision.query, articleIndex);
          console.log('merged');

          // Save to data/posts/ so the editor agent can evaluate it
          const postsDir = join(ROOT, 'data', 'posts');
          mkdirSync(postsDir, { recursive: true });
          const postHtmlPath = join(postsDir, `${winnerHandle}.html`);
          writeFileSync(postHtmlPath, mergedHtml);
          writeFileSync(postHtmlPath.replace('.html', '.json'), JSON.stringify({
            title: winnerArticle.title,
            target_keyword: decision.query,
          }, null, 2));

          // Run editor review — checks link health, topical map alignment, editorial quality
          process.stdout.write(`    Running editor review... `);
          try {
            execSync(`node agents/editor/index.js data/posts/${winnerHandle}.html`, { cwd: ROOT, stdio: 'pipe' });
            console.log(`done → data/reports/editor/${winnerHandle}-editor-report.md`);
          } catch (editorErr) {
            const msg = editorErr.stderr?.toString().trim().slice(0, 120) ?? editorErr.message;
            console.log(`editor warning (non-fatal): ${msg}`);
          }

          // Save to Shopify as draft for review before publishing
          process.stdout.write(`    Saving Shopify draft... `);
          await updateArticle(winnerArticle.blogId, winnerArticle.articleId, {
            body_html: mergedHtml,
            published: false,
          });
          console.log('saved');
          results.push({ query: decision.query, loserPath, winnerPath, action: 'CONSOLIDATE', status: 'draft_saved' });
        } catch (e) {
          console.log(`error: ${e.message}`);
          results.push({ query: decision.query, loserPath, winnerPath, action: 'CONSOLIDATE', status: 'error', error: e.message });
        }
      }

      // Create redirect (for both REDIRECT and CONSOLIDATE)
      if (loser.action === 'REDIRECT' || loser.action === 'CONSOLIDATE') {
        if (existingPaths.has(loserPath)) {
          results.push({ query: decision.query, loserPath, winnerPath, action: loser.action, status: 'redirect_exists' });
        } else {
          try {
            await createRedirect(loserPath, winnerPath);
            existingPaths.add(loserPath);
            results.push({ query: decision.query, loserPath, winnerPath, action: loser.action, status: 'redirect_created' });
          } catch (e) {
            results.push({ query: decision.query, loserPath, winnerPath, action: loser.action, status: 'redirect_error', error: e.message });
          }
        }
      }
    }
  }

  return results;
}

// ── report ────────────────────────────────────────────────────────────────────

function buildReport(groups, decisions, results) {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const high = decisions.filter((d) => d.confidence === 'HIGH');
  const med = decisions.filter((d) => d.confidence === 'MEDIUM');
  const low = decisions.filter((d) => d.confidence === 'LOW');

  const redirectsCreated = results.filter((r) => r.status === 'redirect_created').length;
  const draftsaved = results.filter((r) => r.status === 'draft_saved').length;
  const manualNeeded = decisions.filter((d) => d.confidence !== 'HIGH').length +
    decisions.filter((d) => d.confidence === 'HIGH' && d.losers.some((l) => l.action === 'MONITOR')).length;

  const lines = [
    `# Cannibalization Resolver Report — ${config.name}`,
    `**Run date:** ${now}  `,
    `**Window:** Last ${days} days | Min impressions: ${minImpr}  `,
    `**Mode:** ${apply ? 'APPLIED' : 'DRY RUN'}  `,
    `**Blog-vs-blog groups found:** ${groups.length}  `,
    '',
    '## Summary',
    '',
    `| | Count |`,
    `|---|---|`,
    `| 🟢 HIGH confidence decisions | ${high.length} |`,
    `| 🟡 MEDIUM confidence (manual review) | ${med.length} |`,
    `| 🔴 LOW confidence (manual review) | ${low.length} |`,
  ];

  if (apply) {
    lines.push(`| ↩️ Redirects created | ${redirectsCreated} |`);
    lines.push(`| 🔀 Consolidated drafts saved | ${draftsaved} |`);
    lines.push(`| 👁️ Monitor / skip | ${manualNeeded} |`);
  }

  lines.push('');

  if (apply && results.length > 0) {
    lines.push('## Actions Taken');
    lines.push('');
    lines.push('| Query | Loser | Winner | Action | Status |');
    lines.push('|---|---|---|---|---|');
    for (const r of results) {
      const icon = {
        redirect_created: '✅↩️', draft_saved: '✅🔀', redirect_exists: '⏭️',
        skipped_not_blog: '⏭️', winner_not_found: '⚠️', error: '❌', redirect_error: '❌',
      }[r.status] || '•';
      lines.push(`| ${r.query} | ${r.loserPath} | ${r.winnerPath || '—'} | ${r.action} | ${icon} ${r.status} |`);
    }
    lines.push('');
    if (draftsaved > 0) {
      lines.push(`> **⚠️ ${draftsaved} consolidated post(s) saved as drafts.** Review editor reports in \`data/reports/editor/<slug>-editor-report.md\`, then publish in Shopify admin → Blog Posts → Drafts.`);
      lines.push('');
    }
  }

  lines.push('## Resolution Decisions');
  lines.push('');

  for (const d of decisions) {
    const icon = { HIGH: '🟢', MEDIUM: '🟡', LOW: '🔴' }[d.confidence] || '⚪';
    lines.push(`### ${icon} "${d.query}"`);
    lines.push(`**Winner:** \`${d.winner}\`  `);
    lines.push(`**Confidence:** ${d.confidence} — ${d.summary}`);
    lines.push('');
    for (const l of d.losers) {
      const aIcon = { REDIRECT: '↩️', CONSOLIDATE: '🔀', MONITOR: '👁️' }[l.action] || '•';
      const applied = apply && d.confidence === 'HIGH' ? ' *(applied)*' : '';
      lines.push(`- ${aIcon} **${l.action}** \`${l.path}\`${applied} — ${l.reason}`);
    }
    lines.push('');
  }

  if (!apply && high.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## To Apply HIGH-Confidence Resolutions');
    lines.push('```');
    lines.push('node agents/cannibalization-resolver/index.js --apply');
    lines.push('```');
    lines.push('');
    lines.push('CONSOLIDATE cases will save merged content as Shopify drafts for your review before publishing.');
  }

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCannibalization Resolver — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'} | Window: ${days}d | Min impressions: ${minImpr}\n`);

  mkdirSync(REPORTS_DIR, { recursive: true });

  // Fetch GSC data
  process.stdout.write('  Fetching GSC query+page data... ');
  const queryPageRows = await getAllQueryPageRows(5000, days);
  console.log(`${queryPageRows.length} rows`);

  // Detect blog-vs-blog cannibalization
  process.stdout.write('  Detecting blog-vs-blog cannibalization... ');
  const groups = detectCannibalization(queryPageRows);
  console.log(`${groups.length} groups`);

  if (groups.length === 0) {
    console.log('  No blog cannibalization detected.');
    process.exit(0);
  }

  console.log('  Top groups:');
  groups.slice(0, 5).forEach((g) => {
    console.log(`    "${g.query}" — ${g.totalImpressions} impr`);
    g.pages.forEach((p) => console.log(`      ${p.path} (pos ${p.position}, ${p.clicks} clicks)`));
  });

  // Load Shopify article index and existing redirects in parallel
  process.stdout.write('\n  Loading Shopify articles and redirects... ');
  const [articleIndex, existingRedirects] = await Promise.all([
    buildArticleIndex(),
    getRedirects(),
  ]);
  console.log(`${articleIndex.size} articles, ${existingRedirects.length} existing redirects`);

  // Triage with Claude
  process.stdout.write('  Triaging decisions with Claude... ');
  const decisions = await triageWithClaude(groups);
  console.log('done');

  const highConf = decisions.filter((d) => d.confidence === 'HIGH');
  const actionable = highConf.filter((d) => d.losers.some((l) => l.action !== 'MONITOR'));
  console.log(`  HIGH confidence: ${highConf.length} | Actionable: ${actionable.length}`);

  // Apply resolutions
  let results = [];
  if (apply) {
    console.log('\n  Applying resolutions...');
    results = await applyResolutions(decisions, articleIndex, existingRedirects);
    const redirectsCreated = results.filter((r) => r.status === 'redirect_created').length;
    const drafts = results.filter((r) => r.status === 'draft_saved').length;
    console.log(`\n  Done: ${redirectsCreated} redirects created, ${drafts} drafts saved`);
  }

  // Save decisions JSON
  const decisionsPath = join(REPORTS_DIR, 'cannibalization-decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    days, minImpr, applied: apply,
    blogGroups: groups.length,
    decisions,
    results,
  }, null, 2));

  // Write report
  const reportPath = join(REPORTS_DIR, 'cannibalization-report.md');
  writeFileSync(reportPath, buildReport(groups, decisions, results));

  console.log(`\n  Decisions: ${decisionsPath}`);
  console.log(`  Report:    ${reportPath}`);

  if (!apply && actionable.length > 0) {
    console.log(`\n  ${actionable.length} HIGH-confidence case(s) ready. Run with --apply to resolve.`);
  }
}

main()
  .then(() => notifyLatestReport('Cannibalization Resolver completed', join(ROOT, 'data', 'reports', 'cannibalization')))
  .catch((err) => {
    notify({ subject: 'Cannibalization Resolver failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
