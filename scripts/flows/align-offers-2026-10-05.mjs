#!/usr/bin/env node
/**
 * Make the live flow emails say what the business now offers (2026-10-05).
 *
 *   node scripts/flows/align-offers-2026-10-05.mjs           # dry: counts every span, writes nothing
 *   node scripts/flows/align-offers-2026-10-05.mjs --apply   # creates WELCOME30, repoints 5 emails
 *
 * Sean, 2026-10-05: the 30% popup "is converting well" so it stays the welcome
 * offer; RSC sells multi-unit packs, not subscriptions.
 *
 * 1. WELCOME30. The popup hands out unique Welcome_30 codes from a legacy coupon
 *    Klaviyo's v3 API does not expose, and a coupon tag cannot be test-rendered,
 *    so an email cannot be shown to regenerate one reliably. A blank code in a
 *    welcome email is the worst outcome, so the emails carry a static code:
 *    30%, once per customer, restricted to Shopify's "Customers who haven't
 *    purchased" segment so an existing customer cannot use it.
 * 2. Welcome 1 + 5 called SHIPFREE "your welcome code" under a popup promising 30%.
 * 3. Winback 3 called 25% "the biggest discount we offer"; the welcome offer is 30%.
 * 4. Replenishment 1 + 2 sold Subscribe & Save. They now sell the packs.
 *
 * Mechanics (lib/klaviyo.js): a flow-owned template cannot be edited in place,
 * so each email gets a NEW template built from its live HTML plus exact span
 * replacements, then the flow action is repointed at it. Every span must occur
 * the stated number of times in the LIVE html or the run aborts before any
 * write. Live html and the previous template id are backed up first.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import k from '../../lib/klaviyo.js';
import { getAccessToken } from '../../lib/shopify.js';
import { API_VERSION } from '../../lib/shopify-api-version.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NEVER_PURCHASED_SEGMENT = 'gid://shopify/Segment/365228064938'; // number_of_orders = 0

const PACK_BOX = [
  ['15% off every refill, either way', 'Stock up and save', 1],
  ['Every 6 weeks', 'Body cream', 1],
  ['Most people', 'Buy 4, get 1 free', 1],
  ['Every 8 weeks', 'Bar soap', 1],
  ['If it lasts you longer', 'Buy 8, get 4 free', 1],
  ['Reorder or set up a refill', 'Reorder or stock up', 7],
];

export const PLAN = [
  {
    name: 'Welcome 1', action: '115998382', message: 'WRFgzM',
    subject: ['Welcome to Real Skin Care — free shipping inside 🌿', 'Welcome to Real Skin Care: 30% off inside 🌿'],
    edits: [
      ['Your shipping is covered.', 'Your 30% code is inside.', 1],
      ['Free shipping on your first order', '30% off your first order', 1],
      ['SHIPFREE', 'WELCOME30', 1],
      ['Use it at checkout. Orders over $45 ship free anyway.', 'Use it at checkout on your first order. Orders over $45 also ship free.', 1],
    ],
  },
  {
    name: 'Welcome 5', action: '115998390', message: 'XWsR8f',
    subject: ['Your free shipping is still waiting', 'Your 30% off is still waiting'],
    edits: [
      ['SHIPFREE is still good — this is the last time I mention it.', 'WELCOME30 is still good. This is the last time I mention it.', 1],
      ['Free shipping on your first order', '30% off your first order', 1],
      ['SHIPFREE', 'WELCOME30', 1],
    ],
  },
  {
    name: 'Winback 3', action: '112416908', message: 'QQ7YMn',
    edits: [
      ['25% off everything — the biggest discount we offer, and this is the last email in the series.', '25% off everything, and this is the last email in the series.', 1],
      ['This is the biggest discount we offer, and the last email in this series.', 'This is the last email in this series.', 1],
      ["WINBACK25 is the best code we hand out, and this is the last time we'll send it.", "This is the last time we'll send WINBACK25.", 1],
    ],
  },
  {
    name: 'Replenishment 1', action: '112464442', message: 'Wk6QRC',
    edits: [
      ['Subscribe &amp; Save is 15% off every refill — the cadence only changes how often it turns up, not the price. Skip, pause, swap scent or cancel any time from your account; it is not a contract and you do not have to call anyone.',
        'Stocking up is the cheapest way to buy. Most of our products come in packs right on the product page, and the bigger the pack, the less each one costs.', 1],
      ...PACK_BOX,
      ['If six weeks is too fast for how you actually use it, pick eight — same discount either way. Running a subscription you keep skipping is worse than not having one.',
        'Not sure about a whole pack? Every order comes with our 30-day refund, and you do not have to send anything back.', 1],
    ],
  },
  {
    name: 'Replenishment 2', action: '112464444', message: 'RvcYBq',
    edits: [
      ['Two options. Reorder when you notice, or put it on Subscribe &amp; Save at 15% off — pick the interval that matches how fast you actually get through it. Skip, pause, swap or cancel any time from your account.',
        'Reorder when you notice, or stock up so you notice less often. The packs on each product page cost less per item, and the cream and bar soap packs include free ones.', 1],
      ...PACK_BOX,
    ],
  },
];

const count = (s, sub) => s.split(sub).length - 1;

/** Pure: apply one email's edits in order. Already-applied spans are skipped; anything else unexpected throws. */
export function applyEdits(html, edits) {
  let out = html;
  const notes = [];
  for (const [before, after, n] of edits) {
    const b = count(out, before);
    if (b === n) { out = out.split(before).join(after); notes.push(`replaced x${n}: ${before.slice(0, 48)}`); continue; }
    if (b === 0 && count(out, after) >= n) { notes.push(`already: ${after.slice(0, 48)}`); continue; }
    throw new Error(`span found ${b} times (expected ${n}): ${before.slice(0, 80)}`);
  }
  return { html: out, notes, changed: out !== html };
}

/** Pure: copy rules for the new text. */
export function checkNewCopy(plan) {
  for (const e of plan) {
    for (const [, after] of e.edits) if (/—/.test(after)) throw new Error(`${e.name}: new copy has an em dash`);
    if (e.subject && /—/.test(e.subject[1])) throw new Error(`${e.name}: new subject has an em dash`);
    for (const [, after] of e.edits) if (/subscri/i.test(after)) throw new Error(`${e.name}: new copy still mentions subscriptions`);
  }
}

async function ensureWelcome30(apply) {
  const token = await getAccessToken();
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const gql = async (query, variables) => (await (await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
  })).json());
  const existing = await gql('{ codeDiscountNodeByCode(code: "WELCOME30") { id } }');
  if (existing.data?.codeDiscountNodeByCode) return `WELCOME30 exists (${existing.data.codeDiscountNodeByCode.id})`;
  if (!apply) return 'WELCOME30 would be created';
  const r = await gql(`mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } } }`, {
    d: {
      title: 'WELCOME30 (welcome emails, first order only)', code: 'WELCOME30', startsAt: new Date().toISOString(),
      customerSelection: { customerSegments: { add: [NEVER_PURCHASED_SEGMENT] } },
      customerGets: { value: { percentage: 0.30 }, items: { all: true } },
      appliesOncePerCustomer: true,
    },
  });
  const res = r.data?.discountCodeBasicCreate;
  if (!res?.codeDiscountNode) throw new Error(`WELCOME30 create failed: ${JSON.stringify(res?.userErrors ?? r)}`);
  return `WELCOME30 created (${res.codeDiscountNode.id})`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  checkNewCopy(PLAN);
  // Read and transform EVERYTHING before writing anything.
  const work = [];
  for (const e of PLAN) {
    const action = await k.getFlowAction(e.action);
    const msg = action.definition?.data?.message ?? {};
    const tpl = await k.getFlowMessageTemplate(e.message);
    const r = applyEdits(tpl.html, e.edits);
    let subjectState = 'unchanged';
    if (e.subject) {
      if (msg.subject_line === e.subject[0]) subjectState = 'apply';
      else if (msg.subject_line === e.subject[1]) subjectState = 'already';
      else throw new Error(`${e.name}: live subject "${msg.subject_line}" matches neither before nor after`);
    }
    work.push({ e, tpl, msg, r, subjectState });
    console.log(`\n== ${e.name} (action ${e.action}, template ${tpl.id})\n  ${r.notes.join('\n  ')}\n  subject: ${subjectState}`);
  }
  console.log(`\n${await ensureWelcome30(apply)}`);
  if (!apply) { console.log('\nDry run. Re-run with --apply to write.'); return; }

  const dir = join(ROOT, 'data', 'reports', 'klaviyo-flow-edits', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  for (const { e, tpl, msg, r, subjectState } of work) {
    writeFileSync(join(dir, `${e.name.replace(/\W+/g, '-')}.before.html`), tpl.html);
    writeFileSync(join(dir, `${e.name.replace(/\W+/g, '-')}.before.json`), JSON.stringify({ action: e.action, template_id: msg.template_id, flow_template: tpl.id, subject_line: msg.subject_line }, null, 2));
    if (!r.changed && subjectState !== 'apply') { console.log(`${e.name}: nothing to do`); continue; }
    const patch = {};
    if (r.changed) {
      const created = await k.createTemplate({ name: `${e.name} (offer alignment 2026-10-05)`, html: r.html });
      patch.template_id = created.id ?? created.data?.id;
    }
    if (subjectState === 'apply') patch.subject_line = e.subject[1];
    await k.updateFlowActionMessage(e.action, patch);
    const shipped = await k.getFlowMessageTemplate(e.message);
    const verify = applyEdits(shipped.html, e.edits);
    if (verify.changed) throw new Error(`${e.name}: read-back still carries a BEFORE span`);
    console.log(`${e.name}: shipped as flow template ${shipped.id}${patch.subject_line ? ', subject updated' : ''}`);
  }
  console.log(`\nBackups: ${dir}`);
}

if (isDirectRun(import.meta.url)) main().catch((err) => { console.error(err.message); process.exit(1); });
