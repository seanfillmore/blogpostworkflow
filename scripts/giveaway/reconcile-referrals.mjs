#!/usr/bin/env node
/**
 * Credit the confirmation (+2) and referral (+5) rungs. Idempotent, so safe to
 * run nightly (and safe to re-run after a failure).
 *
 *   node scripts/giveaway/reconcile-referrals.mjs          # report only
 *   node scripts/giveaway/reconcile-referrals.mjs --apply  # write to Klaviyo
 *
 * Reads EVERY profile on the list, not just the SUBSCRIBED ones. Official rules
 * §12 promises the drawing is independent of ongoing subscription status, so a
 * confirmation has to outlive an unsubscribe: current consent decides who is
 * NEWLY confirmed, and the gv_confirmed_at stamp this script writes is what
 * keeps them confirmed afterwards. See lib/giveaway/reconcile.js.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProfilesWithConsent, updateProfileProperties } from '../../lib/klaviyo-profiles.js';
import { planEntryUpdates } from '../../lib/giveaway/reconcile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { listId } = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const apply = process.argv.includes('--apply');

const profiles = await listProfilesWithConsent(listId);
const subscribed = profiles.filter((p) => p.subscribed).length;
console.log(`${profiles.length} list profiles (${subscribed} currently subscribed)`);

const updates = planEntryUpdates(profiles);
if (!updates.length) { console.log('Everything already reconciled.'); process.exit(0); }

let failures = 0;
for (const row of updates) {
  console.log(`${row.email}: confirmed=${row.breakdown.confirmed} referrals=${row.breakdown.referrals} -> ${row.entries} entries`);
  if (!apply) continue;
  try {
    await updateProfileProperties(row.email, {
      gv_breakdown: row.breakdown,
      gv_entries: row.entries,
      // The durable proof of confirmation. Without it a later unsubscribe would
      // make this entrant invisible to every future run.
      gv_confirmed_at: row.confirmedAt,
    });
  } catch (e) {
    // One bad profile must not abandon the rest of the run. The next run
    // retries it, because the plan is recomputed from stored state.
    failures += 1;
    console.error(`  FAILED ${row.email}: ${e.message}`);
  }
}
console.log(apply
  ? `Updated ${updates.length - failures}/${updates.length} profile(s).`
  : 'Dry run — pass --apply to write.');
if (failures) process.exitCode = 1;
