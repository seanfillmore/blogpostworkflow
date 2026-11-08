#!/usr/bin/env node
/**
 * The three soap / holiday campaigns as DESIGNED emails (Sean, 2026-11-08: "Lets design
 * these emails instead of sending out the text heavy versions"). Layout: lib/email-campaign.js.
 *
 *   node scripts/klaviyo-designed-campaigns.mjs                 # dry run: gate, prices, render
 *   CAMPAIGN_HTML_DIR=/tmp/x node scripts/klaviyo-designed-campaigns.mjs   # also write the HTML
 *   node scripts/klaviyo-designed-campaigns.mjs --apply         # put each design on its campaign
 *
 * --apply never creates, schedules or sends anything. It creates a library template and
 * assigns it to the EXISTING campaign's message (Klaviyo snapshots it), then reads the
 * campaign back and reports status and send time, so a scheduled send keeps its slot.
 * Supersedes the text-heavy bodies from klaviyo-create-unscented-bars-campaign.mjs and
 * klaviyo-create-holiday-campaigns.mjs (those scripts made the campaigns; this one
 * replaces their content).
 *
 * Every price shown is read from Shopify (Admin API) at run time; a mismatch refuses.
 */
import { writeFileSync } from 'node:fs';
import { renderCampaign, campaignCopy } from '../lib/email-campaign.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { unsubscribeFindings } from '../lib/email-rebuild-checks.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const SITE = 'https://www.realskincare.com';
const CDN = 'https://cdn.shopify.com/s/files/1/0270/1911/6579/files';
const img = (f) => `${CDN}/${f}?width=600&format=jpg`;
const pdp = (h, v) => `${SITE}/products/${h}${v ? `?variant=${v}` : ''}`;
const SHOP = `${SITE}/collections/all-products`;
const ADD = (n) => `${SITE}/cart/add?id=45828179951786&quantity=${n}`;

export const CAMPAIGNS = {
  soap: {
    id: '01M6MWD0680VGK3WJK7R1VW3Z1',
    subject: '2 free bars of soap with your next order',
    preheader: 'Spend $60 and two Pure Unscented bars are on us.',
    prices: [['coconut-bar-soap-4-pack', '4x Pure Unscented', '29.00'], ['coconut-bar-soap-12-pack', '12x Pure Unscented', '60.00']],
    sections: [
      { type: 'hero', src: `${CDN}/email-hero-soap.jpg`, href: SHOP, alt: 'Three Pure Unscented coconut bar soaps on a bathroom vanity' },
      { type: 'band', kicker: 'A little extra in your order', heading: '2 free bars of soap, on us',
        text: 'Every $60+ order gets two Pure Unscented bars free. Our coconut oil hand and body soap, with nothing added for scent.',
        cta: { text: 'Shop now', href: SHOP } },
      { type: 'steps', heading: 'How it works', items: [
        { title: 'Shop', text: 'Fill your cart to $60. The free bars do not count toward it.' },
        { title: 'Add 2 bars', text: 'Pure Unscented, from the soap page or the link below.' },
        { title: 'Pay $0 for them', text: 'They ring up free at checkout. One gift per order.' }] },
      { type: 'link', text: 'Already at $60? Add my 2 free bars', href: ADD(2) },
      { type: 'products', heading: 'Stocking up for yourself?', items: [
        { img: img('coconut-bar-soap-4-pack-hero-4x-pure-unscented_04fc3d20-43ed-4d3c-8b86-a8e14fa617f9.jpg'), name: 'Pure Unscented 4-Pack', note: '$7.25 a bar', price: '$29', href: pdp('coconut-bar-soap-4-pack', '48868611588266') },
        { img: img('coconut-bar-soap-12-pack-hero-12x-pure-unscented.jpg'), name: 'Pure Unscented 12-Pack', note: '$5 a bar', price: '$60', href: pdp('coconut-bar-soap-12-pack', '49135322988714') }] },
      { type: 'signoff', ps: 'Free shipping starts at $45, so a $60 order ships free too.' },
    ],
  },
  bf: {
    id: '01M6WMCXT9Y8AA08Z5A1EGWGW4',
    subject: '3 free bars of soap with any order, starting today',
    preheader: 'No minimum. Add anything, add three bars, and they are on us.',
    prices: [['coconut-lotion', null, '30.00'], ['coconut-moisturizer', null, '28.00'], ['coconut-oil-deodorant', null, '15.00'], ['coconut-oil-toothpaste', null, '13.00']],
    sections: [
      { type: 'hero', src: `${CDN}/email-hero-bf.jpg`, href: SHOP, alt: 'Pure Unscented coconut bar soaps stacked on a bathroom vanity' },
      { type: 'band', kicker: 'Black Friday', heading: '3 free bars of soap with any order',
        text: 'Starting today there is no minimum. Add anything from the store, add three Pure Unscented bars, and they ring up at $0.',
        cta: { text: 'Shop now', href: SHOP } },
      { type: 'steps', heading: 'How it works', items: [
        { title: 'Add anything', text: 'Any product, any size.' },
        { title: 'Add 3 bars', text: 'Pure Unscented hand and body soap.' },
        { title: 'Pay $0 for them', text: 'One gift per order, while supplies last.' }] },
      { type: 'link', text: 'Something in your cart already? Add my 3 free bars', href: ADD(3) },
      { type: 'products', heading: 'Pick anything', items: [
        { img: img('real_skin_care_body_lotion_coconut_breeze_0695fe28-c662-4efd-9abe-ddb8146b34fd.webp'), name: 'Body Lotion', price: '$30', href: pdp('coconut-lotion') },
        { img: img('real_skin_care_body_cream_coconut.jpg'), name: 'Body Cream', price: '$28', href: pdp('coconut-moisturizer') },
        { img: img('real_skin_care_deodorant_geranium_flower.jpg'), name: 'Deodorant', price: '$15', href: pdp('coconut-oil-deodorant') },
        { img: img('real_skin_care_toothpaste_mint.jpg'), name: 'Toothpaste', price: '$13', href: pdp('coconut-oil-toothpaste') }] },
      { type: 'signoff', ps: 'Free shipping starts at $45. Sending gifts? Order by Thursday, Dec 10 for delivery by Christmas.' },
    ],
  },
  holiday: {
    id: '01M6WMD1N911C7Y4PHDY8QJNHC',
    subject: 'Order by Thursday for Christmas delivery',
    preheader: 'Our holiday order-by date is Thursday, Dec 10.',
    prices: [['coconut-oil-lip-balm', null, '15.00'], ['coconut-soap', null, '11.00'], ['sensitive-skin-starter-set', null, '46.80'], ['clean-swap', null, '59.00']],
    sections: [
      { type: 'band', tone: 'dark', kicker: 'Two days left', heading: 'Order by Thursday, Dec 10 for Christmas delivery',
        text: 'Easy gifts below, and every order still comes with 3 Pure Unscented bars free.',
        cta: { text: 'Shop gifts', href: SHOP } },
      { type: 'products', heading: 'Easy gifts', items: [
        { img: img('real_skin_care_lip_balm_vanilla_dream.jpg'), name: 'Lip Balm', note: 'Small enough for any stocking', price: '$15', href: pdp('coconut-oil-lip-balm') },
        { img: img('real_skin_care_bar_soap_unscented.jpg'), name: 'Coconut Bar Soap', note: 'Four scents', price: '$11', href: pdp('coconut-soap') },
        { img: img('lotion-beach-real_6cc8ec81-f25d-453e-883f-d75a5941236b.jpg'), name: 'Sensitive Skin Set', note: 'Body lotion and body cream', price: '$46.80', href: pdp('sensitive-skin-starter-set') },
        { img: img('clean-swap-gentle-hero.jpg'), name: 'The Clean Swap', note: 'Everyday basics, switched', price: '$59', href: pdp('clean-swap') }] },
      { type: 'text', html: 'Add 3 Pure Unscented bars to any order and they ring up at $0.' },
      { type: 'link', text: 'Add my 3 free bars', href: ADD(3) },
      { type: 'signoff', ps: 'Free shipping starts at $45.' },
    ],
  },
};

export function checkHtml(c, html) {
  const problems = [];
  if (/[–—]/.test(html)) problems.push('em/en dash present');
  if (!html.includes('href="{% unsubscribe_link %}"')) problems.push('unsubscribe_link missing');
  const u = unsubscribeFindings(html);
  if (u.length) problems.push(`unsubscribe findings ${JSON.stringify(u)}`);
  for (const s of c.sections) for (const href of [s.href, s.cta?.href, ...(s.items ?? []).map((i) => i.href)].filter(Boolean)) {
    if (!html.includes(`href="${href}"`) && !html.includes(`href="${href.replace(/&/g, '&amp;')}"`)) problems.push(`link missing: ${href}`);
  }
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
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const k = APPLY ? await import('../lib/klaviyo.js') : null;
  for (const [key, c] of Object.entries(CAMPAIGNS)) {
    if (only && key !== only) continue;
    const gate = checkSeoCopyFields(campaignCopy(c));
    if (!gate.ok) throw new Error(`${key}: gate blocked ${JSON.stringify(gate.blocking)}`);
    await assertPrices(c.prices);
    const html = renderCampaign(c);
    const problems = checkHtml(c, html);
    if (problems.length) throw new Error(`${key}: ${problems.join('; ')}`);
    if (process.env.CAMPAIGN_HTML_DIR) writeFileSync(`${process.env.CAMPAIGN_HTML_DIR}/${key}.html`, html);
    console.log(`${key}: gate ok, ${c.prices.length} prices live, html ${html.length} chars`);
    if (!APPLY) continue;

    const camp = await k.klaviyoRequest('GET', `/campaigns/${c.id}/?include=campaign-messages`);
    const a = camp.data.attributes;
    if (a.status === 'Sent' || a.status === 'Sending') throw new Error(`${key}: campaign is ${a.status}; not touched`);
    const messageId = camp.data.relationships['campaign-messages'].data[0].id;
    const tpl = await k.createTemplate({ name: `Campaign (designed): ${a.name}`, html });
    const rendered = await k.renderTemplate(tpl.id, { first_name: 'Test' });
    if (checkHtml(c, rendered.html).filter((p) => !p.startsWith('unsubscribe_link')).length) throw new Error(`${key}: rendered template failed checks`);
    await k.assignTemplateToCampaignMessage(messageId, tpl.id);
    // Subject/preview edits do not apply to a SCHEDULED campaign; set them on drafts only.
    if (a.status === 'Draft') await k.updateCampaignMessageContent(messageId, { subject: c.subject, preview: c.preheader });
    const back = (await k.klaviyoRequest('GET', `/campaigns/${c.id}/`)).data.attributes;
    console.log(`  ${key}: design applied to ${c.id} · status ${back.status} · send ${back.send_strategy?.datetime ?? 'none'} (was ${a.status} · ${a.send_strategy?.datetime ?? 'none'})`);
  }
  if (!APPLY) console.log('DRY RUN. --apply to put the designs on the campaigns.');
}

if (isDirectRun(import.meta.url)) run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
