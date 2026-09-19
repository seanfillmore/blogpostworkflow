#!/usr/bin/env node
/**
 * Indexing Fixer
 *
 * Takes action on the indexing gaps identified by indexing-checker. Three-tier
 * escalation:
 *
 *   Tier 1 — Automatic sitemap resubmission
 *     Posts flagged verdict.action === 'resubmit_sitemap' get a sitemap ping
 *     to nudge Google to re-crawl.
 *
 *   Tier 2 — Automatic Indexing API submission (no approval required)
 *     Posts flagged verdict.action === 'submit_indexing_api' are submitted
 *     directly to the Google Indexing API. No human approval step.
 *
 *   Tier 3 — Manual investigation flag. TWO INDEPENDENT PATHS, counted and
 *   reported separately because the remedies are different:
 *
 *     (a) escalated — submission-count escalation. A post with >= 2 prior
 *         DELIVERED Indexing API submissions (lib/indexing-escalation.js) that
 *         is STILL not indexed gets indexing_blocked: true on its post JSON.
 *         There is no age condition: the trigger is the delivered-submission
 *         count alone. (This docstring claimed an additional 30-day age
 *         condition until 2026-09-19; no such check has ever existed in the
 *         code, and adding one would be a behaviour change.)
 *
 *     (b) critical — a true technical misconfiguration (noindex tag, robots.txt
 *         block, canonical conflict, page fetch failure). Neither resubmission
 *         nor a refresh can fix these, so they go straight to the manual flag.
 *
 *     Both land in the run's notify() subject and body. They were NOT both
 *     surfaced until 2026-09-19: the escalations were printed to a cron log and
 *     nowhere else, so five posts were re-stamped indexing_blocked every morning
 *     and never once appeared in the 5 AM digest.
 *
 * crawled_not_indexed — Content quality path (separate from the tiers above)
 *     Google crawled the page but declined to index it, signalling a content
 *     quality issue. The fixer auto-triggers refresh-runner to rewrite the post
 *     (if not refreshed within the last 30 days). After the refresh, the next
 *     indexing-checker run will re-inspect and submit via Tier 2 if needed.
 *
 *     REVENUE-GATED. This is the path that spends money: each refresh is a
 *     chain of paid LLM calls, and on 2026-08-21 eleven of them fired in one
 *     unattended run for a single cluster that has returned $0. A post whose
 *     cluster the revenue report shows earning nothing is SKIPPED AND COUNTED
 *     here (lib/cluster-hold.js). No cluster is named in this file — the held
 *     set is measured, so it releases itself the moment the cluster earns.
 *     `--include-held` refreshes them anyway.
 *
 *     The free tiers above are deliberately NOT gated: a sitemap ping and an
 *     Indexing API submission cost nothing but a Google quota, and a hold is a
 *     spend pause, never a deindexing. Held pages stay live and stay submitted.
 *
 * Cron: daily 3:30 AM PT (after indexing-checker at 3:00 AM PT).
 *
 * Usage:
 *   node agents/indexing-fixer/index.js              # normal run
 *   node agents/indexing-fixer/index.js --dry-run    # preview actions
 *   node agents/indexing-fixer/index.js --include-held  # refresh $0-cluster posts too
 *   node agents/indexing-fixer/index.js --approve <slug>   # force Indexing API submit
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { notify } from '../../lib/notify.js';
import { resubmitSitemap, submitUrlForIndexing, getQuotaStatus } from '../../lib/gsc-indexing.js';
import {
  isInfraError, countDeliveredSubmissions, escalationDecisions,
} from '../../lib/indexing-escalation.js';
import {
  loadClusterHold, partitionHeld, renderHoldLines, renderDisagreementLines, holdBanner, HOLD_FLAG,
} from '../../lib/cluster-hold.js';

import { getMetaPath, POSTS_DIR, ROOT, replacePostMeta, requirePostMeta } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'indexing');
// This agent's OWN report — the checker owns REPORTS_DIR above. The digest reads
// `needs_decision[]` out of this file rather than scanning post metadata, the
// same rule PR #911 established: what a human sees is what the robot SAYS it
// gave up on, never the fleet's working state.
const FIXER_REPORTS_DIR = join(ROOT, 'data', 'reports', 'indexing-fixer');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');
const QUEUE_FILE = join(QUEUE_DIR, 'indexing-submissions.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const INCLUDE_HELD = args.includes(HOLD_FLAG);
const approveIdx = args.indexOf('--approve');
const APPROVE_SLUG = approveIdx !== -1 ? args[approveIdx + 1] : null;

// Config: the primary sitemap URL to resubmit. Shopify sites expose sitemap.xml
// at the root. If multiple sitemap indexes exist they're nested under this.
function loadConfig() {
  const c = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
  const siteUrl = (c.url || '').replace(/\/$/, '');
  return {
    name: c.name,
    siteUrl,
    sitemapUrl: `${siteUrl}/sitemap.xml`,
  };
}

// ── queue (shared shape with the future performance-engine approval loop) ────

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { items: [] };
  try { return JSON.parse(readFileSync(QUEUE_FILE, 'utf8')); } catch { return { items: [] }; }
}

function saveQueue(q) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

function upsertQueueItem(item) {
  const q = loadQueue();
  const idx = q.items.findIndex((x) => x.slug === item.slug);
  if (idx === -1) q.items.push(item);
  else q.items[idx] = { ...q.items[idx], ...item, updated_at: new Date().toISOString() };
  saveQueue(q);
}

// ── post metadata ─────────────────────────────────────────────────────────────

function loadPostMeta(slug) {
  try { return requirePostMeta(slug); } catch { return null; }
}

/**
 * Slugs whose indexing problem has resolved but still carry indexing_blocked.
 *
 * Exported for test: this is the sweep that was missing, and its absence is what
 * let a cached flag outlive the condition it described.
 */
export function staleBlockedSlugs(results, getMeta) {
  const out = [];
  for (const r of results || []) {
    if (!r?.slug) continue;
    if (r.verdict?.severity !== 'ok') continue;
    const meta = getMeta(r.slug);
    if (meta?.indexing_blocked) out.push(r.slug);
  }
  return out;
}

/**
 * Split the crawled_not_indexed list into what gets a paid refresh and what is
 * held because its cluster earns $0.
 *
 * Exported for test, and thin on purpose: the rule itself lives in
 * lib/cluster-hold.js so every agent holds on the same measured evidence rather
 * than on its own copy of a threshold. The post's recorded target keyword is
 * consulted alongside the slug — that keyword is what seo-impact attributes
 * revenue on, and the legacy corpus has slugs that name no product at all.
 *
 * @returns {{kept:Array, held:Array, overridden:Array}}
 */
export function holdContentQuality(results, hold, { includeHeld = false, getMeta = loadPostMeta } = {}) {
  return partitionHeld(results, hold, {
    includeHeld,
    describe: (r) => ({
      slug: r?.slug,
      keyword: getMeta?.(r?.slug)?.target_keyword,
      title: r?.title,
      url: r?.url,
    }),
  });
}

/**
 * Compose the run's digest subject, body and severity.
 *
 * Exported for test, and pure on purpose: the notify() call it feeds sits inside
 * processNormalRun, which reads a report off disk and talks to the Indexing API,
 * so the only way to pin what the 5 AM digest actually SAYS is to make the
 * composition itself a function with no I/O.
 *
 * The severity rule is the fleet rule (CLAUDE.md): `status: 'error'` means the
 * AGENT BROKE, never "the agent found something bad". `escalated` is deliberately
 * NOT in the ternary — a page Google declines to index is a finding a human
 * should read, not a report that this agent is broken. `critical` and
 * `tierTwoFailed` keep the behaviour they already had; changing either is a
 * separate decision.
 *
 * @returns {{parts: string[], subject: string, body: string, status: string}}
 *          `parts` empty means the run had nothing to report and no notification
 *          should be sent.
 */
export function buildRunNotification({
  infraFailure = null,
  tierOne = [],
  tierTwoSucceeded = [],
  tierTwoFailed = [],
  contentQuality = [],
  heldRefreshes = [],
  escalated = [],
  critical = [],
  holdLines = [],
  disagreementLines = [],
} = {}) {
  const parts = [];
  if (infraFailure) parts.push('⚠ Indexing API infra failure — submissions aborted (re-auth/quota check needed)');
  if (tierOne.length) parts.push(`Sitemap pinged (${tierOne.length} URLs)`);
  if (tierTwoSucceeded.length || tierTwoFailed.length) {
    const sub = [];
    if (tierTwoSucceeded.length) sub.push(`${tierTwoSucceeded.length} submitted to Indexing API`);
    if (tierTwoFailed.length) sub.push(`${tierTwoFailed.length} Indexing API submissions FAILED`);
    parts.push(sub.join(', '));
  }
  if (contentQuality.length) parts.push(`${contentQuality.length} content-quality refresh triggered`);
  // Named in the subject so a held cluster is visible in the 5 AM digest rather
  // than showing up as a run that mysteriously stopped doing anything.
  if (heldRefreshes.length) parts.push(`${heldRefreshes.length} held ($0 cluster)`);
  // Worded so it cannot be read as the `critical` count beside it: these are two
  // different findings with two different remedies.
  if (escalated.length) parts.push(`${escalated.length} escalated (repeat submissions, still not indexed)`);
  if (critical.length) parts.push(`${critical.length} flagged for manual fix`);

  // ORDER IS LOAD-BEARING, and this is the second half of the visibility fix.
  // agents/daily-summary renders an entry body through previewBody(), which cuts
  // at EIGHT LINES. The run that hid the escalations carried 14 [tier1] lines
  // and 13 [refresh] lines, so anything appended after them was truncated away
  // before a human could see it — moving the escalated set into the body alone
  // would have changed the subject and nothing else. What no further run will
  // ever clear goes first; the routine, self-clearing work goes last.
  const body = [
    ...(infraFailure ? [`[INFRA] Indexing API failure: ${String(infraFailure).slice(0, 160)} — Tier 2 aborted; remaining posts will retry next run.`] : []),
    ...escalated.map((r) => `[escalated] ${r.slug}: ${r.prior_indexing_submissions} prior Indexing API submissions, still not indexed (state: ${r.state})`),
    ...critical.map((r) => `[critical] ${r.slug}: ${r.verdict?.action}`),
    ...tierTwoFailed.map((r) => `[tier2-FAIL] ${r.slug}: ${String(r.error).slice(0, 120)}`),
    ...holdLines,
    ...disagreementLines,
    ...tierOne.map((r) => `[tier1] ${r.slug}: sitemap pinged (${r.age_days}d old, ${r.state})`),
    ...tierTwoSucceeded.map((r) => `[tier2] ${r.slug}: submitted to Indexing API (${r.age_days}d old)`),
    ...contentQuality.map((r) => `[refresh] ${r.slug}: refresh-runner triggered (crawled_not_indexed)`),
  ].join('\n');

  return {
    parts,
    subject: `Indexing Fixer: ${parts.join(', ')}`,
    body,
    status: (critical.length > 0 || tierTwoFailed.length > 0) ? 'error' : 'info',
  };
}

function stampPostMeta(slug, patch) {
  const meta = loadPostMeta(slug);
  if (!meta) return;
  const merged = { ...meta, ...patch };
  replacePostMeta(slug, merged);
}

function recordSubmission(slug, submission) {
  const meta = loadPostMeta(slug);
  if (!meta) return;
  const history = meta.indexing_submissions || [];
  history.push(submission);
  stampPostMeta(slug, { indexing_submissions: history });
}

function ageInDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

// ── critical action handlers ──────────────────────────────────────────────────

function handleCriticalVerdict(result) {
  const reasons = {
    fix_noindex_tag: 'Page has a noindex meta tag. Remove it in the Shopify article HTML.',
    fix_robots_txt: 'robots.txt blocks this URL. Check the Shopify theme robots.txt.liquid file.',
    fix_canonical_mismatch: `Google picked a different canonical (${result.google_canonical || '?'}) than what the page declares. Update the canonical tag or content to match.`,
    fix_page_fetch: `Page fetch failed with ${result.page_fetch_state}. URL may be 404 or returning an error.`,
  };
  const action = result.verdict.action;
  return reasons[action] || 'Manual investigation required.';
}

// ── main ──────────────────────────────────────────────────────────────────────

async function processNormalRun() {
  const config = loadConfig();
  console.log('\nIndexing Fixer\n');

  const latestPath = join(REPORTS_DIR, 'latest.json');
  if (!existsSync(latestPath)) {
    console.error(`  No indexing report at ${latestPath}. Run indexing-checker first.`);
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(latestPath, 'utf8'));
  const allResults = report.results || [];

  // Clear indexing_blocked on posts that have since been indexed.
  //
  // The flag was only ever cleared when a post got RETRIED, and a post whose
  // verdict is now 'ok' is filtered out of `actionable` below — so it stopped
  // being retried and the flag outlived the problem. That left 46 posts wearing a
  // permanent "technical fix required" label, 32 of them indexed by Google, and
  // legacy-triage bucketed all 46 as broken (which legacy-rebuilder skips forever).
  const resolved = staleBlockedSlugs(allResults, loadPostMeta);
  if (resolved.length) {
    console.log(`  Clearing stale indexing_blocked on ${resolved.length} now-indexed post(s):`);
    for (const slug of resolved) {
      console.log(`    - ${slug}`);
      if (!DRY_RUN) {
        stampPostMeta(slug, {
          indexing_blocked: false,
          indexing_blocked_reason: null,
          indexing_unblocked_at: new Date().toISOString(),
        });
      }
    }
  }

  const actionable = allResults.filter((r) => r.verdict && r.verdict.severity !== 'ok');
  console.log(`  Actionable items from latest report: ${actionable.length}`);

  if (actionable.length === 0) {
    console.log('  Nothing to fix. Indexing is healthy.');
    return;
  }

  const quota = getQuotaStatus();
  console.log(`  Indexing API submissions remaining today: ${quota.submission.remaining}/${quota.submission.cap}\n`);

  const tierOne = actionable.filter((r) => r.verdict.action === 'resubmit_sitemap');
  const tierTwo = actionable.filter((r) => r.verdict.action === 'submit_indexing_api');
  const critical = actionable.filter((r) => [
    'fix_noindex_tag', 'fix_robots_txt', 'fix_canonical_mismatch', 'fix_page_fetch',
  ].includes(r.verdict.action));

  // The only paid path in this agent. Everything above is a free API call, so
  // only this one is revenue-gated. Held posts stay live, stay in the sitemap,
  // and stay eligible for Tier 1/Tier 2 — we simply stop buying them rewrites.
  const hold = loadClusterHold({ root: ROOT });
  const banner = holdBanner(hold);
  if (banner) console.log(`${banner}\n`);
  const { kept: contentQuality, held: heldRefreshes } = holdContentQuality(
    actionable.filter((r) => r.verdict.action === 'content_quality_review'),
    hold,
    { includeHeld: INCLUDE_HELD },
  );

  console.log(`  Tier 1 (sitemap ping — auto):        ${tierOne.length}`);
  console.log(`  Tier 2 (indexing API — auto):        ${tierTwo.length}`);
  console.log(`  Content quality (auto-refresh):      ${contentQuality.length}`);
  if (heldRefreshes.length) console.log(`  Content quality (HELD, $0 cluster):  ${heldRefreshes.length}`);
  // Tier 3 has two paths and this block could only ever see one of them: the
  // submission-count escalations are decided inside the Tier 2 loop below, so
  // they are counted and printed there. This line used to be labelled "manual
  // investigation" and printed 0 on mornings when five escalations fired six
  // lines further down.
  console.log(`  Tier 3a (misconfiguration — manual):  ${critical.length}`);
  console.log(`  Tier 3b (repeat submissions):         counted below\n`);

  for (const h of renderHoldLines(heldRefreshes)) console.log(`  ${h}`);
  if (heldRefreshes.length) console.log('');

  // ── Tier 1: sitemap resubmission ──────────────────────────────────────────
  // One sitemap ping covers all pending URLs simultaneously (the sitemap
  // contains all live posts), so we only need ONE resubmit per run regardless
  // of how many URLs are flagged.
  if (tierOne.length > 0) {
    console.log(`  Tier 1: Resubmitting sitemap ${config.sitemapUrl}...`);
    if (DRY_RUN) {
      console.log('    (dry-run — skipping)');
    } else {
      try {
        const result = await resubmitSitemap(config.sitemapUrl);
        console.log(`    ✓ sitemap resubmitted (HTTP ${result.status})`);
        const submission = {
          method: 'sitemap_resubmit',
          submitted_at: new Date().toISOString(),
          result: 'ok',
        };
        // Stamp every Tier 1 candidate with the submission record
        for (const r of tierOne) {
          recordSubmission(r.slug, submission);
        }
      } catch (err) {
        console.error(`    ✗ sitemap resubmit failed: ${err.message}`);
      }
    }
  }

  // ── Tier 2: auto-submit to Indexing API ───────────────────────────────────
  const tierTwoSucceeded = [];
  const tierTwoFailed = [];
  // Tier 3b. Collected rather than only logged: every one of these stamps
  // indexing_blocked on a live post, and until 2026-09-19 none of them reached
  // the digest — five posts were re-stamped every morning in silence.
  const escalated = [];
  let infraFailure = null; // set if an account-wide auth/quota/network error hits
  for (const r of tierTwo) {
    // An account-wide infra failure (auth/scope/quota/network) means every
    // remaining submission will fail the same way. Stop the loop rather than
    // recording per-post "failures" that would poison each post's give-up budget.
    if (infraFailure) break;

    const meta = loadPostMeta(r.slug);
    const subs = meta?.indexing_submissions || [];
    const priorSitemap = countDeliveredSubmissions(subs, 'sitemap_resubmit');
    const priorIndexing = countDeliveredSubmissions(subs, 'indexing_api');

    // Escalation to Tier 3: only submissions actually DELIVERED to Google count.
    // Errored submissions (e.g. an auth outage) never reached the index pipeline,
    // so they must not push a post toward a permanent block.
    if (priorIndexing >= 2) {
      console.log(`  Tier 3b escalation: ${r.slug} — ${priorIndexing} prior Indexing API submissions, still not indexed`);
      escalated.push({
        slug: r.slug,
        title: r.title,
        url: r.url,
        state: r.state,
        age_days: r.age_days,
        prior_indexing_submissions: priorIndexing,
      });
      if (!DRY_RUN) {
        stampPostMeta(r.slug, {
          indexing_blocked: true,
          indexing_blocked_reason: `${priorIndexing} prior Indexing API submissions failed to get the post indexed. Current state: ${r.state}. Manual investigation required.`,
          indexing_blocked_at: new Date().toISOString(),
        });
      }
      continue;
    }

    if (quota.submission.remaining === 0) {
      console.log(`  Tier 2 skip: ${r.slug} — Indexing API quota exhausted for today`);
      continue;
    }

    console.log(`  Tier 2 submitting: ${r.slug} (prior: ${priorSitemap} sitemap, ${priorIndexing} indexing)`);
    if (DRY_RUN) {
      console.log('    (dry-run — skipping)');
    } else {
      try {
        const result = await submitUrlForIndexing(r.url, 'URL_UPDATED');
        console.log(`    ✓ submitted ${r.url}`);
        recordSubmission(r.slug, {
          method: 'indexing_api',
          type: 'URL_UPDATED',
          submitted_at: result.submitted_at,
          notification_time: result.notification_time,
          result: 'ok',
        });
        // We're actively retrying this post — clear any stale block left over
        // from a prior infra outage so it isn't treated as broken elsewhere.
        if (meta?.indexing_blocked) {
          stampPostMeta(r.slug, {
            indexing_blocked: false,
            indexing_blocked_reason: null,
            indexing_unblocked_at: new Date().toISOString(),
          });
        }
        upsertQueueItem({
          slug: r.slug,
          title: r.title,
          url: r.url,
          state: r.state,
          age_days: r.age_days,
          status: 'submitted',
          submitted_at: result.submitted_at,
          updated_at: new Date().toISOString(),
        });
        tierTwoSucceeded.push(r);
      } catch (err) {
        console.error(`    ✗ submission failed: ${err.message}`);
        recordSubmission(r.slug, {
          method: 'indexing_api',
          submitted_at: new Date().toISOString(),
          result: 'error',
          error: err.message,
        });
        tierTwoFailed.push({ slug: r.slug, error: err.message });
        // Account-wide failure (auth/scope/quota/network): abort the rest of the
        // run so we don't record a cascade of per-post failures. The next run
        // retries cleanly once the underlying issue (e.g. re-auth) is resolved.
        if (isInfraError(err.message)) {
          infraFailure = err.message;
          console.error(`    ⚠ infrastructure failure detected — aborting Tier 2 for this run`);
        }
      }
    }
  }

  // The count the summary block above could not know yet.
  console.log(`\n  Tier 3b (repeat submissions — escalated): ${escalated.length}`);
  for (const e of escalated) {
    console.log(`    [escalated] ${e.slug}: ${e.prior_indexing_submissions} prior Indexing API submissions, still not indexed (state: ${e.state})`);
  }
  console.log('');

  // ── Content quality: auto-refresh via refresh-runner ──────────────────────
  // Google crawled but declined to index — content quality is the fix, not
  // resubmission. Trigger refresh-runner if not refreshed in the last 30 days.
  const REFRESH_COOLDOWN_DAYS = 30;
  for (const r of contentQuality) {
    const meta = loadPostMeta(r.slug);
    const lastRefresh = meta ? ageInDays(meta.last_refreshed_at) : null;

    if (lastRefresh != null && lastRefresh < REFRESH_COOLDOWN_DAYS) {
      console.log(`  Content quality skip: ${r.slug} — refreshed ${lastRefresh}d ago, waiting for Google to re-crawl`);
      continue;
    }

    console.log(`  Content quality: triggering refresh for ${r.slug} (last refresh: ${lastRefresh != null ? lastRefresh + 'd ago' : 'never'})`);
    if (DRY_RUN) {
      console.log('    (dry-run — skipping)');
    } else {
      try {
        execSync(`node agents/refresh-runner/index.js ${r.slug}`, { cwd: ROOT, stdio: 'inherit' });
        console.log(`    ✓ refresh complete for ${r.slug}`);
      } catch (err) {
        console.error(`    ✗ refresh failed for ${r.slug}: ${err.message}`);
      }
    }
  }

  // ── Tier 3a: true technical misconfigurations ──────────────────────────────
  for (const r of critical) {
    const reason = handleCriticalVerdict(r);
    console.log(`  Tier 3a critical: ${r.slug} — ${r.verdict.action}`);
    console.log(`    ${reason}`);
    if (!DRY_RUN) {
      stampPostMeta(r.slug, {
        indexing_blocked: true,
        indexing_blocked_reason: reason,
        indexing_blocked_at: new Date().toISOString(),
      });
    }
  }

  // ── The run's own report ─────────────────────────────────────────────────
  // `needs_decision[]` is what agents/daily-summary renders in "Needs your
  // decision" — the same field, the same row shape and the same renderer as
  // queue-autoapply's (PR #911), because it is the same class of finding: a skip
  // no automated run will ever clear. Written even when empty, so a downstream
  // staleness check can tell "ran, found nothing" from "did not run".
  //
  // Written on a DRY run too: it records what the run decided, and a dry run
  // decides exactly the same thing. Nothing here touches a post or Shopify.
  const needsDecision = escalationDecisions(escalated, loadPostMeta);
  try {
    mkdirSync(FIXER_REPORTS_DIR, { recursive: true });
    writeFileSync(join(FIXER_REPORTS_DIR, 'latest.json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      dry_run: DRY_RUN,
      tier_one: tierOne.length,
      tier_two_submitted: tierTwoSucceeded.length,
      tier_two_failed: tierTwoFailed.length,
      content_quality_refreshed: contentQuality.length,
      content_quality_held: heldRefreshes.length,
      escalated: escalated.length,
      critical: critical.length,
      needs_decision: needsDecision,
    }, null, 2));
  } catch (err) {
    // Best-effort: failing to write a report must never take down a run that
    // already did its work.
    console.error(`  ⚠ could not write indexing-fixer report: ${err.message}`);
  }

  // ── Daily digest notification ────────────────────────────────────────────
  // Composition lives in the pure buildRunNotification so it can be tested; a
  // hold and an escalation are both routine housekeeping working as designed, so
  // neither moves this off 'info' — only a real failure does. Deferred either way.
  const notification = buildRunNotification({
    infraFailure,
    tierOne,
    tierTwoSucceeded,
    tierTwoFailed,
    contentQuality,
    heldRefreshes,
    escalated,
    critical,
    holdLines: renderHoldLines(heldRefreshes),
    disagreementLines: renderDisagreementLines(hold),
  });

  if (notification.parts.length > 0) {
    await notify({
      subject: notification.subject,
      body: notification.body,
      status: notification.status,
      category: 'seo',
    }).catch(() => {});
  }

  console.log('\nIndexing fixer run complete.');
}

async function processApproval(slug) {
  console.log(`\nIndexing Fixer — manual approval for ${slug}\n`);

  const q = loadQueue();
  const item = q.items.find((x) => x.slug === slug);
  if (!item) { console.error(`  Not in queue: ${slug}`); process.exit(1); }
  if (item.status !== 'pending_approval') {
    console.error(`  Already ${item.status}`);
    process.exit(1);
  }

  const quota = getQuotaStatus();
  if (quota.submission.remaining === 0) {
    console.error(`  Daily Indexing API quota exhausted (${quota.submission.cap}/day). Try tomorrow.`);
    process.exit(1);
  }

  try {
    const result = await submitUrlForIndexing(item.url, 'URL_UPDATED');
    console.log(`  ✓ Submitted ${item.url} to Indexing API`);

    recordSubmission(slug, {
      method: 'indexing_api',
      type: 'URL_UPDATED',
      submitted_at: result.submitted_at,
      notification_time: result.notification_time,
      result: 'ok',
    });

    item.status = 'submitted';
    item.submitted_at = result.submitted_at;
    item.updated_at = new Date().toISOString();
    saveQueue(q);

    await notify({
      subject: `Indexing API submission: ${slug}`,
      body: `Submitted ${item.url} to Google Indexing API. Expect re-crawl within 24 hours.`,
      status: 'info',
      category: 'seo',
    }).catch(() => {});
  } catch (err) {
    console.error(`  ✗ Submission failed: ${err.message}`);
    recordSubmission(slug, {
      method: 'indexing_api',
      submitted_at: new Date().toISOString(),
      result: 'error',
      error: err.message,
    });
    process.exit(1);
  }
}

async function main() {
  if (APPROVE_SLUG) {
    await processApproval(APPROVE_SLUG);
  } else {
    await processNormalRun();
  }
}

// Only run when invoked directly. Without this guard, importing anything from this
// module submits URLs to the Google Indexing API, stamps post metadata, and fires
// notifications — an import of it during testing did exactly that.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    console.error('Indexing fixer failed:', err);
    process.exit(1);
  });
}
