#!/usr/bin/env node
/**
 * Build the metric-triggered flow that delivers 07-referral-pending.html.
 *
 *   node scripts/giveaway/build-referral-audit-flow.mjs            # dry — prints the plan
 *   node scripts/giveaway/build-referral-audit-flow.mjs --apply    # build it and set it live
 *
 * WHY A METRIC FLOW AND NOT A CAMPAIGN. A campaign sends one message to a
 * segment on a schedule. This has to reach ONE entrant, at the moment the
 * nightly audit finds their referral is stuck, with THEIR referrer's address in
 * the copy. A metric-triggered flow does that, and it inherits Klaviyo's consent
 * handling rather than reimplementing it — an unsubscribed profile is simply not
 * delivered to, which is what lib/giveaway/referral-audit.js's notify:null rule
 * relies on as a second line rather than the only one.
 *
 * ORDER IS LOad-BEARING. A flow cannot bind to a metric that has never fired, so
 * the metric is bootstrapped with one event FIRST, against an internal address
 * that is not on the giveaway list. Doing it the other way round would fire the
 * live flow at the bootstrap address. Klaviyo flows trigger only on events
 * received AFTER the flow goes live, so the bootstrap event never sends.
 *
 * KLAVIYO CLONES TEMPLATES INTO A FLOW. Same trap documented at length in
 * build-nurture-flow.mjs: creating a flow with `template_id` COPIES the
 * template, and the flow's send points at the copy. Editing
 * data/giveaway/nurture/07-referral-pending.html and re-running `templates` in
 * that script changes nothing about this flow. After any content change to 07,
 * re-run THIS script — which, because definitions cannot be PATCHed, deletes and
 * recreates the flow and issues a new flow id.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');

const {
  upsertTemplateByName, createFlow, updateFlowStatus, deleteFlow, trackEvent, findMetricByName,
} = await import('../../lib/klaviyo.js');
const { send, FROM } = await import('../flows/klaviyo-graph.js');
const { METRIC } = { METRIC: 'Giveaway Referral Pending' };

const apply = process.argv.includes('--apply');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

// Not on the giveaway list and never subscribed, so it cannot receive marketing
// email even by accident. Its only job is to make the metric exist.
const BOOTSTRAP_EMAIL = 'giveaway-audit-bootstrap@realskincare.com';

const MESSAGE = {
  subject: 'About the friend you named',
  preview: "Their side isn't finished yet — here's what unlocks the +5.",
  name: 'Giveaway Referral Pending',
};

if (!apply) {
  console.log('DRY RUN — would:');
  console.log(`  1. fire one "${METRIC}" event at ${BOOTSTRAP_EMAIL} to create the metric`);
  console.log('  2. upsert template "Giveaway Nurture 07 — Referral Pending"');
  console.log(`  3. ${config.referralAuditFlowId ? `delete prior flow ${config.referralAuditFlowId}, then ` : ''}create a metric-triggered flow`);
  console.log('  4. set it live');
  console.log('\nPass --apply to do it.');
  process.exit(0);
}

// 1. Make the metric exist. Must precede flow creation — see header.
let metric = await findMetricByName(METRIC);
if (metric) {
  console.log(`Metric already exists: ${metric.id}`);
} else {
  await trackEvent(METRIC, BOOTSTRAP_EMAIL, { bootstrap: true });
  // Klaviyo indexes a brand-new metric asynchronously; poll rather than assume.
  for (let i = 0; i < 10 && !metric; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    metric = await findMetricByName(METRIC);
  }
  if (!metric) throw new Error(`metric "${METRIC}" did not appear after the bootstrap event`);
  console.log(`Metric created: ${metric.id}`);
}

// 2. Template.
const html = readFileSync(join(ROOT, 'data', 'giveaway', 'nurture', '07-referral-pending.html'), 'utf8');
const tpl = await upsertTemplateByName('Giveaway Nurture 07 — Referral Pending', html);
config.nurtureTemplates = { ...(config.nurtureTemplates || {}), '07-referral-pending.html': tpl.id };
console.log(`Template ${tpl.id}`);

// 3. Flow. One send, no delay: the audit has already decided this entrant should
// hear about it, so a delay would only add a window in which the referrer
// confirms and the mail becomes wrong.
const definition = {
  triggers: [{ type: 'metric', id: metric.id }],
  profile_filter: null,
  entry_action_id: 'send1',
  actions: [send('send1', { ...MESSAGE, template_id: tpl.id }, null, 'live')],
};

if (config.referralAuditFlowId) {
  try {
    await deleteFlow(config.referralAuditFlowId);
    console.log(`  removed prior flow ${config.referralAuditFlowId}`);
  } catch (e) {
    console.error(`  WARNING: could not delete prior flow ${config.referralAuditFlowId} — a duplicate may remain: ${e.message}`);
  }
}

const flow = await createFlow({ name: 'Giveaway — Referral Pending', definition });
config.referralAuditFlowId = flow.id;
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Flow ${flow.id} created (${flow.status})`);

// 4. Live. Safe to do immediately: nothing enters this flow until
// audit-referrals.mjs --apply fires an event, and that only happens for a pair
// the classifier marked notifiable.
await updateFlowStatus(flow.id, 'live');
console.log(`Flow ${flow.id} is live. From: ${FROM.from_email}`);
console.log('\nRemember: editing 07-referral-pending.html does NOT change this flow. Re-run this script.');
