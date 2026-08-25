/**
 * Legacy Post Rebuilder
 *
 * Identifies blog posts that carry no injected JSON-LD at all (the direct
 * statement of "built before the current pipeline existed"; it was a `FAQPage`
 * substring search until 2026-08-24, when the injector stopped emitting that
 * type — see `isLegacyHtml` below) and rebuilds them tier-appropriately:
 *   winner → skip · rising → light surgical refresh · flop/untriaged → full
 *   refresh via refresh-runner (content-refresher → editor → publisher, in
 *   place on the existing post) · broken → skip for manual fix.
 *
 * REVENUE-GATED. A full rebuild is a refresh-runner chain of paid LLM calls, so
 * posts whose cluster the revenue report shows earning $0 are SKIPPED AND
 * COUNTED (lib/cluster-hold.js) before the pick list is capped. No cluster is
 * named in this file. Held posts are NOT touched in any way — still live, still
 * indexed, still carrying whatever tags they had. `--include-held` rebuilds them.
 *
 * EFFICIENCY-RANKED BEFORE --limit (lib/cluster-efficiency.js). The scheduler
 * runs this at `--limit 5`, so the order the pick list is in decides which five
 * of the backlog get rebuilt. The hold answers WHETHER; the ranking answers IN
 * WHAT ORDER, cheapest-converting-first — and reserves one of the five for the
 * lowest-ranked cluster present so a ranking never starves one to zero.
 *
 * Naming one slug on the command line is an operator asking for that post, and
 * is never held — the hold exists to stop UNATTENDED spend.
 *
 * Usage:
 *   node agents/legacy-rebuilder/index.js                    # list legacy posts (dry run)
 *   node agents/legacy-rebuilder/index.js <slug> --apply     # rebuild one post
 *   node agents/legacy-rebuilder/index.js --limit 3 --apply  # rebuild N posts
 *   node agents/legacy-rebuilder/index.js --limit 3 --apply --include-held
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getContentPath, getPostMeta, getMetaPath } from '../../lib/posts.js';
import { mayRewriteBody } from '../../lib/post-lock.js';
import { hasInjectedSchema } from '../../lib/injected-schema.js';
import { getArticle } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';
import {
  rankClusters, orderByEfficiency, renderEfficiencyLines, efficiencyBanner,
} from '../../lib/cluster-efficiency.js';
import {
  loadClusterHold, partitionHeld, renderHoldLines, renderDisagreementLines, holdBanner,
  holdSummaryFragment, HOLD_FLAG,
} from '../../lib/cluster-hold.js';

/**
 * Split the legacy pick list into what gets rebuilt and what is held because its
 * cluster earns $0.
 *
 * Held BEFORE `--limit` is applied, deliberately: holding afterwards would let
 * five held posts consume the whole daily budget and leave the backlog of
 * earning-cluster posts untouched. The efficiency ranking is applied in the same
 * place and for the same reason — and unlike the hold it removes nothing, so a
 * `ranking` that is absent or unavailable simply leaves the list as it was.
 *
 * Exported for test; both rules live in lib/ so this agent, the queue and every
 * other gated agent decide on the same measured evidence.
 *
 * @returns {{kept:Array, held:Array, overridden:Array, efficiency:object|null}}
 */
export function selectLegacyPosts(posts, {
  hold = null, includeHeld = false, ranking = null, limit = null,
} = {}) {
  const describe = (p) => ({
    slug: p?.slug,
    keyword: p?.meta?.target_keyword,
    title: p?.meta?.title,
  });
  const out = partitionHeld(posts, hold, { includeHeld, describe });
  if (!ranking) return { ...out, efficiency: null };
  const efficiency = orderByEfficiency(out.kept, ranking, { limit, describe });
  return { ...out, kept: efficiency.items, efficiency };
}

/**
 * The digest body. Previously this was counts only — "4 rebuilt, 1 failed" — while
 * the actual slug and reason went to console.error and were lost with the log. A
 * failure the operator cannot name is a failure nobody acts on, which is how one
 * post sat broken across runs without anyone knowing which post it was.
 */
export function renderRebuildSummary({ succeeded, failures = [], remaining }) {
  const lines = [`Rebuilt ${succeeded} post(s). ${remaining} legacy posts remain.`];
  if (failures.length) {
    lines.push('', `Failed (${failures.length}):`);
    for (const f of failures) {
      lines.push(`- ${f.slug}: ${f.reason || 'no reason captured (rebuild reported failure without an error)'}`);
    }
  }
  return lines.join('\n');
}

/**
 * Drop a post's `needs_rebuild` tag and record that we deliberately let it go.
 *
 * findLegacyPosts() re-selects any post carrying `needs_rebuild`, so a branch
 * that skips a post WITHOUT clearing the tag re-queues it tomorrow, and every
 * day after — which is what the `broken` bucket did: it returned success, left
 * the tag set, and the same post re-entered the run (and the digest) forever.
 * The `winner` branch had always cleared it; `broken` never did.
 *
 * The bucket and its triage reason are untouched, so a broken post is still
 * listed as broken and still needs its manual technical fix — it just stops
 * asking for the same rebuild every morning.
 *
 * @returns {{meta: object, cleared: boolean}}
 */
export function clearNeedsRebuild(meta, { ackField, at } = {}) {
  const { needs_rebuild: _drop, ...rest } = meta || {};
  if (!meta?.needs_rebuild) return { meta: rest, cleared: false };
  return { meta: ackField ? { ...rest, [ackField]: at } : rest, cleared: true };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BACKUPS_DIR = join(ROOT, 'data', 'backups', 'legacy-rebuild');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeHeld = args.includes(HOLD_FLAG);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const slugArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');

/**
 * Has this post been through the content pipeline at all?
 *
 * The pure half of `isLegacy`, exported so the predicate a paid rebuild routes
 * on is testable without a filesystem.
 *
 * IT USED TO BE `!html.includes('FAQPage')` AND THAT STOPPED WORKING (2026-08-24)
 * ─────────────────────────────────────────────────────────────────────────────
 * `agents/schema-injector` no longer emits FAQPage — Google removed the FAQ rich
 * result from Search — so every post the pipeline writes from now on carries no
 * such string. Left alone, this function would have called all of them legacy
 * and queued a full paid rebuild for each, five a day, unattended, forever.
 *
 * `hasInjectedSchema` states directly what the substring was only a proxy for.
 * The swap can only SHRINK the legacy set (FAQPage can only occur inside a
 * JSON-LD block), so no post is newly enrolled into spend: measured over the 93
 * eligible local posts, 39 legacy before, 36 after, 0 newly legacy. The 3 that
 * fall out were a defect — FAQPage was conditional on 2+ question headings while
 * the injector ran unconditionally, so a processed post with too few question
 * headings could never satisfy the test and was rebuilt and re-queued every
 * morning.
 */
export function isLegacyHtml(html) {
  return !hasInjectedSchema(html);
}

function isLegacy(slug) {
  const p = getContentPath(slug);
  if (!existsSync(p)) return false;
  return isLegacyHtml(readFileSync(p, 'utf8'));
}

function findLegacyPosts() {
  // Two signals: no injected schema at all (old posts built before the pipeline
  // existed), or editor-tagged needs_rebuild (posts that failed the editor this
  // week).
  return listAllSlugs()
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter((p) => p.meta && p.meta.shopify_article_id)
    .filter((p) => isLegacy(p.slug) || p.meta.needs_rebuild);
}

function run(cmd, label) {
  console.log(`  > ${label}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch (err) {
    // Surface the real failure — a bare "failed" was undiagnosable.
    const detail = (err.message || String(err)).split('\n')[0];
    console.error(`  ✗ ${label} failed: ${detail}`);
    return false;
  }
}

/**
 * Light refresh for rising-tier posts (ranking but needs polish).
 * Never rewrites body content — just runs the surgical fix agents:
 * answer-first intro, featured-product CTA, schema injector. Then pushes
 * the (auto-fixed) body_html to Shopify via the editor's --push-shopify
 * flag so live site reflects local changes.
 */
async function lightRefresh(slug) {
  const { getContentPath: getContent } = await import('../../lib/posts.js');
  console.log(`\nLight refresh: ${slug}`);
  console.log(`  Bucket: rising — surgical fixes only, body content untouched`);

  run(`node agents/answer-first-rewriter/index.js ${slug} --apply`, `answer-first: ${slug}`);
  run(`node agents/featured-product-injector/index.js --handle ${slug}`, `featured-product: ${slug}`);
  run(`node agents/schema-injector/index.js --slug ${slug} --apply`, `schema: ${slug}`);

  // Editor runs with --in-pipeline (no re-tagging) + --push-shopify (sync
  // any pre-review auto-fixes back to Shopify's body_html).
  if (!run(`node agents/editor/index.js ${getContent(slug)} --in-pipeline --push-shopify`, `editor+push: ${slug}`)) {
    console.error(`  ⛔ Editor failed — light refresh aborted`);
    return false;
  }

  // Clear the needs_rebuild tag on success
  const { needs_rebuild: _drop, ...rest } = getPostMeta(slug) || {};
  const updated = { ...rest, refreshed_at: new Date().toISOString() };
  writeFileSync(getMetaPath(slug), JSON.stringify(updated, null, 2));

  console.log(`  ✓ Light refresh complete`);
  return true;
}

async function rebuildPost(slug) {
  const meta = getPostMeta(slug);
  if (!meta) throw new Error(`No metadata for ${slug}`);
  if (!meta.shopify_article_id || !meta.shopify_blog_id) {
    throw new Error(`Missing shopify_article_id or shopify_blog_id for ${slug}`);
  }

  // Tier-aware routing. legacy-triage stamps meta.legacy_bucket:
  //   winner  → never rebuild (preserve working post; clear any stale tag)
  //   rising  → light refresh only (schema + CTAs + answer-first), never
  //             rewrite body content
  //   flop    → full pipeline rebuild (current behavior)
  //   broken  → technical issue, manual fix required, skip
  //   (unset) → treat as flop to preserve current behavior for untriaged
  //             posts. run `node agents/legacy-triage/index.js` first to
  //             classify properly.
  //
  // The BUCKET is not the lock. `legacy_locked` is stamped when triage buckets a
  // post as a winner, but a later re-triage can move the bucket without clearing
  // the lock — production carries `natural-soap-bar` at `legacy_locked: true` /
  // `legacy_bucket: 'flop'`, which this routing alone would have sent through a
  // FULL pipeline rebuild. The lock decides; the bucket only picks the treatment
  // among posts the lock allows. See lib/post-lock.js.
  const bucket = meta.legacy_bucket || null;
  const bodyLock = mayRewriteBody(slug);
  if (bucket === 'winner' || !bodyLock.allowed) {
    console.log(`\nSkipping: ${slug}`);
    console.log(bucket === 'winner'
      ? `  Bucket: winner — preserving post that is already ranking`
      : `  Winner lock: ${bodyLock.reason} (bucket: ${bucket || 'unset'})`);
    // Clear any stale needs_rebuild tag so the post doesn't keep surfacing
    const { meta: cleanedWinner, cleared: winnerCleared } = clearNeedsRebuild(meta, {
      ackField: 'legacy_winner_ack_at', at: new Date().toISOString(),
    });
    if (winnerCleared) {
      writeFileSync(getMetaPath(slug), JSON.stringify(cleanedWinner, null, 2));
      console.log('  Cleared stale needs_rebuild tag');
    }
    return true;
  }
  if (bucket === 'broken') {
    console.log(`\nSkipping: ${slug}`);
    console.log(`  Bucket: broken — ${meta.legacy_triage_reason || 'technical fix required'}`);
    // This branch used to return success with the tag still set, so the post
    // re-entered findLegacyPosts() (and the digest) every single day, forever.
    // Clearing it does not hide the problem — `legacy_bucket: 'broken'` and
    // `legacy_triage_reason` still say exactly what is wrong, and the post is
    // still picked up by the missing-FAQ-schema signal.
    const { meta: cleanedBroken, cleared: brokenCleared } = clearNeedsRebuild(meta, {
      ackField: 'legacy_broken_ack_at', at: new Date().toISOString(),
    });
    if (brokenCleared) {
      writeFileSync(getMetaPath(slug), JSON.stringify(cleanedBroken, null, 2));
      console.log('  Cleared needs_rebuild — broken-bucket posts need a manual fix, not a daily re-queue');
    }
    return true;
  }
  if (bucket === 'rising') {
    return await lightRefresh(slug);
  }

  // Full rebuild (flop or unset) — route through the canonical refresh pipeline.
  //
  // The previous implementation re-ran research → write → image from scratch,
  // which is structurally broken for an EXISTING post: content-researcher
  // refuses to brief a keyword that already has a post (anti-cannibalization),
  // so no brief was ever written and the `write` step failed every run. Even if
  // it had succeeded, blog-post-writer keys its output directory off the brief's
  // (keyword-derived) slug, so it could fork a duplicate post.
  //
  // refresh-runner rewrites weak sections IN PLACE on the existing post
  // (content-refresher → editor gate → publisher updates the same article),
  // which is exactly what rebuilding a flop needs.
  console.log(`\nRebuilding (full refresh): ${slug}`);
  console.log(`  Bucket: ${bucket || 'untriaged (default: flop)'}`);
  console.log(`  Article ID: ${meta.shopify_article_id}`);

  // Backup original body_html from Shopify (live version) before refreshing.
  mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const liveArticle = await getArticle(meta.shopify_blog_id, meta.shopify_article_id);
  const backupPath = join(BACKUPS_DIR, `${slug}.${stamp}.html`);
  writeFileSync(backupPath, liveArticle.body_html || '');
  console.log(`  Backup saved: ${backupPath}`);

  if (!run(`node agents/refresh-runner/index.js ${slug}`, `refresh: ${slug}`)) {
    console.error(`  ⛔ Refresh failed — original post untouched on Shopify`);
    return false;
  }

  // Stamp metadata, clear rebuild tag (refresh-runner stamps refreshed_at; we
  // add rebuilt_at + drop needs_rebuild so the post stops surfacing as legacy).
  const { needs_rebuild: _drop, ...rest } = getPostMeta(slug) || {};
  const updatedMeta = { ...rest, rebuilt_at: new Date().toISOString() };
  writeFileSync(getMetaPath(slug), JSON.stringify(updatedMeta, null, 2));

  return true;
}

async function main() {
  console.log('\nLegacy Post Rebuilder\n');

  const hold = loadClusterHold({ root: ROOT });
  const banner = holdBanner(hold);
  if (banner) console.log(`${banner}\n`);

  // Deprioritise, don't condemn. Same order rule as the hold: rank BEFORE the
  // cap, or the five least efficient posts eat a budget of five.
  const ranking = rankClusters(hold);
  const rankBanner = efficiencyBanner(ranking);
  if (rankBanner) console.log(`${rankBanner}\n`);

  // An explicit slug is an operator asking for that post; the hold only ever
  // stops unattended spend, so it does not apply to a hand-typed request — and
  // neither does the ranking, which would otherwise silently reorder a list of one.
  const { kept: legacy, held, efficiency } = slugArg
    ? { kept: findLegacyPosts(), held: [], efficiency: null }
    : selectLegacyPosts(findLegacyPosts(), { hold, includeHeld, ranking, limit });

  if (held.length) {
    for (const line of renderHoldLines(held)) console.log(`  ${line}`);
    console.log('');
  }
  const rankLines = renderEfficiencyLines(ranking, efficiency);
  for (const line of rankLines) console.log(`  ${line}`);

  // Tier breakdown — shows what action each post would receive.
  const byBucket = { winner: [], rising: [], flop: [], broken: [], untriaged: [] };
  for (const p of legacy) {
    const b = p.meta.legacy_bucket || 'untriaged';
    if (byBucket[b]) byBucket[b].push(p);
    else byBucket.untriaged.push(p);
  }

  console.log(`Found ${legacy.length} legacy post(s). Tier breakdown:`);
  console.log(`  winner    (skip):          ${byBucket.winner.length}`);
  console.log(`  rising    (light refresh): ${byBucket.rising.length}`);
  console.log(`  flop      (full rebuild):  ${byBucket.flop.length}`);
  console.log(`  broken    (skip manual):   ${byBucket.broken.length}`);
  console.log(`  untriaged (default rebuild): ${byBucket.untriaged.length}`);
  if (byBucket.untriaged.length > 0) {
    console.log('  Tip: run `node agents/legacy-triage/index.js --force` to classify untriaged posts first.');
  }

  if (!apply) {
    console.log('\nDry run — no changes. Pass --apply to run tier-appropriate actions.');
    for (const p of legacy.slice(0, 20)) {
      const b = p.meta.legacy_bucket || 'untriaged';
      console.log(`  [${b}] ${p.slug}`);
    }
    if (legacy.length > 20) console.log(`  ... and ${legacy.length - 20} more`);
    return;
  }

  // Filter by single slug or limit
  let toRebuild = legacy;
  if (slugArg) toRebuild = legacy.filter((p) => p.slug === slugArg);
  else if (limit) toRebuild = legacy.slice(0, limit);

  console.log(`\nRebuilding ${toRebuild.length} post(s)...`);

  let succeeded = 0;
  const failures = [];
  for (const p of toRebuild) {
    try {
      const ok = await rebuildPost(p.slug);
      if (ok) succeeded++;
      // rebuildPost returns false after already logging its own reason, so there
      // is no error object to carry here — record the slug so the digest can at
      // least name it.
      else failures.push({ slug: p.slug, reason: null });
    } catch (err) {
      console.error(`  ✗ ${p.slug}: ${err.message}`);
      failures.push({ slug: p.slug, reason: err.message });
    }
  }

  await notify({
    subject: `Legacy Rebuilder: ${succeeded} rebuilt, ${failures.length} failed${holdSummaryFragment(held)}`,
    body: [
      renderRebuildSummary({ succeeded, failures, remaining: legacy.length - succeeded }),
      ...(held.length ? ['', ...renderHoldLines(held)] : []),
      ...(rankLines.length ? ['', ...rankLines] : []),
      ...(hold.disagreements.length ? ['', ...renderDisagreementLines(hold)] : []),
    ].join('\n'),
    // A hold never moves the status — it is the policy working, not a failure.
    status: failures.length > 0 ? 'warning' : 'success',
  });

  console.log(`\nDone. ${succeeded} succeeded, ${failures.length} failed.`);
}

// Only run when invoked directly. Without this guard, importing anything from
// this module starts a live rebuild — Shopify writes included — and its
// process.exit(1) takes the host process down with it.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    notify({ subject: 'Legacy Rebuilder failed', body: err.message, status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
}
