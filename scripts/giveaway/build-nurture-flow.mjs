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
 * Definition shape: this repo has no PROVEN example of a hand-authored "list"
 * trigger (every list-triggered flow here was built in the Klaviyo UI and is
 * cloned via getFlowDefinition, never hand-written). The action/link/data
 * envelope below (temporary_id, links.next, time-delay + send-email data
 * shapes) IS proven live in scripts/flows/build-reset-delivery.mjs (a metric
 * trigger) and scripts/flows/klaviyo-graph.js's send()/delay() helpers, reused
 * as-is here. Only the trigger's `{ type: 'list', list_id }` shape is a
 * best-effort match of the public Klaviyo Flows API — if `flow` mode 400s,
 * read the error detail (klaviyoRequest surfaces `detail @ source.pointer`)
 * and adjust the trigger object; the action graph should not need to change.
 *
 * NOTE: entrants must be suppressed from the Welcome flow (UUa3Qk) or FIRST20
 * stacks on the day-30 offer and silently costs ~$20 of a $40 contribution.
 * That is a one-time manual filter in the Klaviyo UI, printed as a reminder below.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertTemplateByName, createFlow, updateFlowStatus } from '../../lib/klaviyo.js';
import { send, delay } from '../flows/klaviyo-graph.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const NURTURE_DIR = join(ROOT, 'data', 'giveaway', 'nurture');
const DELAYS_HOURS = [0, 48, 144, 288, 480, 672]; // 0, d2, d6, d12, d20, d28
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
    preview: 'Every friend who enters and names you is worth +5 entries — up to 10 friends.',
    name: 'Giveaway Nurture 02 — Referral',
  },
  '03-angle': {
    subject: 'Most "unscented" soap isn\'t. Ours is.',
    preview: "Here's a category fact worth knowing before you pick your next bar.",
    name: 'Giveaway Nurture 03 — Angle',
  },
  '04-ugc': {
    subject: 'Show us your soap moment (+10 entries)',
    preview: 'Send a photo or video for +10 entries, or tag us on Instagram for +3.',
    name: 'Giveaway Nurture 04 — UGC',
  },
  '05-reminder': {
    subject: 'Your entries so far + how to add more',
    preview: "You've got entries banked — here's how many, and how to add more.",
    name: 'Giveaway Nurture 05 — Reminder',
  },
  '06-final-call': {
    subject: 'Entries close soon — 2 days to the drawing',
    preview: 'Entries close [DRAW DATE] — the drawing is 2 days later.',
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
  // schedule in DELAYS_HOURS (0, 48, 144, 288, 480, 672).
  const deltas = DELAYS_HOURS.slice(1).map((h, i) => h - DELAYS_HOURS[i]);

  const actions = [];
  files.forEach((file, i) => {
    const key = file.replace(/\.html$/, '');
    const sendId = `send${i + 1}`;
    const nextDelayId = `delay${i + 1}`;
    const isLast = i === files.length - 1;
    actions.push(send(sendId, { ...MESSAGES[key], template_id: config.nurtureTemplates[file] }, isLast ? null : nextDelayId));
    if (!isLast) actions.push(delay(nextDelayId, deltas[i], 'hours', `send${i + 2}`));
  });

  const definition = {
    triggers: [{ type: 'list', id: config.listId }],
    profile_filter: null,
    entry_action_id: 'send1',
    actions,
  };

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
}
