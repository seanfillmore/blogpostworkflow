#!/usr/bin/env node
/**
 * Audit every referral pair, tell the reachable half of each broken one what
 * would fix it, and report the rest to a human.
 *
 *   node scripts/giveaway/audit-referrals.mjs            # dry run — prints the report
 *   node scripts/giveaway/audit-referrals.mjs --apply    # fires the emails
 *
 * Dry by default because it sends real email to real people, same posture as
 * scripts/giveaway/nudge-unconfirmed.mjs.
 *
 * WHY IT EXISTS. Measured 2026-08-21: one referral pair on the list, crediting
 * nothing, because the named referrer had never entered. reconcile.js
 * re-evaluates referrer eligibility on EVERY nightly pass, so that pair is
 * pending rather than dead — the +5 lands the moment that person enters and
 * confirms. Nobody was telling the entrant that, so the field just sat there.
 * Referred entrants cost $0 against $0.59 a paid lead, which makes this the only
 * rung on the ladder that compounds ad spend instead of consuming it.
 *
 * WHAT IT WILL NOT DO. It never writes gv_referred_by. Official Rules §5
 * identifies a referral "solely by the referrer's email address entered in that
 * field" and §6 awards a second $536.40 prize to the referrer "named at the time
 * of entry"; rewriting the field defeats both, and §13 conditions Sponsor's
 * modification power on "fraud, technical failure, or any other factor beyond
 * Sponsor's reasonable control", which an entrant's typo is not. Near-misses are
 * therefore REPORTED, with the address they probably meant, for a human to
 * judge. Prevention lives in the entry form instead — see
 * lib/giveaway/referrer-suggest.js.
 *
 * WHO IS SILENT ON PURPOSE:
 *   self_referral / self_referral_suspected — §6 voids these, and a "did you
 *     mean?" to someone self-referring is an invitation to launder a void
 *     referral. They go to the report, never to email.
 *   referee_unconfirmed / referrer_unconfirmed's referrer — Klaviyo will not
 *     deliver marketing email to a profile that has not consented, which is this
 *     whole population. nudge-unconfirmed.mjs owns them via a re-issued opt-in,
 *     which is a consent request rather than marketing.
 *
 * RESTRAINT IS THE DESIGN. One notification per referral pair, ever, stamped on
 * the profile so the state survives a re-run. An entrant who ignores it is left
 * alone; repeated mail about a referral they cannot fix is indistinguishable
 * from spam, and a complaint against the sending domain costs more than five
 * entries.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// A missing .env must not throw at IMPORT time — same reasoning as
// nudge-unconfirmed.mjs: the policy below is pure and worth testing without
// credentials. A run that actually needs the token fails on the first call.
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch { /* no .env is a valid state — see above */ }

const { listProfilesWithConsent, listEntrantProfiles, updateProfileProperties } = await import('../../lib/klaviyo-profiles.js');
const { trackEvent } = await import('../../lib/klaviyo.js');
const { classifyReferrals, summarizeAudit, mergeEntrantProfiles } = await import('../../lib/giveaway/referral-audit.js');
const { notify } = await import('../../lib/notify.js');

export const METRIC = 'Giveaway Referral Pending';
const STAMP = 'gv_referral_audit_notified_at';

const apply = process.argv.includes('--apply');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));

/**
 * Who should be mailed on this pass.
 *
 * Pure and exported so the "never twice" rule is testable: the classifier says
 * a row is notifiable, and this says whether we have already acted on it.
 */
export function selectNotifyTargets(rows, profilesByEmail) {
  return rows.filter((row) => {
    if (row.notify !== 'referee') return false;
    const profile = profilesByEmail.get(row.referee);
    return !profile?.properties?.[STAMP];
  });
}

// BOTH sources, because they are different populations. Klaviyo adds a profile
// to the list only after double opt-in, so the list is the CONFIRMED set —
// measured 2026-08-22: 278 submitted, 77 listed. Reading the list alone (as
// this script did when it shipped) hid 6 of the 7 referral pairs that existed
// and made the referee_unconfirmed branch dead code in production.
const [listed, submitted] = await Promise.all([
  listProfilesWithConsent(config.listId),
  listEntrantProfiles(config.entryOpensAt),
]);
const profiles = mergeEntrantProfiles(listed, submitted);
const byEmail = new Map(profiles.map((p) => [String(p.email || '').trim().toLowerCase(), p]));
const rows = classifyReferrals(profiles);
const summary = summarizeAudit(rows);
const targets = selectNotifyTargets(rows, byEmail);

console.log(`${submitted.length} submitted, ${listed.length} confirmed, ${summary.pairs} referral pair(s)`);
for (const [status, count] of Object.entries(summary.byStatus)) console.log(`  ${status}: ${count}`);

// Rows a human has to judge. Printed even on a dry run, because this IS the
// deliverable for the statuses that never generate email.
//
// samePersonSuspected is NOT in this list. By operator determination
// 2026-08-22 those are valid referrals and route normally; they are surfaced
// separately below so the §6 PRIZE determination still has its evidence at the
// draw, which is the only place that question is actually asked.
const forReview = rows.filter((r) => ['self_referral', 'referrer_near_miss', 'referrer_unparseable'].includes(r.status));
if (forReview.length) {
  console.log(`\nNeeds a human decision (${forReview.length}) — no email sent for any of these:`);
  for (const r of forReview) {
    const hint = r.suggestion ? ` | probably meant ${r.suggestion.email} (${r.suggestion.distance} edit(s), already confirmed when they entered: ${r.suggestion.confirmedBeforeEntry})` : '';
    console.log(`  [${r.status}] ${r.referee} named ${r.namedRaw}${hint}`);
  }
}

const samePerson = rows.filter((r) => r.samePersonSuspected);
if (samePerson.length) {
  console.log(`\nSame-person suspected (${samePerson.length}) — treated as VALID referrals; listed for the §6 prize determination at the draw:`);
  for (const r of samePerson) console.log(`  ${r.referee} named ${r.namedRaw} [${r.status}]`);
}

console.log(`\n${targets.length} entrant(s) to notify${apply ? '' : ' (dry run)'}`);
let failures = 0;
for (const row of targets) {
  console.log(`  ${row.referee} -> named ${row.namedReferrer} (${row.status})`);
  if (!apply) continue;
  try {
    // Event first, stamp second. If the stamp write fails after a successful
    // send, the next run re-sends once — annoying. If the stamp were written
    // first and the send failed, the entrant would never be told at all, which
    // is the failure that costs them entries. Prefer the recoverable one.
    await trackEvent(METRIC, row.referee, {
      named_referrer: row.namedReferrer,
      status: row.status,
      // The live lander. Hardcoded rather than read from config/giveaway.json,
      // which holds no URL — a `config.landingUrl ?? fallback` here would have
      // silently shipped the fallback forever.
      entry_url: 'https://www.realskincare.com/pages/free-soap-giveaway',
    });
    await updateProfileProperties(row.referee, { [STAMP]: new Date().toISOString() });
  } catch (e) {
    failures += 1;
    console.error(`  FAILED ${row.referee}: ${e.message}`);
  }
}

const outDir = join(ROOT, 'data', 'reports', 'giveaway');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'referral-audit.json'), `${JSON.stringify({
  generatedAt: new Date().toISOString(), applied: apply, summary, rows, notified: apply ? targets.length - failures : 0, failures,
}, null, 2)}\n`);

// notify() takes { subject, body, status, category } — anything else is written
// to the digest as an undefined subject with no body, which reads as a blank row.
const reviewLines = forReview.map((r) => {
  const hint = r.suggestion ? ` — probably meant ${r.suggestion.email}` : '';
  return `  [${r.status}] ${r.referee} named ${r.namedRaw}${hint}`;
});
await notify({
  subject: `Giveaway referral audit: ${summary.pairs} pair(s), ${forReview.length} need review`,
  body: [
    `${submitted.length} submitted, ${listed.length} confirmed, ${summary.pairs} referral pair(s).`,
    ...Object.entries(summary.byStatus).map(([s, c]) => `  ${s}: ${c}`),
    '',
    apply ? `Notified ${targets.length - failures}/${targets.length} entrant(s).` : `DRY RUN — ${targets.length} would be notified.`,
    failures ? `${failures} send failure(s) — see data/reports/giveaway/referral-audit.json` : '',
    '',
    reviewLines.length ? 'Needs a human decision (no email sent for these):' : 'Nothing needs a human decision.',
    ...reviewLines,
    samePerson.length ? `\nSame-person suspected (${samePerson.length}) — valid referrals, listed for the §6 prize determination:` : '',
    ...samePerson.map((r) => `  ${r.referee} named ${r.namedRaw} [${r.status}]`),
  ].filter(Boolean).join('\n'),
  status: failures ? 'error' : 'success',
  category: 'giveaway',
});

console.log(apply ? `\nDone. ${targets.length - failures}/${targets.length} notified.` : '\nDry run — pass --apply to send.');
if (failures) process.exitCode = 1;
