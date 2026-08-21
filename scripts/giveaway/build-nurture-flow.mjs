/**
 * Build the giveaway nurture flow.
 *
 *   node scripts/giveaway/build-nurture-flow.mjs templates    # all 6 templates
 *   node scripts/giveaway/build-nurture-flow.mjs flow         # onboarding flow (01-04)
 *   node scripts/giveaway/build-nurture-flow.mjs campaigns    # deadline sends (05-06)
 *   node scripts/giveaway/build-nurture-flow.mjs golive
 *
 * Trigger: added to the giveaway list. Every CTA is a ladder action; nothing in
 * this flow sells. The consolation offer is a separate day-30 campaign.
 *
 * Definition shape: `{ type: 'list', id: <listId> }` for the trigger — NOT
 * `list_id`, which the resource 'ListTrigger' rejects live (verified 2026-08-11).
 * The action/link/data envelope (temporary_id, links.next, time-delay +
 * send-email data shapes) is proven live in
 * scripts/flows/build-reset-delivery.mjs (git history only — deleted from the
 * working tree, recovered via `git show fccdd89:scripts/flows/build-reset-delivery.mjs`)
 * and scripts/flows/klaviyo-graph.js's send()/delay() helpers, reused as-is here.
 *
 * NOTE: entrants must be suppressed from the Welcome flow (UUa3Qk) or FIRST20
 * stacks on the day-30 offer and silently costs ~$20 of a $40 contribution.
 * That is a one-time manual filter in the Klaviyo UI, printed as a reminder below.
 *
 * ============================================================================
 * KLAVIYO CLONES TEMPLATES INTO A FLOW — `templates` MODE ALONE IS NOT ENOUGH
 * ============================================================================
 * Creating a flow with `template_id` does NOT make the flow reference that
 * template; Klaviyo copies it and the flow's send actions point at the copies.
 * Verified 2026-08-13: config held RFn6ZR/RAJQEt/Rw7Aj5/V2k6YD while the flow's
 * four sends pointed at TNFMGh/XpxyHf/WLww6C/SyDGt3.
 *
 * So editing a nurture HTML file and running `templates` updates the source
 * templates and changes NOTHING about a flow that already exists — the emails
 * keep sending the old copy, with no error anywhere. After any content change
 * to 01-04, re-run `flow` as well. (This costs a new flow id each time, since
 * definitions cannot be PATCHed.)
 *
 * The same applies to the deadline campaigns: `campaigns` mode re-assigns the
 * template on every run, so re-run it after any content change to 05-06.
 *
 * ============================================================================
 * TWO CLOCKS — WHY THIS IS NOT ONE SIX-EMAIL FLOW
 * ============================================================================
 * Every delay here is RELATIVE TO ENTRY (list-add), but the Entry Period is a
 * FIXED window with one shared close date, and those two facts do not compose.
 * Originally all six emails sat on the relative clock, so an entrant who joined
 * on day 20 reached 05-reminder ("the drawing is getting closer") on day 40 and
 * 06-final-call ("entries close September 14, the drawing is two days later") on
 * day 48 — over a month after the winner was drawn, stating a passed deadline as
 * though upcoming and soliciting referrals, posts and uploads that could no
 * longer be credited to anything.
 *
 * The emails were doing two different jobs, so they are now split by job:
 *
 *   01-confirm .. 04-ugc   ONBOARDING  -> this flow, relative to entry
 *   05-reminder, 06-final  DEADLINE    -> `campaigns` mode, fixed dates computed
 *                                         from config.entryClosesAt
 *
 * See lib/giveaway/nurture-schedule.js, which owns the split and the dates.
 *
 * The flow's own tail is bounded by scripts/giveaway/close-entry-period.mjs
 * (cron `TZ=America/Los_Angeles 5 5 15 9 *`), which flips this flow to `draft` the morning after
 * entries close — so a day-28 entrant stops receiving onboarding emails rather
 * than getting them past the draw. No date-based profile_filter is needed.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertTemplateByName, createFlow, updateFlowStatus, deleteFlow, createCampaign, deleteCampaign, assignTemplateToCampaignMessage } from '../../lib/klaviyo.js';
import { send, delay, FROM } from '../flows/klaviyo-graph.js';
import { FLOW_DELAYS_HOURS, splitNurtureFiles, flowDelayDeltas, campaignSchedule } from '../../lib/giveaway/nurture-schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const NURTURE_DIR = join(ROOT, 'data', 'giveaway', 'nurture');
// Timing now lives in lib/giveaway/nurture-schedule.js. Only the four ONBOARDING
// emails are on this relative-to-entry clock; the two DEADLINE emails moved to
// fixed-date campaigns because their copy is about the contest close, which is
// the same date for everyone. Read that module's header before changing either.
const DELAYS_HOURS = FLOW_DELAYS_HOURS;
const mode = process.argv[2] || 'templates';

// Subject/preview copy for each send-email action. Keys match the nurture file
// basenames (without .html) so a mismatch throws loudly instead of silently
// pairing the wrong subject with the wrong body.
const MESSAGES = {
  '01-confirm': {
    subject: "You're entered — here's what's next",
    preview: "You're entered. Here's what happens next — and why it's worth staying subscribed.",
    name: 'Giveaway Nurture 01 — Confirm',
  },
  '02-referral': {
    subject: 'Refer a friend, get +5 entries',
    // "enters AND CONFIRMS" — the +5 lands only once the friend clicks their own
    // double-opt-in link. That is what the rules say (§6) and what
    // lib/giveaway/reconcile.js enforces; promising it on "enters" alone
    // advertises a credit that never arrives.
    preview: 'Every friend who enters and confirms their entry is worth +5 entries — up to 10 friends.',
    name: 'Giveaway Nurture 02 — Referral',
  },
  '03-angle': {
    subject: 'Most "unscented" soap isn\'t. Ours is.',
    preview: "Here's a category fact worth knowing before you pick your next bar.",
    name: 'Giveaway Nurture 03 — Angle',
  },
  '04-ugc': {
    subject: 'Show us your soap moment (+10 entries)',
    // "Upload", not "reply": there is no inbound-mail processor anywhere in this
    // codebase, so a photo sent as an email reply grants usage rights and earns
    // nothing. The only path that credits the +10 rung is POST /api/giveaway/upload,
    // driven by the form on /pages/giveaway-entered. And "photo", not "photo or
    // video": validateUpload accepts jpg/jpeg/png/webp only.
    preview: 'Your entries so far, and what is still open to you.',
    name: 'Giveaway Nurture 04 — UGC',
  },
  '05-reminder': {
    subject: 'Your entries so far + how to add more',
    preview: "You've got entries banked — here's how many, and how to add more.",
    name: 'Giveaway Nurture 05 — Reminder',
  },
  '06-final-call': {
    // "tomorrow" is true because this is a CAMPAIGN on a fixed date (close - 1),
    // not a flow step whose send date varied per entrant. The previous subject,
    // "2 days to the drawing", was never right: it now sends September 13 and
    // the drawing is September 16, three days later. The body's claim is a
    // different one and is correct — the drawing is 2 days after the CLOSE.
    subject: 'Entries close tomorrow — last call',
    // The Entry Period close. This is a SECOND home for that date — the body's
    // copy lives in data/giveaway/nurture/06-final-call.html, but a message's
    // preheader lives on the flow's send-email action and is built from here,
    // so filling in the HTML alone leaves the preheader reading the literal
    // "[ENTRY CLOSE DATE]" in every inbox. Both must be changed together.
    preview: 'Entries close September 14, 2026 — the drawing is 2 days later.',
    name: 'Giveaway Nurture 06 — Final Call',
  },
};

const files = readdirSync(NURTURE_DIR).filter((f) => f.endsWith('.html')).sort();
// Throws if any expected email is missing or any unexpected one appears — an
// unclassified email would reach neither the flow nor a campaign and simply
// never send, with nothing downstream to notice.
const { flow: flowFiles, campaigns: campaignFiles } = splitNurtureFiles(files);

for (const file of files) {
  const html = readFileSync(join(NURTURE_DIR, file), 'utf8');
  if (!/unsubscribe/i.test(html)) throw new Error(`${file} has no unsubscribe link`);
  if (!/does not forfeit your entry/i.test(html)) throw new Error(`${file} is missing the entry-retention line`);
  if (/SOAP4MO|SOAP6MO|\$99|\$66/.test(html)) throw new Error(`${file} contains offer copy — the offer is day 30 only`);
  // A plain catalogue link is NOT the day-30 offer and is allowed: the entered
  // page has carried one since launch. But a sweepstakes email that asks for a
  // sale must say, in the same email, that buying changes nothing about the
  // draw. The disclosure already ships in every email; this stops a future edit
  // adding a buy button to one that lost it.
  if (/href="[^"]*\/(products|collections|cart)\//.test(html)
      && !/A purchase will not improve your chances of winning/i.test(html)) {
    throw new Error(
      `${file} has a purchase link but no "will not improve your chances" disclosure — `
      + 'a sweepstakes email that asks for a sale must disclaim it in the same email.',
    );
  }
  const key = file.replace(/\.html$/, '');
  if (!MESSAGES[key]) throw new Error(`${file} has no MESSAGES entry (subject/preview/name)`);
}
console.log(`All ${files.length} emails pass the content gates (${flowFiles.length} in the flow, ${campaignFiles.length} as dated campaigns).`);

if (mode === 'templates' || mode === 'flow' || mode === 'campaigns') {
  config.nurtureTemplates = {};
  for (const file of files) {
    const key = file.replace(/\.html$/, '');
    const name = MESSAGES[key].name;
    const tpl = await upsertTemplateByName(name, readFileSync(join(NURTURE_DIR, file), 'utf8'));
    config.nurtureTemplates[file] = tpl.id;
    console.log(`  template ${name} -> ${tpl.id}`);
  }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

if (mode === 'flow') {
  // Delta hours BETWEEN consecutive sends, derived from the absolute-from-entry
  // schedule in DELAYS_HOURS (0.5, 48, 144, 288).
  const deltas = flowDelayDeltas(DELAYS_HOURS);

  // Klaviyo's time-delay `value` must be an integer (verified live 2026-08-11:
  // 400 "An invalid field type was passed in" on both a 0.5 and a 47.5 hours
  // value). The 30-minute lead-in makes both the lead delay and the first
  // inter-send delta fractional in hours, so express those two in minutes
  // instead — every other delta is already a whole number of hours.
  const asDelayArgs = (hours) => (Number.isInteger(hours) ? [hours, 'hours'] : [hours * 60, 'minutes']);

  const actions = [];
  const leadHours = DELAYS_HOURS[0];
  // Entry -> optional leading delay (currently 30min) -> send1 -> delay -> send2 -> ...
  const entryActionId = leadHours > 0 ? 'delay0' : 'send1';
  if (leadHours > 0) actions.push(delay('delay0', ...asDelayArgs(leadHours), 'send1'));

  flowFiles.forEach((file, i) => {
    const key = file.replace(/\.html$/, '');
    const sendId = `send${i + 1}`;
    const nextDelayId = `delay${i + 1}`;
    const isLast = i === flowFiles.length - 1;
    actions.push(send(sendId, { ...MESSAGES[key], template_id: config.nurtureTemplates[file] }, isLast ? null : nextDelayId));
    if (!isLast) actions.push(delay(nextDelayId, ...asDelayArgs(deltas[i]), `send${i + 2}`));
  });

  const definition = {
    triggers: [{ type: 'list', id: config.listId }],
    profile_filter: null,
    entry_action_id: entryActionId,
    actions,
  };

  // Flow definitions can't be PATCHed (lib/klaviyo.js has no update-definition
  // endpoint) — rebuilding means delete-then-recreate. Idempotent: reruns after
  // a content or timing fix don't leave orphan draft flows behind.
  if (config.nurtureFlowId) {
    try {
      await deleteFlow(config.nurtureFlowId);
      console.log(`  removed prior draft flow ${config.nurtureFlowId}`);
    } catch (err) {
      console.error(`  WARNING: delete of prior draft flow ${config.nurtureFlowId} failed — proceeding to create a new flow anyway (may leave an orphaned duplicate): ${err.message}`);
    }
  }

  const flow = await createFlow({ name: 'Giveaway — Entry & Nurture', definition });
  config.nurtureFlowId = flow.id;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Flow ${flow.id} created (${flow.status}).`);
}

if (mode === 'campaigns') {
  // The two DEADLINE emails. Campaigns, not flow steps, because their subject
  // is the contest close — one date shared by every entrant. As flow steps they
  // fired N days after each person's own entry, so a day-20 entrant received
  // "entries close September 14" on day 40. Klaviyo creates campaigns in draft;
  // nothing sends until a send-job is submitted from the UI.
  if (!config.entryClosesAt) throw new Error('config.entryClosesAt is not set — cannot schedule the deadline campaigns');
  const schedule = campaignSchedule(config.entryClosesAt);
  config.deadlineCampaigns = config.deadlineCampaigns || {};

  // Idempotent, matching `flow` mode: without this, every rerun after a copy or
  // date fix leaves the previous campaign behind, and two campaigns pointed at
  // the same list would each send to every entrant.
  for (const [file, prior] of Object.entries(config.deadlineCampaigns)) {
    try {
      await deleteCampaign(prior.id);
      console.log(`  removed prior draft campaign ${prior.id} (${file})`);
    } catch (err) {
      console.error(`  WARNING: delete of prior campaign ${prior.id} failed — a duplicate may now exist and would double-send: ${err.message}`);
    }
  }
  config.deadlineCampaigns = {};

  for (const { file, sendAt, leadDays } of schedule) {
    const key = file.replace(/\.html$/, '');
    const msg = MESSAGES[key];
    const templateId = config.nurtureTemplates?.[file];
    if (!templateId) throw new Error(`no template for ${file} — run \`templates\` mode first`);

    const campaign = await createCampaign({
      name: `Giveaway — ${msg.name.replace(/^Giveaway Nurture \d+ — /, '')} (${sendAt.slice(0, 10)})`,
      listId: config.listId,
      sendAt,
      subject: msg.subject,
      preview: msg.preview,
      fromEmail: FROM.from_email,
      fromLabel: FROM.from_label,
      messageLabel: msg.name,
    });

    // A campaign created without this has no body at all — the message exists
    // but renders empty, and Klaviyo will not tell you until you preview it.
    const messageId = campaign.messageIds?.[0];
    if (!messageId) throw new Error(`campaign ${campaign.id} came back with no campaign-message to attach a template to`);
    await assignTemplateToCampaignMessage(messageId, templateId);

    config.deadlineCampaigns[file] = { id: campaign.id, messageId, sendAt };
    console.log(`  ${file}  ->  campaign ${campaign.id}  sends ${sendAt} (${leadDays}d before close)  template ${templateId}`);
  }

  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nEntry Period closes ${config.entryClosesAt}. Both campaigns are DRAFT.`);
  console.log('>>> MANUAL STEP: open each campaign in Klaviyo and click Schedule. Creating a');
  console.log('    campaign via the API does not queue it — the send date is stored, but no');
  console.log('    send job exists until it is scheduled. <<<');
}

if (mode === 'golive') {
  await updateFlowStatus(config.nurtureFlowId, 'live');
  console.log(`Flow ${config.nurtureFlowId} is live.`);
  console.log('\n>>> MANUAL STEP: add a suppression filter excluding gv_entrant profiles');
  console.log('    from the Welcome flow (UUa3Qk), or FIRST20 will stack on the day-30 offer. <<<');
  console.log('\nEnd boundary: scripts/giveaway/close-entry-period.mjs (cron `TZ=America/Los_Angeles 5 5 15 9 *`) flips');
  console.log('this flow to draft the morning after entries close, so a late entrant stops');
  console.log('receiving onboarding emails once there is nothing left to act on. The two');
  console.log('deadline emails are no longer in this flow at all — they are dated campaigns.');
}
