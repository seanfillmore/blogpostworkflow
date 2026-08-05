/**
 * Reset lander content.
 *
 *   node scripts/update-reset-lander-content.mjs --definitions [--apply]
 *   node scripts/update-reset-lander-content.mjs --content     [--apply]
 *
 * Definitions are inert: sections self-suppress until content exists, so this
 * can ship ahead of the copy without touching any live page.
 */
import { shopifyGraphQL } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');

// NOTE: `comparison_rows` is deliberately NOT here. It is a PRODUCT metafield
// (`bundle.comparison_rows`), per the schema in docs/bundle-landing-architecture.md,
// created by metafieldsSet in Task 6. Liquid reads product metafields without a
// definition, the same way bundle.value_stack and bundle.lander are read today.
const NEW_FIELDS = [
  { key: 'hook',            name: 'Hook',             type: 'multi_line_text_field' },
  { key: 'ingredient_cards',name: 'Ingredient cards', type: 'json' },
  { key: 'stats',           name: 'Stats',            type: 'json' },
  { key: 'mechanism',       name: 'Mechanism',        type: 'json' },
  { key: 'timeline',        name: 'Timeline',         type: 'json' },
  { key: 'founder_note',    name: 'Founder note',     type: 'multi_line_text_field' },
];

async function definitions() {
  const cur = await shopifyGraphQL(`{
    metaobjectDefinitionByType(type:"bundle_lander"){ id fieldDefinitions { key } } }`);
  const def = cur.metaobjectDefinitionByType;
  if (!def) throw new Error('bundle_lander definition not found');
  const have = new Set(def.fieldDefinitions.map((f) => f.key));
  const missing = NEW_FIELDS.filter((f) => !have.has(f.key));

  if (!missing.length) { console.log('all fields already defined.'); return; }
  console.log('will add:', missing.map((f) => `${f.key} (${f.type})`).join(', '));
  if (!APPLY) { console.log('\ndry run — re-run with --apply.'); return; }

  const res = await shopifyGraphQL(
    `mutation($id:ID!, $ops:[MetaobjectFieldDefinitionOperationInput!]!){
       metaobjectDefinitionUpdate(id:$id, definition:{ fieldDefinitions:$ops }){
         userErrors{ field message } } }`,
    { id: def.id, ops: missing.map((f) => ({ create: { key: f.key, name: f.name, type: f.type } })) },
  );
  const errs = res.metaobjectDefinitionUpdate.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  console.log(`added ${missing.length} field definition(s)`);
}

const METAOBJECT_ID = 'gid://shopify/Metaobject/220166586538'; // 99-coconut-reset-digital
const PRODUCT_ID = 'gid://shopify/Product/8566372303018';

// Hero angle (spec-fixed, binding on Meta ads): you keep running out, and you
// have already spent more than this on lotions that did not work.
// Sources: "runs out faster than they expect" (4), "$15 ceiling" (4),
// "sunk-cost fatigue after spending hundreds" (3).
const CONTENT = {
  hook:
    "You have bought one bottle before. It lasted about a month — right about the time your skin " +
    "started behaving.\nThis is ninety days of both formulas — about $1.34 a day — so you find out what " +
    "your skin does when it never runs out.",

  timeline: JSON.stringify([
    { when: 'Month 1', title: 'Twice a day, every day',
      body: 'Lotion in the morning, cream at night. The first month is about not skipping — dry skin comes back fastest when the routine is occasional.' },
    { when: 'Month 2', title: 'You stop thinking about it',
      body: 'Most people are into their second bottle here — past the point where a single one would have run out.' },
    { when: 'Month 3', title: 'The part you never reach',
      body: 'Third lotion, third jar. Ninety days is long enough to know whether something works, rather than guessing after two weeks.' },
  ]),

  mechanism: JSON.stringify([
    { title: 'Lotion — daily, absorbs fast',
      body: 'Lighter, for everyday use over large areas. "dude as soon as you put it on it just ABSORBS." Answers the "natural oils sit on top like a greasy baked good" objection (5 mentions).' },
    { title: 'Cream — overnight, concentrated',
      body: 'Thicker, for heels, elbows and cracked hands while you sleep. "It may be a tiny 4oz jar but has the power of a big bottle of lotion."' },
  ]),

  ingredient_cards: JSON.stringify([
    { name: 'Organic virgin coconut oil', role: 'Cold-pressed. The base of both formulas.' },
    { name: 'Organic jojoba', role: 'Closest plant oil to skin\'s own sebum.' },
    { name: 'Purified spring water', role: 'What makes the lotion a lotion, not an oil.' },
    { name: 'Plant-based emulsifying wax', role: 'Holds oil and water together. No petroleum.' },
    { name: 'Grapefruit seed extract', role: 'The preservative — instead of parabens or phenoxyethanol.' },
    { name: 'Beeswax', role: 'The barrier that keeps moisture in overnight.' },
  ]),

  stats: JSON.stringify([
    { value: '6', label: 'ingredients you can pronounce' },
    { value: '90', label: 'days of both formulas' },
    // Deliberately NOT a review stat. Judge.me already renders stars and the
    // live count at the top of the page; restating it here created a second
    // source that immediately drifted (ours said 135, Judge.me said 131).
    { value: '30', label: 'day money-back guarantee' },
    { value: '$1.34', label: 'per day' },
  ]),

  founder_note:
    "I made this because my own family kept running out. One bottle is what everybody buys first, " +
    "and it ends before you know whether it worked.\nThree of each is what ninety days " +
    "actually takes. Nothing else changed — same six ingredients, same batch sizes.",

  // No number here either. Judge.me owns the count; this caption only labels
  // the stars the hero already draws.
  rating_caption: 'Verified buyer reviews',
};

// Objection: "CeraVe, Vanicream, Cetaphil are the default recommendation
// for sensitive and eczema skin" — 6 mentions, the entrenched habit to displace.
const COMPARISON_ROWS = JSON.stringify([
  { attribute: 'Ingredient count', us: '6', them: '20+' },
  { attribute: 'Preservative', us: 'Grapefruit seed', them: 'Parabens / phenoxyethanol' },
  { attribute: 'Fragrance', us: 'Essential oil or none', them: 'Synthetic "fragrance"' },
  { attribute: 'Mineral oil', us: 'None', them: 'Common' },
  { attribute: 'Made in', us: 'USA, small batch', them: 'Contract manufactured' },
]);

const DESCRIPTION = `<p>Ninety days of the two formulas that do the work: three 8oz Body Lotions for
every day, and three 4oz Body Creams for overnight. Both are made from the same six ingredients —
organic virgin coconut oil, organic jojoba, purified spring water, plant-based emulsifying wax,
grapefruit seed extract and beeswax.</p>
<p>Most people buy a single bottle, run out in about a month, and never find out what their skin does
with a routine it can rely on. Three of each is what ninety days actually takes. Works out to about
$1.34 a day.</p>
<p>Made for your body, not your face. Includes the 90-Day Routine &amp; Tracker and the Coconut
Skincare Field Guide, emailed within minutes of ordering. 30-day no-questions-asked money-back
guarantee.</p>`;

async function content() {
  const fields = [
    { key: 'hook', value: CONTENT.hook },
    { key: 'timeline', value: CONTENT.timeline },
    { key: 'mechanism', value: CONTENT.mechanism },
    { key: 'ingredient_cards', value: CONTENT.ingredient_cards },
    { key: 'stats', value: CONTENT.stats },
    { key: 'founder_note', value: CONTENT.founder_note },
    { key: 'rating_caption', value: CONTENT.rating_caption },
  ];
  console.log('metaobject fields:', fields.map((f) => f.key).join(', '));
  console.log('product metafield: bundle.comparison_rows');
  console.log('product.descriptionHtml:', DESCRIPTION.length, 'chars');
  if (!APPLY) { console.log('\ndry run — re-run with --apply.'); return; }

  const mo = await shopifyGraphQL(
    `mutation($id:ID!,$f:[MetaobjectFieldInput!]!){
       metaobjectUpdate(id:$id, metaobject:{fields:$f}){ userErrors{ field message } } }`,
    { id: METAOBJECT_ID, f: fields },
  );
  if (mo.metaobjectUpdate.userErrors.length) throw new Error(JSON.stringify(mo.metaobjectUpdate.userErrors));

  const mf = await shopifyGraphQL(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
    { m: [{ ownerId: PRODUCT_ID, namespace: 'bundle', key: 'comparison_rows', type: 'json', value: COMPARISON_ROWS }] },
  );
  if (mf.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(mf.metafieldsSet.userErrors));

  const pr = await shopifyGraphQL(
    `mutation($p:ProductUpdateInput!){ productUpdate(product:$p){ userErrors{ field message } } }`,
    { p: { id: PRODUCT_ID, descriptionHtml: DESCRIPTION } },
  );
  if (pr.productUpdate.userErrors.length) throw new Error(JSON.stringify(pr.productUpdate.userErrors));

  console.log('content written.');
}

async function main() {
  if (process.argv.includes('--definitions')) return definitions();
  if (process.argv.includes('--content')) return content();
  console.error('specify --definitions or --content');
  process.exit(1);
}

await main();
