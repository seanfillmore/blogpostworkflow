#!/usr/bin/env node
/**
 * Blocked Post Resolver
 *
 * Hard-blocked posts used to resolve themselves only if somebody noticed the
 * "Action Required — N posts hard-blocked" block in the 5 AM digest and ran a
 * script by hand. Nobody did, so the same posts sat there for weeks: on
 * 2026-08-16 three LIVE, HTTP-200, traffic-earning pages were flagged and were
 * still flagged on 2026-08-22.
 *
 * scripts/remediate-live-post.js already does exactly the right loop — pull the
 * LIVE body from Shopify, gate it, repair via link-repair / citation-finder /
 * content-remediator up to 3×, re-gate, push only if it ends up PASSING and
 * actually changed. It was simply never scheduled. This agent schedules it, and
 * adds the one thing the script does not do: decide what happens when the loop
 * runs out of attempts.
 *
 * ON EXHAUSTION: SOFTEN, NEVER DELETE. Sean's explicit decision. These are
 * indexed pages that earn traffic. The agent strips/softens the offending claim
 * (agents/citation-finder already supports softening what it cannot source),
 * clears `needs_rebuild`, and LEAVES THE PAGE LIVE. It never calls
 * lib/post-kill.js. It never unpublishes. A page that cannot be perfected is a
 * page that keeps earning, not a page that gets deleted.
 *
 * It also records a fingerprint of the editor report it failed on, so the same
 * unfixable verdict is not re-attempted tomorrow (and every day after) at full
 * LLM price. A NEW editor verdict re-opens the post automatically.
 *
 * REVENUE-GATED CANDIDATE SELECTION. Each candidate is a chain of paid LLM calls
 * (editor gate ×N plus up to three repair agents), so a post whose cluster the
 * revenue report shows earning $0 is SKIPPED AND COUNTED (lib/cluster-hold.js)
 * before the --limit budget is spent. No cluster is named in this file. A held
 * post is left EXACTLY as it is: still live, still indexed, flag untouched — the
 * hold pauses spend, it never resolves or removes anything. `--include-held`
 * remediates them anyway, and naming a post with --slug is never held.
 *
 * EFFICIENCY-RANKED, TOO (lib/cluster-efficiency.js). The hold decides WHETHER a
 * post may be spent on; the ranking decides in what ORDER the survivors spend a
 * budget of five, so the categories that convert are reached before the ones
 * that merely rank. It excludes nothing — one in-cap slot is reserved for the
 * lowest-ranked cluster present so a ranking can never starve one to zero.
 *
 * Output: one deferred notify() summary line, per the digest convention — this
 * agent does not email.
 *
 * Usage:
 *   node agents/blocked-post-resolver/index.js                  # DRY RUN — list only
 *   node agents/blocked-post-resolver/index.js --apply          # remediate + push
 *   node agents/blocked-post-resolver/index.js --slug <slug> --apply
 *   node agents/blocked-post-resolver/index.js --limit 3 --apply
 *   node agents/blocked-post-resolver/index.js --limit 3 --apply --include-held
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listAllSlugs, getPostMeta, getMetaPath, getContentPath, getEditorReportPath, ROOT, replacePostMeta } from '../../lib/posts.js';
import { classifyBlockedReport, reportFingerprint } from '../../lib/blocked-posts.js';
import { isPassing, parseEditorBlockers, firstBlockerReason } from '../../lib/editor-remediation.js';
import { notify } from '../../lib/notify.js';
import {
  loadClusterHold, partitionHeld, renderHoldLines, renderDisagreementLines, holdBanner,
  holdSummaryFragment, HOLD_FLAG,
} from '../../lib/cluster-hold.js';
import {
  rankClusters, orderByEfficiency, renderEfficiencyLines, efficiencyBanner,
} from '../../lib/cluster-efficiency.js';

// How many posts one unattended run will remediate. Each one is a chain of
// paid LLM calls (editor gate ×N, plus up to 3 repair agents), so an uncapped
// run after a bad editor day is an unauthorised bill.
const DEFAULT_LIMIT = 5;

// ── pure decisions (unit-tested; no I/O) ─────────────────────────────────────

/**
 * Which posts this run will act on, plus what the revenue hold withheld.
 *
 * `includeLive: true` is deliberate and is the opposite of what the 5 AM digest
 * asks for. A live page serving content that fails the gate is exactly this
 * agent's job; it is just not something to wake a human for.
 *
 * ORDER: hold, THEN efficiency ranking, THEN `--slug`, THEN `--limit`. Both the
 * hold and the ranking go before the limit for the same reason — five held (or
 * five least-efficient) posts must not consume a budget of five and leave every
 * earning-cluster post blocked for another day. `--slug` is checked after both
 * so an explicitly named post is never withheld OR reordered away: the hold
 * stops unattended spend, and a hand-typed slug is not unattended.
 *
 * The ranking DEPRIORITISES, it never excludes: `orderByEfficiency` reserves the
 * last in-cap slot for the lowest-ranked cluster present, so the bottom cluster
 * still gets a post remediated on a run where it has one to remediate.
 *
 * @param {Array<{slug:string, meta:object, report:string, reportAgeDays:number}>} entries
 * @param {{now?:number, limit?:number, slug?:string, hold?:object, includeHeld?:boolean,
 *          ranking?:object}} opts
 * @returns {{kept:Array, held:Array, overridden:Array, efficiency:object|null}}
 */
export function selectBlockedPostsWithHold(entries, {
  now = Date.now(), limit = null, slug = null, hold = null, includeHeld = false,
  ranking = null,
} = {}) {
  const classified = (entries || [])
    .map((e) => {
      const verdict = classifyBlockedReport({
        report: e.report, meta: e.meta, reportAgeDays: e.reportAgeDays, now, includeLive: true,
      });
      return verdict ? { ...e, live: verdict.live, blockers: verdict.blockerText } : null;
    })
    .filter(Boolean);

  const { kept, held, overridden } = slug
    ? { kept: classified, held: [], overridden: [] }
    : partitionHeld(classified, hold, {
      includeHeld,
      describe: (e) => ({ slug: e.slug, keyword: e.meta?.target_keyword, title: e.meta?.title }),
    });

  let out = kept;
  let efficiency = null;
  if (!slug && ranking) {
    efficiency = orderByEfficiency(out, ranking, {
      limit,
      describe: (e) => ({ slug: e.slug, keyword: e.meta?.target_keyword, title: e.meta?.title }),
    });
    out = efficiency.items;
  }
  if (slug) out = out.filter((e) => e.slug === slug);
  if (limit) out = out.slice(0, limit);
  return { kept: out, held, overridden, efficiency };
}

/** The selection alone. Kept as the call shape everything already uses. */
export function selectBlockedPosts(entries, opts = {}) {
  return selectBlockedPostsWithHold(entries, opts).kept;
}

/**
 * What to do with one selected post. A post with no Shopify article has no LIVE
 * body to pull, so remediate-live-post.js exits 1 on it immediately — that post
 * belongs to calendar-runner's publish pipeline, not here.
 */
export function planPost(entry) {
  const meta = entry?.meta || {};
  if (!meta.shopify_article_id || !meta.shopify_blog_id) {
    return { slug: entry.slug, action: 'skip', reason: 'not on Shopify (no article/blog id) — owned by the publish pipeline' };
  }
  return { slug: entry.slug, action: 'remediate', reason: null };
}

/** Meta after the gate passes: the flag goes, and so does any prior write-off. */
export function metaAfterSuccess(meta, { at }) {
  const { needs_rebuild: _flag, blocked_resolution: _prior, ...rest } = meta || {};
  return { ...rest, blocked_resolved_at: at };
}

/**
 * Meta after the repair loop is exhausted.
 *
 * The flag is cleared so the post stops resurfacing, and the verdict it failed
 * on is fingerprinted so tomorrow's run does not pay to fail again on identical
 * text. Nothing about the post's PUBLISH state is touched — the page stays live.
 */
export function metaAfterExhaustion(meta, { at, report, reasons = [] }) {
  const { needs_rebuild: _flag, ...rest } = meta || {};
  return {
    ...rest,
    blocked_resolution: {
      outcome: 'exhausted',
      attempted_at: at,
      reasons,
      report_fingerprint: reportFingerprint(report),
      note: 'Claims softened where possible; page left LIVE and earning. Never unpublished.',
    },
  };
}

/** The single deferred digest line. Names every post and what happened to it. */
export function renderResolverSummary({
  resolved = [], exhausted = [], skipped = [], failed = [], dryRun = false, candidates = [],
  held = [], notes = [],
} = {}) {
  // `notes` carries the attribution-disagreement lines. They belong in the
  // digest body, not only in the console banner: this agent runs unattended.
  const holdLines = [...renderHoldLines(held), ...notes];
  if (dryRun) {
    if (!candidates.length) {
      return ['Dry run — no blocked posts found.', ...holdLines].join('\n');
    }
    return [
      `Dry run — ${candidates.length} blocked post(s) would be remediated:`,
      ...candidates.map((c) => `- ${c.slug}${c.live ? ' (LIVE)' : ''}`),
      ...(holdLines.length ? ['', ...holdLines] : []),
      '',
      'Re-run with --apply to remediate and push.',
    ].join('\n');
  }

  if (!resolved.length && !exhausted.length && !skipped.length && !failed.length) {
    return ['No blocked posts — nothing to resolve.', ...holdLines].join('\n');
  }

  const lines = [
    `${resolved.length} resolved, ${exhausted.length} softened & written off, `
    + `${skipped.length} skipped, ${failed.length} failed.`,
  ];
  if (resolved.length) {
    lines.push('', 'Resolved (gate passes; live content updated):');
    for (const r of resolved) lines.push(`- ${r.slug}${r.softened ? ' (via claim softening)' : ''}`);
  }
  if (exhausted.length) {
    lines.push('', 'Repair loop exhausted — claims softened, flag cleared, page STILL LIVE:');
    for (const e of exhausted) lines.push(`- ${e.slug}: ${(e.reasons || []).join(', ') || 'see editor report'}`);
  }
  if (skipped.length) {
    lines.push('', 'Skipped:');
    for (const s of skipped) lines.push(`- ${s.slug}: ${s.reason}`);
  }
  if (failed.length) {
    lines.push('', 'Failed (nothing changed on Shopify):');
    for (const f of failed) lines.push(`- ${f.slug}: ${f.reason}`);
  }
  if (holdLines.length) lines.push('', ...holdLines);
  return lines.join('\n');
}

// ── run ──────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

function readReport(slug) {
  const p = getEditorReportPath(slug);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function reportAgeDays(slug) {
  try { return (Date.now() - statSync(getEditorReportPath(slug)).mtimeMs) / 86400000; }
  catch { return Infinity; }
}

function collectEntries() {
  const out = [];
  for (const slug of listAllSlugs()) {
    const report = readReport(slug);
    if (!report) continue;
    const meta = getPostMeta(slug);
    if (!meta) continue;
    out.push({ slug, meta, report, reportAgeDays: reportAgeDays(slug) });
  }
  return out;
}

const NODE = process.execPath;
/** Run a child step. Returns the exit code (0 = ok); never throws. */
function runStep(cmd) {
  try { execSync(cmd, { cwd: ROOT, stdio: 'inherit' }); return 0; }
  catch (err) { return err.status ?? 1; }
}

function blockerSections(report) {
  return parseEditorBlockers(report).map((b) => b.section);
}

/**
 * Exhaustion path. Force a soften pass (citation-finder softens anything it
 * cannot source), re-gate, and push ONLY if that cleared the gate. If it did
 * not: clear the flag, write off this verdict, and leave the live page exactly
 * as it is. Nothing here unpublishes, drafts, or deletes anything.
 */
async function softenAndSettle(slug, meta) {
  console.log(`  ${slug}: repair loop exhausted — forcing a claim-softening pass.`);
  runStep(`"${NODE}" agents/citation-finder/index.js --slug ${slug}`);
  // Re-gate WITHOUT --in-pipeline so the editor rewrites editor-report.md and
  // reconciles needs_rebuild (agents/editor/index.js:1393).
  runStep(`"${NODE}" agents/editor/index.js ${getContentPath(slug)}`);

  const report = readReport(slug) || '';
  const at = new Date().toISOString();

  if (isPassing(report)) {
    const { updateArticle, getArticle } = await import('../../lib/shopify.js');
    const live = await getArticle(meta.shopify_blog_id, meta.shopify_article_id);
    const body = readFileSync(getContentPath(slug), 'utf8');
    if (body && body !== (live.body_html || '')) {
      await updateArticle(meta.shopify_blog_id, meta.shopify_article_id, { body_html: body });
      console.log(`  ${slug}: ✓ softening cleared the gate — pushed to Shopify.`);
    }
    replacePostMeta(slug, metaAfterSuccess(getPostMeta(slug) || meta, { at }));
    return { outcome: 'resolved', softened: true };
  }

  const reasons = blockerSections(report);
  if (!reasons.length) reasons.push(firstBlockerReason(report));
  replacePostMeta(slug, 
    metaAfterExhaustion(getPostMeta(slug) || meta, { at, report, reasons }));
  console.log(`  ${slug}: still failing (${reasons.join(', ')}). Page left LIVE; flag cleared; verdict written off.`);
  return { outcome: 'exhausted', reasons };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const includeHeld = process.argv.includes(HOLD_FLAG);
  const slug = arg('--slug');
  const limitRaw = arg('--limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : DEFAULT_LIMIT;

  console.log('\nBlocked Post Resolver\n');

  const hold = loadClusterHold({ root: ROOT });
  const banner = holdBanner(hold);
  if (banner) console.log(`${banner}\n`);
  // Deprioritise, don't condemn: the hold decides WHETHER, this decides IN WHAT
  // ORDER the surviving posts spend a budget of five.
  const ranking = rankClusters(hold);
  const rankBanner = efficiencyBanner(ranking);
  if (rankBanner) console.log(`${rankBanner}\n`);

  const { kept: candidates, held, efficiency } = selectBlockedPostsWithHold(
    collectEntries(), { limit, slug, hold, includeHeld, ranking },
  );
  console.log(`  ${candidates.length} blocked post(s)${apply ? '' : ' (DRY RUN)'}`);
  if (held.length) for (const line of renderHoldLines(held)) console.log(`  ${line}`);
  const rankLines = renderEfficiencyLines(ranking, efficiency);
  for (const line of rankLines) console.log(`  ${line}`);

  if (!apply) {
    for (const c of candidates) console.log(`    [${c.live ? 'live' : 'pre-publish'}] ${c.slug}`);
    const body = renderResolverSummary({ dryRun: true, candidates, held, notes: [...rankLines, ...renderDisagreementLines(hold)] });
    console.log(`\n${body}`);
    await notify({ subject: `Blocked Post Resolver: ${candidates.length} candidate(s)${holdSummaryFragment(held)} (dry run)`, body, status: 'info', category: 'pipeline' }).catch(() => {});
    return;
  }

  const resolved = []; const exhausted = []; const skipped = []; const failed = [];

  for (const entry of candidates) {
    const plan = planPost(entry);
    if (plan.action === 'skip') { skipped.push(plan); console.log(`  [skip] ${plan.slug}: ${plan.reason}`); continue; }

    try {
      // The canonical repair loop. --push because the scheduled path applies
      // (Autonomy Principle); it still pushes ONLY a revision that PASSES.
      const code = runStep(`"${NODE}" scripts/remediate-live-post.js ${entry.slug} --push`);
      if (code === 0) {
        const at = new Date().toISOString();
        replacePostMeta(entry.slug, metaAfterSuccess(getPostMeta(entry.slug) || entry.meta, { at }));
        resolved.push({ slug: entry.slug, softened: false });
        console.log(`  [ok] ${entry.slug}: gate passes.`);
        continue;
      }
      const settled = await softenAndSettle(entry.slug, entry.meta);
      if (settled.outcome === 'resolved') resolved.push({ slug: entry.slug, softened: true });
      else exhausted.push({ slug: entry.slug, reasons: settled.reasons });
    } catch (err) {
      failed.push({ slug: entry.slug, reason: (err.message || String(err)).split('\n')[0] });
      console.error(`  [fail] ${entry.slug}: ${err.message}`);
    }
  }

  const body = renderResolverSummary({ resolved, exhausted, skipped, failed, dryRun: false, held, notes: [...rankLines, ...renderDisagreementLines(hold)] });
  console.log(`\n${body}`);

  await notify({
    subject: `Blocked Post Resolver: ${resolved.length} resolved, ${exhausted.length} written off, ${failed.length} failed${holdSummaryFragment(held)}`,
    body,
    // Deferred, per the digest convention in CLAUDE.md — never immediate. An
    // exhausted post is a note, not an outage: the page is still live.
    status: failed.length ? 'error' : 'info',
    category: 'pipeline',
  }).catch(() => {});
}

// Only run when invoked directly. Importing this module must not start a live
// remediation — it pushes to Shopify.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    notify({ subject: 'Blocked Post Resolver failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
}
