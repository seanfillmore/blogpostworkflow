#!/usr/bin/env node
/**
 * Correct the five entrant addresses whose mail DOMAIN does not exist.
 *
 *   node scripts/giveaway/fix-mistyped-entrant-emails.mjs            # dry (default)
 *   node scripts/giveaway/fix-mistyped-entrant-emails.mjs --apply    # write
 *
 * WHY THIS IS A ONE-OFF SCRIPT AND NOT A FEATURE. Prevention is the real fix and
 * it ships in the same change: theme/assets/giveaway.js now runs the same
 * "did you mean?" check on #gv-email that it already ran on #gv-ref. This script
 * exists only to clear the five people stranded before that shipped. It carries a
 * FIXED, hand-reviewed plan rather than a scan, for the same reason
 * scripts/remediate-live-health-claims.js does: a script that recomputes its own
 * targets at run time can act on a target nobody reviewed.
 *
 * OPERATOR DETERMINATION 2026-08-24 (Sean, "Fix them"), made against a stated
 * concern. Correcting an entry address changes who holds entries in a $536.40
 * prize draw, and every correction is a GUESS about intent. The concern was
 * raised, the call was made, and these are the guardrails it is executed under:
 *
 *   1. DOMAIN ONLY. The local part is never touched. Each `to` differs from its
 *      `from` solely in the mail host, and a test asserts that.
 *   2. THE TARGET DOMAIN MUST BE A REAL PROVIDER — every one is in
 *      referrer-suggest.js's KNOWN_DOMAINS, and the correction is exactly what
 *      suggestDomainTypo() proposes. That function is what would have run on the
 *      form, so this reproduces the entrant's own accepted suggestion after the
 *      fact rather than inventing a new opinion.
 *   3. NO COLLISIONS. If the corrected address already belongs to any profile,
 *      the row is REFUSED, not merged. Merging two profiles would move entries
 *      between people, which is the one outcome worse than leaving a typo.
 *   4. THE LIVE VALUE MUST STILL MATCH `from`. If the profile has moved on, skip
 *      and say so — the same guard remediate-live-health-claims.js uses.
 *
 * WHY THESE FIVE AND NOT THE OTHER TEN THE SCAN FLAGGED. ymail.com, mail.com,
 * cs.com, me.com, aim.com and myyahoo.com are REAL providers that a naive
 * edit-distance scan proposes "correcting". Three cs.com entrants and one
 * ymail.com entrant have CONFIRMED, i.e. they received and clicked an email at
 * those domains — proof the domain delivers. Only domains that resolve nowhere
 * are in this plan.
 *
 * WHAT HAPPENS AFTER. These profiles are on the list and unconfirmed, so nothing
 * re-triggers confirm flow VyjCRz (it fires on list-add, which already happened).
 * They reach the corrected address through the confirm-reminder campaign, whose
 * audience is the unconfirmed segment X7atwC — that segment re-evaluates
 * continuously, so a corrected profile is picked up without any further action.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch { /* no .env is a valid state */ }

/**
 * The plan. Every `to` is what suggestDomainTypo() returns for its `from`, which
 * a test re-derives rather than trusting this table.
 */
export const PLAN = [
  { from: 'sonador1959@hotmail.comi', to: 'sonador1959@hotmail.com' },
  { from: 'carolelang703@gmail.comc', to: 'carolelang703@gmail.com' },
  { from: 'carlacythurston@yahoo.como', to: 'carlacythurston@yahoo.com' },
  { from: 'jlorrainecamp@gmail.comin', to: 'jlorrainecamp@gmail.com' },
  { from: 'katarinaprincess@hotmail.cp', to: 'katarinaprincess@hotmail.com' },
];

const APPLY = process.argv.includes('--apply');
const norm = (e) => String(e ?? '').trim().toLowerCase();

async function main() {
  const { klaviyoRequest } = await import('../../lib/klaviyo.js');
  const { listEntrantProfiles } = await import('../../lib/klaviyo-profiles.js');
  const { suggestDomainTypo } = await import('../../lib/giveaway/referrer-suggest.js');
  const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));

  // Re-derive every correction from the shared module. If the plan and the
  // function ever disagree, the plan is wrong and the run stops before any write.
  for (const row of PLAN) {
    const derived = suggestDomainTypo(row.from);
    if (derived !== row.to) {
      throw new Error(`plan disagrees with suggestDomainTypo for ${row.from}: plan says ${row.to}, module says ${derived}`);
    }
  }

  const entrants = await listEntrantProfiles(config.entryOpensAt);
  const byEmail = new Map(entrants.map((p) => [norm(p.email), p]));

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${PLAN.length} planned correction(s), ${entrants.length} entrants\n`);

  const results = [];
  for (const { from, to } of PLAN) {
    const profile = byEmail.get(norm(from));
    if (!profile) {
      console.log(`  SKIP  ${from}\n        no entrant holds this address any more`);
      results.push({ from, to, outcome: 'skipped-absent' });
      continue;
    }
    if (byEmail.has(norm(to))) {
      console.log(`  REFUSE ${from} -> ${to}\n        ${to} is ALREADY an entrant — correcting would merge two people's entries`);
      results.push({ from, to, outcome: 'refused-collision' });
      continue;
    }
    const confirmed = profile.properties?.gv_confirmed_at
      || String(profile.properties?.gv_confirmed) === 'true';
    if (!APPLY) {
      console.log(`  WOULD  ${from} -> ${to}\n        profile ${profile.id}, entries ${profile.properties?.gv_entries ?? '?'}, confirmed ${confirmed}`);
      results.push({ from, to, outcome: 'would-apply' });
      continue;
    }
    try {
      await klaviyoRequest('PATCH', `/profiles/${profile.id}/`, {
        data: { type: 'profile', id: profile.id, attributes: { email: to } },
      });
      console.log(`  FIXED  ${from} -> ${to}  (profile ${profile.id})`);
      results.push({ from, to, outcome: 'applied', profileId: profile.id });
    } catch (e) {
      console.log(`  FAILED ${from} -> ${to}\n        ${e.message}`);
      results.push({ from, to, outcome: 'failed', error: e.message });
    }
  }

  const tally = results.reduce((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] || 0) + 1 }), {});
  console.log(`\n${JSON.stringify(tally)}`);
  if (!APPLY) console.log('\nDry run. Re-run with --apply to write.');
  else console.log('\nThese profiles reach their corrected address via the confirm-reminder\ncampaign (audience: unconfirmed segment X7atwC, re-evaluated continuously).');
  return results;
}

const { isDirectRun } = await import('../../lib/is-direct-run.js');
if (isDirectRun(import.meta.url)) await main();
