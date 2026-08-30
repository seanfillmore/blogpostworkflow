#!/usr/bin/env node
/**
 * Build the three consolation-offer campaigns — the giveaway's whole revenue event.
 *
 *   node scripts/giveaway/build-offer-campaigns.mjs                  # dry run
 *   node scripts/giveaway/build-offer-campaigns.mjs --apply
 *   node scripts/giveaway/build-offer-campaigns.mjs --apply --audience all
 *   node scripts/giveaway/build-offer-campaigns.mjs --retemplate --apply
 *
 * AUDIENCE DEFAULTS TO CONFIRMED ONLY. `--audience confirmed` (the default)
 * targets config.confirmedSegmentId; `--audience all` targets the whole entrant
 * list. Confirmed-first is deliberate: those profiles clicked something
 * recently, so they are the least likely to complain, and the domain is
 * carrying a spam rate that was over the Google/Yahoo line on backfill day.
 * Expand to the full list only after the first send's numbers come back clean —
 * scripts/giveaway/deliverability-check.mjs is the gate for that.
 *
 * THIS SCRIPT DOES NOT SEND, AND CANNOT SCHEDULE. An API-created Klaviyo
 * campaign carries a send_strategy but queues NO send job: it stays in Draft
 * until somebody clicks Schedule in the UI. That is not a bug in this script
 * and it is not something an extra API call fixes — the deadline campaigns had
 * exactly this trap, and a campaign that looks scheduled and never sends is the
 * worst available outcome for a one-shot revenue event. The final line of every
 * run says so.
 *
 * Content gates run BEFORE anything is uploaded (lib/giveaway/offer-campaigns.js).
 * A broken cart link here reaches every confirmed entrant at once.
 *
 * --retemplate: RE-PUSH the email bodies into campaigns that already exist.
 *
 * A KLAVIYO TEMPLATE IS A SNAPSHOT, NOT A LIVE REFERENCE. Assigning a template
 * to a campaign COPIES it; the campaign message then owns its own copy and no
 * later edit to the library template reaches it. So editing an email file and
 * re-running the plain `templates` upload changes NOTHING about what sends, with
 * no error anywhere — the same trap documented for flows in
 * build-nurture-flow.mjs. After any copy change to an existing campaign, this
 * mode is what actually moves it, and the run VERIFIES by reading the campaign
 * message back rather than trusting the assign call's 200.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { OFFER_SENDS, checkOfferEmail, sendTimeFor } from '../../lib/giveaway/offer-campaigns.js';
import { TIERS, OPENS_AT, CLOSES_AT, CLOSES_HUMAN } from '../../lib/giveaway/consolation-offer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const NURTURE_DIR = join(ROOT, 'data', 'giveaway', 'nurture');

const FROM = { fromEmail: 'support@realskincare.com', fromLabel: 'Real Skin Care' };

async function main() {
  const apply = process.argv.includes('--apply');
  const retemplate = process.argv.includes('--retemplate');
  const audArg = process.argv.indexOf('--audience');
  const audience = audArg > -1 ? process.argv[audArg + 1] : 'confirmed';
  if (!['confirmed', 'all'].includes(audience)) {
    throw new Error(`--audience must be "confirmed" or "all", got ${audience}`);
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const audienceId = audience === 'confirmed' ? config.confirmedSegmentId : config.listId;
  if (!audienceId) throw new Error(`no audience id for --audience ${audience} in config/giveaway.json`);

  // Gate everything first. Nothing is uploaded if any email is broken.
  let failed = 0;
  for (const send of OFFER_SENDS) {
    const problems = checkOfferEmail(readFileSync(join(NURTURE_DIR, send.file), 'utf8'));
    for (const p of problems) { console.error(`  FAIL ${send.file}: ${p}`); failed += 1; }
  }
  if (failed) throw new Error(`${failed} content gate failure(s) — nothing uploaded`);
  console.log(`All ${OFFER_SENDS.length} offer emails pass the content gates.`);
  for (const t of TIERS) {
    console.log(`  ${t.anchor ? '⭐' : '  '} ${t.title} — $${t.priceUsd} for ${t.totalBars} bars ($${t.valueUsd} value)`);
  }
  console.log(`Closes ${CLOSES_HUMAN}`);
  console.log(`Audience: ${audience} (${audienceId})\n`);

  for (const send of OFFER_SENDS) {
    console.log(`  ${send.name}\n    send at ${sendTimeFor(send, OPENS_AT)} | subject: ${send.subject}`);
  }

  if (!apply) {
    console.log(retemplate
      ? '\nDry run — re-run with --apply to re-push these bodies into the existing campaigns.'
      : '\nDry run — re-run with --apply to create the templates and campaigns.');
    return;
  }

  const { upsertTemplateByName, createCampaign, assignTemplateToCampaignMessage, getCampaign,
    updateCampaignMessageContent } = await import('../../lib/klaviyo.js');

  config.offerTemplates = config.offerTemplates || {};
  config.offerCampaigns = config.offerCampaigns || {};

  if (retemplate) {
    let moved = 0;
    const subjectBlocked = [];
    for (const send of OFFER_SENDS) {
      const campaignId = config.offerCampaigns[send.file];
      if (!campaignId) { console.error(`  SKIP ${send.file}: no campaign recorded`); continue; }

      const html = readFileSync(join(NURTURE_DIR, send.file), 'utf8');
      const tpl = await upsertTemplateByName(send.name, html);
      config.offerTemplates[send.file] = tpl.id;

      const campaign = await getCampaign(campaignId);
      const messageIds = (campaign.included || []).filter((x) => x.type === 'campaign-message').map((x) => x.id);
      if (!messageIds.length) { console.error(`  SKIP ${send.file}: campaign ${campaignId} has no message`); continue; }
      for (const messageId of messageIds) {
        // The BODY moves even on a Scheduled campaign.
        await assignTemplateToCampaignMessage(messageId, tpl.id);
        // The SUBJECT and PREVIEW live on the MESSAGE, not the template, and
        // Klaviyo refuses to modify a message while its campaign is Scheduled
        // ("Campaign Messages cannot be updated when campaign is not in draft").
        // So a re-template on a scheduled campaign moves half the email. That is
        // reported, never thrown: failing the run here would leave the earlier
        // campaigns re-templated and the later ones not, which is worse than a
        // known, named mismatch.
        try {
          await updateCampaignMessageContent(messageId, { subject: send.subject, preview: send.preview });
        } catch (err) {
          if (/not in draft/i.test(err.message)) subjectBlocked.push(send.file);
          else throw err;
        }
      }

      // VERIFY through the consumer. A template assign returning 200 is not
      // evidence the campaign now carries the new copy — read it back.
      //
      // Re-read once on mismatch: Klaviyo's read-after-write is eventually
      // consistent, and a single read straight after a successful PATCH
      // reported a stale subject that was in fact already updated. A verifier
      // that cries wolf is one people stop believing, which is worse than not
      // having it.
      let after = await getCampaign(campaignId);
      let msgCheck = (after.included || []).find((x) => x.type === 'campaign-message');
      const readSubject = (m) => m?.attributes?.definition?.content?.subject ?? m?.attributes?.content?.subject ?? null;
      if (readSubject(msgCheck) !== send.subject) {
        await new Promise((r) => setTimeout(r, 1500));
        after = await getCampaign(campaignId);
        msgCheck = (after.included || []).find((x) => x.type === 'campaign-message');
      }
      const msg = msgCheck;
      const assigned = msg?.relationships?.template?.data?.id ?? null;
      const liveSubject = msg?.attributes?.definition?.content?.subject ?? msg?.attributes?.content?.subject ?? null;
      // Built into the same log line rather than console.error: stderr and stdout
      // interleave, and a warning printed separately lands under the WRONG send.
      const subjectNote = liveSubject === send.subject
        ? ''
        : `\n    STALE SUBJECT — wanted ${JSON.stringify(send.subject)}`;
      const problems = checkOfferEmail(html);
      console.log(
        `  ${send.name}\n    campaign ${campaignId} (${after.status}) | template now ${assigned}`
        + `\n    subject: ${JSON.stringify(liveSubject)}${subjectNote}`
        + `${problems.length ? ` | GATE FAILURES: ${problems.length}` : ''}`,
      );
      if (!assigned) console.error('    WARNING: campaign message reports NO template after assignment');
      moved += 1;
    }
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\n${moved} campaign(s) re-templated.`);
    console.log(
      'Klaviyo copies a template into the campaign on assignment, so this is what\n'
      + 'actually changes what sends. Re-check each campaign is still SCHEDULED above —\n'
      + 'if one dropped back to Draft, it needs Schedule clicked again.',
    );
    if (subjectBlocked.length) {
      console.error(
        `\nSUBJECT NOT UPDATED on ${subjectBlocked.length} campaign(s): ${subjectBlocked.join(', ')}.\n`
        + 'Klaviyo will not modify a campaign message while the campaign is Scheduled.\n'
        + 'The BODY is updated and live; the SUBJECT still reads whatever it did before.\n'
        + 'To change it: revert the campaign to Draft in Klaviyo, re-run this command,\n'
        + 'then click Schedule again. Leaving it is safe only if the old subject still\n'
        + 'names a real tier — check the warnings above.',
      );
    }
    return;
  }

  for (const send of OFFER_SENDS) {
    const html = readFileSync(join(NURTURE_DIR, send.file), 'utf8');
    const tpl = await upsertTemplateByName(send.name, html);
    config.offerTemplates[send.file] = tpl.id;

    const campaign = await createCampaign({
      name: send.name,
      audienceId,
      sendAt: sendTimeFor(send, OPENS_AT),
      subject: send.subject,
      preview: send.preview,
      ...FROM,
    });
    for (const messageId of campaign.messageIds) {
      await assignTemplateToCampaignMessage(messageId, tpl.id);
    }
    config.offerCampaigns[send.file] = campaign.id;
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`  created campaign ${campaign.id} (template ${tpl.id}) — ${send.name}`);
  }

  console.log(
    `\nAll three exist as DRAFTS. Klaviyo does not queue a send job for an`
    + `\nAPI-created campaign — open each one and click Schedule, or none will send.`
    + `\nWindow: ${OPENS_AT} → ${CLOSES_AT}.`,
  );
}

if (isDirectRun(import.meta.url)) {
  await main();
}
