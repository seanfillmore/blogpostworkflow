#!/usr/bin/env node
/**
 * Second confirmation reminder — to the unconfirmed entrants who have NEVER been asked.
 *
 *   node scripts/giveaway/send-confirm-reminder.mjs           # dry run, read only
 *   node scripts/giveaway/send-confirm-reminder.mjs --apply   # create the segment + DRAFT campaign
 *   node scripts/giveaway/send-confirm-reminder.mjs --send    # queue the send job (with --apply)
 *   node scripts/giveaway/send-confirm-reminder.mjs --send-campaign <id>   # send a verified draft
 *
 * THREE GATES, DELIBERATELY. Dry by default; `--apply` builds a draft that mails
 * nobody; `--send` is the only thing that reaches a real inbox. An outward-facing
 * send to ~1,600 people is not something to acquire by typing one flag, and the
 * Klaviyo API makes the middle state free — see the Draft trap below.
 *
 * WHY THIS IS NOT `nudge-unconfirmed.mjs`. That script re-issues a SUBSCRIBE to
 * make Klaviyo send its own double-opt-in email, and it correctly refuses to run
 * under `flow_link` because re-subscribing a single opt-in list sends nothing at
 * all — it would report "nudged 40" while sending zero. This one is the
 * `flow_link` mechanism: the entrant is already subscribed, so the ask is an
 * ordinary marketing email carrying the `update_property_link` that writes
 * `gv_confirmed` and pays the +2. The two are mutually exclusive by mechanism,
 * which is why each refuses to run under the other's.
 *
 * THE AUDIENCE IS A DATE CUTOFF, NOT A LIST OF ADDRESSES. The first reminder
 * (campaign 01M0RZM53084R8VEM8A2MS63PZ, 2026-08-25 14:00 UTC) went to the WHOLE
 * unconfirmed segment as it stood at that instant. So "entered after that
 * moment" is an exact statement of "never received it" — no event queries, no
 * per-profile stamping, and it cannot drift as the segment grows. Everyone who
 * entered before it got their ask and ignored it; they keep their base entry and
 * are left alone. See lib/giveaway/confirm-reminder.js for why yield is not the
 * binding constraint here — the complaint rate is.
 *
 * THE DRAFT TRAP. A campaign created through the API stores its `send_strategy`
 * and queues NO send job: it sits in Draft looking scheduled forever. That has
 * bitten this project twice (the deadline campaigns, then the first confirm
 * reminder). `--send` posts the send job explicitly and then re-reads the
 * campaign to confirm the status actually moved — a success log is not a send.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// A missing .env must not throw at import time — the send policy in
// lib/giveaway/confirm-reminder.js is pure and testable without credentials, and
// crashing here would make that untrue. A run that needs the token fails loudly
// on the first Klaviyo call. Same posture as nudge-unconfirmed.mjs.
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch { /* no .env is a valid state — see above */ }

const { klaviyoRequest, createCampaign, getCampaign, assignTemplateToCampaignMessage } =
  await import('../../lib/klaviyo.js');
const { resolveMechanism, CONFIRM_MECHANISMS } = await import('../../lib/giveaway/reconcile.js');
const { selectReminderTargets, projectReminderOutcome, FIRST_REMINDER, MIN_HOURS_SINCE_ENTRY } =
  await import('../../lib/giveaway/confirm-reminder.js');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SEND = args.includes('--send');

// Ids come from config, never from a literal here: config/giveaway.json is the
// single source of truth for this promotion's ids and dates, and a second copy
// in a script is a second copy that goes stale.
const required = (key, value) => {
  if (!value) throw new Error(`config/giveaway.json is missing ${key} — refusing to guess it`);
  return value;
};
const UNCONFIRMED_SEGMENT = required('unconfirmedSegmentId', config.unconfirmedSegmentId);
// The confirm-request template already carries the update_property_link button
// and has passed this project's content gates. Reusing it is what the first
// reminder did, and authoring new copy would put an ungated email in front of
// 1,600 people to save nothing.
const TEMPLATE_ID = required('confirmTemplateId', config.confirmTemplateId);
const FROM = { fromEmail: 'support@realskincare.com', fromLabel: 'Real Skin Care' };

/**
 * Everyone who entered at or before this received the first reminder. Taken
 * from config when it is recorded there, so a re-send that ever happens updates
 * one file rather than this script's constants.
 */
const FIRST_REMINDER_SENT_AT = new Date(
  config.confirmReminderCampaign?.sendAt ?? FIRST_REMINDER.sentAt,
);

function entryDeadline() {
  return new Date(required('entryClosesAt', config.entryClosesAt));
}

async function fetchSegmentProfiles(segmentId) {
  const out = [];
  let url = `/segments/${segmentId}/profiles/?page[size]=100`;
  while (url) {
    const d = await klaviyoRequest('GET', url);
    for (const p of d.data || []) {
      const props = p.attributes?.properties || {};
      out.push({
        id: p.id,
        email: p.attributes?.email,
        createdAt: p.attributes?.created ? new Date(p.attributes.created) : null,
        // gv_test is stamped by the giveaway's own test harness. These inboxes
        // are ours, so mailing them is harmless — but they inflate the
        // denominator every rate here is measured against.
        isTest: props.gv_test === true || props.gv_test === 'true',
      });
    }
    const next = d.links?.next;
    url = next ? next.replace(/^https:\/\/a\.klaviyo\.com\/api/, '') : null;
  }
  return out;
}

/**
 * Queue the send job for an existing campaign, then re-read it.
 *
 * `attributes.id`, NOT `campaign_id` — the campaign-send-job resource names it
 * `id`, and `campaign_id` is rejected outright. Measured against the live API
 * 2026-09-05; the shape matches scripts/giveaway/repair-scheduled-campaign-unsub.mjs.
 *
 * A success log is not a send. The Draft trap means a campaign can accept every
 * call and still sit there mailing nobody, so the status is re-read and polled:
 * a scheduled campaign settles on "Queued without Recipients" (Klaviyo computes
 * recipients at send time) and only a campaign still reading "Draft" has failed.
 */
async function sendCampaign(id) {
  await klaviyoRequest('POST', '/campaign-send-jobs/', {
    data: { type: 'campaign-send-job', attributes: { id } },
  });
  let status = 'Draft';
  for (let i = 0; i < 6 && status === 'Draft'; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    status = (await getCampaign(id)).status;
  }
  console.log(`\n  send job posted. campaign status is now: ${status}`);
  if (status === 'Draft') {
    console.error('  STILL DRAFT — the send job did not take. Nothing was mailed.');
    process.exit(1);
  }
  return status;
}

async function main() {
  // Send a draft a previous --apply already built and a human has since
  // verified. Without this the only way to send is another --apply, which
  // orphans the verified draft and creates a second exclusion segment — which
  // is exactly what happened on the first live run.
  const sendExisting = args.indexOf('--send-campaign');
  if (sendExisting !== -1) {
    const id = args[sendExisting + 1];
    if (!id) { console.error('--send-campaign requires a campaign id'); process.exit(64); }
    const before = await getCampaign(id);
    console.log(`Sending existing campaign ${id}`);
    console.log(`  status now : ${before.status}`);
    console.log(`  audiences  : ${JSON.stringify(before.audiences)}`);
    if (before.status !== 'Draft') {
      console.error(`  Refusing: campaign is "${before.status}", not Draft. Nothing to queue.`);
      process.exit(64);
    }
    await sendCampaign(id);
    return;
  }

  const mechanism = resolveMechanism(config);
  if (mechanism !== CONFIRM_MECHANISMS.FLOW_LINK) {
    // Under double_opt_in the entrant is NOT subscribed, so a marketing campaign
    // cannot legally or technically reach them. nudge-unconfirmed.mjs is the
    // tool for that mechanism. Refusing is the whole point — the inverse of that
    // script's own refusal, and for the same reason.
    console.error(`Refusing: confirmMechanism is "${mechanism}", not flow_link.`);
    console.error('Under double opt-in an unconfirmed profile has not consented and a campaign');
    console.error('cannot reach it. Use scripts/giveaway/nudge-unconfirmed.mjs instead.');
    process.exit(64);
  }
  if (SEND && !APPLY) {
    console.error('Refusing: --send requires --apply. There is nothing to send without a campaign.');
    process.exit(64);
  }

  const now = new Date();
  const deadline = entryDeadline();

  console.log('Confirm reminder #2');
  console.log(`  mechanism      : ${mechanism}`);
  console.log(`  entry closes   : ${deadline.toISOString()} (${((deadline - now) / 86400000).toFixed(1)} days)`);
  console.log(`  first reminder : ${FIRST_REMINDER.sentAt} — ${FIRST_REMINDER.clicksUnique}/${FIRST_REMINDER.delivered} confirmed`);
  console.log('');

  const unconfirmed = await fetchSegmentProfiles(UNCONFIRMED_SEGMENT);
  console.log(`  unconfirmed segment ${UNCONFIRMED_SEGMENT}: ${unconfirmed.length} profiles`);

  const { due, skipped, halted } = selectReminderTargets({
    unconfirmed,
    alreadyRemindedBefore: FIRST_REMINDER_SENT_AT,
    now,
    deadline,
  });

  if (halted) {
    console.log(`\n  HALTED: ${halted}`);
    console.log('  A confirmation that lands after entries close pays nothing.');
    process.exit(0);
  }

  const reasons = {};
  for (const s of skipped) reasons[s.reason.replace(/\d+\.\d+h/, 'Nh')] = (reasons[s.reason.replace(/\d+\.\d+h/, 'Nh')] || 0) + 1;
  console.log('\n  Skipped:');
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${reason}`);
  }
  // The cutoff is a PROXY and it over-excludes. Measured 2026-09-05: it holds
  // back 917 profiles as "already reminded" while the first campaign reports
  // only 489 recipients — Klaviyo's smart sending suppressed the rest, so a few
  // hundred people entered before the cutoff and never actually received it.
  // Stated rather than hidden, because the gap looks like a bug until you know
  // it is one. It errs toward not mailing, which is the direction this policy
  // must fail in; closing it means querying Received Email events per profile,
  // which is a bigger change than the entries it would recover.
  const alreadyReminded = skipped.filter((s) => /already reminded/.test(s.reason)).length;
  if (alreadyReminded > FIRST_REMINDER.recipients) {
    console.log(`\n  Note: ${alreadyReminded} held back as already-reminded, but the first campaign`);
    console.log(`  reports only ${FIRST_REMINDER.recipients} recipients — smart sending suppressed the difference.`);
    console.log('  The cutoff over-excludes by design; it never mails anyone twice.');
  }

  console.log(`\n  WOULD REMIND: ${due.length}`);

  if (due.length === 0) {
    console.log('  Nothing to send.');
    return;
  }

  const p = projectReminderOutcome(due.length);
  console.log('\n  Projected, from the first reminder\'s own measured rates:');
  console.log(`    confirmations  ~${p.expectedConfirmations}  (${(p.confirmRate * 100).toFixed(1)}%)`);
  console.log(`    unsubscribes   ~${p.expectedUnsubscribes}`);
  console.log(`    spam complaints ~${p.expectedSpamComplaints}  (${(p.spamRate * 100).toFixed(2)}%)`);
  if (p.aboveComplaintEnforcement) {
    console.log('    !! ABOVE the 0.3% Google/Yahoo enforcement rate — do not send.');
  } else if (p.aboveComplaintTarget) {
    console.log('    !  Above the 0.1% target rate. Domain reputation is shared with every');
    console.log('       other Klaviyo send this store makes; weigh that against the entries.');
  }
  console.log('    (n=1 on the complaint estimate — one complaint in 487. Directional only.)');

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to create the segment and a DRAFT campaign.');
    return;
  }

  // THE AUDIENCE IS X7atwC MINUS AN EXCLUSION, NOT A REBUILT SEGMENT.
  //
  // The obvious construction — one segment saying "in X7atwC AND created after
  // the cutoff" — is impossible: `profile-group-membership` takes LISTS, not
  // segments ("Group X7atwC does not exist for company", measured). The
  // alternative, restating X7atwC's own confirmed-vs-subscribed logic inline,
  // would put a second copy of the rule that `confirmedEmailSet` deliberately
  // owns alone into a script that mails people — exactly the drift that had
  // `p.subscribed` meaning "confirmed" in six places.
  //
  // So the campaign INCLUDES the maintained segment and EXCLUDES a cheap,
  // purely-date-and-flag one. Set subtraction, no duplicated logic, and X7atwC
  // stays the single definition of "unconfirmed".
  //
  // All three conditions sit in ONE group because Klaviyo ORs within a group and
  // ANDs across them — the inverse of what the nesting reads like, and a trap
  // that has already produced a wrong audience on this account. OR is what is
  // wanted here: exclude anyone matching ANY of these.
  const cutoff = new Date(FIRST_REMINDER_SENT_AT.getTime() + 1000);
  const tooRecent = new Date(now.getTime() - MIN_HOURS_SINCE_ENTRY * 3_600_000);
  const segmentName = `Giveaway 2026-09 — Confirm reminder #2 EXCLUSIONS (${now.toISOString().slice(0, 10)})`;
  const seg = await klaviyoRequest('POST', '/segments/', {
    data: {
      type: 'segment',
      attributes: {
        name: segmentName,
        definition: {
          condition_groups: [{
            conditions: [
              // Already received the first reminder. +1s so a profile created at
              // the exact send instant is excluded, matching the `<=` the policy
              // module uses — the boundary must never be mailed twice.
              { type: 'profile-property', property: 'created', filter: { type: 'date', operator: 'before', date: cutoff.toISOString() } },
              // Entered too recently — the confirm flow's own email is still working.
              { type: 'profile-property', property: 'created', filter: { type: 'date', operator: 'after', date: tooRecent.toISOString() } },
              // Our own test inboxes, which live inside X7atwC and dilute every
              // rate measured off a send to it.
              { type: 'profile-property', property: "properties['gv_test']", filter: { type: 'boolean', operator: 'equals', value: true } },
            ],
          }],
        },
      },
    },
  });
  console.log(`\n  exclusion segment: ${seg.data.id} — ${segmentName}`);
  console.log(`    excludes: created before ${cutoff.toISOString()} (already reminded)`);
  console.log(`              created after  ${tooRecent.toISOString()} (confirm flow still working)`);
  console.log('              gv_test = true (our own inboxes)');
  console.log('  VERIFY BY MEMBERSHIP, NOT COUNT — a segment can report a plausible count and');
  console.log('  hold the wrong people.');

  // createCampaign hardcodes `excluded: []`, so the campaign is built directly
  // here rather than widening that helper for one caller.
  const campaignName = `Giveaway — Confirm reminder #2 (${now.toISOString().slice(0, 10)})`;
  const created = await klaviyoRequest('POST', '/campaigns/', {
    data: {
      type: 'campaign',
      attributes: {
        name: campaignName,
        audiences: { included: [UNCONFIRMED_SEGMENT], excluded: [seg.data.id] },
        // Static, absolute: a deadline is one moment worldwide, not a local hour.
        send_strategy: { method: 'static', datetime: new Date(now.getTime() + 3_600_000).toISOString(), options: { is_local: false } },
        send_options: { use_smart_sending: true },
        'campaign-messages': {
          data: [{
            type: 'campaign-message',
            attributes: {
              definition: {
                channel: 'email',
                label: campaignName,
                content: {
                  subject: 'Your 2 bonus entries are still unclaimed',
                  preview_text: 'One click, and they are on your entry.',
                  from_email: FROM.fromEmail,
                  from_label: FROM.fromLabel,
                },
              },
            },
          }],
        },
      },
    },
  });
  const campaign = {
    id: created.data.id,
    messageIds: (created.data.relationships?.['campaign-messages']?.data || []).map((m) => m.id),
  };
  console.log(`  campaign created: ${campaign.id} (DRAFT — no send job queued)`);

  // Attach the confirm-request template. Without it the campaign sends an empty
  // shell: the entire mechanism here is the update_property_link button inside
  // that template, so a send with no template confirms nobody and spends the
  // domain reputation anyway.
  const messageId = campaign.messageIds?.[0];
  if (!messageId) throw new Error('campaign created with no message id — refusing to continue');
  await assignTemplateToCampaignMessage(messageId, TEMPLATE_ID);
  console.log(`  template ${TEMPLATE_ID} attached to message ${messageId}`);
  console.log("  (it carries {% update_property_link 'gv_confirmed' 'true' ... %} — the click IS the confirmation)");

  if (!SEND) {
    console.log('\n  Not sent. Re-run with --apply --send once the template is attached and verified.');
    return;
  }

  await sendCampaign(campaign.id);
}

main().catch((err) => {
  console.error('[send-confirm-reminder]', err.message);
  process.exit(1);
});
