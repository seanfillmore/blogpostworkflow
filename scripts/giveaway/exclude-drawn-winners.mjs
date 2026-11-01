#!/usr/bin/env node
/**
 * Keep the prize winners out of the consolation campaigns.
 *
 *   node scripts/giveaway/exclude-drawn-winners.mjs --setup             # report
 *   node scripts/giveaway/exclude-drawn-winners.mjs --setup --apply     # create the list, exclude it on every offer campaign
 *   node scripts/giveaway/exclude-drawn-winners.mjs --winners           # report who would be added
 *   node scripts/giveaway/exclude-drawn-winners.mjs --winners --apply   # add the drawn winners to the list
 *   node scripts/giveaway/exclude-drawn-winners.mjs --disqualified          # report the §5 cohort
 *   node scripts/giveaway/exclude-drawn-winners.mjs --disqualified --apply  # add the §5 cohort to the list
 *
 * WHY. All three consolation campaigns target the whole entrant list, and the
 * draw-day send (15:00 PT Sep 16) opens "We drew the winner. It wasn't you."
 * The draw is conducted by hand at noon, so without this the winner and the
 * referral-prize winner are told they lost three hours after being told they won.
 *
 * TWO STEPS, because they happen on different days. --setup runs BEFORE the draw:
 * it attaches a static exclusion list to each still-scheduled offer campaign.
 * --winners runs right AFTER `draw.mjs --apply`: it adds the winners to that list.
 * Recipients are computed at send time, so list membership added before 15:00 PT
 * is honoured by the draw-day send.
 *
 * EDITING A SCHEDULED CAMPAIGN is the documented revert → edit → requeue cycle
 * (see scripts/giveaway/repair-scheduled-campaign-unsub.mjs). `action: revert`
 * returns it to Draft; `action: cancel` is PERMANENT and this file never sends it.
 * The campaign JSON is backed up before the revert, the requeue is attempted even
 * when the edit fails, and the send time is checked after.
 *
 * Adding a profile to a list grants no marketing consent (Klaviyo docs, Add
 * Profiles to List), so the list is inert apart from the exclusion.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { klaviyoRequest } from '../../lib/klaviyo.js';
import { findListByName, createList, getProfileByEmail } from '../../lib/klaviyo-profiles.js';
import {
  withExcludedList, drawnWinnerEmails, disqualifiedEmails, missingFromMembership,
} from '../../lib/giveaway/offer-exclusion.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const APPLY = process.argv.includes('--apply');
const SETUP = process.argv.includes('--setup');
const WINNERS = process.argv.includes('--winners');
const DISQUALIFIED = process.argv.includes('--disqualified');
const LIST_NAME = 'Giveaway 2026-09 — Drawn winners (offer exclusion)';
const OUT = join(ROOT, 'data', 'reports', 'giveaway-offer-exclusion');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if ([SETUP, WINNERS, DISQUALIFIED].filter(Boolean).length !== 1) {
  console.error('Pass exactly one of --setup, --winners or --disqualified.');
  process.exit(64);
}

/**
 * Every email on the list, following `links.next` to the end.
 *
 * Paginated because the exclusion list now holds thousands of §5-disqualified
 * entrants alongside the two winners. The single-page read this replaces would
 * report a winner absent immediately after adding them.
 */
async function listMemberEmails(listId) {
  const emails = [];
  let url = `/lists/${listId}/profiles/?fields%5Bprofile%5D=email&page%5Bsize%5D=100`;
  for (let guard = 0; url && guard < 500; guard += 1) {
    const d = await klaviyoRequest('GET', url);
    for (const m of d.data || []) emails.push(String(m.attributes?.email || '').toLowerCase());
    const next = d.links?.next || null;
    url = next ? next.replace(/^https:\/\/[^/]+\/api/, '') : null;
  }
  return emails;
}

/** Add profiles to the exclusion list in chunks, then verify membership. */
async function addToExclusionList(listId, emails, profileIds) {
  for (let i = 0; i < profileIds.length; i += 100) {
    const chunk = profileIds.slice(i, i + 100);
    await klaviyoRequest('POST', `/lists/${listId}/relationships/profiles/`, {
      data: chunk.map((id) => ({ type: 'profile', id })),
    });
    console.log(`  added ${i + chunk.length}/${profileIds.length}`);
  }
  // A 204 says the call succeeded, not that they are on it.
  const missing = missingFromMembership(emails, await listMemberEmails(listId));
  if (missing.length) {
    console.error(`!! ${missing.length} not on the list after adding (first few: ${missing.slice(0, 5).join(', ')})`);
    process.exitCode = 1;
    return false;
  }
  console.log(`✓ verified: all ${emails.length} on list ${listId} — excluded from every offer send`);
  return true;
}

async function campaign(id) {
  const d = await klaviyoRequest('GET', `/campaigns/${id}/`);
  return d;
}

async function pollStatus(id, want, tries = 20) {
  let s = null;
  for (let i = 0; i < tries; i++) {
    s = (await campaign(id)).data.attributes.status;
    if (want(s)) return s;
    await sleep(3000);
  }
  return s;
}

async function resolveListId() {
  if (config.offerExclusionListId) return config.offerExclusionListId;
  const found = await findListByName(LIST_NAME);
  if (found) return found.id;
  if (!APPLY) return null;
  const created = await createList(LIST_NAME);
  console.log(`created list ${created.id} "${created.name}"`);
  return created.id;
}

async function setup() {
  const listId = await resolveListId();
  console.log(`exclusion list: ${listId ?? '(does not exist yet — --apply creates it)'}`);
  if (listId && !config.offerExclusionListId) {
    console.log(`  → record it: add "offerExclusionListId": "${listId}" to config/giveaway.json`);
  }

  let bad = 0;
  for (const [file, id] of Object.entries(config.offerCampaigns || {})) {
    const before = await campaign(id);
    const attrs = before.data.attributes;
    const sendBefore = attrs.send_strategy?.datetime ?? null;
    console.log(`\n▸ ${file} (${id}) · ${attrs.status} · send ${sendBefore}`);
    console.log(`  audiences ${JSON.stringify(attrs.audiences)}`);
    if (!listId) continue;
    if (attrs.status === 'Sent' || attrs.status === 'Sending') { console.log('  already sending/sent — left alone'); continue; }

    const plan = withExcludedList(attrs.audiences, listId);
    if (!plan.changed) { console.log('  ✓ already excludes the list'); continue; }
    if (!APPLY) { console.log(`  would exclude ${listId}`); continue; }

    mkdirSync(join(OUT, 'backups', stamp), { recursive: true });
    writeFileSync(join(OUT, 'backups', stamp, `${id}.campaign.json`), JSON.stringify(before, null, 2));

    const wasDraft = attrs.status === 'Draft';
    let reverted = false;
    try {
      if (!wasDraft) {
        await klaviyoRequest('PATCH', `/campaign-send-jobs/${id}/`, {
          data: { type: 'campaign-send-job', id, attributes: { action: 'revert' } },
        });
        reverted = true;
        const s = await pollStatus(id, (x) => x === 'Draft');
        if (s !== 'Draft') throw new Error(`revert did not reach Draft (status ${s})`);
        console.log('  reverted → Draft');
      }
      await klaviyoRequest('PATCH', `/campaigns/${id}/`, {
        data: { type: 'campaign', id, attributes: { audiences: plan.audiences } },
      });
      console.log(`  audiences → ${JSON.stringify(plan.audiences)}`);
    } catch (err) {
      console.error(`  ✗ edit FAILED: ${err.message}`);
      bad += 1;
    } finally {
      // A reverted campaign left in Draft is a silent missed send. Requeue it
      // whether or not the edit succeeded.
      if (reverted) {
        await klaviyoRequest('POST', '/campaign-send-jobs/', {
          data: { type: 'campaign-send-job', attributes: { id } },
        });
        const s = await pollStatus(id, (x) => x === 'Scheduled');
        console.log(`  requeued · status ${s}`);
        if (s !== 'Scheduled') { console.error('  !! did not settle to Scheduled — check this campaign by hand NOW'); bad += 1; }
      }
    }

    const after = (await campaign(id)).data.attributes;
    const sendAfter = after.send_strategy?.datetime ?? null;
    const excludes = (after.audiences?.excluded || []).includes(listId);
    if (sendAfter !== sendBefore) { console.error(`  !! send time CHANGED ${sendBefore} → ${sendAfter}`); bad += 1; }
    if (!excludes) { console.error('  !! read-back does not exclude the list'); bad += 1; }
    if (excludes && sendAfter === sendBefore) console.log('  ✓ verified: excludes the list, send time unchanged');
  }
  if (!APPLY) console.log('\nDry run — pass --apply to write.');
  process.exitCode = bad ? 1 : 0;
}

async function winners() {
  const resultPath = join(ROOT, 'data', 'giveaway', 'draw-result.json');
  if (!existsSync(resultPath)) {
    console.error('Refusing: data/giveaway/draw-result.json does not exist. Run draw.mjs --apply first.');
    process.exit(1);
  }
  const listId = config.offerExclusionListId;
  if (!listId) {
    console.error('Refusing: config/giveaway.json has no offerExclusionListId. Run --setup --apply first.');
    process.exit(1);
  }

  // A list nobody excludes does nothing. Say so before adding anyone to it.
  for (const [file, id] of Object.entries(config.offerCampaigns || {})) {
    const attrs = (await campaign(id)).data.attributes;
    if (!(attrs.audiences?.excluded || []).includes(listId) && attrs.status !== 'Sent') {
      console.error(`WARNING: ${file} (${attrs.status}) does NOT exclude ${listId} — run --setup --apply`);
      process.exitCode = 1;
    }
  }

  const emails = drawnWinnerEmails(JSON.parse(readFileSync(resultPath, 'utf8')));
  const profiles = [];
  for (const email of emails) {
    const p = await getProfileByEmail(email);
    if (!p) { console.error(`Refusing: no Klaviyo profile for ${email}`); process.exit(1); }
    profiles.push(p);
    console.log(`  ${email} → profile ${p.id}`);
  }
  if (!APPLY) { console.log('\nDry run — pass --apply to add them to the exclusion list.'); return; }

  await addToExclusionList(listId, emails, profiles.map((p) => p.id));
}

/**
 * Keep the §5-disqualified automated cohort out of the consolation sends.
 *
 * They confirmed at 0.14% and will never buy, so mailing them flattens every
 * rate the offer is measured on. They go onto the SAME list the winners go onto,
 * which all three campaigns already exclude — so this never edits a scheduled
 * send, which is the one thing that could cost the campaign its revenue event.
 *
 * Resolving each profile one at a time is deliberate: a bulk add by email would
 * CREATE a profile for an address Klaviyo does not have, and inventing profiles
 * while excluding people is exactly backwards.
 */
async function disqualified() {
  const evPath = join(ROOT, 'data', 'giveaway', 'evidence', '2026-09-15-entry-fraud', 'disqualified-entrants.json');
  if (!existsSync(evPath)) {
    console.error(`Refusing: no evidence record at ${evPath}`);
    process.exit(1);
  }
  const listId = config.offerExclusionListId;
  if (!listId) {
    console.error('Refusing: config/giveaway.json has no offerExclusionListId. Run --setup --apply first.');
    process.exit(1);
  }

  // A list nobody excludes does nothing. Say so before adding thousands to it.
  for (const [file, id] of Object.entries(config.offerCampaigns || {})) {
    const attrs = (await campaign(id)).data.attributes;
    if (!(attrs.audiences?.excluded || []).includes(listId) && attrs.status !== 'Sent') {
      console.error(`WARNING: ${file} (${attrs.status}) does NOT exclude ${listId} — run --setup --apply`);
      process.exitCode = 1;
    }
  }

  const emails = disqualifiedEmails(JSON.parse(readFileSync(evPath, 'utf8')));
  console.log(`${emails.length} disqualified entrant(s) to exclude from the offer sends`);

  const already = new Set(await listMemberEmails(listId));
  const todo = emails.filter((e) => !already.has(e));
  console.log(`  already on the list: ${emails.length - todo.length} · to add: ${todo.length}`);
  if (!todo.length) { console.log('✓ nothing to do — all already excluded'); return; }

  // Kept as PAIRS: a profile Klaviyo does not have drops out of both halves at
  // once, so the verification set can never drift out of step with what was sent.
  const resolved = [];
  const noProfile = [];
  for (const email of todo) {
    const p = await getProfileByEmail(email);
    if (!p) { noProfile.push(email); continue; }
    resolved.push({ email, id: p.id });
  }
  // Absent from Klaviyo means nothing can mail them, so there is nothing to
  // exclude — a warning, never a refusal.
  if (noProfile.length) console.log(`  ${noProfile.length} have no Klaviyo profile (nothing to exclude)`);
  console.log(`  resolved ${resolved.length} profile(s)`);
  if (!resolved.length) { console.log('✓ nothing addressable to add'); return; }

  if (!APPLY) { console.log('\nDry run — pass --apply to add them to the exclusion list.'); return; }
  await addToExclusionList(listId, resolved.map((r) => r.email), resolved.map((r) => r.id));
}

if (SETUP) await setup();
else if (WINNERS) await winners();
else await disqualified();
