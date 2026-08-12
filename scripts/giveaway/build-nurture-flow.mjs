/**
 * Build the giveaway nurture flow.
 *
 *   node scripts/giveaway/build-nurture-flow.mjs templates
 *   node scripts/giveaway/build-nurture-flow.mjs flow
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
 * REQUIRED LAUNCH STEP — THE TAIL OF THIS FLOW OUTLIVES THE ENTRY PERIOD
 * ============================================================================
 * Every delay below is RELATIVE TO ENTRY (list-add), and `profile_filter` is
 * null, but the Entry Period is a FIXED 30-day window with one shared close
 * date. Those two facts do not compose: someone who enters on day 20 reaches
 * 05-reminder ("the drawing is getting closer") on day 40 and 06-final-call
 * ("entries close [ENTRY CLOSE DATE], the drawing is two days later") on day 48
 * — a week and a half AFTER the draw, stating a deadline that has already passed
 * as though it were upcoming, and soliciting referrals, Instagram posts and
 * uploads that can no longer be credited to anything.
 *
 * A relative-delay flow cannot fix this from inside the definition. When the
 * Entry Period dates are set, the flow needs an END BOUNDARY: either a flow end
 * date, or a date-based `profile_filter` / message-level filter that stops any
 * send once entries have closed. See the runbook
 * (docs/runbooks/2026-08-11-giveaway-launch.md, "Nurture flow — deliberately
 * DRAFT") for the required step. Do NOT set this flow live without it.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertTemplateByName, createFlow, updateFlowStatus, deleteFlow } from '../../lib/klaviyo.js';
import { send, delay } from '../flows/klaviyo-graph.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const NURTURE_DIR = join(ROOT, 'data', 'giveaway', 'nurture');
// 01-confirm fires 0.5h (30min) after entry, not 0h: with double opt-in on,
// Klaviyo sends its OWN confirmation email immediately at list-add, and a
// simultaneous send-of-ours read as two emails landing at once. 30 minutes is
// enough separation that 01-confirm lands after Klaviyo's email, so its copy
// can reference that email as already-received rather than something to expect.
// Remaining five entries are unchanged, still absolute hours-from-entry: d2,
// d6, d12, d20, d28.
const DELAYS_HOURS = [0.5, 48, 144, 288, 480, 672];
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
    preview: 'Upload a photo for +10 entries, or tag us on Instagram for +3.',
    name: 'Giveaway Nurture 04 — UGC',
  },
  '05-reminder': {
    subject: 'Your entries so far + how to add more',
    preview: "You've got entries banked — here's how many, and how to add more.",
    name: 'Giveaway Nurture 05 — Reminder',
  },
  '06-final-call': {
    subject: 'Entries close soon — 2 days to the drawing',
    preview: 'Entries close [ENTRY CLOSE DATE] — the drawing is 2 days later.',
    name: 'Giveaway Nurture 06 — Final Call',
  },
};

const files = readdirSync(NURTURE_DIR).filter((f) => f.endsWith('.html')).sort();
if (files.length !== 6) throw new Error(`expected 6 nurture emails, found ${files.length}`);

for (const file of files) {
  const html = readFileSync(join(NURTURE_DIR, file), 'utf8');
  if (!/unsubscribe/i.test(html)) throw new Error(`${file} has no unsubscribe link`);
  if (!/does not forfeit your entry/i.test(html)) throw new Error(`${file} is missing the entry-retention line`);
  if (/SOAP4MO|SOAP6MO|\$99|\$66/.test(html)) throw new Error(`${file} contains offer copy — the offer is day 30 only`);
  const key = file.replace(/\.html$/, '');
  if (!MESSAGES[key]) throw new Error(`${file} has no MESSAGES entry (subject/preview/name)`);
}
console.log('All 6 emails pass the content gates.');

if (mode === 'templates' || mode === 'flow') {
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
  // schedule in DELAYS_HOURS (0.5, 48, 144, 288, 480, 672).
  const deltas = DELAYS_HOURS.slice(1).map((h, i) => h - DELAYS_HOURS[i]);

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

  files.forEach((file, i) => {
    const key = file.replace(/\.html$/, '');
    const sendId = `send${i + 1}`;
    const nextDelayId = `delay${i + 1}`;
    const isLast = i === files.length - 1;
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

if (mode === 'golive') {
  await updateFlowStatus(config.nurtureFlowId, 'live');
  console.log(`Flow ${config.nurtureFlowId} is live.`);
  console.log('\n>>> MANUAL STEP: add a suppression filter excluding gv_entrant profiles');
  console.log('    from the Welcome flow (UUa3Qk), or FIRST20 will stack on the day-30 offer. <<<');
  console.log('\n>>> MANUAL STEP: give this flow an END DATE (or a date-based filter) at the');
  console.log('    Entry Period close. Delays here are relative to entry, so without one a');
  console.log('    day-20 entrant receives 05-reminder and 06-final-call AFTER the draw,');
  console.log('    quoting a deadline that has already passed. See the header comment. <<<');
}
