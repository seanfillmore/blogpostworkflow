#!/usr/bin/env node
/**
 * One-off (2026-11-04, Sean: "We can offer this to our engaged audience"): the
 * "2 free Pure Unscented bars on $60+" announcement, built as a Klaviyo DRAFT for
 * Sean to review. It never schedules and never sends (no send_strategy, no
 * /campaign-send-jobs/ call), same as scripts/klaviyo-create-instagram-campaign.mjs.
 *
 *   node scripts/klaviyo-create-unscented-bars-campaign.mjs           # dry run: gate + render
 *   node scripts/klaviyo-create-unscented-bars-campaign.mjs --apply   # create template + DRAFT campaign
 *
 * The offer it describes is the live automatic discount from
 * scripts/unscented-bar-push.mjs; prices are read from the storefront at run time and
 * the run refuses if they no longer match the copy.
 *
 * Audience: Email List S6hKFq + Purchasers UAPGjf, excluding UigAyc (giveaway winners
 * and disqualified cohort). Giveaway entrants are deliberately NOT included (Sean,
 * 2026-11-04: "leave their profiles alone"). Smart Sending on.
 */
import { writeFileSync } from 'node:fs';
import { renderEmail } from '../lib/email-render.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { unsubscribeFindings } from '../lib/email-rebuild-checks.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const SITE = 'https://www.realskincare.com';
export const ADD_URL = `${SITE}/cart/add?id=45828179951786&quantity=2`;
export const SHOP_URL = `${SITE}/collections/all-products`;
export const PACKS = { 'coconut-bar-soap-4-pack': ['4x Pure Unscented', '29.00'], 'coconut-bar-soap-12-pack': ['12x Pure Unscented', '60.00'] };

export const SUBJECT = '2 free bars of soap with your next order';
export const PREVIEW = 'Spend $60 and two Pure Unscented bars are on us.';
export const INCLUDED = ['S6hKFq', 'UAPGjf'];
export const EXCLUDED = ['UigAyc'];
const NAME = 'Free Pure Unscented bars on $60+ (2026-11, DRAFT for review)';

export const COPY = {
  heading: 'Two free bars of soap, on us',
  p1: 'Hi {{ first_name|default:"there" }}, we have more Pure Unscented bar soap on the shelf than we need, and we would rather it be in your shower. So right now, any $60+ order gets 2 bars free.',
  p2: 'It is our coconut oil hand and body soap with nothing added for scent, an easy pick if fragrance bothers your skin.',
  how: 'How it works:',
  s1: 'Shop as usual until your cart reaches $60. The free bars do not count toward it.',
  s2: 'Add 2 Pure Unscented bars to your cart, or tap the link below once you are there.',
  s3: 'They ring up at $0 at checkout. One gift per order, while supplies last.',
  button: 'Shop now',
  add: 'Already at $60? Add my 2 free bars',
  packs: 'Stocking up for yourself? The Pure Unscented 4-pack is now $29 and the 12-pack is $60.',
  ps: 'PS: Free shipping still starts at $45, so a $60 order ships free too.',
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
      { type: 'p', html: COPY.p2 },
      { type: 'p', html: `<strong>${COPY.how}</strong>` },
      {
        type: 'raw',
        html: `<ol style="margin:0 0 20px;padding-left:20px;font-family:${BODY_FONT};font-size:16px;line-height:24px;color:#000000;">\n${li(COPY.s1)}\n${li(COPY.s2)}\n${li(COPY.s3, true)}\n</ol>`,
      },
      { type: 'cta', text: COPY.button, href: SHOP_URL },
      {
        type: 'raw',
        html: `<p style="margin:0 0 20px;text-align:center;font-family:${BODY_FONT};font-size:16px;line-height:24px;"><a href="${ADD_URL}" style="color:#000000;font-weight:600;text-decoration:underline;">${COPY.add}</a></p>`,
      },
      { type: 'p', html: COPY.packs },
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
  return html.replace(before, 'Unsubscribe here, no hard feelings.');
}

export function checkHtml(html) {
  const problems = [];
  if (/[–—]/.test(html)) problems.push('em/en dash present');
  if (!html.includes('href="{% unsubscribe_link %}"')) problems.push('unsubscribe_link missing');
  const u = unsubscribeFindings(html);
  if (u.length) problems.push(`unsubscribe findings ${JSON.stringify(u)}`);
  // Klaviyo's renderer writes the & as &amp;, which is the same link in every client.
  if (!html.includes(`href="${ADD_URL}"`) && !html.includes(`href="${ADD_URL.replace(/&/g, '&amp;')}"`)) problems.push('add-bars link missing');
  if (!html.includes(`href="${SHOP_URL}"`)) problems.push('shop CTA missing');
  return problems;
}

/** The copy quotes two prices; refuse if the storefront no longer charges them. */
async function assertPricesLive() {
  for (const [handle, [title, want]] of Object.entries(PACKS)) {
    const p = await (await fetch(`${SITE}/products/${handle}.js`)).json();
    const v = p.variants.find((x) => x.title === title);
    const got = v ? (v.price / 100).toFixed(2) : null;
    if (got !== want) throw new Error(`${handle} ${title} is $${got}, copy says $${want}`);
  }
}

async function run() {
  const APPLY = process.argv.includes('--apply');
  const gate = checkSeoCopyFields({ subject: SUBJECT, preview: PREVIEW, ...COPY });
  console.log(`gate: ok=${gate.ok} blocking=${gate.blocking.length} advisory=${gate.advisory.length}`);
  if (!gate.ok) throw new Error(`gate blocked: ${JSON.stringify(gate.blocking)}`);
  await assertPricesLive();
  console.log('prices: 4-pack $29 and 12-pack $60 confirmed live');
  const html = buildHtml();
  const problems = checkHtml(html);
  if (problems.length) throw new Error(problems.join('; '));
  if (process.env.CAMPAIGN_HTML_OUT) writeFileSync(process.env.CAMPAIGN_HTML_OUT, html);
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
                label: 'Free Pure Unscented bars',
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
  const back = await klaviyoRequest('GET', `/campaigns/${campaignId}/`);
  console.log(`created DRAFT campaign ${campaignId} (status ${back.data.attributes.status}), message ${messageId}, template ${tpl.id}`);
}

if (isDirectRun(import.meta.url)) run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
