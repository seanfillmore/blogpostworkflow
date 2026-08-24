#!/usr/bin/env node
/**
 * Make `data/posts/<slug>/content.html` hold the article that is actually live.
 *
 *   node scripts/reconcile-content-mirrors.mjs                 # DRY (default)
 *   node scripts/reconcile-content-mirrors.mjs --apply
 *   node scripts/reconcile-content-mirrors.mjs --slug <slug>   # one post
 *   node scripts/reconcile-content-mirrors.mjs --all           # every drifted mirror
 *   node scripts/reconcile-content-mirrors.mjs --json
 *   node scripts/reconcile-content-mirrors.mjs --no-reinject-schema
 *
 * WHY THIS EXISTS ALONGSIDE A GATE THAT ALREADY REFUSES
 * ────────────────────────────────────────────────────
 * `lib/content-mirror.js` + `agents/publisher` stop the damage: a republish that
 * would REPLACE a live page rather than edit it is refused, and `--force` does
 * not disarm it. That disarms the fuse at `scheduler.js:121`. It does not make
 * the 27 wrong files right, and a mirror that can only ever be refused is a post
 * that can never be republished — the gate is a guard, not a fix.
 *
 * Shopify is authoritative for published content. `scripts/remediate-live-post.js`
 * and `scripts/regate-live-posts.js` both already pull `body_html` down over
 * `content.html`; this does the same thing, per post, with the containment test
 * re-run rather than assumed. See `lib/content-reconcile.js` for the decision
 * table and the reasoning behind each hold — the module is pure so every hold is
 * constructible in a test.
 *
 * WHAT IT WILL NOT TOUCH
 * ──────────────────────
 * `content.html` and nothing else. `content-refreshed.html`, `meta.json`,
 * `editor-report.md`, `answer-first.md`, `internal-links.md` and `image.webp`
 * are never read for writing, never moved and never deleted. Six queued
 * `content-refreshed.html` drafts exist on this corpus and are the pipeline's
 * genuine work-in-progress; `agents/refresh-runner` copies one over the mirror
 * moments before publishing, and `lib/queue-apply.js` pushes the queue item's
 * own `refreshed_html_path` rather than the mirror, so neither path is affected
 * by what happens here.
 *
 * SCHEMA RE-INJECTION IS NOT AN EXTRA — IT IS WHAT KEEPS THE FIX FREE
 * ──────────────────────────────────────────────────────────────────
 * `agents/legacy-rebuilder` runs daily from `scheduler.js` at `--limit 5
 * --apply`, and decides "legacy" by `!html.includes('FAQPage')` read straight
 * from `content.html`. 36 mirrors on this corpus carry FAQ JSON-LD their live
 * article does not, so a plain copy-down hands that agent 36 new legacy posts
 * and it starts paying for full pipeline rebuilds of live pages, five a day,
 * unattended. So a mirror that had JSON-LD gets `agents/schema-injector` re-run
 * on it (WITHOUT `--apply` — local write only, no Shopify call), which rebuilds
 * the schema from the NEW prose. That is strictly better than preserving the old
 * blocks: on a different-article mirror the old FAQPage answers questions the
 * live page does not ask.
 *
 * The FAQ check is a VERIFY, not a prediction — the injector's heading
 * heuristics live in the injector, and a second copy here would drift from it
 * silently. Each post is written, re-injected, and then checked; a post that
 * comes back without `FAQPage` is RESTORED FROM ITS BACKUP and reported as
 * `held: faq-regression`. On this corpus that is one post
 * (`best-natural-bar-soap-for-men`, whose live body carries a single question
 * heading).
 *
 * `--no-reinject-schema` does NOT switch that protection off — it only removes
 * the thing that would have restored the schema, so every mirror that had FAQ
 * JSON-LD is written, found wanting, rolled back and held. That is the honest
 * consequence of the flag rather than a defect in it, and it is what the flag is
 * good for: seeing exactly which posts depend on the re-injection.
 *
 * IDEMPOTENCE
 * ───────────
 * "In sync" is judged with JSON-LD stripped from both sides, so the mirror this
 * script leaves behind — live prose plus regenerated schema live does not have —
 * is in sync on the next run. A second `--apply` writes nothing and makes no
 * backup. `compareBodies` ignores `<script>` entirely, so re-injected schema can
 * never re-open the gate this closes.
 *
 * AFTERWARDS
 * ──────────
 * `data/posts/<slug>/editor-report.md` is now stale for every reconciled post —
 * it describes the body that was there before. `scripts/regate-live-posts.js`
 * re-runs the editor against the live body and regenerates it; this script does
 * not, because `agents/editor` makes Claude calls and can set
 * `meta.needs_rebuild`, and neither belongs inside a file-reconciliation run.
 * The reconciled slugs are named at the end so that pass can be scoped.
 *
 * READ-ONLY AGAINST SHOPIFY. It issues GETs. There is no code path in this file
 * that writes a live article.
 *
 * Exit codes:
 *   0  nothing left to reconcile in the selected scope (or a clean dry run)
 *   1  at least one post is HELD and needs a human
 *   3  a local post could not be read at all
 *  64  an argument this script refuses
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBlogs, getArticles } from '../lib/shopify.js';
import { compareBodies } from '../lib/content-mirror.js';
import {
  applyMirrorReconcile, decideMirrorAction, hasFaqPage, inDefaultScope, PINNED_MIRROR_SLUGS,
} from '../lib/content-reconcile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'content-mirror');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const asJson = args.includes('--json');
const sweepAll = args.includes('--all');
const reinjectSchema = !args.includes('--no-reinject-schema');
const onlySlug = (() => {
  const i = args.indexOf('--slug');
  return i !== -1 ? args[i + 1] : null;
})();

if (onlySlug && sweepAll) {
  console.error('reconcile-content-mirrors: --slug and --all are mutually exclusive.');
  process.exit(64);
}

const pinned = new Set(PINNED_MIRROR_SLUGS);

// ── local corpus ─────────────────────────────────────────────────────────────

function postDirs() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter((n) => {
      try { return statSync(join(POSTS_DIR, n)).isDirectory() && existsSync(join(POSTS_DIR, n, 'meta.json')); }
      catch { return false; }
    })
    .sort();
}

const blogs = await getBlogs();
const liveById = new Map();
for (const b of blogs) {
  // published_status=any — a DRAFT article is still an article this mirror can
  // overwrite, and two of the drifted posts are drafts.
  for (const a of await getArticles(b.id, { published_status: 'any' })) {
    liveById.set(String(a.id), { ...a, blog_id: b.id, blog_handle: b.handle });
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rows = [];

for (const slug of postDirs()) {
  if (onlySlug && slug !== onlySlug) continue;

  let meta;
  try { meta = JSON.parse(readFileSync(join(POSTS_DIR, slug, 'meta.json'), 'utf8')); }
  catch (err) { rows.push({ slug, state: 'meta-unreadable', detail: err.message }); continue; }

  if (!meta.shopify_article_id) { rows.push({ slug, state: 'no-article-id' }); continue; }

  const live = liveById.get(String(meta.shopify_article_id));
  if (!live) { rows.push({ slug, state: 'article-not-on-shopify', articleId: meta.shopify_article_id }); continue; }

  const contentPath = join(POSTS_DIR, slug, 'content.html');
  if (!existsSync(contentPath)) { rows.push({ slug, state: 'no-local-content', articleId: live.id }); continue; }

  let localHtml;
  try { localHtml = readFileSync(contentPath, 'utf8'); }
  catch (err) { rows.push({ slug, state: 'local-unreadable', detail: err.message }); continue; }

  const liveHtml = live.body_html || '';
  const comparison = compareBodies(localHtml, liveHtml);
  const decision = decideMirrorAction({ comparison, localHtml, liveHtml, pinned: pinned.has(slug) });

  // Scope: --slug and --all bypass it; the default is exactly what
  // check-content-mirrors.mjs flags (its exit 1 and exit 2).
  //
  // A HOLD is reported whatever the scope. It is a finding, it is never
  // written, and the one post on this corpus that is genuinely AHEAD of live
  // (`best-toothpaste-for-sensitive-teeth-2025`, similarity 0.991) sits above
  // the warn band — scoping holds would be the one arrangement that hides it.
  if (!inDefaultScope(comparison) && !onlySlug && !sweepAll && decision.action !== 'hold') continue;

  rows.push({
    slug,
    state: 'considered',
    articleId: live.id,
    published: !!live.published_at,
    tier: comparison.tier,
    blockSimilarity: comparison.blockSimilarity,
    localBlocks: comparison.localBlocks,
    liveBlocks: comparison.liveBlocks,
    sharedBlocks: comparison.sharedBlocks,
    blocksGained: comparison.liveOnlyBlocks,
    blocksLost: comparison.localOnlyBlocks,
    direction: comparison.direction,
    hadFaqSchema: hasFaqPage(localHtml),
    action: decision.action,
    hold: decision.hold,
    reason: decision.reason,
    willReinjectSchema: decision.reinjectSchema && reinjectSchema,
    applied: false,
    backup: null,
    note: null,
  });
}

// ── apply ────────────────────────────────────────────────────────────────────
//
// Write → re-inject → verify → roll back on regression. Nothing about this loop
// touches Shopify, and nothing outside `content.html` and `backups/`.

if (apply) {
  for (const r of rows.filter((x) => x.action === 'reconcile')) {
    const contentPath = join(POSTS_DIR, r.slug, 'content.html');
    const backupPath = join(POSTS_DIR, r.slug, 'backups', `content-reconcile-${stamp}.html`);

    const out = applyMirrorReconcile({
      contentPath,
      backupPath,
      liveHtml: liveById.get(String(r.articleId)).body_html || '',
      reinject: r.willReinjectSchema,
      // NO --apply: local write only. The agent pushes to Shopify only under its
      // own --apply flag, which is never passed from here.
      runInjector: () => execFileSync(
        process.execPath,
        [join(ROOT, 'agents', 'schema-injector', 'index.js'), '--slug', r.slug],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
      ),
    });

    r.backup = backupPath.replace(`${ROOT}/`, '');
    if (out.injectorError) r.note = `schema-injector failed: ${out.injectorError}`;

    if (out.rolledBack) {
      r.action = 'hold';
      r.hold = 'faq-regression';
      r.applied = false;
      r.reason = 'reconciled, but FAQ schema could not be regenerated from the live body — rolled back, because agents/legacy-rebuilder would queue a paid full rebuild for a mirror without FAQPage';
    } else {
      r.applied = true;
    }
  }
}

// ── output ───────────────────────────────────────────────────────────────────

const considered = rows.filter((r) => r.state === 'considered');
const reconciled = considered.filter((r) => r.action === 'reconcile');
const held = considered.filter((r) => r.action === 'hold');
const inSync = considered.filter((r) => r.action === 'in-sync');
const unreadable = rows.filter((r) => r.state === 'meta-unreadable' || r.state === 'local-unreadable');

const summary = {
  generated_at: new Date().toISOString(),
  mode: apply ? 'apply' : 'dry',
  scope: onlySlug ? `slug:${onlySlug}` : sweepAll ? 'all-drifted' : 'flagged (different-article + 0.25-0.75 warn band)',
  reinject_schema: reinjectSchema,
  considered: considered.length,
  reconciled: reconciled.length,
  held: held.length,
  in_sync: inSync.length,
  unreadable: unreadable.length,
};

if (apply && reconciled.length) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `reconcile-${stamp}.json`), JSON.stringify({ summary, rows }, null, 2));
}

if (asJson) {
  console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
  const L = [];
  const fmt = (r) => [
    r.blockSimilarity.toFixed(3).padStart(5),
    `${r.sharedBlocks}/${r.localBlocks}->${r.liveBlocks}`.padStart(13),
    `+${r.blocksGained}/-${r.blocksLost}`.padStart(9),
    r.direction.padEnd(14),
    r.published ? 'live ' : 'DRAFT',
    r.slug,
  ].join('  ');

  L.push('');
  L.push(`Reconcile data/posts/*/content.html from live Shopify — ${apply ? 'APPLY' : 'DRY RUN'}`);
  L.push(`  scope: ${summary.scope}`);
  L.push(`  ${summary.considered} considered · ${summary.reconciled} ${apply ? 'reconciled' : 'to reconcile'} · ${summary.held} held · ${summary.in_sync} already in sync`);
  L.push('');

  if (reconciled.length) {
    L.push(`${apply ? 'RECONCILED' : 'WOULD RECONCILE'} (${reconciled.length}) — sim, shared/local->live, blocks gained/lost:`);
    for (const r of [...reconciled].sort((a, b) => a.blockSimilarity - b.blockSimilarity)) {
      L.push('  ' + fmt(r) + (r.willReinjectSchema ? '  [schema re-injected]' : ''));
      if (r.note) L.push(`        ! ${r.note}`);
    }
    L.push('');
  }

  if (held.length) {
    L.push(`HELD — not overwritten, and each one needs a human (${held.length}):`);
    for (const r of held) {
      L.push(`  ${r.slug}  [${r.hold}]`);
      L.push(`      ${r.reason}`);
    }
    L.push('');
  }

  if (unreadable.length) {
    L.push('UNREADABLE:');
    for (const r of unreadable) L.push(`  ${r.slug}: ${r.state} — ${r.detail}`);
    L.push('');
  }

  if (!apply && reconciled.length) {
    L.push('Nothing was written. Re-run with --apply.');
    L.push('At --apply each file is backed up to data/posts/<slug>/backups/content-reconcile-<stamp>.html');
    L.push('BEFORE it is overwritten, and a post whose FAQ schema cannot be regenerated is restored');
    L.push('from that backup and held rather than left for agents/legacy-rebuilder to rebuild.');
    L.push('');
  }

  if (apply && reconciled.length) {
    L.push('data/posts/<slug>/editor-report.md is now STALE for every post above — it describes the');
    L.push('body that was there before. Regenerate with:');
    L.push('  node scripts/regate-live-posts.js --all');
    L.push('');
    L.push('Then re-check:  npm run check-content-mirrors');
    L.push('');
  }

  console.log(L.join('\n'));
}

process.exitCode = unreadable.length ? 3 : held.length ? 1 : 0;
