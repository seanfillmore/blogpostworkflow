#!/usr/bin/env node
/**
 * Take the §5-disqualified cohort out of Klaviyo's billable profile count.
 *
 *   node scripts/giveaway/suppress-disqualified.mjs                    # report
 *   node scripts/giveaway/suppress-disqualified.mjs --limit 1 --apply  # canary ONE
 *   node scripts/giveaway/suppress-disqualified.mjs --apply            # all of them
 *   node scripts/giveaway/suppress-disqualified.mjs --verify           # re-check state only
 *
 * WHY SUPPRESS RATHER THAN DELETE. Klaviyo bills on ACTIVE profiles and
 * suppressed profiles do not contribute to the plan's count, so suppression is
 * what stops us paying for 2,948 bots — which is the whole ask. Deletion would
 * also stop the charge, and would additionally destroy the Klaviyo-side record
 * of entrants we have just disqualified from a promotion somebody may complain
 * about. Same benefit, strictly more loss, and irreversible: so suppression.
 *
 * WHAT MAKES THIS SAFE. The disqualified set and the committed draw pool
 * partition the entrants exactly (2,948 + 4,419 = 7,367), and
 * `assertSafeToSuppress` REFUSES on any overlap, on a count that disagrees with
 * the evidence record, or on an empty list. Suppression is invisible in practice
 * — nobody notices they stopped receiving email — so these are arithmetic
 * guards rather than care taken at the keyboard.
 *
 * The bulk endpoint is ASYNC (a *-bulk-create-job, the same shape as the
 * subscribe job that once looked exactly like a silent failure ninety seconds
 * in), so this never treats a 2xx as proof. It re-reads profiles and checks the
 * stored suppression state, and `--verify` does that alone.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { klaviyoRequest } from '../../lib/klaviyo.js';
import { getProfileByEmail } from '../../lib/klaviyo-profiles.js';
import { disqualifiedEmails } from '../../lib/giveaway/offer-exclusion.js';
import { suppressionBatches, assertSafeToSuppress, verificationSample } from '../../lib/giveaway/suppression.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPLY = process.argv.includes('--apply');
const VERIFY_ONLY = process.argv.includes('--verify');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg === -1 ? null : Number(process.argv[limitArg + 1]);
const SAMPLE = 25;

const EVIDENCE = join(ROOT, 'data', 'giveaway', 'evidence', '2026-09-15-entry-fraud', 'disqualified-entrants.json');
const SNAPSHOT = join(ROOT, 'data', 'giveaway', 'draw-snapshot.json');

for (const p of [EVIDENCE, SNAPSHOT]) {
  if (!existsSync(p)) { console.error(`Refusing: missing ${p}`); process.exit(1); }
}

const evidence = JSON.parse(readFileSync(EVIDENCE, 'utf8'));
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const all = disqualifiedEmails(evidence);

// Guards run against the WHOLE set, before any --limit narrows it. A canary run
// must be gated on the same evidence as the full one.
assertSafeToSuppress(all, snapshot, evidence.disqualified_count ?? null);
console.log(`✓ safe: ${all.length} disqualified, disjoint from the ${snapshot.totals.entrants}-entrant draw pool`);

const emails = LIMIT ? all.slice(0, LIMIT) : all;
if (LIMIT) console.log(`--limit ${LIMIT} → acting on ${emails.length}`);

/**
 * Is this profile suppressed?
 *
 * Klaviyo records suppression as a list of reasons under the email marketing
 * subscription. An UNREADABLE profile returns null rather than false, so a read
 * failure can never be reported as "not suppressed" and send somebody chasing a
 * suppression that did work.
 */
async function suppressionState(email) {
  const p = await getProfileByEmail(email);
  if (!p) return { email, exists: false, suppressed: null };
  try {
    const d = await klaviyoRequest(
      'GET',
      `/profiles/${p.id}/?additional-fields%5Bprofile%5D=subscriptions`,
    );
    const marketing = d.data?.attributes?.subscriptions?.email?.marketing ?? {};
    const reasons = marketing.suppression ?? marketing.suppressions ?? [];
    return {
      email,
      exists: true,
      suppressed: Array.isArray(reasons) ? reasons.length > 0 : Boolean(reasons),
      consent: marketing.consent ?? null,
      reasons: Array.isArray(reasons) ? reasons.map((r) => r.reason ?? r) : reasons,
    };
  } catch (e) {
    console.error(`  ! could not read ${email}: ${String(e.message).slice(0, 120)}`);
    return { email, exists: true, suppressed: null };
  }
}

async function reportSample(label, list) {
  const sample = verificationSample(list, SAMPLE);
  console.log(`\n${label} (sample of ${sample.length}):`);
  let yes = 0; let no = 0; let unknown = 0;
  for (const email of sample) {
    const s = await suppressionState(email);
    if (s.suppressed === true) yes += 1;
    else if (s.suppressed === false) no += 1;
    else unknown += 1;
  }
  console.log(`  suppressed ${yes} · not suppressed ${no} · unreadable/absent ${unknown}`);
  return { yes, no, unknown, of: sample.length };
}

if (VERIFY_ONLY) {
  await reportSample('Suppression state', emails);
  process.exit(0);
}

const batches = suppressionBatches(emails);
console.log(`${emails.length} address(es) in ${batches.length} batch(es) of at most 100`);

if (!APPLY) {
  await reportSample('Suppression state BEFORE', emails);
  console.log('\nDry run — pass --apply to suppress.');
  process.exit(0);
}

let sent = 0;
for (const [i, batch] of batches.entries()) {
  await klaviyoRequest('POST', '/profile-suppression-bulk-create-jobs/', {
    data: {
      type: 'profile-suppression-bulk-create-job',
      attributes: { profiles: { data: batch.map((email) => ({ type: 'profile', attributes: { email } })) } },
    },
  });
  sent += batch.length;
  console.log(`  batch ${i + 1}/${batches.length} accepted · ${sent}/${emails.length}`);
}

// The job is ASYNC: a 2xx says it was queued, not that anybody is suppressed.
console.log('\nqueued — waiting for the jobs to process before checking');
await new Promise((r) => setTimeout(r, 30000));
const after = await reportSample('Suppression state AFTER', emails);

if (after.no > 0) {
  console.error(`\n!! ${after.no} of the sampled ${after.of} are still not suppressed.`);
  console.error('   The jobs are async — re-run with --verify in a few minutes before concluding it failed.');
  process.exitCode = 1;
} else if (after.unknown > 0) {
  console.error(`\n!! ${after.unknown} of the sampled ${after.of} could not be read — check by hand.`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ all ${after.of} sampled are suppressed — they leave the billable active-profile count`);
}
