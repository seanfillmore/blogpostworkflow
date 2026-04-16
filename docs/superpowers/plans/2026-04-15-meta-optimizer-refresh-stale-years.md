# Meta Optimizer: Refresh Stale Years Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--refresh-stale-years` mode to `agents/meta-optimizer/index.js` that scans every published blog article on Shopify, detects stale year references in the title and meta description (`summary_html`), and rewrites them to use the current year — clearing the ~20-post backlog currently hard-blocked by the editor.

**Architecture:** Deterministic regex replacement (no LLM call needed — "2025 → 2026" doesn't require creative rewriting). The agent iterates Shopify blog articles via the existing `getBlogs()` / `getArticles()` helpers, applies year replacement to the `title` and `summary_html` fields, and pushes updates via `updateArticle()`. Local `data/posts/<slug>/meta.json` is kept in sync so the editor sees the refreshed state on subsequent runs.

**Tech Stack:** Node.js ES modules, Shopify Admin REST API (via `lib/shopify.js` — `getBlogs`, `getArticles`, `updateArticle`).

**Scope boundary:** Blog articles only. Shopify pages, products, and collections also store stale years in their `global.title_tag` / `global.description_tag` metafields, but the current backlog is in blog articles. Extending to those resource types is a follow-up (minor — reuse the same `refreshStaleYears` helper, iterate `getPages` / `getProducts` / `getCustomCollections`, write via `upsertMetafield`). Not in this plan.

**Single-post mode:** The spec envisions this agent being called by the editor orchestrator for individual posts. That mode comes in Stage 2 (orchestrator implementation). This plan ships batch mode only, which is all that's needed to clear the current backlog.

---

## Task 0: Set up the feature branch

**Files:** None (workflow step).

- [ ] **Step 1: Create the feature branch**

Run: `git checkout -b feature/meta-optimizer-refresh-stale-years`
Expected: `Switched to a new branch 'feature/meta-optimizer-refresh-stale-years'`.

- [ ] **Step 2: Verify clean working tree**

Run: `git status`
Expected: "nothing to commit, working tree clean" (or only untracked data files — those are fine).

---

## Task 1: Extract year-refresh logic into a pure, testable helper

**Files:**
- Create: `agents/meta-optimizer/lib/refresh-stale-years.js`
- Create: `agents/meta-optimizer/lib/refresh-stale-years.test.js`

- [ ] **Step 1: Write the failing tests**

Create `agents/meta-optimizer/lib/refresh-stale-years.test.js`:

```js
import { refreshStaleYears } from './refresh-stale-years.js';

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; return; }
  console.log('  ✓', msg);
}

const currentYear = new Date().getFullYear();
const lastYear = currentYear - 1;
const twoYearsAgo = currentYear - 2;

console.log('refreshStaleYears()\n');

// Basic stale year replacement
{
  const { text, changed } = refreshStaleYears(`Best Aluminum Free Deodorant in ${lastYear}`);
  assert(text === `Best Aluminum Free Deodorant in ${currentYear}`, 'replaces last year in title');
  assert(changed === true, 'changed flag is true when replacement happened');
}

// Multiple stale years in same string
{
  const { text, changed } = refreshStaleYears(`Best of ${twoYearsAgo} & ${lastYear} Comparison`);
  assert(text === `Best of ${currentYear} & ${currentYear} Comparison`, 'replaces multiple stale years');
  assert(changed === true, 'changed when multiple replacements');
}

// Current year is untouched
{
  const { text, changed } = refreshStaleYears(`Best Deodorant in ${currentYear}`);
  assert(text === `Best Deodorant in ${currentYear}`, 'leaves current year alone');
  assert(changed === false, 'changed is false when no replacement');
}

// Future years are untouched (don't invent fresh content)
{
  const nextYear = currentYear + 1;
  const { text, changed } = refreshStaleYears(`Planned for ${nextYear}`);
  assert(text === `Planned for ${nextYear}`, 'leaves future years alone');
  assert(changed === false, 'changed is false for future years');
}

// No years at all
{
  const { text, changed } = refreshStaleYears('Best Natural Deodorant Review');
  assert(text === 'Best Natural Deodorant Review', 'leaves year-free text alone');
  assert(changed === false, 'changed is false when no years present');
}

// Empty/null input
{
  const { text, changed } = refreshStaleYears('');
  assert(text === '', 'handles empty string');
  assert(changed === false, 'no change on empty');
}
{
  const { text, changed } = refreshStaleYears(null);
  assert(text === '', 'handles null input');
  assert(changed === false, 'no change on null');
}

// Year inside HTML tag (summary_html case)
{
  const { text, changed } = refreshStaleYears(`<p>Updated for ${lastYear} with new picks.</p>`);
  assert(text === `<p>Updated for ${currentYear} with new picks.</p>`, 'replaces year inside HTML');
  assert(changed === true, 'changed when year is in HTML');
}

// Year as part of a longer number (e.g., phone number 2025551234) is NOT matched
{
  const { text, changed } = refreshStaleYears(`Call 2025551234 today`);
  assert(text === `Call 2025551234 today`, 'does not match year inside longer digit run');
  assert(changed === false, 'changed is false when "year" is part of longer number');
}

// Year 2019 and older are NOT touched (treated as historical references)
{
  const { text, changed } = refreshStaleYears(`A 2018 study showed`);
  assert(text === `A 2018 study showed`, 'leaves pre-2020 years alone (historical)');
  assert(changed === false, 'changed is false for pre-2020 years');
}

console.log('\nDone.');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node agents/meta-optimizer/lib/refresh-stale-years.test.js`
Expected: Error — `Cannot find module './refresh-stale-years.js'`

- [ ] **Step 3: Write the helper**

Create `agents/meta-optimizer/lib/refresh-stale-years.js`:

```js
/**
 * Replaces stale year references (2020 through current year - 1) with the
 * current year. Leaves the current year, future years, and pre-2020 years
 * (historical references) untouched.
 *
 * Uses \b boundaries so "year" embedded in a longer digit run (e.g. phone
 * numbers) is not matched.
 *
 * Returns { text, changed } — `changed` is true if any replacement happened.
 */
export function refreshStaleYears(input) {
  if (!input) return { text: '', changed: false };
  const currentYear = new Date().getFullYear();
  const minYear = 2020;
  let changed = false;
  const text = input.replace(/\b(20\d{2})\b/g, (match, yearStr) => {
    const year = parseInt(yearStr, 10);
    if (year >= minYear && year < currentYear) {
      changed = true;
      return String(currentYear);
    }
    return match;
  });
  return { text, changed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node agents/meta-optimizer/lib/refresh-stale-years.test.js`
Expected: All assertions pass, no `✗ FAIL` lines.

- [ ] **Step 5: Commit**

```bash
git add agents/meta-optimizer/lib/refresh-stale-years.js agents/meta-optimizer/lib/refresh-stale-years.test.js
git commit -m "feat(meta-optimizer): add year-refresh helper with tests"
```

---

## Task 2: Add `--refresh-stale-years` mode to the meta-optimizer agent

**Files:**
- Modify: `agents/meta-optimizer/index.js`

- [ ] **Step 1: Import the helper and sync helpers at the top of the file**

At `agents/meta-optimizer/index.js`, find the existing imports block (around line 26-32):

```js
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
```

Replace with:

```js
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import { getPostMeta, getMetaPath, listAllSlugs } from '../../lib/posts.js';
import * as gsc from '../../lib/gsc.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { refreshStaleYears } from './lib/refresh-stale-years.js';
```

- [ ] **Step 2: Add the refresh function**

In `agents/meta-optimizer/index.js`, find the last top-level function above `main()` (search for the line `async function main(` to find `main`; the refresh function goes just above it). Add this new function immediately above `async function main(`:

```js
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

          // Sync local meta.json so the editor agent sees the refreshed state
          syncLocalMeta(article.handle, { title: record.titleAfter });

          console.log(`    ✓ Updated on Shopify${titleResult.changed ? ' (+ local meta)' : ''}`);
        } catch (e) {
          console.error(`    ✗ Shopify update failed: ${e.message}`);
        }
      }

      changes.push(record);
    }
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
    if (!existsSync(metaPath)) return;
    const meta = getPostMeta(handle);
    if (!meta) return;
    const updated = { ...meta, ...updates };
    writeFileSync(metaPath, JSON.stringify(updated, null, 2));
  } catch (e) {
    console.warn(`    Warning: could not sync local meta for ${handle}: ${e.message}`);
  }
}
```

- [ ] **Step 3: Wire the new flag into main()**

In `agents/meta-optimizer/index.js`, find the `main()` function (search for `async function main(`). Find where args are parsed and the dispatcher logic begins. The existing structure runs the GSC-based optimizer unconditionally. Add the flag handling.

Find the existing args parsing block (near the top of main, after `const args = process.argv.slice(2);`). It should look similar to:

```js
const args = process.argv.slice(2);
const apply = args.includes('--apply');
```

Immediately after `const apply = args.includes('--apply');`, add:

```js
const refreshStaleYearsMode = args.includes('--refresh-stale-years');
```

Then find the first line of actual work in `main()` (the line that begins the GSC-based optimizer flow — likely `const blogs = await getBlogs();` or similar, or a call to a function). Immediately BEFORE that line, insert:

```js
if (refreshStaleYearsMode) {
  await runRefreshStaleYears({ apply });
  return;
}
```

This short-circuits the GSC flow when `--refresh-stale-years` is set.

- [ ] **Step 4: Update the usage comment at the top of the file**

Find the comment block at the top of `agents/meta-optimizer/index.js` that starts with `* Usage:` and lists the CLI options. Append a new line to the usage examples:

Find:
```
 *   node agents/meta-optimizer/index.js --limit 20     # max pages to process
 */
```

Replace with:
```
 *   node agents/meta-optimizer/index.js --limit 20                # max pages to process
 *   node agents/meta-optimizer/index.js --refresh-stale-years     # scan all posts for stale years (dry run)
 *   node agents/meta-optimizer/index.js --refresh-stale-years --apply  # scan + push refreshed titles to Shopify
 */
```

- [ ] **Step 5: Syntax check**

Run: `node --check agents/meta-optimizer/index.js`
Expected: No output (success).

- [ ] **Step 6: Commit**

```bash
git add agents/meta-optimizer/index.js
git commit -m "feat(meta-optimizer): add --refresh-stale-years batch mode"
```

---

## Task 3: Local dry-run — verify detection before applying

**Files:** No code changes. Verification step.

- [ ] **Step 1: Run the dry-run locally**

Run: `node agents/meta-optimizer/index.js --refresh-stale-years`
Expected:
- Prints each article with stale years, showing before/after
- Writes `data/reports/meta-optimizer/stale-years-report.md`
- Final line: `Done. Scanned N article(s), M had stale years.`

- [ ] **Step 2: Inspect the report**

Open `data/reports/meta-optimizer/stale-years-report.md` and confirm:
- The ~20 expected hard-blocked posts appear
- Each change makes sense (e.g., `Best Aluminum Free Deodorant in 2025` → `Best Aluminum Free Deodorant in 2026`)
- No false positives (current-year posts not listed)

If the report looks wrong, STOP and investigate. Do not proceed to apply.

- [ ] **Step 3: Sanity-check a specific known post**

Pick one post from the report (e.g., the one the user originally flagged). Verify its title actually contains a stale year on Shopify by checking [the Shopify admin](https://admin.shopify.com/) or via:

```bash
node -e "
const { getBlogs, getArticles } = await import('./lib/shopify.js');
const blogs = await getBlogs();
const arts = await getArticles(blogs[0].id);
const match = arts.find((a) => a.handle === 'PASTE-HANDLE-HERE');
console.log('title:', match?.title);
"
```

Expected: `title: <something with a stale year>`

---

## Task 4: Apply locally on one post, verify, then batch-apply

**Files:** No code changes. Verification step.

- [ ] **Step 1: Apply the batch update**

Run: `node agents/meta-optimizer/index.js --refresh-stale-years --apply`
Expected:
- Each changed article prints `✓ Updated on Shopify (+ local meta)` or `✓ Updated on Shopify`
- Final summary shows N updated

- [ ] **Step 2: Verify one post on Shopify admin**

Open the Shopify admin for the post the user originally flagged. Confirm the title is now current-year.

- [ ] **Step 3: Re-run the editor on that post to verify the blocker cleared**

Run: `node agents/editor/index.js data/posts/<slug>/content.html`
Expected: Editor report no longer flags stale year in title. The editorial review section for Year Accuracy should say PASS (or at minimum no longer list the title year as a blocker).

If the editor still flags a stale year blocker, STOP and investigate — something in the local meta sync did not happen correctly.

---

## Task 5: Wire into the daily scheduler

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Add the scheduler step**

In `scheduler.js`, find the daily section. The legacy-rebuilder step was recently added as "Step 5f". Find that line:

```js
// Step 5f: rebuild legacy / editor-tagged posts — max 5 per day, daily until backlog clears
runStep('legacy-rebuilder', `"${NODE}" agents/legacy-rebuilder/index.js --limit 5 --apply${dryFlag}`);
```

Immediately after that line, insert:

```js

// Step 5g: refresh stale year references in titles + meta descriptions (idempotent)
runStep('meta-optimizer --refresh-stale-years', `"${NODE}" agents/meta-optimizer/index.js --refresh-stale-years${dryFlag ? '' : ' --apply'}`);
```

Note: this step runs with `--apply` by default (no dry flag), matching the behaviour of the other daily scheduler steps. `dryFlag` is the existing scheduler variable that short-circuits writes when the scheduler itself is in dry-run mode.

- [ ] **Step 2: Syntax check**

Run: `node --check scheduler.js`
Expected: No output.

- [ ] **Step 3: Commit**

```bash
git add scheduler.js
git commit -m "feat(scheduler): run meta-optimizer year refresh daily"
```

---

## Task 6: Open PR and ship

**Files:** None (workflow step).

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feature/meta-optimizer-refresh-stale-years`

(If you were working on a different branch name, substitute it here. The branch should have been created at the start of implementation.)

- [ ] **Step 2: Open the PR**

Run:

```bash
gh pr create --title "feat(meta-optimizer): refresh stale years to clear editor backlog" --body "$(cat <<'EOF'
## Summary
- Adds \`--refresh-stale-years\` mode to \`agents/meta-optimizer/index.js\`
- Scans every published blog article on Shopify, detects stale year references (2020..currentYear-1) in title and summary_html, rewrites to current year
- Deterministic regex replacement — no LLM call, fast, idempotent
- Syncs local \`data/posts/<slug>/meta.json\` so editor sees refreshed titles on next run
- Wired into daily scheduler; once backlog clears, the step becomes a no-op

## Test plan
- [x] Unit tests in \`agents/meta-optimizer/lib/refresh-stale-years.test.js\` pass
- [x] Dry-run locally lists ~20 posts with stale years
- [x] \`--apply\` locally updates Shopify titles + local meta
- [x] Editor re-run on a previously-blocked post no longer flags stale-year blocker

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Merge the PR**

Run: `gh pr merge --merge`

- [ ] **Step 4: Sync local main**

Run: `git checkout main && git pull`
Expected: Fast-forward with the feature branch commits.

- [ ] **Step 5: Deploy to server**

Run: `ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'`
Expected: Git pulls cleanly (or merges with local data file updates per the deploy hygiene notes), PM2 shows `seo-dashboard online`.

---

## Task 7: Server-side verification

**Files:** None (verification step).

- [ ] **Step 1: Run the dry-run on the server**

Run: `ssh root@137.184.119.230 'cd ~/seo-claude && node agents/meta-optimizer/index.js --refresh-stale-years'`
Expected: Same report as local.

- [ ] **Step 2: Apply on the server**

Run: `ssh root@137.184.119.230 'cd ~/seo-claude && node agents/meta-optimizer/index.js --refresh-stale-years --apply'`
Expected: Updates Shopify with the same changes applied locally (idempotent — only articles still showing stale years get touched).

- [ ] **Step 3: Count the cleared backlog**

Before this change, the editor was hard-blocking ~20 posts on stale year in title. Verify the count has dropped:

Run:
```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node -e "
const { listAllSlugs, getPostMeta } = await import(\"./lib/posts.js\");
const stale = listAllSlugs().filter((s) => {
  const m = getPostMeta(s);
  if (!m?.title) return false;
  const currentYear = new Date().getFullYear();
  return /\b(20\d{2})\b/.test(m.title) && parseInt(m.title.match(/20\d{2}/)[0], 10) < currentYear;
});
console.log(stale.length + \" posts still have stale years in title\");
stale.slice(0, 10).forEach((s) => console.log(\"  -\", s));
"'
```

Expected: `0 posts still have stale years in title`. If non-zero, inspect the listed slugs — the replacement may have missed them (possibly a year format the regex didn't catch, e.g. "'25").

- [ ] **Step 4: Verify next editor pass clears the rebuild tags**

The editor runs daily via the scheduler on tagged posts (Step 5f). Tomorrow's scheduler run should clear the `needs_rebuild` tags on posts that were only blocked by stale years. To verify sooner without waiting for the scheduler:

Run: `ssh root@137.184.119.230 'cd ~/seo-claude && node agents/legacy-rebuilder/index.js'`
Expected: Fewer flagged posts than before. Any post whose only issue was the stale-year title should no longer appear.

---
