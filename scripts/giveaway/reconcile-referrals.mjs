#!/usr/bin/env node
/**
 * Credit referrers whose referred friends have now confirmed. Idempotent, so
 * safe to run nightly (and safe to re-run after a failure).
 *
 *   node scripts/giveaway/reconcile-referrals.mjs          # report only
 *   node scripts/giveaway/reconcile-referrals.mjs --apply  # write to Klaviyo
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSubscribedProfiles, updateProfileProperties } from '../../lib/klaviyo-profiles.js';
import { planEntryUpdates } from '../../lib/giveaway/reconcile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { listId } = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const apply = process.argv.includes('--apply');

const confirmed = await listSubscribedProfiles(listId);
console.log(`${confirmed.length} confirmed entrants`);

const updates = planEntryUpdates(confirmed);
if (!updates.length) { console.log('Everything already reconciled.'); process.exit(0); }

let failures = 0;
for (const row of updates) {
  console.log(`${row.email}: confirmed=${row.breakdown.confirmed} referrals=${row.breakdown.referrals} -> ${row.entries} entries`);
  if (!apply) continue;
  try {
    await updateProfileProperties(row.email, {
      gv_breakdown: row.breakdown,
      gv_entries: row.entries,
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
