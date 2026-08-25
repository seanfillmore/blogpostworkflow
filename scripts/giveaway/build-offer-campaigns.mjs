#!/usr/bin/env node
/**
 * Build the three consolation-offer campaigns — the giveaway's whole revenue event.
 *
 *   node scripts/giveaway/build-offer-campaigns.mjs                  # dry run
 *   node scripts/giveaway/build-offer-campaigns.mjs --apply
 *   node scripts/giveaway/build-offer-campaigns.mjs --apply --audience all
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
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { OFFER_SENDS, checkOfferEmail, sendTimeFor } from '../../lib/giveaway/offer-campaigns.js';
import { OPENS_AT, CLOSES_AT, CLOSES_HUMAN, priceUsd, totalBars } from '../../lib/giveaway/consolation-offer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const NURTURE_DIR = join(ROOT, 'data', 'giveaway', 'nurture');

const FROM = { fromEmail: 'support@realskincare.com', fromLabel: 'Real Skin Care' };

async function main() {
  const apply = process.argv.includes('--apply');
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
  console.log(`Offer: ${totalBars()} bars for $${priceUsd()} | closes ${CLOSES_HUMAN}`);
  console.log(`Audience: ${audience} (${audienceId})\n`);

  for (const send of OFFER_SENDS) {
    console.log(`  ${send.name}\n    send at ${sendTimeFor(send, OPENS_AT)} | subject: ${send.subject}`);
  }

  if (!apply) {
    console.log('\nDry run — re-run with --apply to create the templates and campaigns.');
    return;
  }

  const { upsertTemplateByName, createCampaign, assignTemplateToCampaignMessage } =
    await import('../../lib/klaviyo.js');

  config.offerTemplates = config.offerTemplates || {};
  config.offerCampaigns = config.offerCampaigns || {};

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
