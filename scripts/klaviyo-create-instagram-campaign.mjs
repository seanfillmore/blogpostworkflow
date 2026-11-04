#!/usr/bin/env node
/**
 * One-off (2026-11-04, Sean-approved copy): build the "follow us on Instagram"
 * campaign as a Klaviyo DRAFT. It never schedules and never sends.
 *
 *   node scripts/klaviyo-create-instagram-campaign.mjs           # dry run: gate + render, prints HTML size
 *   node scripts/klaviyo-create-instagram-campaign.mjs --apply   # create template + DRAFT campaign
 *
 * A Klaviyo campaign only sends once a campaign-send-job is created. This script
 * never calls /campaign-send-jobs/ and creates the campaign with no send_strategy,
 * so the result is a draft that a human (or a later, separately approved step)
 * must schedule. It is held because the body promises a DM "Natural" -> $10 code
 * and the auto-reply that sends those codes is still being built.
 *
 * Audience: Email List S6hKFq + Purchasers UAPGjf, excluding UigAyc (drawn winners
 * and the disqualified giveaway cohort). Smart Sending on.
 */
import { writeFileSync } from 'node:fs';
import { renderEmail } from '../lib/email-render.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { unsubscribeFindings } from '../lib/email-rebuild-checks.js';
import { IG } from '../lib/instagram-follow-block.js';
import { isDirectRun } from '../lib/is-direct-run.js';

export const SUBJECT = 'Our Instagram is worth a follow now';
export const PREVIEW = 'Quick how-tos, real reviews and a new creator video every day.';
export const INCLUDED = ['S6hKFq', 'UAPGjf'];
export const EXCLUDED = ['UigAyc'];
const NAME = 'Instagram follow invite (2026-11, DRAFT, hold until DM auto-reply is live)';

export const COPY = {
  heading: 'Come follow along on Instagram',
  p1: 'Hi {{ first_name|default:"there" }}, quick one from me. We have been putting real work into our Instagram lately, and I think it is genuinely worth a follow. Here is what you will find there:',
  b1: 'Short how-tos you can read in a minute: how to switch to an aluminum-free deodorant without quitting in week one, what is actually in your toothpaste, and why we leave SLS out of ours.',
  b2: 'Real reviews from customers, in their own words.',
  b3: 'A new video every day from one of our creators, showing how they use our products in real life.',
  b4: 'And the occasional post that is just about everyday life.',
  button: 'Follow @realskincare_com',
  offer: 'Have not ordered from us yet? Send us a DM on Instagram with the word "Natural" and we will send you $10 off your first order.',
  ps: 'PS: If you have a question about anything we make, you can ask it there too. I read the messages.',
};

const BODY_FONT = "Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif";

export function buildHtml() {
  const li = (t, last) => `<li style="margin:0${last ? '' : ' 0 8px'};">${t}</li>`;
  let html = renderEmail({
    preheader: PREVIEW,
    format: 'plain',
    blocks: [
      { type: 'h1', text: COPY.heading },
      { type: 'p', html: COPY.p1 },
      {
        type: 'raw',
        html: `<ul style="margin:0 0 20px;padding-left:20px;font-family:${BODY_FONT};font-size:16px;line-height:24px;color:#000000;">\n${[COPY.b1, COPY.b2, COPY.b3].map((t) => li(t)).join('\n')}\n${li(COPY.b4, true)}\n</ul>`,
      },
      { type: 'cta', text: COPY.button, href: IG },
      { type: 'p', html: COPY.offer },
      { type: 'signoff' },
      {
        type: 'raw',
        html: `<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid #EDEDED;font-family:${BODY_FONT};font-size:15px;line-height:23px;color:#000000;"><strong>PS:</strong> ${COPY.ps.replace(/^PS:\s*/, '')}</p>`,
      },
    ],
  });
  // The shared renderer's footer carries an em dash; this campaign carries none.
  const before = 'Unsubscribe here — no hard feelings.';
  if (!html.includes(before)) throw new Error('renderer footer changed; re-check the unsubscribe line');
  html = html.replace(before, 'Unsubscribe here, no hard feelings.');
  return html;
}

export function checkHtml(html) {
  const problems = [];
  if (/[–—]/.test(html)) problems.push('em/en dash present');
  if (!html.includes('href="{% unsubscribe_link %}"')) problems.push('unsubscribe_link missing');
  const u = unsubscribeFindings(html);
  if (u.length) problems.push(`unsubscribe findings ${JSON.stringify(u)}`);
  if ((html.match(new RegExp(`href="${IG}"`, 'g')) || []).length < 1) problems.push('Instagram CTA missing');
  return problems;
}

async function run() {
  const APPLY = process.argv.includes('--apply');
  const gate = checkSeoCopyFields({ subject: SUBJECT, preview: PREVIEW, ...COPY });
  console.log(`gate: ok=${gate.ok} blocking=${gate.blocking.length} advisory=${gate.advisory.length}`);
  if (!gate.ok) throw new Error(`gate blocked: ${JSON.stringify(gate.blocking)}`);
  const html = buildHtml();
  const problems = checkHtml(html);
  if (problems.length) throw new Error(problems.join('; '));
  const out = process.env.CAMPAIGN_HTML_OUT;
  if (out) writeFileSync(out, html);
  console.log(`html ok (${html.length} chars)`);
  if (!APPLY) { console.log('DRY RUN. Re-run with --apply to create the DRAFT.'); return; }

  const { klaviyoRequest, createTemplate, renderTemplate, assignTemplateToCampaignMessage } = await import('../lib/klaviyo.js');
  const tpl = await createTemplate({ name: `Campaign: ${NAME}`, html });
  const rendered = await renderTemplate(tpl.id, { first_name: 'Test' });
  if (checkHtml(rendered.html).filter((p) => !p.startsWith('unsubscribe_link')).length) throw new Error('rendered template failed checks');

  const d = await klaviyoRequest('POST', '/campaigns/', {
    data: {
      type: 'campaign',
      attributes: {
        name: NAME,
        audiences: { included: INCLUDED, excluded: EXCLUDED },
        send_options: { use_smart_sending: true },
        'campaign-messages': {
          data: [{
            type: 'campaign-message',
            attributes: {
              definition: {
                channel: 'email',
                label: 'Instagram follow invite',
                content: { subject: SUBJECT, preview_text: PREVIEW, from_email: 'support@realskincare.com', from_label: 'Real Skin Care', reply_to_email: 'support@realskincare.com' },
              },
            },
          }],
        },
      },
    },
  });
  const campaignId = d.data.id;
  const messageId = d.data.relationships['campaign-messages'].data[0].id;
  await assignTemplateToCampaignMessage(messageId, tpl.id);
  console.log(`created DRAFT campaign ${campaignId}, message ${messageId}, library template ${tpl.id}`);
}

if (isDirectRun(import.meta.url)) run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
