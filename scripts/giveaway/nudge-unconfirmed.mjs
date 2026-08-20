#!/usr/bin/env node
/**
 * Re-send the double-opt-in confirmation to entrants who submitted but never clicked.
 *
 * WHY THIS IS A SCRIPT AND NOT A KLAVIYO FLOW. A flow sends MARKETING email, and Klaviyo
 * will not deliver marketing email to a profile that has not consented — which is the
 * entire point of double opt-in and the whole population this targets. There is no flow
 * that can reach an unconfirmed profile, so "a flow that pesters people to confirm" cannot
 * be built as asked. What CAN be re-sent is the opt-in confirmation itself: re-issuing the
 * subscribe makes Klaviyo send its double-opt-in email again. That is a consent request,
 * not marketing, which is why it is allowed to reach them at all — and why this script must
 * never be repurposed to carry a promotional message.
 *
 * WHY IT IS WORTH DOING. Measured 2026-08-20, day one of the paid campaign: 11 submitted,
 * 3 confirmed. Confirming is worth +2 entries on top of the base 1, and it is what puts the
 * profile on the list — so an unconfirmed entrant gets no nurture email, cannot be credited
 * as anyone's referrer, and cannot be sold to. Acquisition was costing $1.87 a submission
 * and $6.86 a confirmed entrant; the whole gap is this step.
 *
 * RESTRAINT IS THE DESIGN. Repeated consent requests to someone who is ignoring them are
 * indistinguishable from spam, and a complaint against the sending domain costs far more
 * than eight entries. So: a minimum gap between nudges, a hard cap on how many any address
 * ever receives, and a stamp on the profile so the state survives a re-run. An entrant who
 * never confirms after the cap keeps their base entry and is left alone.
 *
 * Usage:
 *   node scripts/giveaway/nudge-unconfirmed.mjs            # dry run — prints who WOULD be nudged
 *   node scripts/giveaway/nudge-unconfirmed.mjs --apply    # actually re-sends
 *
 * Dry by default because it sends real email to real people. Same posture as
 * scripts/prune-ad-studio.mjs: the cheapest action is the one you get by accident.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0 && !process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const { listEntrantProfiles, listProfilesWithConsent, subscribeToList, updateProfileProperties } =
  await import('../../lib/klaviyo-profiles.js');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));

/** At least this long since the last nudge (or since entry, for the first one). */
export const MIN_HOURS_BETWEEN = 48;
/** Total confirmation re-sends any one address may ever receive. Three is already generous. */
export const MAX_NUDGES = 3;

/**
 * Who is due, and why not for everyone else. Pure so the policy is testable without
 * touching Klaviyo — the decision matters more than the sending.
 */
export function selectNudgeTargets({ submitted, confirmedEmails, now, minHours = MIN_HOURS_BETWEEN, maxNudges = MAX_NUDGES }) {
  const due = [];
  const skipped = [];
  const confirmed = new Set([...confirmedEmails].map((e) => String(e).toLowerCase()));
  for (const p of submitted) {
    const email = String(p.email || '').toLowerCase();
    const props = p.properties || {};
    if (!email) continue;
    if (confirmed.has(email) || props.gv_confirmed_at) { skipped.push({ email, why: 'confirmed' }); continue; }
    const count = Number(props.gv_confirm_nudges || 0);
    if (count >= maxNudges) { skipped.push({ email, why: `capped at ${maxNudges}` }); continue; }
    const last = props.gv_last_nudge_at || props.gv_entered_at;
    const hours = last ? (now - new Date(last).getTime()) / 36e5 : Infinity;
    if (hours < minHours) { skipped.push({ email, why: `only ${hours.toFixed(1)}h since last contact` }); continue; }
    due.push({ email, firstName: props.gv_first_name || null, nudgeNumber: count + 1 });
  }
  return { due, skipped };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const [submitted, listed] = await Promise.all([
    listEntrantProfiles(config.entryOpensAt),
    listProfilesWithConsent(config.listId),
  ]);
  const confirmedEmails = listed.filter((p) => p.subscribed).map((p) => p.email);

  const { due, skipped } = selectNudgeTargets({ submitted, confirmedEmails, now: Date.now() });

  console.log(`${submitted.length} submitted | ${confirmedEmails.length} confirmed | ${due.length} due a nudge`);
  for (const s of skipped) console.log(`  skip ${s.email} — ${s.why}`);
  if (!due.length) { console.log('Nothing to send.'); return; }

  if (!apply) {
    for (const d of due) console.log(`  WOULD nudge ${d.email} (#${d.nudgeNumber})`);
    console.log('\nDry run. Re-run with --apply to send.');
    return;
  }

  let sent = 0;
  for (const d of due) {
    try {
      // Re-issuing the subscribe is what makes Klaviyo re-send its opt-in email. The
      // stamp is written only after that succeeds, so a failure retries next run rather
      // than silently consuming one of the entrant's three chances.
      await subscribeToList(config.listId, { email: d.email, firstName: d.firstName, properties: {} });
      await updateProfileProperties(d.email, {
        gv_confirm_nudges: d.nudgeNumber,
        gv_last_nudge_at: new Date().toISOString(),
      });
      sent += 1;
      console.log(`  nudged ${d.email} (#${d.nudgeNumber})`);
    } catch (e) {
      console.error(`  FAILED ${d.email}: ${e.message}`);
    }
  }
  console.log(`\nSent ${sent}/${due.length}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
