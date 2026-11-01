#!/usr/bin/env node
/**
 * Draft the two October 2026 campaigns from the approved content schedule
 * (Sean, 2026-10-06: "Yes"). Creates them as DRAFTS in Klaviyo for review:
 * nothing is scheduled or sent.
 *
 *   node scripts/flows/draft-october-campaigns-2026-10.mjs           # dry: prints copy, gates it
 *   node scripts/flows/draft-october-campaigns-2026-10.mjs --apply   # creates the drafts
 *
 * Facts used, each checked against the repo on 2026-10-06:
 *   - cream base = 7 ingredients (config/ingredients.json `cream`); it holds NO
 *     jojoba, so the email never says it does.
 *   - cream 5-pack $112 = buy 4, get 1 free (config/bundles.json, live).
 *   - "a jar lasts about a month of nightly use" (live cream PDP copy).
 *   - bar soap base = saponified organic virgin coconut oil, no sulfates.
 *   - 30-day refund, nothing to send back (live trust line).
 * Audience: the core Email List (S6hKFq). Send times are 9:00 AM Pacific.
 */
import { isDirectRun } from '../../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import { shell, H1, P_, SIGN, button, FREESHIP_NOTE } from './components.js';

const CORE_LIST = 'S6hKFq';
const CREAM = 'https://www.realskincare.com/products/coconut-moisturizer';
const SOAP = 'https://www.realskincare.com/products/coconut-soap';
const GUARANTEE = 'Every order comes with our 30-day refund. If it is not for you, email us and we will refund you. You do not have to send it back.';

export const CAMPAIGNS = [
  {
    name: '2026-10-14 Cream: thick on purpose + 5-pack',
    sendAt: '2026-10-14T09:00:00-07:00',
    subject: 'Why our cream is thick on purpose',
    preview: 'Seven ingredients, and a new way to stock up.',
    paragraphs: [
      'Hi {{ first_name|default:"there" }},',
      'Our Coconut Moisturizer has seven ingredients, all on the jar: spring water, organic virgin coconut oil, organic beeswax, unrefined red palm oil, and three that make it a cream and keep it fresh (a plant-based emulsifying wax, palm stearic and grapefruit seed extract).',
      'It is thick on purpose. A little goes a long way on hands, knees, elbows and feet, and one jar lasts about a month of nightly use.',
      'New this month: buy 4, get 1 free. Five jars for $112, which works out to $22.40 a jar.',
    ],
    cta: [CREAM, 'Get 5 for the price of 4'],
    after: [GUARANTEE],
  },
  {
    name: '2026-10-28 Dry-skin season routine',
    sendAt: '2026-10-28T09:00:00-07:00',
    subject: 'Dry-skin season starts this week',
    preview: 'Two small changes for the cold months.',
    paragraphs: [
      'Hi {{ first_name|default:"there" }},',
      'The heat comes on, the air gets dry, and most of us feel it on our hands first. Two small changes get most people through winter:',
      '<strong>1. Wash with real soap.</strong> Our bar soap has one ingredient in its base: organic coconut oil, turned into soap. No sulfates, no foam boosters.',
      '<strong>2. Cream before bed.</strong> Hands, elbows, knees and heels, right after washing while the skin is still a little damp. It is thick, so a small amount is enough.',
      'That is the whole routine.',
    ],
    cta: [CREAM, 'Shop the cream'],
    secondCta: [SOAP, 'Shop the bar soap'],
    after: [],
  },
];

export function html(c) {
  return shell(
    c.preview,
    H1(c.subject) + c.paragraphs.map(P_).join('') + button(...c.cta) + (c.secondCta ? button(...c.secondCta) : '') +
      c.after.map(P_).join('') + FREESHIP_NOTE + SIGN,
  );
}

/** Pure: no em dashes, no subscription offer, and the commercial claim gate passes. */
export function checkCopy(c) {
  const text = [c.subject, c.preview, ...c.paragraphs, ...c.after, c.cta[1], c.secondCta?.[1] ?? ''].join(' ');
  if (/—/.test(text)) throw new Error(`${c.name}: em dash`);
  if (/subscri/i.test(text)) throw new Error(`${c.name}: mentions subscriptions`);
  if (/jojoba/i.test(text)) throw new Error(`${c.name}: the cream has no jojoba`);
  const gate = checkSeoCopyFields({ subject: c.subject, body: text });
  if (!gate.ok) throw new Error(`${c.name}: claim gate ${JSON.stringify(gate.blocking)}`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  for (const c of CAMPAIGNS) checkCopy(c);
  const k = (await import('../../lib/klaviyo.js')).default;
  for (const c of CAMPAIGNS) {
    console.log(`\n== ${c.name}\nSubject: ${c.subject}\nPreview: ${c.preview}\n${c.paragraphs.join('\n')}\n[${c.cta[1]}]${c.secondCta ? ` [${c.secondCta[1]}]` : ''}\n${c.after.join('\n')}`);
    if (!apply) continue;
    const tpl = await k.createTemplate({ name: `Campaign: ${c.name}`, html: html(c) });
    const camp = await k.createCampaign({
      name: c.name, audienceId: CORE_LIST, sendAt: c.sendAt, subject: c.subject, preview: c.preview,
      fromEmail: 'support@realskincare.com', fromLabel: 'Real Skin Care',
    });
    await k.assignTemplateToCampaignMessage(camp.messageIds[0], tpl.id);
    const back = await k.getCampaign(camp.id);
    console.log(`created DRAFT campaign ${camp.id} (status ${back.status}), template ${tpl.id}`);
  }
  if (!apply) console.log('\nDry run. Re-run with --apply to create the drafts.');
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
