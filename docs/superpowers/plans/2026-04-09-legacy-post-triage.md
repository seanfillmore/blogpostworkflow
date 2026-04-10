# Legacy Post Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a triage agent that classifies 94 legacy published posts into 4 buckets (winner/rising/flop/broken) using existing SEO signals, then integrate with the dashboard, performance engine, and downstream agents so each bucket gets the right treatment automatically.

**Architecture:** One new agent (`legacy-triage`) reads indexing state, rank snapshots, GSC performance, and word counts. It stamps each legacy post's JSON with `legacy_bucket` and optionally `legacy_locked`. Downstream agents check these fields before acting. The dashboard gets a new card. The performance engine gets a new candidate picker for legacy flops.

**Tech Stack:** Node.js ESM, existing `lib/gsc.js`, existing signal files from indexing-checker and rank-tracker.

---

## File structure

**Created:**
- `agents/legacy-triage/index.js` — the triage agent (~250 lines)

**Modified:**
- `agents/performance-engine/index.js` — add `pickLegacyFlops` candidate picker
- `agents/content-refresher/index.js` — check `legacy_locked` before refreshing
- `agents/refresh-runner/index.js` — check `legacy_locked` before refreshing
- `agents/meta-optimizer/index.js` — check `legacy_locked` before rewriting
- `agents/dashboard/lib/data-loader.js` — expose triage data on `/api/data`
- `agents/dashboard/public/js/dashboard.js` — new Legacy Triage card on Optimize tab
- `agents/dashboard/lib/run-agent.js` — add to allowlist
- `docs/signal-manifest.md` — add triage producer/consumer entries

---

## Task 1: Build the triage agent

**Files:**
- Create: `agents/legacy-triage/index.js`

- [ ] **Step 1: Create the agent**

```javascript
#!/usr/bin/env node
/**
 * Legacy Post Triage
 *
 * One-time classification pass (re-runnable) that sorts legacy published
 * posts into 4 buckets: winner, rising, flop, broken. Stamps each post's
 * JSON with legacy_bucket and legacy_triage_reason. Auto-locks winners.
 *
 * Usage:
 *   node agents/legacy-triage/index.js
 *   node agents/legacy-triage/index.js --dry-run
 *   node agents/legacy-triage/index.js --force   # re-triage already-bucketed posts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'legacy-triage');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const CANONICAL_ROOT = (config.url || '').replace(/\/$/, '');

// ── helpers ──────────────────────────────────────────────────────────────────

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isLegacy(meta) {
  return !!(meta.legacy_source || meta.legacy_synced_at || !meta.target_keyword || meta.target_keyword === '');
}

function wordCount(slug) {
  const html = join(POSTS_DIR, `${slug}.html`);
  if (!existsSync(html)) return 0;
  return readFileSync(html, 'utf8').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function toCanonicalUrl(meta) {
  if (meta.shopify_handle) return `${CANONICAL_ROOT}/blogs/news/${meta.shopify_handle}`;
  if (meta.shopify_url) return meta.shopify_url.replace(/https?:\/\/[^\/]+/, CANONICAL_ROOT);
  return null;
}

// ── signal loaders ──────────────────────────────────────────────────────────

function loadIndexingStates() {
  const idx = readJsonSafe(join(ROOT, 'data', 'reports', 'indexing', 'latest.json'));
  if (!idx) return {};
  const map = {};
  for (const r of (idx.results || [])) {
    if (r.slug) map[r.slug] = r.state;
    if (r.url) map[r.url] = r.state;
  }
  return map;
}

function loadRankData() {
  const dir = join(ROOT, 'data', 'rank-snapshots');
  if (!existsSync(dir)) return {};
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (!files.length) return {};
  const snap = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8'));
  const map = {};
  for (const p of (snap.posts || [])) {
    if (p.slug) map[p.slug] = p;
    if (p.url) map[p.url] = p;
  }
  return map;
}

async function loadGscPerformance(url) {
  try {
    const gsc = await import('../../lib/gsc.js');
    return await gsc.getPagePerformance(url, 90);
  } catch { return null; }
}

// ── classification ──────────────────────────────────────────────────────────

const BROKEN_STATES = new Set(['not_found', 'excluded_noindex', 'excluded_robots', 'excluded_canonical']);

function classify({ meta, indexState, rankEntry, gscMetrics, words }) {
  // Broken — technical issue, skip content pipeline
  if (BROKEN_STATES.has(indexState) || meta.indexing_blocked) {
    return { bucket: 'broken', reason: `Indexing state: ${indexState || 'blocked'}. Technical fix required.` };
  }

  // crawled_not_indexed — Google looked and declined
  if (indexState === 'crawled_not_indexed') {
    return { bucket: 'flop', reason: 'Google crawled but chose not to index. Content quality or duplicate issue.' };
  }

  const position = rankEntry?.position ?? gscMetrics?.position ?? null;
  const impressions = gscMetrics?.impressions ?? 0;
  const clicks = gscMetrics?.clicks ?? 0;
  const isIndexed = indexState === 'indexed' || impressions > 0;

  // Winner — page 1 with real traffic signal
  if (isIndexed && position != null && position <= 10 && impressions >= 10) {
    return { bucket: 'winner', reason: `Position ${Math.round(position)}, ${impressions} impressions. Page 1 — auto-locked.` };
  }

  // Rising — positions 11-30 with impression signal
  if (isIndexed && position != null && position >= 11 && position <= 30 && impressions >= 10) {
    return { bucket: 'rising', reason: `Position ${Math.round(position)}, ${impressions} impressions. Meta-only optimization candidate.` };
  }

  // Flop — thin content
  if (words < 800) {
    return { bucket: 'flop', reason: `Thin content (${words} words). Full rewrite needed.` };
  }

  // Flop — indexed but zero signal after presumed long life
  if (isIndexed && impressions === 0) {
    return { bucket: 'flop', reason: 'Indexed but zero impressions in 90 days. Content not matching any search query.' };
  }

  // Flop — not indexed and not in broken states (just neglected)
  if (!isIndexed && !BROKEN_STATES.has(indexState)) {
    return { bucket: 'flop', reason: `Not indexed (state: ${indexState || 'unknown'}). Needs rewrite or technical investigation.` };
  }

  // Flop — position >50 or no ranking data
  if (position == null || position > 50) {
    return { bucket: 'flop', reason: `${position ? 'Position ' + Math.round(position) : 'No ranking data'}. Not competitive.` };
  }

  // Default fallback — if we get here, something unexpected. Call it rising to avoid
  // accidentally rewriting a decent post.
  return { bucket: 'rising', reason: `Position ${Math.round(position)}, ${impressions} impressions. Default: meta-only.` };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nLegacy Post Triage\n');

  mkdirSync(REPORTS_DIR, { recursive: true });

  // Load all published legacy posts
  const posts = [];
  for (const f of readdirSync(POSTS_DIR).filter(x => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
      if (!meta.slug) meta.slug = basename(f, '.json');
      if (meta.shopify_status !== 'published') continue;
      if (!isLegacy(meta)) continue;
      if (meta.legacy_bucket && !FORCE) continue; // already triaged
      meta._file = join(POSTS_DIR, f);
      posts.push(meta);
    } catch { /* skip */ }
  }

  console.log(`  Legacy published posts to triage: ${posts.length}`);
  if (posts.length === 0) { console.log('  Nothing to triage.'); return; }

  const indexStates = loadIndexingStates();
  const rankData = loadRankData();
  console.log(`  Indexing states loaded: ${Object.keys(indexStates).length}`);
  console.log(`  Rank entries loaded: ${Object.keys(rankData).length}`);

  const results = [];
  const bucketCounts = { winner: 0, rising: 0, flop: 0, broken: 0 };

  for (const meta of posts) {
    const slug = meta.slug;
    const url = toCanonicalUrl(meta);
    const indexState = indexStates[slug] || (url ? indexStates[url] : null) || null;
    const rankEntry = rankData[slug] || (url ? rankData[url] : null) || null;
    const words = wordCount(slug);

    // GSC call per post — rate-limited but we have 500/day quota headroom
    let gscMetrics = null;
    if (url) {
      try { gscMetrics = await loadGscPerformance(url); } catch { /* skip */ }
    }

    const { bucket, reason } = classify({ meta, indexState, rankEntry, gscMetrics, words });
    bucketCounts[bucket]++;

    const entry = {
      slug,
      title: meta.title || slug,
      url,
      bucket,
      reason,
      position: rankEntry?.position ?? gscMetrics?.position ?? null,
      impressions: gscMetrics?.impressions ?? 0,
      clicks: gscMetrics?.clicks ?? 0,
      words,
      indexing_state: indexState,
    };
    results.push(entry);

    const icon = bucket === 'winner' ? 'WINNER' : bucket === 'rising' ? 'RISING' : bucket === 'flop' ? 'FLOP' : 'BROKEN';
    console.log(`  [${icon}] ${slug} — ${reason.slice(0, 80)}`);

    // Stamp the post JSON
    if (!DRY_RUN) {
      meta.legacy_bucket = bucket;
      meta.legacy_triage_reason = reason;
      if (bucket === 'winner') meta.legacy_locked = true;
      meta.legacy_triaged_at = new Date().toISOString();
      writeFileSync(meta._file, JSON.stringify({ ...meta, _file: undefined }, null, 2));
    }
  }

  console.log('\n  Summary:');
  for (const [b, c] of Object.entries(bucketCounts)) console.log(`    ${b}: ${c}`);

  // Write reports
  if (!DRY_RUN) {
    const snapshot = {
      generated_at: new Date().toISOString(),
      total: posts.length,
      counts: bucketCounts,
      results,
    };
    writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));

    const dateStr = new Date().toISOString().slice(0, 10);
    const md = [
      `# Legacy Post Triage — ${dateStr}`,
      '',
      `Total: ${posts.length} | Winners: ${bucketCounts.winner} | Rising: ${bucketCounts.rising} | Flops: ${bucketCounts.flop} | Broken: ${bucketCounts.broken}`,
      '',
      '## Winners (locked)',
      ...results.filter(r => r.bucket === 'winner').map(r => `- **${r.title}** — pos ${Math.round(r.position)}, ${r.impressions} impr`),
      '',
      '## Rising (meta-only)',
      ...results.filter(r => r.bucket === 'rising').map(r => `- **${r.title}** — pos ${r.position ? Math.round(r.position) : '?'}, ${r.impressions} impr`),
      '',
      '## Flops (rewrite)',
      ...results.filter(r => r.bucket === 'flop').map(r => `- **${r.title}** — ${r.words} words, ${r.reason.slice(0, 60)}`),
      '',
      '## Broken (technical fix)',
      ...results.filter(r => r.bucket === 'broken').map(r => `- **${r.title}** — ${r.reason}`),
    ].join('\n');
    writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), md);
  }

  await notify({
    subject: `Legacy Triage: ${bucketCounts.winner} winners, ${bucketCounts.rising} rising, ${bucketCounts.flop} flops, ${bucketCounts.broken} broken`,
    body: `Triaged ${posts.length} legacy posts.\n\n` +
      Object.entries(bucketCounts).map(([b, c]) => `${b}: ${c}`).join('\n'),
    status: bucketCounts.broken > 0 ? 'error' : 'info',
    category: 'seo',
  }).catch(() => {});

  console.log('\nLegacy triage complete.');
}

main().catch(err => {
  console.error('Legacy triage failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify syntax**

```bash
node --check agents/legacy-triage/index.js && echo OK
```

- [ ] **Step 3: Commit**

```bash
mkdir -p agents/legacy-triage
git add agents/legacy-triage/index.js
git commit -m "feat(seo): legacy post triage agent"
```

---

## Task 2: Winner protection — add `legacy_locked` checks to downstream agents

**Files:**
- Modify: `agents/content-refresher/index.js`
- Modify: `agents/refresh-runner/index.js`
- Modify: `agents/meta-optimizer/index.js`

- [ ] **Step 1: Add lock check to content-refresher**

In `agents/content-refresher/index.js`, find the loop that processes each target (around the line `const { article, keyword, position, impressions, relatedKeywords } = targets[i];`). Immediately after the slug is derived, add:

```javascript
    // Winner protection — legacy posts auto-locked by triage must not be refreshed
    try {
      const postMeta = JSON.parse(readFileSync(join(ROOT, 'data', 'posts', `${slug}.json`), 'utf8'));
      if (postMeta.legacy_locked) {
        console.log(`    [skip] ${slug}: legacy winner (locked)`);
        continue;
      }
    } catch { /* proceed if metadata unreadable */ }
```

- [ ] **Step 2: Add lock check to refresh-runner**

In `agents/refresh-runner/index.js`, the function `refreshOne(slug)` already has an indexing-state check at the top. Add the lock check right after it:

```javascript
  // Winner protection — legacy posts auto-locked by triage must not be refreshed
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.legacy_locked) {
      console.log(`  [skip] ${slug}: legacy winner (locked)`);
      return { slug, ok: false, reason: 'legacy winner, locked' };
    }
  } catch { /* proceed */ }
```

- [ ] **Step 3: Add lock check to meta-optimizer**

In `agents/meta-optimizer/index.js`, find the per-item loop (`for (const item of lowCtrPages)`). After the article lookup, add:

```javascript
    // Winner protection
    try {
      const postMeta = JSON.parse(readFileSync(join(ROOT, 'data', 'posts', `${article.handle}.json`), 'utf8'));
      if (postMeta.legacy_locked) {
        console.log(`  [skip] "${keyword}": legacy winner (locked)`);
        continue;
      }
    } catch { /* proceed */ }
```

- [ ] **Step 4: Verify all three**

```bash
node --check agents/content-refresher/index.js && node --check agents/refresh-runner/index.js && node --check agents/meta-optimizer/index.js && echo OK
```

- [ ] **Step 5: Commit**

```bash
git add agents/content-refresher/index.js agents/refresh-runner/index.js agents/meta-optimizer/index.js
git commit -m "feat(seo): winner protection — legacy_locked check in refresher, runner, meta-optimizer"
```

---

## Task 3: Performance engine — add legacy flop picker

**Files:**
- Modify: `agents/performance-engine/index.js`

- [ ] **Step 1: Add `pickLegacyFlops` function**

After the existing `pickMetaRewrites` function, add:

```javascript
function pickLegacyFlops(blocked) {
  const triage = readJsonSafe(join(REPORTS_DIR, '..', 'legacy-triage', 'latest.json'));
  if (!triage) return [];
  return (triage.results || [])
    .filter(r => r.bucket === 'flop' && !blocked.has(r.slug))
    // Skip already-rewritten posts (they'll have a queue item)
    .filter(r => {
      const existing = listQueueItems().find(i => i.slug === r.slug);
      return !existing || existing.status === 'dismissed';
    })
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, MAX_FLOPS)
    .map(r => ({
      slug: r.slug,
      title: r.title || r.slug,
      trigger: 'legacy-flop',
      signal_source: {
        type: 'legacy-triage',
        bucket: 'flop',
        reason: r.reason,
        words: r.words,
        position: r.position,
        impressions: r.impressions,
      },
    }));
}
```

- [ ] **Step 2: Wire into candidate selection**

In the `main()` function, find the section `// Stage 2: new candidates`. After `const metaRewrites = pickMetaRewrites(blocked);`, add:

```javascript
  const legacyFlops = pickLegacyFlops(blocked);
  legacyFlops.forEach(c => blocked.add(c.slug));
```

Update the `candidates` line to include them:

```javascript
  const candidates = [...flops, ...quickWins, ...metaRewrites, ...legacyFlops].slice(0, MAX_ITEMS);
```

Update the log line to include them:

```javascript
  console.log(`    ${flops.length} flops, ${quickWins.length} quick-wins, ${metaRewrites.length} meta, ${legacyFlops.length} legacy flops`);
```

- [ ] **Step 3: Add `trigger-legacy-flop` to the CSS and JS**

In `agents/dashboard/public/dashboard.css`, add after `.trigger-low-ctr-meta`:

```css
.trigger-legacy-flop  { background: #fef3c7; color: #92400e; }
```

- [ ] **Step 4: Verify and commit**

```bash
node --check agents/performance-engine/index.js && echo OK
git add agents/performance-engine/index.js agents/dashboard/public/dashboard.css
git commit -m "feat(performance-engine): pick legacy flops as rewrite candidates"
```

---

## Task 4: Dashboard — expose triage data and render card

**Files:**
- Modify: `agents/dashboard/lib/data-loader.js`
- Modify: `agents/dashboard/public/js/dashboard.js`
- Modify: `agents/dashboard/lib/run-agent.js`

- [ ] **Step 1: Expose triage on `/api/data`**

In `agents/dashboard/lib/data-loader.js`, after the `indexingQueue` line, add:

```javascript
  const legacyTriage    = readJsonIfExists(join(REPORTS_DIR, 'legacy-triage', 'latest.json'));
```

Add `legacyTriage,` to the returned object.

- [ ] **Step 2: Add allowlist entry**

In `agents/dashboard/lib/run-agent.js`, add to `RUN_AGENT_ALLOWLIST`:

```javascript
  'agents/legacy-triage/index.js',
```

- [ ] **Step 3: Add `renderLegacyTriageCard` to the dashboard JS**

In `agents/dashboard/public/js/dashboard.js`, find `renderClusterAuthorityCard` and add this new function before it:

```javascript
function renderLegacyTriageCard(d) {
  var t = d.legacyTriage;
  if (!t) {
    return '<div class="card"><div class="card-header accent-amber"><h2>Legacy Post Triage</h2></div>' +
      '<div class="card-body"><div class="empty-state">No triage data. <button class="btn-sm" onclick="runAgent(\'agents/legacy-triage/index.js\')">Run triage</button></div></div></div>';
  }
  var c = t.counts || {};
  var pills =
    '<span class="weight-pill weight-pos" style="margin-right:6px">Winners: ' + (c.winner||0) + '</span>' +
    '<span class="weight-pill" style="margin-right:6px;background:#dbeafe;color:#1e40af">Rising: ' + (c.rising||0) + '</span>' +
    '<span class="weight-pill weight-neg" style="margin-right:6px">Flops: ' + (c.flop||0) + '</span>' +
    '<span class="weight-pill" style="margin-right:6px;background:#fef3c7;color:#92400e">Broken: ' + (c.broken||0) + '</span>';

  var topFlops = (t.results||[]).filter(function(r){ return r.bucket === 'flop'; }).slice(0, 5);
  var topRising = (t.results||[]).filter(function(r){ return r.bucket === 'rising'; }).slice(0, 5);
  var broken = (t.results||[]).filter(function(r){ return r.bucket === 'broken'; });

  var flopRows = topFlops.length === 0 ? '<div class="empty-state">No flops.</div>'
    : '<table class="data-table"><thead><tr><th>Post</th><th>Words</th><th>Reason</th></tr></thead><tbody>' +
      topFlops.map(function(r) {
        return '<tr><td class="col-title">' + esc(r.title) + '</td><td>' + r.words + '</td><td class="col-reason">' + esc(r.reason.slice(0, 60)) + '</td></tr>';
      }).join('') + '</tbody></table>';

  var risingRows = topRising.length === 0 ? ''
    : '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:12px 0 6px">Top Rising (meta-only)</h3>' +
      '<table class="data-table"><thead><tr><th>Post</th><th>Pos</th><th>Impr</th></tr></thead><tbody>' +
      topRising.map(function(r) {
        return '<tr><td class="col-title">' + esc(r.title) + '</td><td>' + (r.position ? Math.round(r.position) : '?') + '</td><td>' + r.impressions + '</td></tr>';
      }).join('') + '</tbody></table>';

  var brokenRows = broken.length === 0 ? ''
    : '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:12px 0 6px">Broken (manual fix)</h3>' +
      broken.map(function(r) {
        return '<div class="action-row"><div class="action-head"><span class="verdict-pill verdict-blocked">Broken</span><span class="action-title">' + esc(r.title) + '</span></div><div class="action-reason">' + esc(r.reason) + '</div></div>';
      }).join('');

  return '<div class="card"><div class="card-header accent-amber">' +
      '<h2>Legacy Post Triage (' + t.total + ' posts)</h2>' +
      '<button class="btn-sm" onclick="runAgent(\'agents/legacy-triage/index.js\')" style="margin-left:auto">Re-run</button>' +
    '</div><div class="card-body">' +
      '<div style="margin-bottom:12px">' + pills + '</div>' +
      '<h3 style="font-size:11px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:0 0 6px">Top Flops (rewrite candidates)</h3>' +
      flopRows +
      risingRows +
      brokenRows +
    '</div></div>';
}
```

- [ ] **Step 4: Wire into `renderOptimizeTab`**

Find the line `renderClusterAuthorityCard(d) +` and add before it:

```javascript
    renderLegacyTriageCard(d) +
```

- [ ] **Step 5: Verify and commit**

```bash
node --check agents/dashboard/lib/data-loader.js && node --check agents/dashboard/public/js/dashboard.js && node --check agents/dashboard/lib/run-agent.js && echo OK
git add agents/dashboard/lib/data-loader.js agents/dashboard/public/js/dashboard.js agents/dashboard/lib/run-agent.js
git commit -m "feat(dashboard): legacy triage card on Optimize tab"
```

---

## Task 5: Update signal manifest

**Files:**
- Modify: `docs/signal-manifest.md`

- [ ] **Step 1: Add triage entries to the manifest**

In the "SEO signal files" table, add:

```markdown
| `data/reports/legacy-triage/latest.json` | `legacy-triage` | `performance-engine` (picks legacy flops), `meta-optimizer` (picks rising), dashboard Optimize tab | healthy |
| `data/posts/<slug>.json#legacy_bucket` | `legacy-triage` | `performance-engine`, `content-refresher`, `refresh-runner`, `meta-optimizer` | healthy |
| `data/posts/<slug>.json#legacy_locked` | `legacy-triage` (auto-lock winners) | `content-refresher`, `refresh-runner`, `meta-optimizer` (skip if locked) | healthy |
```

- [ ] **Step 2: Commit**

```bash
git add docs/signal-manifest.md
git commit -m "docs: add legacy triage signals to manifest"
```

---

## Task 6: Deploy and first run

- [ ] **Step 1: Push and merge**

```bash
git push -u origin feature/legacy-triage
gh pr create --title "feat(seo): legacy post triage agent" --base main --body "..."
gh pr merge --merge --delete-branch
git checkout main && git pull
```

- [ ] **Step 2: Deploy to server**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

- [ ] **Step 3: Dry-run triage on the server**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/legacy-triage/index.js --dry-run 2>&1 | tail -40'
```

Expected: lists each legacy post with a bucket assignment (WINNER/RISING/FLOP/BROKEN). Counts at the bottom.

- [ ] **Step 4: Real run**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/legacy-triage/index.js 2>&1 | tail -40'
```

Expected: stamps every legacy post JSON with `legacy_bucket` and `legacy_triage_reason`. Winners get `legacy_locked: true`. Report written to `data/reports/legacy-triage/`.

- [ ] **Step 5: Verify dashboard**

Open the dashboard → Optimize tab. The Legacy Post Triage card should show bucket counts and top flops/rising/broken.

- [ ] **Step 6: Test performance engine dry run**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/performance-engine/index.js --dry-run 2>&1 | tail -20'
```

Expected: should now show `legacy-flop` candidates in the candidate list alongside the existing meta rewrite candidates.

## Success criteria

- Every legacy post has a `legacy_bucket` assignment after one triage run
- Winners are locked (`legacy_locked: true`) and no downstream agent touches them
- Flops appear as candidates in the performance engine's nightly run
- Dashboard shows accurate bucket counts with top candidates
- Running triage twice with `--force` produces identical bucket assignments (idempotent given the same input signals)
- The performance engine respects the 3-flop-per-day cap when mixing legacy flops with post-performance flops
