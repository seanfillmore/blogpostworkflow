#!/usr/bin/env node
/**
 * Build the branded CONFIRMATION email + flow for the flow_link mechanism.
 *
 *   node scripts/giveaway/build-confirm-flow.mjs template   # upsert the template only
 *   node scripts/giveaway/build-confirm-flow.mjs flow       # template + the flow
 *
 * WHAT THIS REPLACES. Under double opt-in, Klaviyo sends the confirmation email
 * and its subject line ("Confirm your email") and button label ("Yes, I want to
 * subscribe") are NOT editable — Klaviyo blocks both deliberately. That is the
 * ceiling this exists to lift: 79% of paid-acquired entrants never confirmed,
 * and the two elements doing the most work to earn a click were the two that
 * could not mention a $536.40 prize or +2 entries.
 *
 * HOW THE CLICK IS RECORDED. The template's button is Klaviyo's
 * `{% update_property_link 'gv_confirmed' 'true' '<url>' %}`, which writes the
 * profile property and then redirects. Two constraints on that tag shaped the
 * design and are not negotiable:
 *
 *   1. The value is a quoted LITERAL, so gv_confirmed arrives as the STRING
 *      'true'. lib/giveaway/reconcile.js accepts both spellings for exactly
 *      this reason — see confirmedEver.
 *   2. The redirect must be a STATIC url. The tag supports no dynamic content
 *      and cannot be nested, so ?e={{ person.email }} is impossible and the
 *      landing page has to work for an anonymous visitor.
 *
 * WHY THE FLOW IS ONE SEND AND NOT A REMINDER SEQUENCE. The send and delay
 * action shapes below are the ones proven live by build-nurture-flow.mjs. A
 * conditional split — "send again only if still unconfirmed" — needs a
 * profile_filter whose schema this repo has never exercised (the nurture
 * definition passes `profile_filter: null`), and Klaviyo's segments API on
 * revision 2025-07-15 will not even return an existing segment's `definition`
 * for a shape to copy. Guessing it would produce a flow that looks right and
 * silently re-mails people who already confirmed. So reminders are deliberately
 * NOT built here: send them as a campaign to the "entered but not confirmed"
 * segment, which is a human-reviewed send to hundreds of people and should be.
 *
 * KLAVIYO CLONES TEMPLATES INTO FLOWS. Creating a flow with `template_id` copies
 * the template; the flow's send action points at the copy. Editing the HTML and
 * re-running `template` therefore changes NOTHING about an existing flow, with
 * no error anywhere. After any content change, re-run `flow` as well. Same trap
 * documented at length in build-nurture-flow.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const TEMPLATE_FILE = join(ROOT, 'data', 'giveaway', 'nurture', '00-confirm-request.html');

export const MESSAGE = {
  name: 'Giveaway — 00 Confirm request',
  subject: 'Confirm your entry — 2 bonus entries waiting',
  preview_text: 'One click adds 2 entries to your $536.40 giveaway entry.',
};

/**
 * Content gates, run before anything is uploaded. Pure so they are testable
 * without credentials — the same split every other giveaway script uses.
 *
 * These are not style checks. Each one is a way this specific email can ship
 * broken in a way nobody notices until entries stop being credited.
 */
export function checkConfirmTemplate(html) {
  const problems = [];

  // The entire point of the email. A template that lost its update_property_link
  // still renders, still sends, and confirms nobody — the failure is invisible
  // until the reconciler reports a confirmation rate of zero.
  const links = html.match(/\{%\s*update_property_link[^%]*%\}/g) || [];
  if (!links.length) problems.push('no {% update_property_link %} — this email cannot confirm anyone');

  for (const link of links) {
    if (!/'gv_confirmed'\s*,?\s*'true'/.test(link.replace(/\s+/g, ' '))) {
      problems.push(`update_property_link does not set gv_confirmed to 'true': ${link}`);
    }
    // A dynamic redirect fails silently: the tag does not interpolate, so the
    // entrant lands on a literal "{{ person.email }}" url.
    if (/\{\{|\{%[^%]*\{%/.test(link.replace(/\{%\s*update_property_link|%\}/g, ''))) {
      problems.push(`update_property_link redirect must be static, found dynamic content: ${link}`);
    }
  }

  if (!/\{%\s*unsubscribe\s*%\}/.test(html)) {
    problems.push('no {% unsubscribe %} link — required by CAN-SPAM on a promotional send');
  }
  // Sweepstakes disclosure, same rule build-nurture-flow.mjs enforces.
  if (!/No purchase necessary/i.test(html)) {
    problems.push('missing "No purchase necessary" disclosure');
  }
  if (!/unsubscrib\w+ does not forfeit your entry/i.test(html)) {
    problems.push('missing the §12 promise that unsubscribing does not forfeit an entry');
  }
  return problems;
}

async function main() {
  const mode = process.argv[2];
  if (!['template', 'flow'].includes(mode)) {
    console.error('usage: build-confirm-flow.mjs <template|flow>');
    process.exitCode = 1;
    return;
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const html = readFileSync(TEMPLATE_FILE, 'utf8');

  const problems = checkConfirmTemplate(html);
  if (problems.length) {
    for (const p of problems) console.error(`  FAIL ${p}`);
    throw new Error(`${problems.length} content gate failure(s) — nothing uploaded`);
  }
  console.log('Content gates pass.');

  const { upsertTemplateByName, createFlow, deleteFlow } = await import('../../lib/klaviyo.js');

  const tpl = await upsertTemplateByName(MESSAGE.name, html);
  config.confirmTemplateId = tpl.id;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`  template ${MESSAGE.name} -> ${tpl.id}`);
  if (mode === 'template') return;

  // Trigger: added to the entrant LIST. Under flow_link that is the moment the
  // form is submitted, which is exactly when the confirmation ask should go —
  // and it is the one trigger that can reach a not-yet-confirmed profile.
  //
  // NOTE the mirror-image change this requires in build-nurture-flow.mjs: the
  // NURTURE flow triggers on the same list-add, which under double opt-in meant
  // "confirmed". Under flow_link it means "submitted", so the nurture sequence
  // would start at people who never clicked and 01-confirm would open by
  // congratulating them on confirming. That flow must be retriggered off the
  // confirmed SEGMENT before this one goes live. See docs/giveaway-confirm-cutover.md.
  const definition = {
    triggers: [{ type: 'list', id: config.listId }],
    profile_filter: null,
    entry_action_id: 'send1',
    actions: [{
      temporary_id: 'send1',
      type: 'send-email',
      data: { ...MESSAGE, template_id: config.confirmTemplateId },
      links: { next: null },
    }],
  };

  // Definitions cannot be PATCHed — rebuilding is delete-then-recreate, so a
  // rerun after a copy fix does not leave orphan draft flows behind.
  if (config.confirmFlowId) {
    try {
      await deleteFlow(config.confirmFlowId);
      console.log(`  removed prior draft flow ${config.confirmFlowId}`);
    } catch (err) {
      console.error(`  WARNING: delete of prior draft flow ${config.confirmFlowId} failed — a duplicate may be left behind: ${err.message}`);
    }
  }

  const flow = await createFlow({ name: 'Giveaway — Confirm request', definition });
  config.confirmFlowId = flow.id;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Flow ${flow.id} created (${flow.status}).`);
  console.log(
    '\nKlaviyo creates flows in DRAFT. Before setting it live, open it and confirm\n'
    + 'the trigger reads "added to Giveaway 2026-09 — Entrants" and send yourself a\n'
    + 'preview — click the button and check the profile picks up gv_confirmed=true.',
  );
}

if (isDirectRun(import.meta.url)) {
  await main();
}
