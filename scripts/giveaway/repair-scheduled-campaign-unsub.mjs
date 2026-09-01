#!/usr/bin/env node
/**
 * Repair the broken unsubscribe tag on SCHEDULED Klaviyo campaigns.
 *
 *   node scripts/giveaway/repair-scheduled-campaign-unsub.mjs            # dry run
 *   node scripts/giveaway/repair-scheduled-campaign-unsub.mjs --apply
 *
 * `href="{% unsubscribe %}"` nests a whole <a> element inside an attribute, so the
 * rendered footer carries href="<a class=" (a dead link) and spills the remaining
 * markup as visible text. The fix is one token: `{% unsubscribe_link %}`.
 *
 * WHY THIS IS NOT A TEMPLATE EDIT. Klaviyo CLONES a template onto a campaign message,
 * so editing the source template changes nothing about a campaign that already exists.
 * And a scheduled campaign refuses structural edits outright. The only route is the
 * documented cycle, and the names are treacherous:
 *
 *   PATCH /campaign-send-jobs/{id}  action:revert  → back to DRAFT, re-schedulable
 *   PATCH /campaign-send-jobs/{id}  action:cancel  → CANCELED, PERMANENTLY
 *
 * The destructive one has the friendlier name. This file never sends `cancel`.
 * The send-job id IS the campaign id — there is no separate id to look up.
 *
 * ORDER IS THE SAFETY PROPERTY: back up the campaign JSON and the live body BEFORE
 * reverting, verify the new body through the CONSUMER (re-read the campaign message's
 * template) BEFORE requeueing, and confirm the send time survived. A campaign left in
 * Draft with a date that still passes is a silent missed send, which is why the requeue
 * is never skipped on a failure — the run stops and says so, loudly.
 *
 * Status walks `Queued without Recipients` → `Adding Recipients` → `Scheduled` over
 * ~20-30s. Neither transitional state is an error; poll before concluding anything.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  klaviyoRequest, createTemplate, deleteTemplate, assignTemplateToCampaignMessage,
} from '../../lib/klaviyo.js';
import { hasUnsubscribeTag, unsubscribeFindings } from '../../lib/email-rebuild-checks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const KIT = JSON.parse(readFileSync(join(ROOT, 'data/brand/brand-kit.json'), 'utf8'));
const OUT = join(ROOT, 'data/reports/campaign-unsub-repair');
const BROKEN = /href="\{%\s*unsubscribe\s*%\}"/g;

const APPLY = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** Only these statuses are safe to touch: a Sent campaign is history, a Draft needs no revert. */
const SCHEDULED = new Set(['Scheduled', 'Queued without Recipients', 'Adding Recipients']);

async function campaignWithMessage(id) {
  const d = await klaviyoRequest('GET', `/campaigns/${id}/?include=campaign-messages`);
  const msg = (d.included ?? []).find((i) => i.type === 'campaign-message');
  return { campaign: d.data, message: msg, raw: d };
}

async function templateOf(messageId) {
  const d = await klaviyoRequest('GET', `/campaign-messages/${messageId}/?include=template`);
  const t = (d.included ?? []).find((i) => i.type === 'template');
  return t ? { id: t.id, ...t.attributes } : null;
}

async function pollStatus(id, want, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const d = await klaviyoRequest('GET', `/campaigns/${id}/`);
    const s = d.data.attributes.status;
    if (want(s)) return s;
    await sleep(3000);
  }
  const d = await klaviyoRequest('GET', `/campaigns/${id}/`);
  return d.data.attributes.status;
}

// Every email campaign that is still going to send. Discovered rather than hardcoded:
// a list of ids in a file goes stale the moment somebody schedules another campaign.
const listed = await klaviyoRequest(
  'GET', "/campaigns?filter=equals(messages.channel,'email')&include=campaign-messages",
);
const targets = [];
for (const c of listed.data ?? []) {
  if (!SCHEDULED.has(c.attributes?.status)) continue;
  const msgId = (c.relationships?.['campaign-messages']?.data ?? [])[0]?.id;
  if (!msgId) continue;
  const tpl = await templateOf(msgId);
  const html = tpl?.html ?? '';
  const hits = (html.match(BROKEN) ?? []).length;
  targets.push({
    id: c.id, name: c.attributes.name, status: c.attributes.status,
    sendAt: c.attributes?.send_time ?? c.attributes?.scheduled_at ?? null,
    messageId: msgId, templateId: tpl?.id, html, hits,
  });
}

const broken = targets.filter((t) => t.hits > 0);
log(`${targets.length} scheduled email campaign(s); ${broken.length} carry the broken tag\n`);
for (const t of targets) log(`  ${t.hits ? '✗' : '✓'} [${t.status}] ${t.name}  (${t.hits} hit${t.hits === 1 ? '' : 's'})`);
if (!broken.length) { log('\nnothing to repair'); process.exit(0); }

if (!APPLY) {
  log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}

mkdirSync(join(OUT, 'backups', stamp), { recursive: true });
const results = [];

for (const t of broken) {
  log(`\n▸ ${t.name}`);
  const fixed = t.html.replace(BROKEN, 'href="{% unsubscribe_link %}"');

  // Gate the replacement before anything is written. These are the same questions the
  // flow push asks, and a repair that failed them would be a second defect, not a fix.
  const problems = [
    ...(hasUnsubscribeTag(fixed) ? [] : ['no unsubscribe merge tag after repair']),
    ...unsubscribeFindings(fixed).problems,
    ...(fixed.includes(KIT.postal_address) ? [] : ['postal address missing — CAN-SPAM requires it']),
    ...(fixed === t.html ? ['replacement was a no-op'] : []),
  ];
  if (problems.length) { log(`  ✗ refused: ${problems.join('; ')}`); results.push({ ...t, ok: false, problems }); continue; }

  const before = await campaignWithMessage(t.id);
  writeFileSync(join(OUT, 'backups', stamp, `${t.id}.campaign.json`), JSON.stringify(before.raw, null, 2));
  writeFileSync(join(OUT, 'backups', stamp, `${t.id}.body.html`), t.html);
  const sendBefore = before.campaign.attributes?.send_strategy?.datetime ?? null;
  log(`  backed up campaign JSON + live body · send_strategy.datetime ${sendBefore}`);

  let intermediate = null;
  try {
    await klaviyoRequest('PATCH', `/campaign-send-jobs/${t.id}/`, {
      data: { type: 'campaign-send-job', id: t.id, attributes: { action: 'revert' } },
    });
    const draft = await pollStatus(t.id, (s) => s === 'Draft');
    if (draft !== 'Draft') throw new Error(`revert did not reach Draft (status ${draft})`);
    log('  reverted → Draft');

    const tpl = await createTemplate({ name: `unsub-fix ${t.id} ${stamp}`, html: fixed });
    intermediate = tpl.id;
    await assignTemplateToCampaignMessage(t.messageId, tpl.id);
    log(`  created library template ${tpl.id} and assigned it`);

    // Verify through the CONSUMER. A 200 on the assign says the call succeeded; it does
    // not say the campaign now serves what we meant.
    const after = await campaignWithMessage(t.id);
    const msgId = after.message?.id ?? t.messageId;
    const served = await templateOf(msgId);
    const stillBroken = (served?.html ?? '').match(BROKEN)?.length ?? 0;
    if (stillBroken || !hasUnsubscribeTag(served?.html ?? '')) {
      throw new Error(`campaign still serves a bad footer (${stillBroken} broken hit(s))`);
    }
    log(`  ✓ campaign now serves ${served.id} (${served.html.length}b), 0 broken hits`);

    await klaviyoRequest('POST', '/campaign-send-jobs/', {
      data: { type: 'campaign-send-job', attributes: { id: t.id } },
    });
    const final = await pollStatus(t.id, (s) => s === 'Scheduled');
    const reread = await campaignWithMessage(t.id);
    const sendAfter = reread.campaign.attributes?.send_strategy?.datetime ?? null;
    if (sendAfter !== sendBefore) log(`  ⚠ send time CHANGED: ${sendBefore} → ${sendAfter}`);
    log(`  requeued · status ${final} · send_strategy.datetime ${sendAfter}`);
    if (final !== 'Scheduled') log('  ⚠ did not settle to Scheduled — check this campaign by hand');

    results.push({ ...t, ok: final === 'Scheduled' && sendAfter === sendBefore, status: final, sendBefore, sendAfter, servedTemplate: served.id });
  } catch (err) {
    log(`  ✗ FAILED: ${err.message}`);
    log('  !! campaign may be sitting in Draft with a live send date — fix by hand NOW');
    results.push({ ...t, ok: false, error: err.message });
  } finally {
    // The library template is an intermediate: Klaviyo cloned it onto the message, so
    // leaving it behind litters the account with near-duplicates of every campaign body.
    if (intermediate) { try { await deleteTemplate(intermediate); log(`  cleaned up library intermediate ${intermediate}`); } catch { /* leaked, not fatal */ } }
  }
}

writeFileSync(join(OUT, `run-${stamp}.json`), JSON.stringify(
  results.map(({ html, ...r }) => r), null, 2,
));
const good = results.filter((r) => r.ok).length;
log(`\n${good}/${broken.length} repaired`);
process.exitCode = good === broken.length ? 0 : 1;
