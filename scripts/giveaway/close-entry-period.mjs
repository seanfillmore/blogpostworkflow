#!/usr/bin/env node
/**
 * Stop the nurture flow at the Entry Period close.
 *
 *   node scripts/giveaway/close-entry-period.mjs           # report only
 *   node scripts/giveaway/close-entry-period.mjs --apply   # set the flow to draft
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
 * Idempotent: re-running after the flow is already draft is a no-op, so the
 * cron line can stay installed indefinitely.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { klaviyoRequest, updateFlowStatus } from '../../lib/klaviyo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const apply = process.argv.includes('--apply');

const flowId = config.nurtureFlowId;
if (!flowId) {
  console.error('config.nurtureFlowId is not set — nothing to close.');
  process.exit(2);
}

const flow = await klaviyoRequest('GET', `/flows/${flowId}/`);
const name = flow.data.attributes.name;
const status = flow.data.attributes.status;
console.log(`flow ${flowId} (${name}) is currently: ${status}`);

if (status !== 'live') {
  // Already stopped, or never went live. Either way there is nothing to do and
  // this must not be treated as a failure — the cron line runs unconditionally.
  console.log('Not live — nothing to do.');
  process.exit(0);
}

if (!apply) {
  console.log('Dry run — pass --apply to set it to draft.');
  process.exit(0);
}

await updateFlowStatus(flowId, 'draft');

// Read it back. A success log is not evidence; the stored status is.
const after = await klaviyoRequest('GET', `/flows/${flowId}/`);
const now = after.data.attributes.status;
console.log(`flow ${flowId} is now: ${now}`);
if (now === 'live') {
  console.error('FAILED — the flow is still live. Late entrants will receive post-draw email.');
  process.exit(1);
}
console.log('Entry Period closed: the nurture flow will send nothing further.');

// The pool must be frozen at the close of the Entry Period (§12), and this job
// is the only thing that runs at that moment.
//
// SPAWNED, not imported: importing a script module RUNS it, and doing that here
// would execute the snapshot as a side effect of merely reading this file — the
// hazard documented across the fleet in reference_agents_run_on_import.
//
// A snapshot failure does not undo the flow close above (that already succeeded
// and must not be reverted), but it does fail the job loudly, because a drawing
// with no frozen pool is the one outcome that cannot be recovered later.
if (apply) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'giveaway', 'take-draw-snapshot.mjs'), '--apply'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('SNAPSHOT FAILED — the drawing has no frozen pool. Run take-draw-snapshot.mjs by hand today.');
    process.exitCode = 1;
  }
}
