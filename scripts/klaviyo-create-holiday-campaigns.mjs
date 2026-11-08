#!/usr/bin/env node
/**
 * Two holiday campaigns as Klaviyo DRAFTS for Sean to review (2026-11-07). Neither is
 * scheduled or sent here: no send_strategy, no /campaign-send-jobs/ call.
 *
 *   node scripts/klaviyo-create-holiday-campaigns.mjs           # dry run: gate, prices, render
 *   node scripts/klaviyo-create-holiday-campaigns.mjs --apply   # create both drafts (skips any that exist)
 *
 *   bf       Fri 2026-11-27. Sean: "Push the free bars." From that day the standing offer is
 *            3 free Pure Unscented bars with any order (scripts/unscented-bar-push.mjs).
 *   holiday  Tue 2026-12-08. Sean: the holiday order-by date is Thu Dec 10; the email goes
 *            two days ahead of it, not on the day.
 *
 * Every price the copy quotes is read from Shopify (Admin API) at run time and the run
 * refuses on a mismatch, the same rule as the soap announcement email.
 *
 * Audience: Email List S6hKFq + Purchasers UAPGjf, excluding UigAyc. Giveaway entrants
 * deliberately NOT included (Sean, 2026-11-04). Smart Sending on.
 */
import { writeFileSync } from 'node:fs';
import { renderEmail } from '../lib/email-render.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { unsubscribeFindings } from '../lib/email-rebuild-checks.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const SITE = 'https://www.realskincare.com';
const BODY_FONT = "Outfit,'Helvetica Neue',Helvetica,Arial,sans-serif";
export const INCLUDED = ['S6hKFq', 'UAPGjf'];
export const EXCLUDED = ['UigAyc'];
export const ADD3_URL = `${SITE}/cart/add?id=45828179951786&quantity=3`;
export const SHOP_URL = `${SITE}/collections/all-products`;

/** [handle, variant title or null for "every variant", price] */
const SOAP_PRICES = [
  ['coconut-bar-soap-4-pack', '4x Pure Unscented', '29.00'],
  ['coconut-bar-soap-12-pack', '12x Pure Unscented', '60.00'],
];

export const CAMPAIGNS = {
  bf: {
    name: 'Black Friday: 3 free soap bars with any order (send Fri 2026-11-27, DRAFT)',
    label: 'Black Friday free bars',
    subject: '3 free bars of soap with any order, starting today',
    preview: 'No minimum. Add anything, add three bars, and they are on us.',
    prices: SOAP_PRICES,
    copy: {
      heading: 'Free soap with every order',
      p1: 'Hi {{ first_name|default:"there" }}, starting today every order gets 3 Pure Unscented bars free. There is no minimum: add anything from the store, add three bars, and they ring up at $0.',
      p2: 'It is our coconut oil hand and body soap with nothing added for scent, an easy pick if fragrance bothers your skin, and an easy extra for everyone on your list.',
      how: 'How it works:',
      s1: 'Add anything you like to your cart.',
      s2: 'Add 3 Pure Unscented bars, or tap the link below once something is in your cart.',
      s3: 'They ring up at $0 at checkout. One gift per order, while supplies last.',
      button: 'Shop now',
      add: 'Something in your cart already? Add my 3 free bars',
      extra: 'Stocking up? The Pure Unscented 4-pack is $29 and the 12-pack is $60, and the 3 free bars come with those too.',
      ps: 'PS: Free shipping starts at $45, and if you are sending gifts, order by Thursday, Dec 10 for delivery by Christmas.',
    },
  },
  holiday: {
    name: 'Holiday order-by reminder, Dec 10 (send Tue 2026-12-08, DRAFT)',
    label: 'Holiday order-by reminder',
    subject: 'Order by Thursday for Christmas delivery',
    preview: 'Our holiday order-by date is Thursday, Dec 10.',
    prices: [
      ['coconut-oil-lip-balm', null, '15.00'],
      ['coconut-soap', null, '11.00'],
      ['sensitive-skin-starter-set', null, '46.80'],
      ['clean-swap', null, '59.00'],
    ],
    copy: {
      heading: 'Two days left to order for Christmas',
      p1: 'Hi {{ first_name|default:"there" }}, a quick reminder: to have your order arrive by Christmas, place it by Thursday, Dec 10.',
      how: 'A few easy gifts:',
      s1: 'Lip balm, $15. Small enough for any stocking.',
      s2: 'Coconut bar soap, $11 a bar.',
      s3: 'The Sensitive Skin Moisturizing Set, $46.80, for the person who reacts to everything.',
      s4: 'The Clean Swap, $59, for anyone ready to switch their basics.',
      button: 'Shop gifts',
      extra: 'Every order still comes with 3 Pure Unscented bars free. Add them to your cart and they ring up at $0.',
      ps: 'PS: Free shipping starts at $45.',
    },
  },
};

const li = (t, last) => `<li style="margin:0${last ? '' : ' 0 8px'};">${t}</li>`;
const list = (items) => `<ol style="margin:0 0 20px;padding-left:20px;font-family:${BODY_FONT};font-size:16px;line-height:24px;color:#000000;">\n${items.map((t, i) => li(t, i === items.length - 1)).join('\n')}\n</ol>`;
const ps = (t) => `<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid #EDEDED;font-family:${BODY_FONT};font-size:15px;line-height:23px;color:#000000;"><strong>PS:</strong> ${t.replace(/^PS:\s*/, '')}</p>`;

export function buildHtml(key) {
  const c = CAMPAIGNS[key];
  const k = c.copy;
  const steps = [k.s1, k.s2, k.s3, k.s4].filter(Boolean);
  const blocks = [{ type: 'h1', text: k.heading }, { type: 'p', html: k.p1 }];
  if (k.p2) blocks.push({ type: 'p', html: k.p2 });
  blocks.push({ type: 'p', html: `<strong>${k.how}</strong>` }, { type: 'raw', html: list(steps) });
  blocks.push({ type: 'cta', text: k.button, href: SHOP_URL });
  if (k.add) blocks.push({ type: 'raw', html: `<p style="margin:0 0 20px;text-align:center;font-family:${BODY_FONT};font-size:16px;line-height:24px;"><a href="${ADD3_URL}" style="color:#000000;font-weight:600;text-decoration:underline;">${k.add}</a></p>` });
  blocks.push({ type: 'p', html: k.extra }, { type: 'signoff' }, { type: 'raw', html: ps(k.ps) });
  const html = renderEmail({ preheader: c.preview, format: 'plain', blocks });
  const before = 'Unsubscribe here — no hard feelings.';
  if (!html.includes(before)) throw new Error('renderer footer changed; re-check the unsubscribe line');
  return html.replace(before, 'Unsubscribe here, no hard feelings.');
}

export function checkHtml(key, html) {
  const problems = [];
  if (/[–—]/.test(html)) problems.push('em/en dash present');
  if (!html.includes('href="{% unsubscribe_link %}"')) problems.push('unsubscribe_link missing');
  const u = unsubscribeFindings(html);
  if (u.length) problems.push(`unsubscribe findings ${JSON.stringify(u)}`);
  if (!html.includes(`href="${SHOP_URL}"`)) problems.push('shop CTA missing');
  if (CAMPAIGNS[key].copy.add && !html.includes(`href="${ADD3_URL}"`) && !html.includes(`href="${ADD3_URL.replace(/&/g, '&amp;')}"`)) problems.push('add-bars link missing');
  return problems;
}

async function assertPrices(rows) {
  const { shopifyGraphQL } = await import('../lib/shopify.js');
  for (const [handle, title, want] of rows) {
    const d = await shopifyGraphQL(`query($h: String!) { productByHandle(handle: $h) { status variants(first: 50) { nodes { title price } } } }`, { h: handle });
    const p = d.productByHandle;
    if (!p || p.status !== 'ACTIVE') throw new Error(`${handle} is not an active product`);
    const vs = title ? p.variants.nodes.filter((v) => v.title === title) : p.variants.nodes;
    if (!vs.length || vs.some((v) => Number(v.price).toFixed(2) !== want)) throw new Error(`${handle}${title ? ` ${title}` : ''} is not $${want} (${vs.map((v) => v.price).join(', ')})`);
  }
}

async function run() {
  const APPLY = process.argv.includes('--apply');
  const k = APPLY ? await import('../lib/klaviyo.js') : null;
  for (const key of Object.keys(CAMPAIGNS)) {
    const c = CAMPAIGNS[key];
    const gate = checkSeoCopyFields({ subject: c.subject, preview: c.preview, ...c.copy });
    if (!gate.ok) throw new Error(`${key}: gate blocked ${JSON.stringify(gate.blocking)}`);
    await assertPrices(c.prices);
    const html = buildHtml(key);
    const problems = checkHtml(key, html);
    if (problems.length) throw new Error(`${key}: ${problems.join('; ')}`);
    if (process.env.CAMPAIGN_HTML_DIR) writeFileSync(`${process.env.CAMPAIGN_HTML_DIR}/${key}.html`, html);
    console.log(`${key}: gate ok, ${c.prices.length} prices live, html ${html.length} chars`);
    if (!APPLY) continue;

    // Klaviyo allows only `contains` on name; search on the name itself (the label is NOT
    // part of it, which is how the first version created a duplicate draft), match exactly in code.
    const found = await k.klaviyoRequest('GET', `/campaigns/?filter=${encodeURIComponent(`and(equals(messages.channel,"email"),contains(name,"${c.name.slice(0, 40).replace(/"/g, '')}"))`)}`);
    const existing = { data: found.data.filter((x) => x.attributes.name === c.name) };
    if (existing.data.length) { console.log(`  ${key}: draft already exists (${existing.data[0].id}); not recreated`); continue; }
    const tpl = await k.createTemplate({ name: `Campaign: ${c.name}`, html });
    const rendered = await k.renderTemplate(tpl.id, { first_name: 'Test' });
    if (checkHtml(key, rendered.html).filter((p) => !p.startsWith('unsubscribe_link')).length) throw new Error(`${key}: rendered template failed checks`);
    const d = await k.klaviyoRequest('POST', '/campaigns/', { data: { type: 'campaign', attributes: {
      name: c.name, audiences: { included: INCLUDED, excluded: EXCLUDED }, send_options: { use_smart_sending: true },
      'campaign-messages': { data: [{ type: 'campaign-message', attributes: { definition: {
        channel: 'email', label: c.label,
        content: { subject: c.subject, preview_text: c.preview, from_email: 'support@realskincare.com', from_label: 'Real Skin Care', reply_to_email: 'support@realskincare.com' },
      } } }] },
    } } });
    const id = d.data.id;
    await k.assignTemplateToCampaignMessage(d.data.relationships['campaign-messages'].data[0].id, tpl.id);
    const back = (await k.klaviyoRequest('GET', `/campaigns/${id}/`)).data.attributes.status;
    console.log(`  ${key}: created DRAFT ${id} (status ${back}), template ${tpl.id}`);
  }
  if (!APPLY) console.log('DRY RUN. --apply to create the drafts.');
}

if (isDirectRun(import.meta.url)) run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
