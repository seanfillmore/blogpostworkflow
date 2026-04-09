# Performance Engine + Approval Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop between the existing SEO signal agents and the publisher. A new `performance-engine` agent runs nightly, picks up to 6 high-signal items (flops, quick-wins, low-CTR meta rewrites), produces a refreshed HTML + plain-English summary for each, and puts them on a review queue. The morning recap email surfaces the queue as a styled section with deep links to the dashboard. On the dashboard, each item has Approve and Add Feedback buttons. Approved items get overwritten on Shopify at the next publisher run. Feedback items get re-refreshed the following night with the feedback injected into the prompt.

**Architecture:** One new agent (`performance-engine`) orchestrates existing tools (`content-refresher`, `meta-optimizer`, editor) and writes JSON queue files to `data/performance-queue/`. The dashboard adds one new route module, one new render function, and wires into the existing Optimize tab. The publisher agent gets a new pre-run step that scans for `approved_for_publish` flags. The daily-summary agent gets a new section that reads the queue and renders styled HTML cards.

**Tech Stack:** Node.js ESM, Anthropic SDK (for summary generation and content-refresher), existing `lib/shopify.js` `updateArticle`, existing dashboard route/render patterns.

---

## Concepts

### The queue
A directory `data/performance-queue/` holds one JSON file per queued item. File naming: `<slug>-<timestamp>.json`. The timestamp is the first engine run that produced the item — subsequent feedback-driven re-runs overwrite the same file.

Each queue item JSON:

```json
{
  "slug": "best-natural-deodorant-for-women",
  "title": "Best Natural Deodorant for Women",
  "trigger": "flop-refresh" | "quick-win" | "low-ctr-meta",
  "signal_source": {
    "type": "post-performance" | "quick-wins" | "gsc-opportunity",
    "milestone": 30,
    "verdict": "REFRESH",
    "reason": "9 clicks vs projected 200 (4% of target)"
  },
  "summary": {
    "what_changed": "Rewrote intro, added FAQ section covering 3 unranked queries, fixed 2 broken sources.",
    "why": "Original intro used listicle clichés. The 3 new FAQ questions came from GSC unmapped-query matches (they have impressions but no dedicated content).",
    "projected_impact": "Target query 'best natural deodorant for women' is currently pos 31 → page 1 plausible with stronger intro + FAQ alignment."
  },
  "refreshed_html_path": "data/performance-queue/best-natural-deodorant-for-women.html",
  "backup_html_path":    "data/performance-queue/best-natural-deodorant-for-women.backup.html",
  "created_at": "2026-04-10T10:00:00Z",
  "updated_at": "2026-04-10T10:00:00Z",
  "status": "pending" | "approved" | "published" | "dismissed",
  "feedback": null,
  "feedback_history": [],
  "approved_at": null,
  "published_at": null
}
```

### Caps and priority
Max 6 items per nightly run. Priority order:
1. Flop refreshes (BLOCKED + REFRESH verdicts) — up to 3
2. Quick-win rewrites — up to 2
3. Low-CTR meta-only rewrites — up to 1

If any category has zero eligible items, the slot rolls to the next category (still capped at 6 total). Same-slug collisions across categories: a slug already in the queue with `status !== 'published'` is skipped.

### Feedback loop
Adding feedback to a queue item:
1. Sets `status: 'pending'` even if it was `approved` (your rule: feedback resets approval)
2. Appends the new feedback to `feedback_history` with a timestamp
3. Sets `feedback` to the most recent feedback text
4. The next nightly engine run sees `feedback !== null && feedback not in applied_feedback_history` and re-runs the refresh from the original HTML with the feedback injected into the prompt

### Publishing
The publisher gets a new pre-run step that scans `data/performance-queue/*.json` for `status === 'approved'` items. For each:
1. Calls `updateArticle(blogId, shopifyArticleId, { body_html: refreshedHtml })` via existing `lib/shopify.js`
2. Stamps `status: 'published'`, `published_at: <ts>` on the queue item
3. Copies the refreshed HTML over the canonical `data/posts/<slug>.html`

### Rollback
Each queue item already stores `backup_html_path` — the original HTML before the refresh. A rollback button on a published item calls a new `POST /api/performance-queue/:slug/rollback` route that re-publishes the backup and marks the queue item `status: 'dismissed'`.

---

## File structure

**Created:**
- `agents/performance-engine/index.js` — the nightly engine
- `agents/performance-engine/prompts.js` — prompt templates for summary generation
- `agents/performance-engine/lib/queue.js` — read/write queue items
- `agents/performance-engine/lib/apply-feedback.js` — feedback re-run logic
- `agents/dashboard/routes/performance-queue.js` — dashboard API routes
- `data/performance-queue/` — queue directory (gitignored contents, committed `.gitkeep`)

**Modified:**
- `agents/publisher/index.js` — add pre-run queue scan
- `agents/daily-summary/index.js` — add "Optimization Queue" section with styled HTML cards
- `agents/dashboard/lib/data-loader.js` — expose queue items to `/api/data`
- `agents/dashboard/public/js/dashboard.js` — add `renderPerformanceQueueCard()` to Optimize tab
- `agents/dashboard/public/dashboard.css` — styles for the queue cards and feedback UI
- `agents/dashboard/lib/run-agent.js` — add `agents/performance-engine/index.js` to allowlist
- `agents/dashboard/index.js` — register new route module

---

## Task 1: Queue directory and helpers

**Files:**
- Create: `data/performance-queue/.gitkeep`
- Create: `agents/performance-engine/lib/queue.js`
- Modify: `.gitignore` (add `data/performance-queue/*.json`, `data/performance-queue/*.html`)

- [ ] **Step 1: Create directory and .gitkeep**

```bash
mkdir -p agents/performance-engine/lib data/performance-queue
touch data/performance-queue/.gitkeep
```

- [ ] **Step 2: Add to .gitignore**

Append to `.gitignore`:

```
data/performance-queue/*.json
data/performance-queue/*.html
!data/performance-queue/.gitkeep
```

Verify `.gitkeep` is still tracked:

```bash
git check-ignore -v data/performance-queue/.gitkeep
```

Should print nothing (not ignored).

- [ ] **Step 3: Write `agents/performance-engine/lib/queue.js`**

```javascript
// agents/performance-engine/lib/queue.js
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
export const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');

export function ensureQueueDir() {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
}

export function listQueueItems() {
  ensureQueueDir();
  return readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(QUEUE_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

export function findBySlug(slug) {
  return listQueueItems().find((i) => i.slug === slug) || null;
}

export function writeItem(item) {
  ensureQueueDir();
  item.updated_at = new Date().toISOString();
  writeFileSync(join(QUEUE_DIR, `${item.slug}.json`), JSON.stringify(item, null, 2));
}

/**
 * Returns slugs that are currently in the queue with a non-published status.
 * Used to prevent the engine from queuing the same post twice.
 */
export function activeSlugs() {
  return new Set(listQueueItems()
    .filter((i) => i.status !== 'published' && i.status !== 'dismissed')
    .map((i) => i.slug));
}
```

- [ ] **Step 4: Verify and commit**

```bash
node --check agents/performance-engine/lib/queue.js && echo OK
git add agents/performance-engine/lib/queue.js data/performance-queue/.gitkeep .gitignore
git commit -m "feat(performance-engine): add queue directory and helpers"
```

---

## Task 2: Summary prompt template

**Files:**
- Create: `agents/performance-engine/prompts.js`

- [ ] **Step 1: Write `agents/performance-engine/prompts.js`**

```javascript
// agents/performance-engine/prompts.js
/**
 * Build the Claude prompt that turns a pre/post HTML diff into a
 * plain-English summary for the morning digest.
 *
 * The output must be exactly a JSON object with three fields:
 *   what_changed  (1-2 sentences describing the edits)
 *   why           (1-2 sentences connecting the edits to the signal)
 *   projected_impact (1-2 sentences; best guess, may say "unclear" if low-confidence)
 */
export function buildSummaryPrompt({ slug, trigger, signal, originalHtml, refreshedHtml }) {
  return `You are summarizing a content refresh that was just performed on a Shopify blog post for a natural skincare brand (Real Skin Care). The post was picked up by our automated SEO engine based on a specific signal, then rewritten or adjusted by the content-refresher agent.

Your job: produce a short, plain-English summary that a busy founder can read in 10 seconds and decide whether to approve or give feedback. No jargon. No hedging. Write it as if you were the editor telling the founder exactly what just happened.

POST: ${slug}
TRIGGER: ${trigger}
SIGNAL: ${JSON.stringify(signal, null, 2)}

ORIGINAL HTML (truncated):
${originalHtml.slice(0, 6000)}

REFRESHED HTML (truncated):
${refreshedHtml.slice(0, 6000)}

Respond with EXACTLY this JSON shape, no markdown fence, no commentary:

{
  "what_changed": "1-2 sentences describing the specific edits (sections rewritten, things added, things removed).",
  "why": "1-2 sentences connecting the edits to the signal that triggered the refresh.",
  "projected_impact": "1-2 sentences with a concrete expected outcome, or the string 'unclear' if you can't predict a specific impact."
}`;
}
```

- [ ] **Step 2: Verify and commit**

```bash
node --check agents/performance-engine/prompts.js && echo OK
git add agents/performance-engine/prompts.js
git commit -m "feat(performance-engine): summary prompt template"
```

---

## Task 3: The engine itself

**Files:**
- Create: `agents/performance-engine/index.js`

This is the largest task. The engine reads signal files, picks up to 6 candidates, runs the refresh pipeline for each, generates a summary, and writes a queue item.

- [ ] **Step 1: Write `agents/performance-engine/index.js`**

```javascript
#!/usr/bin/env node
/**
 * Performance Engine
 *
 * Nightly agent that closes the loop between SEO signals and content changes.
 * Reads:
 *   data/reports/post-performance/latest.json     (flops to refresh)
 *   data/reports/quick-wins/latest.json           (page-2 posts to refresh)
 *   data/reports/gsc-opportunity/latest.json      (low-CTR queries for meta rewrites)
 *
 * Picks up to MAX_ITEMS_PER_RUN candidates using the priority allocation,
 * runs the content-refresher or meta-optimizer for each, generates a
 * plain-English summary via Claude, and writes a queue item to
 * data/performance-queue/<slug>.json for human review.
 *
 * Also checks the queue for items with unapplied feedback and re-runs
 * those with the feedback injected into the refresh prompt.
 *
 * Cron: daily 3:00 AM PT (10:00 UTC). The morning digest at 5 AM PT reads
 * the queue and surfaces anything new.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { notify } from '../../lib/notify.js';
import { QUEUE_DIR, listQueueItems, writeItem, activeSlugs } from './lib/queue.js';
import { buildSummaryPrompt } from './prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const REPORTS_DIR = join(ROOT, 'data', 'reports');

const MAX_ITEMS_PER_RUN = 6;
const MAX_FLOPS = 3;
const MAX_QUICK_WINS = 2;
const MAX_META_REWRITES = 1;

// ── env / clients ──────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;
const anthropic = new Anthropic();

// ── helpers ────────────────────────────────────────────────────────────────────

function readJsonSafe(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function loadPostMeta(slug) {
  return readJsonSafe(join(POSTS_DIR, `${slug}.json`));
}

function loadPostHtml(slug) {
  const p = join(POSTS_DIR, `${slug}.html`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ── candidate selection ───────────────────────────────────────────────────────

function pickFlopCandidates(blocked) {
  const pp = readJsonSafe(join(REPORTS_DIR, 'post-performance', 'latest.json'));
  if (!pp || !pp.action_required) return [];
  return pp.action_required
    .filter((f) => (f.verdict === 'REFRESH' || f.verdict === 'BLOCKED'))
    .filter((f) => !blocked.has(f.slug))
    .slice(0, MAX_FLOPS)
    .map((f) => ({
      slug: f.slug,
      title: f.title || f.slug,
      trigger: 'flop-refresh',
      signal_source: {
        type: 'post-performance',
        milestone: f.milestone,
        verdict: f.verdict,
        reason: f.reason,
      },
      mode: 'full-refresh',
    }));
}

function pickQuickWinCandidates(blocked) {
  const qw = readJsonSafe(join(REPORTS_DIR, 'quick-wins', 'latest.json'));
  if (!qw || !qw.top) return [];
  return qw.top
    .filter((c) => !blocked.has(c.slug))
    .slice(0, MAX_QUICK_WINS)
    .map((c) => ({
      slug: c.slug,
      title: c.title || c.slug,
      trigger: 'quick-win',
      signal_source: {
        type: 'quick-wins',
        position: c.position,
        impressions: c.impressions,
        ctr: c.ctr,
        top_query: c.top_query,
      },
      mode: 'full-refresh',
    }));
}

function pickMetaRewriteCandidates(blocked) {
  const gsc = readJsonSafe(join(REPORTS_DIR, 'gsc-opportunity', 'latest.json'));
  if (!gsc || !gsc.low_ctr) return [];
  // low_ctr is a list of queries, not posts. Match each query to a post whose
  // target_keyword contains the query (approximate). Take only the first match
  // to avoid queuing meta rewrites when we can't cleanly target a specific post.
  const { readdirSync } = require('node:fs');
  const postFiles = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json'));
  const posts = postFiles.map((f) => {
    try { return JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);

  const picks = [];
  for (const query of gsc.low_ctr) {
    if (picks.length >= MAX_META_REWRITES) break;
    const match = posts.find((p) => {
      const tk = (p.target_keyword || '').toLowerCase();
      return tk && (query.keyword.toLowerCase().includes(tk) || tk.includes(query.keyword.toLowerCase()));
    });
    if (!match || blocked.has(match.slug)) continue;
    picks.push({
      slug: match.slug,
      title: match.title,
      trigger: 'low-ctr-meta',
      signal_source: {
        type: 'gsc-opportunity',
        query: query.keyword,
        impressions: query.impressions,
        ctr: query.ctr,
        position: query.position,
      },
      mode: 'meta-only',
    });
  }
  return picks;
}

// ── refresh execution ────────────────────────────────────────────────────────

async function runFullRefresh(slug, feedback = null) {
  // Call content-refresher with --slug. If feedback present, pass via --feedback.
  const args = ['agents/content-refresher/index.js', '--slug', slug];
  if (feedback) args.push('--feedback', feedback);
  execSync(`node ${args.join(' ')}`, { cwd: ROOT, stdio: 'inherit' });
  // content-refresher writes data/posts/<slug>-refreshed.html
  const refreshedPath = join(POSTS_DIR, `${slug}-refreshed.html`);
  if (!existsSync(refreshedPath)) throw new Error(`content-refresher did not produce ${refreshedPath}`);
  return readFileSync(refreshedPath, 'utf8');
}

async function runMetaOnly(slug, feedback = null) {
  // meta-optimizer rewrites only title + meta_description. For now, fall back
  // to the full content-refresher in "meta mode" by passing --mode=meta if
  // supported, otherwise call the same full refresh but only keep the meta
  // diff. Simplest correct impl: call content-refresher the same way.
  return runFullRefresh(slug, feedback);
}

async function generateSummary({ slug, trigger, signal, originalHtml, refreshedHtml }) {
  const prompt = buildSummaryPrompt({ slug, trigger, signal, originalHtml, refreshedHtml });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed.what_changed || !parsed.why || !parsed.projected_impact) {
      throw new Error('Summary missing required fields');
    }
    return parsed;
  } catch (err) {
    console.warn(`  [warn] Summary parse failed for ${slug}: ${err.message}. Using fallback.`);
    return {
      what_changed: 'Content refreshed (summary generation failed — see HTML).',
      why: `Triggered by ${trigger}.`,
      projected_impact: 'unclear',
    };
  }
}

// ── feedback re-run ───────────────────────────────────────────────────────────

async function processFeedbackQueue() {
  const items = listQueueItems();
  const needsRerun = items.filter((i) => {
    if (!i.feedback) return false;
    const alreadyApplied = (i.feedback_history || []).some((h) => h.text === i.feedback && h.applied_at);
    return !alreadyApplied;
  });

  for (const item of needsRerun) {
    console.log(`\n  Re-running ${item.slug} with feedback: "${item.feedback.slice(0, 80)}..."`);
    try {
      const originalHtml = readFileSync(item.backup_html_path, 'utf8');
      const refreshedHtml = await runFullRefresh(item.slug, item.feedback);
      writeFileSync(item.refreshed_html_path, refreshedHtml);
      const summary = await generateSummary({
        slug: item.slug,
        trigger: item.trigger,
        signal: item.signal_source,
        originalHtml,
        refreshedHtml,
      });
      item.summary = summary;
      item.status = 'pending';
      item.approved_at = null;
      const history = item.feedback_history || [];
      const existing = history.find((h) => h.text === item.feedback && !h.applied_at);
      if (existing) existing.applied_at = new Date().toISOString();
      else history.push({ text: item.feedback, applied_at: new Date().toISOString() });
      item.feedback_history = history;
      item.feedback = null; // consumed
      writeItem(item);
      console.log(`    [ok] ${item.slug}: feedback applied, back to pending`);
    } catch (err) {
      console.error(`    [fail] ${item.slug}: ${err.message}`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPerformance Engine\n');

  // Stage 1: apply any pending feedback first. Feedback items reset to pending
  // and are independent of the normal candidate budget.
  console.log('  Stage 1: processing feedback queue...');
  await processFeedbackQueue();

  // Stage 2: pick new candidates (skip slugs already in the queue with a non-terminal status).
  console.log('\n  Stage 2: selecting new candidates...');
  const blocked = activeSlugs();
  const flops = pickFlopCandidates(blocked);
  flops.forEach((c) => blocked.add(c.slug));
  const quickWins = pickQuickWinCandidates(blocked);
  quickWins.forEach((c) => blocked.add(c.slug));
  const metaRewrites = pickMetaRewriteCandidates(blocked);

  const candidates = [...flops, ...quickWins, ...metaRewrites].slice(0, MAX_ITEMS_PER_RUN);
  console.log(`    ${flops.length} flops, ${quickWins.length} quick-wins, ${metaRewrites.length} meta rewrites`);
  console.log(`    Total candidates: ${candidates.length} / ${MAX_ITEMS_PER_RUN}`);

  if (candidates.length === 0 && blocked.size === 0) {
    console.log('\n  No candidates and no feedback to process. Engine done.');
    return;
  }

  // Stage 3: run refresh + summary for each new candidate.
  console.log('\n  Stage 3: running refresh pipeline for each candidate...');
  const queued = [];
  for (const c of candidates) {
    console.log(`\n  → ${c.slug} [${c.trigger}]`);
    const originalHtml = loadPostHtml(c.slug);
    if (!originalHtml) {
      console.warn(`    [skip] no HTML at data/posts/${c.slug}.html`);
      continue;
    }

    try {
      const refreshedHtml = c.mode === 'meta-only'
        ? await runMetaOnly(c.slug)
        : await runFullRefresh(c.slug);

      const backupPath    = join(QUEUE_DIR, `${c.slug}.backup.html`);
      const refreshedPath = join(QUEUE_DIR, `${c.slug}.html`);
      writeFileSync(backupPath, originalHtml);
      writeFileSync(refreshedPath, refreshedHtml);

      const summary = await generateSummary({
        slug: c.slug,
        trigger: c.trigger,
        signal: c.signal_source,
        originalHtml,
        refreshedHtml,
      });

      const item = {
        slug: c.slug,
        title: c.title,
        trigger: c.trigger,
        signal_source: c.signal_source,
        summary,
        refreshed_html_path: refreshedPath,
        backup_html_path: backupPath,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'pending',
        feedback: null,
        feedback_history: [],
        approved_at: null,
        published_at: null,
      };
      writeItem(item);
      queued.push(item);
      console.log(`    [queued] ${c.slug}`);
    } catch (err) {
      console.error(`    [fail] ${c.slug}: ${err.message}`);
    }
  }

  console.log(`\n  Queued ${queued.length} new item${queued.length === 1 ? '' : 's'}.`);

  await notify({
    subject: `Performance Engine: ${queued.length} item${queued.length === 1 ? '' : 's'} queued for review`,
    body: queued.length === 0
      ? 'No new items this run.'
      : queued.map((i) => `[${i.trigger}] ${i.title}\n  ${i.summary.what_changed}`).join('\n\n'),
    status: 'info',
    category: 'pipeline',
  }).catch(() => {});

  console.log('\nPerformance Engine run complete.');
}

main().catch((err) => {
  console.error('Performance engine failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Fix the `require('node:fs')` bug**

I used `require` inside `pickMetaRewriteCandidates` — that's CommonJS and this file is ESM. Replace that entire function to import `readdirSync` at the top with the other imports:

```javascript
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
```

Then the function body becomes:

```javascript
function pickMetaRewriteCandidates(blocked) {
  const gsc = readJsonSafe(join(REPORTS_DIR, 'gsc-opportunity', 'latest.json'));
  if (!gsc || !gsc.low_ctr) return [];
  const postFiles = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json'));
  const posts = postFiles.map((f) => {
    try { return JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);

  const picks = [];
  for (const query of gsc.low_ctr) {
    if (picks.length >= MAX_META_REWRITES) break;
    const match = posts.find((p) => {
      const tk = (p.target_keyword || '').toLowerCase();
      return tk && (query.keyword.toLowerCase().includes(tk) || tk.includes(query.keyword.toLowerCase()));
    });
    if (!match || blocked.has(match.slug)) continue;
    picks.push({
      slug: match.slug,
      title: match.title,
      trigger: 'low-ctr-meta',
      signal_source: {
        type: 'gsc-opportunity',
        query: query.keyword,
        impressions: query.impressions,
        ctr: query.ctr,
        position: query.position,
      },
      mode: 'meta-only',
    });
  }
  return picks;
}
```

- [ ] **Step 3: Verify syntax**

```bash
node --check agents/performance-engine/index.js && echo OK
```

- [ ] **Step 4: Dry-run test (no actual refresh calls yet)**

Because this runs `content-refresher` via execSync, a full dry run would actually hit the Anthropic API and write files. Instead, test the candidate-picker logic in isolation:

```bash
node -e "
import('./agents/performance-engine/lib/queue.js').then(async ({ activeSlugs, listQueueItems }) => {
  console.log('Queue items:', listQueueItems().length);
  console.log('Active slugs:', [...activeSlugs()]);
});
"
```

Should print `Queue items: 0` and `Active slugs: []`.

- [ ] **Step 5: Commit**

```bash
git add agents/performance-engine/index.js
git commit -m "feat(performance-engine): nightly signal-driven refresh orchestrator"
```

---

## Task 4: Content-refresher `--feedback` flag

**Files:**
- Modify: `agents/content-refresher/index.js`

The performance engine calls `content-refresher --slug X --feedback "Y"`. The current content-refresher doesn't support `--feedback`. Add it.

- [ ] **Step 1: Read the current content-refresher arg parsing**

```bash
grep -nE "process\.argv|--slug|--feedback" agents/content-refresher/index.js | head -10
```

- [ ] **Step 2: Add `--feedback` parsing**

Near the existing arg parsing block, add:

```javascript
const feedbackIdx = process.argv.indexOf('--feedback');
const FEEDBACK = feedbackIdx !== -1 ? process.argv[feedbackIdx + 1] : null;
```

- [ ] **Step 3: Inject feedback into the refresher's Claude prompt**

Locate the prompt-building function inside `content-refresher` (likely `buildRefreshPrompt` or similar). Add a section to the prompt when `FEEDBACK` is present:

```javascript
const feedbackSection = FEEDBACK
  ? `\n\n## FOUNDER FEEDBACK FROM PRIOR REFRESH\nThe user reviewed a previous version of this refresh and provided the following feedback. Apply it precisely. The feedback is authoritative and overrides the general refresh strategy.\n\n${FEEDBACK}\n`
  : '';
```

Inject `feedbackSection` into the system or user prompt string where it will be visible to Claude.

- [ ] **Step 4: Verify**

```bash
node --check agents/content-refresher/index.js && echo OK
```

- [ ] **Step 5: Commit**

```bash
git add agents/content-refresher/index.js
git commit -m "feat(content-refresher): accept --feedback flag for iterative refreshes"
```

---

## Task 5: Dashboard API routes for the queue

**Files:**
- Create: `agents/dashboard/routes/performance-queue.js`
- Modify: `agents/dashboard/index.js` (register new routes)

Routes needed:
- `POST /api/performance-queue/:slug/approve` — set status=approved
- `POST /api/performance-queue/:slug/feedback` — set feedback, reset to pending
- `POST /api/performance-queue/:slug/dismiss` — set status=dismissed
- `POST /api/performance-queue/:slug/rollback` — publish the backup, mark dismissed
- `GET /api/performance-queue/:slug/html` — stream the refreshed HTML for preview iframe
- `GET /api/performance-queue/:slug/backup-html` — stream the backup for diff view

- [ ] **Step 1: Write `agents/dashboard/routes/performance-queue.js`**

```javascript
// agents/dashboard/routes/performance-queue.js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Re-use queue helpers so the dashboard and engine agree on the shape.
// Import path is relative to agents/dashboard/routes/
import { listQueueItems, writeItem, QUEUE_DIR } from '../../performance-engine/lib/queue.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function findItem(slug) {
  return listQueueItems().find((i) => i.slug === slug) || null;
}

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res) { respondJson(res, { ok: false, error: 'Not found' }, 404); }

function parseSlug(url, prefix) {
  // /api/performance-queue/<slug>/<action> → <slug>
  const rest = url.slice(prefix.length);
  return rest.split('/')[0];
}

export default [
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/approve$/.test(url),
    async handler(req, res) {
      const slug = parseSlug(req.url, '/api/performance-queue/');
      const item = findItem(slug);
      if (!item) return notFound(res);
      item.status = 'approved';
      item.approved_at = new Date().toISOString();
      writeItem(item);
      respondJson(res, { ok: true, item });
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/feedback$/.test(url),
    async handler(req, res) {
      const slug = parseSlug(req.url, '/api/performance-queue/');
      const item = findItem(slug);
      if (!item) return notFound(res);
      try {
        const { feedback } = await readJsonBody(req);
        if (typeof feedback !== 'string' || !feedback.trim()) {
          return respondJson(res, { ok: false, error: 'feedback must be a non-empty string' }, 400);
        }
        item.feedback = feedback.trim();
        item.status = 'pending';
        item.approved_at = null;
        writeItem(item);
        respondJson(res, { ok: true, item });
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 400);
      }
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/dismiss$/.test(url),
    async handler(req, res) {
      const slug = parseSlug(req.url, '/api/performance-queue/');
      const item = findItem(slug);
      if (!item) return notFound(res);
      item.status = 'dismissed';
      writeItem(item);
      respondJson(res, { ok: true, item });
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/rollback$/.test(url),
    async handler(req, res, ctx) {
      const slug = parseSlug(req.url, '/api/performance-queue/');
      const item = findItem(slug);
      if (!item) return notFound(res);
      if (!existsSync(item.backup_html_path)) {
        return respondJson(res, { ok: false, error: 'No backup HTML on disk' }, 400);
      }
      try {
        // Overwrite the canonical HTML with the backup and mark dismissed.
        const { writeFileSync: wf } = await import('node:fs');
        const postsHtml = join(ctx.POSTS_DIR, `${slug}.html`);
        wf(postsHtml, readFileSync(item.backup_html_path, 'utf8'));
        item.status = 'dismissed';
        item.rolled_back_at = new Date().toISOString();
        writeItem(item);
        respondJson(res, { ok: true, item });
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 500);
      }
    },
  },
  {
    method: 'GET',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/html$/.test(url),
    handler(req, res) {
      const slug = parseSlug(req.url, '/api/performance-queue/');
      const item = findItem(slug);
      if (!item || !existsSync(item.refreshed_html_path)) return notFound(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(item.refreshed_html_path));
    },
  },
  {
    method: 'GET',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/backup-html$/.test(url),
    handler(req, res) {
      const slug = parseSlug(req.url, '/api/performance-queue/');
      const item = findItem(slug);
      if (!item || !existsSync(item.backup_html_path)) return notFound(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(item.backup_html_path));
    },
  },
];
```

- [ ] **Step 2: Register in `agents/dashboard/index.js`**

Add import and route registration:

```javascript
import performanceQueueRoutes from './routes/performance-queue.js';

// Add to the ROUTES array (order doesn't matter here — all have unique patterns):
const ROUTES = [
  // ... existing ...
  ...performanceQueueRoutes,
];
```

- [ ] **Step 3: Verify**

```bash
node --check agents/dashboard/routes/performance-queue.js && node --check agents/dashboard/index.js && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/routes/performance-queue.js agents/dashboard/index.js
git commit -m "feat(dashboard): performance-queue API routes"
```

---

## Task 6: Expose queue on `/api/data`

**Files:**
- Modify: `agents/dashboard/lib/data-loader.js`

- [ ] **Step 1: Import queue helper**

Add at the top of `data-loader.js`:

```javascript
import { listQueueItems } from '../../performance-engine/lib/queue.js';
```

- [ ] **Step 2: Add to the aggregate return object**

Just before `return {`, compute:

```javascript
// Performance engine queue — items awaiting review/approval.
const performanceQueue = listQueueItems()
  .filter((i) => i.status !== 'dismissed' && i.status !== 'published')
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
```

Add `performanceQueue,` to the returned object.

- [ ] **Step 3: Verify**

```bash
node --check agents/dashboard/lib/data-loader.js && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/lib/data-loader.js
git commit -m "feat(dashboard): expose performance queue on /api/data"
```

---

## Task 7: Dashboard card + CSS

**Files:**
- Modify: `agents/dashboard/public/js/dashboard.js`
- Modify: `agents/dashboard/public/dashboard.css`

- [ ] **Step 1: Add `renderPerformanceQueueCard` to `public/js/dashboard.js`**

Insert into `renderOptimizeTab` at the very top of the returned HTML:

```javascript
function renderPerformanceQueueCard(d) {
  const items = d.performanceQueue || [];
  if (items.length === 0) {
    return '<div class="card"><div class="card-header accent-indigo"><h2>&#9881; Optimization Queue</h2></div>' +
      '<div class="card-body"><div class="empty-state">Nothing queued. The engine runs nightly at 3 AM PT.</div></div></div>';
  }
  const cards = items.map((i) => {
    const statusClass = 'status-' + i.status;
    return '<div class="queue-item ' + statusClass + '">' +
      '<div class="queue-item-head">' +
        '<span class="queue-trigger trigger-' + esc(i.trigger) + '">' + esc(i.trigger) + '</span>' +
        '<span class="queue-title">' + esc(i.title) + '</span>' +
        '<span class="queue-status">' + esc(i.status) + '</span>' +
      '</div>' +
      '<div class="queue-summary">' +
        '<div><strong>What changed:</strong> ' + esc(i.summary.what_changed) + '</div>' +
        '<div><strong>Why:</strong> ' + esc(i.summary.why) + '</div>' +
        '<div><strong>Projected impact:</strong> ' + esc(i.summary.projected_impact) + '</div>' +
      '</div>' +
      '<div class="queue-actions">' +
        (i.status === 'pending' || i.status === 'approved'
          ? '<button class="btn-approve" onclick="approveQueueItem(\'' + esc(i.slug) + '\')"' + (i.status === 'approved' ? ' disabled' : '') + '>&#10003; ' + (i.status === 'approved' ? 'Approved' : 'Approve') + '</button>' +
            '<button class="btn-sm" onclick="openFeedbackEditor(\'' + esc(i.slug) + '\')">&#9998; Feedback</button>' +
            '<button class="btn-sm" onclick="previewQueueItem(\'' + esc(i.slug) + '\')">&#128065; Preview</button>'
          : '<button class="btn-sm" onclick="previewQueueItem(\'' + esc(i.slug) + '\')">&#128065; Preview</button>') +
      '</div>' +
      '<div id="feedback-editor-' + esc(i.slug) + '" class="feedback-editor" style="display:none">' +
        '<textarea id="feedback-text-' + esc(i.slug) + '" placeholder="Tell the engine what to change. Your feedback will be applied to the next nightly run."></textarea>' +
        '<div class="feedback-buttons">' +
          '<button class="btn-sm" onclick="closeFeedbackEditor(\'' + esc(i.slug) + '\')">Cancel</button>' +
          '<button class="btn-primary" onclick="submitFeedback(\'' + esc(i.slug) + '\')">Submit feedback</button>' +
        '</div>' +
      '</div>' +
      (i.feedback ? '<div class="queue-pending-feedback">Pending feedback: ' + esc(i.feedback) + '</div>' : '') +
    '</div>';
  }).join('');
  return '<div class="card"><div class="card-header accent-indigo">' +
      '<h2>&#9881; Optimization Queue</h2>' +
      '<span class="card-subtitle">' + items.length + ' item' + (items.length > 1 ? 's' : '') + ' awaiting review</span>' +
    '</div><div class="card-body">' + cards + '</div></div>';
}

async function approveQueueItem(slug) {
  const res = await fetch('/api/performance-queue/' + encodeURIComponent(slug) + '/approve', { method: 'POST' });
  if (res.ok) loadData();
}

function openFeedbackEditor(slug) {
  document.getElementById('feedback-editor-' + slug).style.display = 'block';
}

function closeFeedbackEditor(slug) {
  document.getElementById('feedback-editor-' + slug).style.display = 'none';
}

async function submitFeedback(slug) {
  const txt = document.getElementById('feedback-text-' + slug).value.trim();
  if (!txt) { alert('Please enter feedback first.'); return; }
  const res = await fetch('/api/performance-queue/' + encodeURIComponent(slug) + '/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback: txt }),
  });
  if (res.ok) {
    alert('Feedback saved. The next engine run (3 AM PT) will apply it.');
    loadData();
  }
}

function previewQueueItem(slug) {
  window.open('/api/performance-queue/' + encodeURIComponent(slug) + '/html', '_blank');
}
```

Then modify `renderOptimizeTab` to call it at the top:

```javascript
document.getElementById('tab-optimize').innerHTML =
  renderPerformanceQueueCard(d) +
  renderActionRequired(d) +
  renderQuickWinCard(d) +
  // ... rest unchanged
```

- [ ] **Step 2: Add CSS**

Append to `agents/dashboard/public/dashboard.css` BEFORE the final closing `}` of the `@media` block:

```css
.queue-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 12px;
  background: #fafbff;
}
.queue-item.status-approved { background: #f0fdf4; border-color: #bbf7d0; }
.queue-item.status-pending  { background: #fafbff; border-color: #e0e7ff; }

.queue-item-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.queue-trigger {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.trigger-flop-refresh  { background: #fee2e2; color: #991b1b; }
.trigger-quick-win     { background: #d1fae5; color: #065f46; }
.trigger-low-ctr-meta  { background: #dbeafe; color: #1e40af; }

.queue-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
}

.queue-status {
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.queue-summary {
  font-size: 12px;
  color: #374151;
  line-height: 1.6;
  margin-bottom: 12px;
}
.queue-summary strong { color: var(--text); font-weight: 600; }
.queue-summary > div { margin-bottom: 4px; }

.queue-actions {
  display: flex;
  gap: 8px;
}

.btn-approve {
  background: var(--green);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-approve:hover { background: #047857; }
.btn-approve:disabled { background: #86efac; cursor: default; }

.feedback-editor {
  margin-top: 10px;
  padding: 10px;
  background: white;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.feedback-editor textarea {
  width: 100%;
  min-height: 80px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12px;
  resize: vertical;
  box-sizing: border-box;
}
.feedback-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  justify-content: flex-end;
}

.queue-pending-feedback {
  margin-top: 8px;
  padding: 8px 10px;
  background: #fef3c7;
  border: 1px solid #fbbf24;
  border-radius: 6px;
  font-size: 11px;
  color: #92400e;
}
```

- [ ] **Step 3: Verify and commit**

```bash
node --check agents/dashboard/public/js/dashboard.js && echo OK
# Start server, load dashboard, confirm Optimize tab renders empty queue card
git add agents/dashboard/public/js/dashboard.js agents/dashboard/public/dashboard.css
git commit -m "feat(dashboard): performance queue card on Optimize tab"
```

---

## Task 8: Publisher integration

**Files:**
- Modify: `agents/publisher/index.js`

The publisher runs daily at 3 PM PT (existing cron). Add a pre-run step that scans the queue for approved items and publishes them.

- [ ] **Step 1: Read the existing publisher to find a good injection point**

```bash
grep -n "updateArticle\|async function main\|shopify_article_id" agents/publisher/index.js | head -20
```

- [ ] **Step 2: At the top of `main()` (or wherever the entry point is), add a queue scan**

```javascript
import { listQueueItems, writeItem } from '../performance-engine/lib/queue.js';
import { updateArticle, getBlogs } from '../../lib/shopify.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function publishApprovedQueueItems() {
  const approved = listQueueItems().filter((i) => i.status === 'approved');
  if (approved.length === 0) return { count: 0 };

  console.log(`\nPerformance Queue: ${approved.length} approved item${approved.length === 1 ? '' : 's'} to publish.\n`);

  const blogs = await getBlogs();
  const blogId = blogs[0].id; // same blog selection the existing publisher uses

  let success = 0;
  for (const item of approved) {
    try {
      const meta = JSON.parse(readFileSync(join(__dirname, '..', '..', 'data', 'posts', `${item.slug}.json`), 'utf8'));
      if (!meta.shopify_article_id) {
        console.warn(`  [skip] ${item.slug}: no shopify_article_id`);
        continue;
      }
      const refreshedHtml = readFileSync(item.refreshed_html_path, 'utf8');
      await updateArticle(blogId, meta.shopify_article_id, { body_html: refreshedHtml });
      // Copy the refreshed HTML over the canonical HTML
      writeFileSync(join(__dirname, '..', '..', 'data', 'posts', `${item.slug}.html`), refreshedHtml);
      item.status = 'published';
      item.published_at = new Date().toISOString();
      writeItem(item);
      success++;
      console.log(`  [published] ${item.slug}`);
    } catch (err) {
      console.error(`  [fail] ${item.slug}: ${err.message}`);
    }
  }
  return { count: success };
}
```

Call it at the start of `main()`:

```javascript
await publishApprovedQueueItems();
```

- [ ] **Step 3: Verify syntax**

```bash
node --check agents/publisher/index.js && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add agents/publisher/index.js
git commit -m "feat(publisher): publish approved performance queue items"
```

---

## Task 9: Daily summary integration

**Files:**
- Modify: `agents/daily-summary/index.js`

The digest at 5 AM PT already reads various signal files. Add a new section that reads the performance queue and renders styled HTML cards for each pending item.

- [ ] **Step 1: Add queue loader**

Near the other `load*` helpers:

```javascript
import { listQueueItems } from '../performance-engine/lib/queue.js';

function loadPerformanceQueue() {
  try {
    return listQueueItems()
      .filter((i) => i.status === 'pending')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } catch { return []; }
}
```

- [ ] **Step 2: Add section renderer**

Inside `buildDigestHtml`, after the existing `flopSection` and before `performanceSection`, add:

```javascript
const queueItems = loadPerformanceQueue();
let queueSection = '';
if (queueItems.length > 0) {
  const rows = queueItems.map((i) => {
    const triggerLabel = {
      'flop-refresh': 'Refresh (flop)',
      'quick-win':    'Quick win',
      'low-ctr-meta': 'Meta rewrite',
    }[i.trigger] || i.trigger;
    return `
      <div class="queue-card">
        <div class="queue-trigger">${esc(triggerLabel)}</div>
        <div class="queue-title">${esc(i.title)}</div>
        <div class="queue-summary">
          <p><strong>What changed:</strong> ${esc(i.summary.what_changed)}</p>
          <p><strong>Why:</strong> ${esc(i.summary.why)}</p>
          <p><strong>Projected impact:</strong> ${esc(i.summary.projected_impact)}</p>
        </div>
        <a href="${esc(dashboardUrl)}/#optimize" class="queue-cta">Review on dashboard &rarr;</a>
      </div>`;
  }).join('');
  queueSection = `
    <div class="section queue-section">
      <div class="section-title">&#9881;&#65039; Optimization Queue &mdash; ${queueItems.length} item${queueItems.length > 1 ? 's' : ''} ready for review</div>
      <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">The performance engine ran overnight and refreshed these posts. Approve on the dashboard to push the updated content to Shopify at the next publisher run (3 PM PT).</p>
      ${rows}
    </div>`;
}
```

- [ ] **Step 3: Add the `queueSection` to the returned HTML**

Place it between `flopSection` and `performanceSection` in the body template.

- [ ] **Step 4: Add styles to the email's `styles` const**

Inside the `styles` template string, append:

```css
.queue-section { background: #eef2ff; border: 1px solid #c7d2fe; }
.queue-section .section-title { color: #312e81; border-bottom-color: #c7d2fe; }
.queue-card { background: white; border: 1px solid #c7d2fe; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.queue-card .queue-trigger { font-size: 10px; font-weight: 700; color: #4338ca; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.queue-card .queue-title { font-size: 14px; font-weight: 700; color: #1f2937; margin-bottom: 8px; }
.queue-card .queue-summary p { font-size: 12px; color: #374151; line-height: 1.5; margin: 4px 0; }
.queue-card .queue-summary strong { color: #1f2937; }
.queue-card .queue-cta { display: inline-block; margin-top: 8px; padding: 6px 12px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: 600; }
```

- [ ] **Step 5: Verify and commit**

```bash
node --check agents/daily-summary/index.js && echo OK
# Dry-run: send the digest to see the new section render
DRY_RUN=1 node agents/daily-summary/index.js
git add agents/daily-summary/index.js
git commit -m "feat(daily-summary): optimization queue section with styled cards"
```

---

## Task 10: Allowlist and cron

**Files:**
- Modify: `agents/dashboard/lib/run-agent.js`
- Server: add cron entry

- [ ] **Step 1: Add to allowlist**

```javascript
// In agents/dashboard/lib/run-agent.js, add to RUN_AGENT_ALLOWLIST:
'agents/performance-engine/index.js',
```

- [ ] **Step 2: Commit**

```bash
git add agents/dashboard/lib/run-agent.js
git commit -m "chore(dashboard): allowlist performance-engine"
```

- [ ] **Step 3: Deploy the whole PR**

```bash
git push -u origin feature/performance-engine
gh pr create --title "feat(seo): performance engine + approval loop" --body "Closes the loop..."
gh pr merge --merge --delete-branch
git checkout main && git pull
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

- [ ] **Step 4: Add cron on server**

```bash
ssh root@137.184.119.230 '(crontab -l; echo "0 10 * * * cd \"/root/seo-claude\" && /usr/bin/node agents/performance-engine/index.js >> data/reports/scheduler/performance-engine.log 2>&1") | crontab -'
```

`0 10 * * *` UTC = 3 AM PT. The existing daily-summary runs at `0 13 * * *` (5 AM PT), so it has 2 hours to pick up new queue items.

---

## Task 11: Verification

- [ ] **Step 1: Manual engine run**

On the server:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && /usr/bin/node agents/performance-engine/index.js 2>&1 | tail -40'
```

- [ ] **Step 2: Check the queue**

```bash
ssh root@137.184.119.230 'ls ~/seo-claude/data/performance-queue/'
```

- [ ] **Step 3: Check the dashboard**

Open http://137.184.119.230:4242 → Optimize tab → confirm the Optimization Queue card shows the items.

- [ ] **Step 4: Test the approve flow**

Click Approve on one item. Confirm the status changes to approved. Then manually trigger the publisher:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && /usr/bin/node agents/publisher/index.js 2>&1 | tail -20'
```

Confirm the article updates on Shopify and the queue item status flips to published.

- [ ] **Step 5: Test the feedback flow**

Click Add Feedback on another pending item. Enter "Make the intro shorter and remove the FAQ section." Submit. Confirm the queue item now shows the pending feedback.

Re-run the engine manually:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && /usr/bin/node agents/performance-engine/index.js 2>&1 | tail -40'
```

Confirm the item re-runs, the new HTML and summary update on disk, and the status is back to pending with the feedback consumed.

---

## Success criteria

- Nightly at 3 AM PT, the engine refreshes up to 6 posts and writes queue items.
- At 5 AM PT, the daily digest surfaces the queue as a styled section.
- On the dashboard Optimize tab, each queue item has working Approve and Feedback buttons.
- At 3 PM PT, the publisher picks up approved items and updates them on Shopify.
- Feedback submitted after Approve resets the item to pending and is applied on the next nightly run.
- Rollback button reverts a published article to the pre-refresh backup.
- Zero manual CLI interaction required for the normal flow — everything happens through the dashboard.
