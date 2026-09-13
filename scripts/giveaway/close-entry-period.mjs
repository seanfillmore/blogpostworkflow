#!/usr/bin/env node
/**
 * Close the Entry Period: stop the giveaway flows, then freeze the draw pool.
 *
 *   node scripts/giveaway/close-entry-period.mjs           # report only
 *   node scripts/giveaway/close-entry-period.mjs --apply   # draft the flows, take the snapshot
 *
 * WHY THIS EXISTS: Klaviyo has no "flow end date".
 *
 * Every delay in the nurture flow is relative to ENTRY, but the Entry Period is
 * a fixed window with one shared close date. Those do not compose. A profile
 * that enters on day 20 is still sitting in a 480h/672h delay when the draw
 * happens, so it receives `05-reminder` on day 40 and `06-final-call` on day 48
 * — the latter announcing that "entries close September 14, 2026" more than a
 * week AFTER they closed, and soliciting referrals, Instagram posts and photo
 * uploads that can no longer be credited to anything. A 30-day paid campaign
 * produces late entrants in bulk, so this is the common case, not an edge one.
 *
 * The CONFIRM flow is stopped too (added 2026-09-12). It triggers on list-add and
 * asks the entrant to click for +2 entries; after the close that is a promise the
 * frozen pool never keeps.
 *
 * Klaviyo cannot express this from inside the flow definition:
 *   - there is no end-date field on a flow
 *   - delays are relative, and cannot be pinned to an absolute date
 *   - PATCH /flows/{id} accepts ONLY `status` (verified against the API docs
 *     2026-08-12) — the definition, triggers and profile_filter are immutable
 *     after creation, so a filter cannot be added to a live flow either
 *
 * What IS reachable is the flow's status, and setting a flow to `draft` stops
 * it sending — including to profiles already partway through a delay. So the
 * boundary is enforced from outside, on a timer, rather than declared inside.
 *
 * The decisions live in lib/giveaway/entry-period.js: --apply is REFUSED before
 * the close, each flow is handled independently (an already-draft flow no longer
 * skips the snapshot, which the first version of this script did), and an
 * existing snapshot is never retaken — the cron line has no year field and fires
 * again every September 15.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { klaviyoRequest, updateFlowStatus } from '../../lib/klaviyo.js';
import { planEntryPeriodClose } from '../../lib/giveaway/entry-period.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const apply = process.argv.includes('--apply');
const SNAPSHOT = join(ROOT, 'data', 'giveaway', 'draw-snapshot.json');

const flowIds = [config.nurtureFlowId, config.confirmFlowId].filter(Boolean);
if (!flowIds.length) {
  console.error('config has neither nurtureFlowId nor confirmFlowId — nothing to close.');
  process.exit(2);
}

const flows = [];
for (const id of flowIds) {
  const f = await klaviyoRequest('GET', `/flows/${id}/`);
  flows.push({ id, name: f.data.attributes.name, status: f.data.attributes.status });
  console.log(`flow ${id} (${f.data.attributes.name}) is currently: ${f.data.attributes.status}`);
}

const snapshotExists = existsSync(SNAPSHOT);
const plan = planEntryPeriodClose({
  nowMs: Date.now(),
  entryClosesAt: config.entryClosesAt,
  flows,
  apply,
  snapshotExists,
});

if (plan.refused) {
  console.error(plan.refused);
  process.exit(1);
}

if (!apply) {
  console.log(`Dry run — would draft: ${plan.toDraft.join(', ') || 'nothing (no live flows)'}`);
  console.log(snapshotExists ? 'Snapshot already exists — it would not be retaken.' : 'The snapshot would be taken.');
  process.exit(0);
}

let failed = false;
for (const id of plan.toDraft) {
  await updateFlowStatus(id, 'draft');
  // Read it back. A success log is not evidence; the stored status is.
  const after = await klaviyoRequest('GET', `/flows/${id}/`);
  const status = after.data.attributes.status;
  console.log(`flow ${id} is now: ${status}`);
  if (status === 'live') {
    console.error(`FAILED — flow ${id} is still live. Entrants will receive post-close email.`);
    failed = true;
  }
}
if (!plan.toDraft.length) console.log('No live flows — nothing to draft.');

// The pool must be frozen at the close of the Entry Period (§12), and this job
// is the only thing that runs at that moment. It is taken even if a flow failed
// to draft above: a drawing with no frozen pool is the one outcome that cannot
// be recovered later, while a flow can be drafted by hand.
//
// SPAWNED, not imported: importing a script module RUNS it, and doing that here
// would execute the snapshot as a side effect of merely reading this file — the
// hazard documented across the fleet in reference_agents_run_on_import.
if (plan.takeSnapshot) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'giveaway', 'take-draw-snapshot.mjs'), '--apply'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('SNAPSHOT FAILED — the drawing has no frozen pool. Run take-draw-snapshot.mjs by hand today.');
    failed = true;
  }
} else {
  console.log('Snapshot already exists — not retaken.');
}

if (failed) process.exitCode = 1;
else console.log('Entry Period closed.');
