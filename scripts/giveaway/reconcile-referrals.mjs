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
import { listProfilesWithConsent, listEntrantProfiles, updateProfileProperties } from '../../lib/klaviyo-profiles.js';
import { planEntryUpdates, resolveMechanism, confirmedEmailSet } from '../../lib/giveaway/reconcile.js';
import { mergeEntrantProfiles } from '../../lib/giveaway/referral-audit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const { listId } = config;
const apply = process.argv.includes('--apply');

// BOTH populations. Under double opt-in Klaviyo adds a profile to the list only
// once opt-in completes, so the list IS the confirmed set — measured 2026-08-22:
// 280 submitted, 77 listed. Reading the list alone could not see an unconfirmed
// entrant at all, which is why §5's "+5 per confirmed friend" was never paid to
// a referrer who had not confirmed: they were invisible, not merely filtered.
//
// Under flow_link the list holds EVERY entrant and confirmation is a property,
// so the two populations largely converge — but merging both is still correct
// (a profile can be created by the entry endpoint before the subscribe lands)
// and keeps this script identical across the cutover.
const mechanism = resolveMechanism(config);
const [listed, submitted] = await Promise.all([
  listProfilesWithConsent(listId),
  listEntrantProfiles(config.entryOpensAt),
]);
const profiles = mergeEntrantProfiles(listed, submitted);
const confirmedCount = confirmedEmailSet(profiles, { mechanism }).size;
console.log(
  `${submitted.length} submitted, ${listed.length} on the list `
  + `(${listed.filter((p) => p.subscribed).length} currently subscribed, `
  + `${confirmedCount} confirmed via ${mechanism})`,
);

const updates = planEntryUpdates(profiles, { mechanism });
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
      //
      // OMITTED ENTIRELY when null. A row can now be an UNCONFIRMED entrant who
      // earned a referral (§5 pays the +5 on the friend's confirmation, not the
      // referrer's), and those carry confirmedAt: null. Sending the key with a
      // null would write null over a real stamp the moment such a profile later
      // confirms and a race reorders the writes — destroying the one record that
      // makes confirmation survive an unsubscribe.
      ...(row.confirmedAt ? { gv_confirmed_at: row.confirmedAt } : {}),
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
