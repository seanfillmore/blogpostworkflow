#!/usr/bin/env node
/**
 * Subscribe already-submitted entrants who never completed double opt-in.
 *
 *   node scripts/giveaway/backfill-subscribe-entrants.mjs                  # dry run
 *   node scripts/giveaway/backfill-subscribe-entrants.mjs --apply --limit 50
 *
 * WHY THIS EXISTS. 330 of ~417 paid-acquired entrants (79%) submitted the form
 * and never clicked the double-opt-in link. They hold their base entry under the
 * operator determination in config/giveaway.json, but they are not on the list,
 * so they receive no nurture email, cannot be credited as anyone's referrer, and
 * cannot be sold anything. They are leads that were paid for and cannot be
 * reached. Operator determination 2026-08-23: entering the form and providing an
 * email address is the consent, so subscribe them.
 *
 * WHAT THIS DOES NOT DO. It never sets gv_confirmed. These people have not
 * confirmed — subscribing them makes them REACHABLE, it does not earn them the
 * +2, and conflating the two would silently pay a rung nobody clicked and
 * inflate every §5 referral credit that depends on it. After this runs they are
 * subscribed-and-unconfirmed, which under confirmMechanism=flow_link is a state
 * the whole toolchain now models correctly (see lib/giveaway/reconcile.js).
 * The confirmation flow can then reach them, which is the entire point.
 *
 * WHY IT IS BATCHED AND DRY BY DEFAULT. This is an outward-facing, irreversible
 * send-side action against people who did not click a confirmation link. The
 * real exposure is not legal — US CAN-SPAM requires no express consent — it is
 * spam complaints, and complaints are what damage a small sending domain. The
 * 481 existing subscribers depend on that domain's reputation, and it is the
 * same reputation the giveaway's own nurture flow needs. So: a default batch
 * well under the full population, a pause between writes, and a stamp on each
 * profile so a re-run never double-writes and the cohort stays auditable.
 *
 * RUN IT IN BATCHES AND WATCH KLAVIYO'S COMPLAINT RATE BETWEEN THEM. A spike is
 * only actionable while there are still entrants left un-subscribed; run all 330
 * at once and the only thing left to do about it is read about it afterwards.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default batch size. Deliberately far below the full population — see header. */
export const DEFAULT_LIMIT = 50;
/** Milliseconds between writes. Not a rate limit (lib/klaviyo.js retries those). */
export const PAUSE_MS = 250;
/** Stamped on every profile this touches, so a re-run skips it. */
export const BACKFILL_STAMP = 'gv_backfill_subscribed_at';

/**
 * Who gets subscribed on this run, and why not everyone else.
 *
 * Pure so the policy is testable without credentials — the same posture as
 * nudge-unconfirmed.mjs's selectNudgeTargets, and for the same reason: the
 * decision matters far more than the mechanics of the write.
 *
 * @param {{submitted: Array, listedEmails: Set<string>, confirmedEmails: Set<string>, limit: number}} input
 */
export function selectBackfillTargets({ submitted, listedEmails, confirmedEmails, limit = DEFAULT_LIMIT }) {
  const due = [];
  const skipped = [];
  const norm = (e) => String(e ?? '').trim().toLowerCase();
  const listed = new Set([...listedEmails].map(norm));
  const confirmed = new Set([...confirmedEmails].map(norm));

  for (const p of submitted) {
    const email = norm(p.email);
    if (!email) { skipped.push({ email: p.email, why: 'unusable address' }); continue; }
    // Confirmed first: someone who confirmed is already subscribed, and saying
    // "already on the list" about them would hide that this run had nothing to
    // do with them at all.
    if (confirmed.has(email)) { skipped.push({ email, why: 'already confirmed' }); continue; }
    if (listed.has(email)) { skipped.push({ email, why: 'already on the list' }); continue; }
    if (p.properties?.[BACKFILL_STAMP]) { skipped.push({ email, why: 'already backfilled' }); continue; }
    due.push({ email, firstName: p.properties?.first_name ?? p.firstName ?? null });
  }
  return { due: due.slice(0, limit), heldBack: Math.max(0, due.length - limit), skipped };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`--limit must be a positive number, got ${process.argv[limitArg + 1]}`);

  const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
  const { listEntrantProfiles, listProfilesWithConsent, subscribeToList, updateProfileProperties } =
    await import('../../lib/klaviyo-profiles.js');
  const { confirmedEmailSet, resolveMechanism } = await import('../../lib/giveaway/reconcile.js');

  const [submitted, listed] = await Promise.all([
    listEntrantProfiles(config.entryOpensAt),
    listProfilesWithConsent(config.listId),
  ]);

  const { due, heldBack, skipped } = selectBackfillTargets({
    submitted,
    listedEmails: new Set(listed.map((p) => p.email)),
    confirmedEmails: confirmedEmailSet(listed, { mechanism: resolveMechanism(config) }),
    limit,
  });

  const reasons = skipped.reduce((acc, s) => ({ ...acc, [s.why]: (acc[s.why] || 0) + 1 }), {});
  console.log(`${submitted.length} submitted | ${listed.length} on the list`);
  console.log(`skipped: ${Object.entries(reasons).map(([w, n]) => `${n} ${w}`).join(', ') || 'none'}`);
  console.log(`${due.length} to subscribe this batch${heldBack ? ` (${heldBack} more held back by --limit ${limit})` : ''}`);

  if (!due.length) { console.log('Nothing to do.'); return; }

  if (!apply) {
    for (const d of due) console.log(`  WOULD subscribe ${d.email}`);
    console.log('\nDry run. Re-run with --apply to write. Check Klaviyo\'s complaint rate between batches.');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await subscribeToList(config.listId, { email: d.email, firstName: d.firstName });
      // Stamped AFTER the subscribe so a failed write is retried next run rather
      // than being recorded as done. NOT gv_confirmed — see the header.
      await updateProfileProperties(d.email, { [BACKFILL_STAMP]: new Date().toISOString() });
      ok += 1;
      console.log(`  subscribed ${d.email}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${d.email}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log(`\n${ok} subscribed, ${failed} failed, ${heldBack} still held back.`);
  console.log('Check the complaint and unsubscribe rate in Klaviyo before running the next batch.');
}

if (isDirectRun(import.meta.url)) {
  await main();
}
