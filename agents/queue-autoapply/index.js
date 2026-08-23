#!/usr/bin/env node
/**
 * Queue Auto-Apply
 *
 * Drains data/performance-queue/ without a human clicking Approve.
 *
 * The Optimization Queue was a manual review chore that nobody was doing: 21
 * items pending, the oldest 37 days old, every one of them waiting on a click.
 * Work that sits in a queue earns $0, which under the Prime Directive makes the
 * queue itself the bug.
 *
 * POLICY — "auto-apply, revenue-gated":
 *
 *   APPLY    seo-opportunity, quick-win, flop-refresh, page-meta-rewrite,
 *            low-ctr-meta, legacy-flop — each only AFTER the existing editorial
 *            gate (lib/edit-gate-repair.js) passes. An item the editor blocks
 *            goes into that library's repair loop, not onto a human's list.
 *   DISMISS  collection-gap items that hold fewer than 2 distinct products, or
 *            that sit in a cluster proven to earn $0. Cluster revenue is read
 *            from data/reports/seo-impact/latest.json through the shared
 *            lib/cluster-hold.js loader — the same evidence, read the same way,
 *            as every agent that puts a $0 cluster on hold. No cluster is named
 *            in code. Only the 2+ products rule is hardcoded (CLAUDE.md).
 *   LEAVE    everything else, including the pdp-builder artifacts that share
 *            this directory with a different schema.
 *
 * At most 5 LIVE applies per run (lib/queue-autoapply.js MAX_APPLIES_PER_RUN);
 * dismissals are uncapped because they touch nothing but a local JSON file.
 * Every applied item gets a backup captured BEFORE the write and a
 * `revert_plan` stamped onto it, so the dashboard's rollback route can actually
 * undo it (see lib/queue-revert.js).
 *
 * Usage:
 *   node agents/queue-autoapply/index.js              # DRY RUN — decides, changes nothing
 *   node agents/queue-autoapply/index.js --apply      # what the scheduler runs
 *   node agents/queue-autoapply/index.js --apply --limit 2
 *
 * Scheduled from scheduler.js after the queue producers and alongside the
 * publisher step that ships `approved` items.
 */

import { writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { listQueueItems, writeItem } from '../performance-engine/lib/queue.js';
import { getContentPath, ROOT as POSTS_ROOT } from '../../lib/posts.js';
import { loadClusterHold, holdBanner } from '../../lib/cluster-hold.js';
import { planRun, cooldownTargets, targetSlugFor, MAX_APPLIES_PER_RUN } from '../../lib/queue-autoapply.js';
import { applyItem, findPostMeta, matchProductsForGap } from '../../lib/queue-apply.js';
import { revertPlanFor } from '../../lib/queue-revert.js';
import { checkEditGate, runEditGateWithRepair } from '../../lib/edit-gate-repair.js';
import { buildTriggerCommand } from '../dashboard/lib/opportunity-trigger.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'queue-autoapply');

const REFRESH_TRIGGERS = new Set(['quick-win', 'flop-refresh', 'low-ctr-meta', 'legacy-flop']);

/**
 * Shopify calls, imported lazily. lib/shopify.js throws at import time without
 * OAuth credentials, and a dry run must be able to report its plan on a laptop
 * that has none.
 */
async function shopifyDeps() {
  const s = await import('../../lib/shopify.js');
  return {
    getBlogs: s.getBlogs,
    getArticle: s.getArticle,
    updateArticle: s.updateArticle,
    getProducts: s.getProducts,
    getMetafields: s.getMetafields,
    updateProduct: s.updateProduct,
    createCustomCollection: s.createCustomCollection,
    upsertMetafield: s.upsertMetafield,
  };
}

/**
 * How many distinct products each pending collection-gap item would hold.
 * One Shopify product read for the whole run, and only when there is at least
 * one such item — the common case makes no call at all.
 */
export async function buildProductCounts(items, deps) {
  const gaps = items.filter((i) => i?.trigger === 'collection-gap' && i.status === 'pending');
  const counts = new Map();
  if (!gaps.length) return counts;
  const products = await deps.getProducts();
  for (const item of gaps) counts.set(item.slug, matchProductsForGap(item, products).length);
  return counts;
}

/**
 * Make sure a backup of the current live body exists before anything is
 * applied, and return its path. Nothing is applied without one — "revertible"
 * has to be true at the moment of the write, not aspirationally afterwards.
 *
 * @returns {string|null} backup path, or null when this item edits no post body
 */
function ensureBackup(item, log) {
  const postSlug = findPostMeta(targetSlugFor(item))?.meta?.slug || targetSlugFor(item);
  const contentPath = getContentPath(postSlug);
  if (!existsSync(contentPath)) return null; // page/product items have no post body
  const backupPath = item.backup_html_path && item.backup_html_path.endsWith('.backup.html')
    ? item.backup_html_path
    : join(QUEUE_DIR, `${item.slug}.backup.html`);
  // Never overwrite an existing backup: performance-engine wrote it from the
  // PRE-refresh body, which is the state a revert has to reach. Re-taking it
  // here would snapshot the refresh we are about to apply.
  if (!existsSync(backupPath)) {
    mkdirSync(QUEUE_DIR, { recursive: true });
    copyFileSync(contentPath, backupPath);
    log(`      backup captured → ${backupPath.replace(ROOT + '/', '')}`);
  }
  return backupPath;
}

/**
 * Run the editorial gate for an item, repairing rather than escalating.
 *
 * For a refresh item the artifact being judged is `refreshed_html_path`, not
 * the post's current `content.html` — and both the editor and every repair
 * agent in lib/edit-gate-repair.js operate on the post directory. So the
 * refreshed body is STAGED into content.html first (the backup above is what
 * makes that safe), gated, repaired in place, and then copied back so the
 * repairs are part of what ships. A gate that never clears puts the original
 * body back before returning.
 *
 * @returns {{pass:boolean, reason?:string, attempts:number}}
 */
function gateItem(item, { dryRun, log }) {
  const postSlug = findPostMeta(targetSlugFor(item))?.meta?.slug || targetSlugFor(item);
  const contentPath = getContentPath(postSlug);
  const staged = REFRESH_TRIGGERS.has(item.trigger)
    && item.refreshed_html_path && existsSync(item.refreshed_html_path)
    && existsSync(contentPath);

  if (dryRun) {
    // Read the standing verdict only. Staging and repair both mutate the post
    // directory and spend Anthropic calls, which a dry run must not do.
    const gate = checkEditGate(postSlug);
    return { ...gate, attempts: 0, dry: true };
  }

  const backupPath = item.backup_html_path;
  if (staged) {
    copyFileSync(item.refreshed_html_path, contentPath);
    log('      staged refreshed HTML for the editor gate');
  }

  const { gate, attempts } = runEditGateWithRepair(postSlug, { log: (m) => log(`   ${m}`) });

  if (staged) {
    if (gate.pass) {
      // Repairs land in content.html; ship those, not the pre-repair draft.
      copyFileSync(contentPath, item.refreshed_html_path);
    } else if (backupPath && existsSync(backupPath)) {
      copyFileSync(backupPath, contentPath);
      log('      gate failed — original body restored locally, nothing pushed');
    }
  }
  return { ...gate, attempts };
}

/**
 * Put the pre-refresh body back into content.html after a failed apply, so a
 * local file never claims a change that never reached Shopify.
 */
function unstageRefresh(item, log) {
  if (!REFRESH_TRIGGERS.has(item.trigger)) return;
  if (!item.backup_html_path || !existsSync(item.backup_html_path)) return;
  const postSlug = findPostMeta(targetSlugFor(item))?.meta?.slug || targetSlugFor(item);
  const contentPath = getContentPath(postSlug);
  if (!existsSync(contentPath)) return;
  copyFileSync(item.backup_html_path, contentPath);
  log('      local content.html restored to the pre-refresh body');
}

/** A seo-opportunity is a recommendation: approving it RUNS the executor agent. */
function runOpportunity(item, log) {
  const cmd = buildTriggerCommand(item); // throws → caller records a failure
  log(`      executor: ${cmd.agent} ${cmd.args.join(' ')}`);
  execFileSync(process.execPath, [join(ROOT, cmd.script), ...cmd.args], { cwd: ROOT, stdio: 'inherit' });
  return { agent: cmd.agent };
}

/** Previously-live SEO metafields, read before we overwrite them. */
async function capturePreviousMeta(item, deps) {
  const resource = item.trigger === 'page-meta-rewrite' ? 'pages'
    : item.trigger === 'product-meta-rewrite' ? 'products' : null;
  if (!resource || !item.resource_id) return undefined;
  try {
    const fields = await deps.getMetafields(resource, item.resource_id);
    const pick = (key) => fields.find((f) => f.namespace === 'global' && f.key === key)?.value ?? null;
    return { title_tag: pick('title_tag'), description_tag: pick('description_tag') };
  } catch {
    return undefined; // fall back to the item's stored original_* values
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function run({ dryRun = true, cap = MAX_APPLIES_PER_RUN, log = console.log } = {}) {
  log(`\nQueue Auto-Apply${dryRun ? ' — DRY RUN (nothing will be changed)' : ''}\n`);

  const items = listQueueItems();
  // Same evidence, same loader, as every agent that puts a $0 cluster on hold —
  // this used to classify the report inline, which was a second copy of the
  // load waiting to drift away from the rest of the fleet.
  const hold = loadClusterHold({ root: ROOT });
  const clusters = hold.classified;
  const banner = holdBanner(hold);
  if (banner) log(banner);
  if (!hold.available) {
    log('    The 2+ distinct products rule still applies; it needs no revenue data.');
  }
  const cooldown = cooldownTargets(items);

  const deps = await shopifyDeps().catch((err) => {
    log(`  ⚠ Shopify unavailable (${err.message}) — collection-gap product counts cannot be resolved.`);
    return null;
  });
  const productCounts = deps ? await buildProductCounts(items, deps) : new Map();

  const plan = planRun(items, { clusters, cooldown, productCounts }, { cap });
  log(`  ${items.length} item(s) in the queue → ${plan.apply.length} to apply, ${plan.dismiss.length} to dismiss, ${plan.skip.length} left alone (cap ${cap}/run).\n`);

  const applied = [];
  const dismissed = [];
  const gated = [];
  const failed = [];

  // ── dismissals first: cheap, local-only, and they shrink the queue a human
  //    would otherwise scroll past.
  for (const { item, reason } of plan.dismiss) {
    log(`  ✗ dismiss  ${item.slug} — ${reason}`);
    if (!dryRun) {
      item.status = 'dismissed';
      item.dismissed_reason = reason;
      item.dismissed_by = 'queue-autoapply';
      item.dismissed_at = new Date().toISOString();
      writeItem(item);
    }
    dismissed.push({ slug: item.slug, trigger: item.trigger, reason });
  }

  // ── applies
  for (const { item } of plan.apply) {
    log(`\n  → apply    ${item.slug} [${item.trigger}]`);

    if (!dryRun) item.backup_html_path = ensureBackup(item, log) || item.backup_html_path;

    // A refresh OVERWRITES a live article body. Without a backup that write is
    // irreversible, so it does not happen — no exception, no override.
    // (page/product meta items are covered by capturePreviousMeta below, and a
    // seo-opportunity targeting a collection has no body to back up; those
    // record `revertible: false` rather than being blocked.)
    if (!dryRun && REFRESH_TRIGGERS.has(item.trigger) && !(item.backup_html_path && existsSync(item.backup_html_path))) {
      log('      ✗ no backup of the current body — refusing to overwrite a live article irreversibly');
      failed.push({ slug: item.slug, trigger: item.trigger, error: 'no backup available — refused rather than apply irreversibly' });
      continue;
    }

    let gate;
    try {
      gate = gateItem(item, { dryRun, log });
    } catch (err) {
      log(`      ✗ editor gate errored: ${err.message}`);
      failed.push({ slug: item.slug, trigger: item.trigger, error: `editor gate: ${err.message}` });
      continue;
    }

    if (!gate.pass) {
      log(`      ⊘ gated after ${gate.attempts} repair attempt(s): ${gate.reason}`);
      if (!dryRun) {
        const attempts = (Number(item.autoapply?.gate_attempts) || 0) + 1;
        item.autoapply = { ...(item.autoapply || {}), gate_attempts: attempts, last_gated_at: new Date().toISOString(), last_gate_reason: gate.reason };
        writeItem(item); // stays PENDING — the repair loop owns it, not a human queue
      }
      gated.push({ slug: item.slug, trigger: item.trigger, reason: gate.reason, repair_attempts: gate.attempts });
      continue;
    }

    if (dryRun) { applied.push({ slug: item.slug, trigger: item.trigger, dry: true }); continue; }
    if (!deps) {
      failed.push({ slug: item.slug, trigger: item.trigger, error: 'Shopify credentials unavailable' });
      continue;
    }

    try {
      const previous = await capturePreviousMeta(item, deps);
      const revertPlan = revertPlanFor(item, previous ? { previous } : undefined);

      if (item.trigger === 'seo-opportunity') {
        item.status = 'in_progress';
        item.triggered_at = new Date().toISOString();
        writeItem(item);
        const { agent } = runOpportunity(item, log);
        item.status = 'completed';
        item.completed_at = new Date().toISOString();
        item.triggered_agent = agent;
        delete item.error;
      } else {
        const result = await applyItem(item, deps);
        if (result?.dismissed) {
          item.status = 'dismissed';
          item.dismissed_reason = result.reason;
          item.dismissed_by = 'queue-autoapply';
          item.dismissed_at = new Date().toISOString();
          writeItem(item);
          log(`      retired: ${result.reason}`);
          dismissed.push({ slug: item.slug, trigger: item.trigger, reason: result.reason });
          continue;
        }
        item.status = 'published';
        item.published_at = new Date().toISOString();
      }

      item.approved_at = new Date().toISOString();
      item.approved_by = 'queue-autoapply';
      if (revertPlan) item.revert_plan = revertPlan;
      item.autoapply = { ...(item.autoapply || {}), applied_at: new Date().toISOString(), gate_attempts: gate.attempts, revertible: !!revertPlan };
      writeItem(item);

      log(`      ✓ applied${revertPlan ? '' : ' (NOT automatically revertible — recorded)'}`);
      applied.push({ slug: item.slug, trigger: item.trigger, revertible: !!revertPlan });
    } catch (err) {
      log(`      ✗ apply failed: ${err.message}`);
      // The gate STAGED the refreshed body into content.html. If the Shopify
      // write then failed, local and live disagree in the worst direction:
      // the checkout looks updated while the storefront serves the old body,
      // and the next agent to read content.html would treat the un-shipped
      // refresh as canonical. Put the original back.
      unstageRefresh(item, log);
      item.status = item.trigger === 'seo-opportunity' ? 'failed' : 'pending';
      item.error = String(err.message).slice(0, 500);
      if (item.status === 'failed') item.failed_at = new Date().toISOString();
      writeItem(item);
      failed.push({ slug: item.slug, trigger: item.trigger, error: err.message });
    }
  }

  for (const { item, reason } of plan.skip) log(`  ·  skip     ${item?.slug || '(malformed item)'} — ${reason}`);

  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    cap,
    queue_size: items.length,
    seo_impact_generated_at: hold.generatedAt,
    applied,
    dismissed,
    gated,
    failed,
    skipped: plan.skip.map(({ item, reason }) => ({ slug: item?.slug || null, trigger: item?.trigger || item?.type || null, reason })),
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(REPORT_DIR, `${report.generated_at.slice(0, 10)}.json`), JSON.stringify(report, null, 2));

  // ONE deferred notification per run. Never `immediate: true` — this is
  // routine housekeeping and belongs in the 5 AM digest with everything else.
  const lines = [
    `Applied ${applied.length} · dismissed ${dismissed.length} · gated ${gated.length} · failed ${failed.length} (queue ${items.length}, cap ${cap}/run)`,
    '',
    ...applied.map((a) => `APPLIED   ${a.slug} [${a.trigger}]${a.revertible === false ? ' — no automatic revert' : ''}`),
    ...dismissed.map((d) => `DISMISSED ${d.slug} [${d.trigger}] — ${d.reason}`),
    ...gated.map((g) => `GATED     ${g.slug} [${g.trigger}] — ${g.reason} (${g.repair_attempts} repair attempts; stays pending for the repair loop)`),
    ...failed.map((f) => `FAILED    ${f.slug} [${f.trigger}] — ${f.error}`),
  ];
  await notify({
    subject: `Queue auto-apply: ${applied.length} applied, ${dismissed.length} dismissed${dryRun ? ' (dry run)' : ''}`,
    body: lines.join('\n'),
    status: failed.length ? 'error' : 'success',
    category: 'pipeline',
  });

  log(`\n  Report: data/reports/queue-autoapply/latest.json`);
  return report;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Importing this module must never run the agent. `POSTS_ROOT` is imported only
// so a misconfigured SEO_CLAUDE_ROOT is visible in the log rather than silently
// pointing the editor gate at another tree.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const cap = limitIdx !== -1 ? Math.max(0, Math.min(MAX_APPLIES_PER_RUN, parseInt(args[limitIdx + 1], 10) || 0)) : MAX_APPLIES_PER_RUN;
  if (POSTS_ROOT !== ROOT) console.warn(`  ⚠ posts root is ${POSTS_ROOT}, agent root is ${ROOT}`);
  run({ dryRun: !args.includes('--apply'), cap })
    .then(() => console.log('\nDone.\n'))
    .catch((err) => { console.error('Error:', err.message); process.exit(1); });
}
