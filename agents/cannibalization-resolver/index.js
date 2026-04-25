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
 *   CONSOLIDATE — Claude fetches both articles, merges the best content into winner.
 *                 If the editor agent passes the merged article cleanly, it is
 *                 auto-published to Shopify. If the editor flags blockers, the
 *                 merged article is saved as a draft for human review. Redirect
 *                 is created immediately either way so link equity is preserved.
 *   MONITOR     — No action. Logged for next review cycle. Use when pages serve
 *                 genuinely different sub-intents.
 *
 * Safety:
 *   - Dry run by default. No changes without --apply.
 *   - Only acts on HIGH-confidence decisions.
 *   - Only touches /blogs/news/ URLs — never products, collections, or pages.
 *   - Auto-publish only when the editor agent reports no blockers (no
 *     `meta.needs_rebuild` set on the merged post). Otherwise the merged article
 *     stays as a Shopify draft and is surfaced in the report's "Drafts needing
 *     review" section.
 *   - Redirect is created immediately on consolidation so link equity is preserved
 *     even before any draft is reviewed and published.
 *   - All decisions persisted to cannibalization-decisions.json for audit trail.
 *
 * Usage:
 *   node agents/cannibalization-resolver/index.js              # dry run
 *   node agents/cannibalization-resolver/index.js --apply      # resolve HIGH-confidence cases
 *   node agents/cannibalization-resolver/index.js --days 28    # shorter GSC window
 *   node agents/cannibalization-resolver/index.js --min-impr 30
 *   node agents/cannibalization-resolver/index.js --report-json  # write latest.json with all conflicts
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
import { notify, notifyLatestReport } from '../../lib/notify.js';
import {
  getBlogs, getArticles, updateArticle,
  getRedirects, createRedirect,
} from '../../lib/shopify.js';

import { getContentPath, getMetaPath, ensurePostDir, ROOT } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
const reportJson = args.includes('--report-json');

// ── URL helpers ───────────────────────────────────────────────────────────────

function urlPath(fullUrl) {
  try { return new URL(fullUrl).pathname; } catch { return fullUrl; }
}

function isBlogPost(url) {
  return urlPath(url).startsWith('/blogs/');
}

function isProduct(url) { return urlPath(url).startsWith('/products/'); }
function isCollection(url) { return urlPath(url).startsWith('/collections/'); }

function classifyUrl(url) {
  if (isBlogPost(url)) return 'blog';
  if (isProduct(url)) return 'product';
  if (isCollection(url)) return 'collection';
  return 'other';
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

// ── extended cannibalization detection (blog + product + collection) ─────────

function detectCannibalizationExtended(queryPageRows) {
  const byQuery = new Map();
  for (const row of queryPageRows) {
    const type = classifyUrl(row.page);
    if (type === 'other') continue;
    if (!byQuery.has(row.query)) byQuery.set(row.query, []);
    byQuery.get(row.query).push({ ...row, type });
  }

  return [...byQuery.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => {
      const sorted = [...pages].sort((a, b) => b.impressions - a.impressions);
      const types = new Set(sorted.map((p) => p.type));
      const conflictType = types.size === 1 ? `${[...types][0]}-vs-${[...types][0]}` :
        [...types].sort().join('-vs-');
      return {
        query,
        conflictType,
        totalImpressions: pages.reduce((s, p) => s + p.impressions, 0),
        pages: sorted.map((p) => ({
          url: p.page,
          type: p.type,
          impressions: p.impressions,
          position: p.position,
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
          ensurePostDir(winnerHandle);
          writeFileSync(getContentPath(winnerHandle), mergedHtml);
          writeFileSync(getMetaPath(winnerHandle), JSON.stringify({
            title: winnerArticle.title,
            target_keyword: decision.query,
          }, null, 2));

          // Run editor review — checks link health, topical map alignment, editorial quality.
          // Use process.execPath so this works in cron/sh environments where `node` may not be on PATH.
          process.stdout.write(`    Running editor review... `);
          let editorRan = false;
          let editorError = null;
          try {
            execSync(`"${process.execPath}" agents/editor/index.js data/posts/${winnerHandle}.html`, { cwd: ROOT, stdio: 'pipe' });
            editorRan = true;
            console.log(`done → data/reports/editor/${winnerHandle}-editor-report.md`);
          } catch (editorErr) {
            editorError = editorErr.stderr?.toString().trim().slice(0, 120) ?? editorErr.message;
            console.log(`editor warning (non-fatal): ${editorError}`);
          }

          // Editor pass/fail signal: editor sets meta.needs_rebuild on the post's
          // meta.json when it finds blockers (broken links, factual concerns, etc.).
          // No needs_rebuild => clean, safe to auto-publish.
          let needsRebuild = null;
          if (editorRan) {
            try {
              const meta = JSON.parse(readFileSync(getMetaPath(winnerHandle), 'utf8'));
              needsRebuild = meta.needs_rebuild ?? null;
            } catch { /* missing/unreadable meta — treat as ambiguous, fall back to draft */ }
          }
          const editorClean = editorRan && !needsRebuild;

          // Auto-publish if the editor passed cleanly. Otherwise save as draft for human review.
          const willPublish = editorClean;
          process.stdout.write(`    ${willPublish ? 'Publishing merged article' : 'Saving Shopify draft'}... `);
          await updateArticle(winnerArticle.blogId, winnerArticle.articleId, {
            body_html: mergedHtml,
            published: willPublish,
          });
          console.log(willPublish ? 'published' : 'saved (needs review)');
          results.push({
            query: decision.query,
            loserPath,
            winnerPath,
            action: 'CONSOLIDATE',
            status: willPublish ? 'published' : 'draft_needs_review',
            editorRan,
            editorError,
            needsRebuildReasons: needsRebuild?.reasons ?? null,
          });
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
  const published = results.filter((r) => r.status === 'published').length;
  const draftNeedsReview = results.filter((r) => r.status === 'draft_needs_review').length;
  // Backwards compatibility — older runs used 'draft_saved' before auto-publish was added.
  const legacyDraftSaved = results.filter((r) => r.status === 'draft_saved').length;
  const reviewQueueCount = med.length + low.length + draftNeedsReview;
  const monitorCount = decisions.filter((d) => d.confidence !== 'HIGH').length +
    decisions.filter((d) => d.confidence === 'HIGH' && d.losers.some((l) => l.action === 'MONITOR')).length;

  const lines = [
    `# Cannibalization Resolver Report — ${config.name}`,
    `**Run date:** ${now}  `,
    `**Window:** Last ${days} days | Min impressions: ${minImpr}  `,
    `**Mode:** ${apply ? 'APPLIED' : 'DRY RUN'}  `,
    `**Blog-vs-blog groups found:** ${groups.length}  `,
    '',
  ];

  if (reviewQueueCount > 0) {
    lines.push(`> 🔍 **${reviewQueueCount} item(s) need your review** — see "Needs review" section below.`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`| | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| 🟢 HIGH confidence decisions | ${high.length} |`);
  lines.push(`| 🟡 MEDIUM confidence (manual review) | ${med.length} |`);
  lines.push(`| 🔴 LOW confidence (manual review) | ${low.length} |`);

  if (apply) {
    lines.push(`| ↩️ Redirects created | ${redirectsCreated} |`);
    lines.push(`| ✅ Auto-published merges (editor passed) | ${published} |`);
    lines.push(`| 📝 Drafts needing review (editor flagged) | ${draftNeedsReview + legacyDraftSaved} |`);
    lines.push(`| 👁️ Monitor / skip | ${monitorCount} |`);
  }

  lines.push('');

  if (apply && results.length > 0) {
    lines.push('## Actions Taken');
    lines.push('');
    lines.push('| Query | Loser | Winner | Action | Status |');
    lines.push('|---|---|---|---|---|');
    for (const r of results) {
      const icon = {
        redirect_created: '✅↩️',
        published: '✅📤',
        draft_needs_review: '📝',
        draft_saved: '📝',
        redirect_exists: '⏭️',
        skipped_not_blog: '⏭️',
        winner_not_found: '⚠️',
        error: '❌',
        redirect_error: '❌',
      }[r.status] || '•';
      lines.push(`| ${r.query} | ${r.loserPath} | ${r.winnerPath || '—'} | ${r.action} | ${icon} ${r.status} |`);
    }
    lines.push('');

    // Surface drafts that the editor flagged so the user can prioritise them.
    const flagged = results.filter((r) => r.status === 'draft_needs_review' || r.status === 'draft_saved');
    if (flagged.length > 0) {
      lines.push('### 📝 Drafts needing review (editor flagged blockers or could not run)');
      lines.push('');
      for (const r of flagged) {
        const reasons = (r.needsRebuildReasons && r.needsRebuildReasons.length > 0)
          ? r.needsRebuildReasons.join('; ')
          : (r.editorError ? `editor failed: ${r.editorError}` : 'editor did not run cleanly');
        lines.push(`- \`${r.winnerPath}\` (merged \`${r.loserPath}\`) — ${reasons}`);
      }
      lines.push('');
      lines.push(`Review editor reports in \`data/reports/editor/<slug>-editor-report.md\`, fix issues in \`data/posts/<slug>.html\`, then publish in Shopify admin → Blog Posts → Drafts.`);
      lines.push('');
    }
  }

  // Dedicated review queue for ambiguous cases. HIGH-confidence cases were
  // already auto-applied (or auto-published / saved-as-draft); the user only
  // needs to weigh in on MEDIUM and LOW decisions plus any editor-flagged drafts.
  const needsReview = [...med, ...low];
  if (needsReview.length > 0) {
    lines.push('## 🔍 Needs review');
    lines.push('');
    lines.push(`${needsReview.length} ambiguous decision(s) require your call. The agent did not apply changes for these — pick a winner per query and re-run with \`--apply\` (or accept the recommendation and apply by hand).`);
    lines.push('');
    for (const d of needsReview) {
      const icon = { MEDIUM: '🟡', LOW: '🔴' }[d.confidence];
      lines.push(`### ${icon} "${d.query}"`);
      lines.push(`Recommended winner: \`${d.winner}\`  `);
      lines.push(`Why ambiguous: ${d.summary}`);
      lines.push('');
      for (const l of d.losers) {
        const aIcon = { REDIRECT: '↩️', CONSOLIDATE: '🔀', MONITOR: '👁️' }[l.action] || '•';
        lines.push(`- ${aIcon} **${l.action}** \`${l.path}\` — ${l.reason}`);
      }
      lines.push('');
    }
  }

  lines.push('## Resolution Decisions (full audit trail)');
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

  // Extended detection: blog + product + collection
  process.stdout.write('  Detecting extended cannibalization (blog/product/collection)... ');
  const extendedGroups = detectCannibalizationExtended(queryPageRows);
  const crossTypeGroups = extendedGroups.filter((g) => g.conflictType !== 'blog-vs-blog');
  console.log(`${extendedGroups.length} total, ${crossTypeGroups.length} cross-type`);

  if (crossTypeGroups.length > 0) {
    console.log('  Cross-type conflicts (recommendations only):');
    crossTypeGroups.slice(0, 10).forEach((g) => {
      console.log(`    "${g.query}" [${g.conflictType}] — ${g.totalImpressions} impr`);
      g.pages.forEach((p) => console.log(`      ${p.url} (${p.type}, pos ${p.position})`));
    });
  }

  if (groups.length === 0 && !reportJson) {
    console.log('  No blog cannibalization detected.');
    if (crossTypeGroups.length > 0) {
      console.log(`  ${crossTypeGroups.length} cross-type conflict(s) found. Run with --report-json for full report.`);
    }
    process.exit(0);
  }

  let decisions = [];
  let results = [];
  let actionable = [];

  if (groups.length > 0) {
    console.log('  Top blog-vs-blog groups:');
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
    decisions = await triageWithClaude(groups);
    console.log('done');

    const highConf = decisions.filter((d) => d.confidence === 'HIGH');
    actionable = highConf.filter((d) => d.losers.some((l) => l.action !== 'MONITOR'));
    console.log(`  HIGH confidence: ${highConf.length} | Actionable: ${actionable.length}`);

    // Apply resolutions
    if (apply) {
      console.log('\n  Applying resolutions...');
      results = await applyResolutions(decisions, articleIndex, existingRedirects);
      const redirectsCreated = results.filter((r) => r.status === 'redirect_created').length;
      const drafts = results.filter((r) => r.status === 'draft_saved').length;
      console.log(`\n  Done: ${redirectsCreated} redirects created, ${drafts} drafts saved`);
    }
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
  if (groups.length > 0) {
    const reportPath = join(REPORTS_DIR, 'cannibalization-report.md');
    writeFileSync(reportPath, buildReport(groups, decisions, results));
    console.log(`\n  Decisions: ${decisionsPath}`);
    console.log(`  Report:    ${reportPath}`);
  } else {
    console.log(`\n  Decisions: ${decisionsPath}`);
  }

  // Write extended JSON report (--report-json)
  if (reportJson) {
    // Build a set of auto-resolved blog-vs-blog queries (applied with --apply)
    const resolvedQueries = new Set(
      results.filter((r) => r.status === 'redirect_created' || r.status === 'draft_saved')
        .map((r) => r.query)
    );

    const conflicts = extendedGroups.map((g) => {
      const isBlogVsBlog = g.conflictType === 'blog-vs-blog';
      const decision = isBlogVsBlog ? decisions.find((d) => d.query === g.query) : null;
      const autoApplied = isBlogVsBlog && apply && resolvedQueries.has(g.query);

      let resolution = 'recommended';
      if (decision) {
        const actions = decision.losers.map((l) => l.action);
        resolution = actions.includes('REDIRECT') || actions.includes('CONSOLIDATE')
          ? decision.confidence : 'MONITOR';
      }

      return {
        query: g.query,
        total_impressions: g.totalImpressions,
        urls: g.pages.map((p) => ({
          url: p.url,
          position: p.position,
          impressions: p.impressions,
          type: p.type,
        })),
        conflict_type: g.conflictType,
        resolution,
        auto_applied: autoApplied,
      };
    });

    const autoResolved = conflicts.filter((c) => c.auto_applied).length;
    const recommended = conflicts.filter((c) => !c.auto_applied).length;

    const latestJsonPath = join(REPORTS_DIR, 'latest.json');
    writeFileSync(latestJsonPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      conflict_count: conflicts.length,
      auto_resolved: autoResolved,
      recommended,
      conflicts,
    }, null, 2));
    console.log(`  JSON report: ${latestJsonPath}`);
  }

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
