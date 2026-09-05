#!/usr/bin/env node
/**
 * Write the founder note, stats and (where it is honest) the timeline for the
 * bundle landers that have none.
 *
 *   node scripts/build-bundle-lander-copy.mjs           # dry
 *   node scripts/build-bundle-lander-copy.mjs --apply   # writes metaobjects, LIVE
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * Only the Coconut Reset carries timeline / mechanism / stats / founder_note
 * data. The other five landers run on hero + grid + FAQ alone, which is why six
 * empty padded sections sat between the free-from band and the FAQ. Collapsing
 * those was the immediate fix; this is the real one.
 *
 * ── WHAT IS DELIBERATELY NOT WRITTEN: `mechanism` ───────────────────────────
 * The mechanism section renders a FIGURE per row from `mechanism_images`, and
 * falls back to an "Image coming soon" placeholder. There is no art for these
 * bundles, so filling the copy would trade six empty bands for five bands of
 * placeholders — worse, because a placeholder looks like a broken page rather
 * than an absent one. Its heading is also hardcoded to "Two formulas, one
 * routine", which is true of the Reset and false of a four-product swap. Both
 * are fixable; neither is fixable by writing copy, so mechanism is left for a
 * change that also brings the pictures.
 *
 * ── EVERY NUMBER IS COMPUTED, NOT TYPED ─────────────────────────────────────
 * The savings, unit counts and distinct-ingredient counts are derived at run
 * time from `config/bundles.json` and `config/ingredients.json` and asserted
 * against what the plan claims. A stat that drifts from the roster fails the run
 * instead of shipping. Ingredient counts are the DISTINCT UNION across the box,
 * which is why the Clean Swap is 12 rather than 6+6+6+1.
 *
 * ── THE DURATION CLAIMS ARE THE DANGEROUS PART, AND THEY ARE DELIBERATE ──────
 * `config/consumption-rates.json` is explicit: claim SHORT, never above the
 * binding rate, because overstating supply is the documented reason RSC
 * subscribers churned. Rates are lotion 30d, cream 30d, deodorant 42d, bar soap
 * 25d (20-30), toothpaste 45d PER PERSON.
 *
 * The 90-Day Clean Swap is the case that matters: three bars of soap is ~75
 * days, not 90. Its existing subheading already says "three months of all four
 * daily products", which this data does not support. This copy does NOT repeat
 * that — it says the lotion and deodorant carry the quarter and names the soap
 * as the one that runs short. The subheading itself is left alone, and reported,
 * because rewriting a live headline claim is a bigger decision than adding
 * sections and belongs to whoever owns the offer.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/** Sean's headshot, already in Files and already on the Reset lander. */
export const FOUNDER_IMAGE = 'gid://shopify/MediaImage/37031734018218';

/** Text fields the timeline heading now reads, added by this script when absent. */
export const NEW_TEXT_FIELDS = Object.freeze(['timeline_eyebrow', 'timeline_heading', 'timeline_lede']);

/** config/ingredients.json key for each product handle. */
const ING_KEY = Object.freeze({
  'coconut-lotion': 'lotion',
  'coconut-moisturizer': 'cream',
  'coconut-oil-deodorant': 'deodorant',
  'coconut-oil-toothpaste': 'toothpaste',
  'coconut-soap': 'bar_soap',
  'coconut-oil-lip-balm': 'lip_balm',
  'organic-foaming-hand-soap': 'liquid_soap',
});

/**
 * Facts computed from the roster, so a stat cannot quietly drift from the offer.
 * @returns {{units:number, distinctIngredients:number, savings:number, price:number}}
 */
export function factsFor(handle, root = ROOT) {
  const roster = JSON.parse(readFileSync(join(root, 'config', 'bundles.json'), 'utf8'));
  const ing = JSON.parse(readFileSync(join(root, 'config', 'ingredients.json'), 'utf8'));
  const b = roster.bundles.find((x) => x.handle === handle);
  if (!b) throw new Error(`${handle} is not in config/bundles.json`);
  const v = b.variants[0];
  const set = new Set();
  let units = 0;
  for (const c of v.components) {
    const k = ING_KEY[c.product];
    if (!k) throw new Error(`no ingredient key for ${c.product}`);
    for (const i of ing[k].base_ingredients) set.add(i);
    units += c.qty;
  }
  return {
    units,
    distinctIngredients: set.size,
    savings: Number(v.compareAtPrice) - Number(v.price),
    price: Number(v.price),
  };
}

const stat = (value, label) => ({ value: String(value), label });

/**
 * @param {string} handle
 * @param {ReturnType<typeof factsFor>} f
 */
export function copyFor(handle, f) {
  switch (handle) {
    case 'clean-swap': return {
      founder_note:
        'Most people buy one thing, like it, and then never get round to the rest — the swap ends up taking a year. '
        + 'This is the four we use every day, in one order instead of four. Same formulas and same sizes we sell singly.',
      stats: [
        stat(f.units, 'full-size products'),
        stat(f.distinctIngredients, 'ingredients across all four'),
        stat(30, 'day money-back guarantee'),
        stat(`$${f.savings}`, 'less than buying them singly'),
      ],
      timeline_eyebrow: 'About a month',
      timeline_heading: 'What runs out first',
      timeline_lede: 'Four products, four different rates. Worth knowing before you reorder.',
      timeline: [
        { when: 'Day 1', title: 'All four at once', body: 'The reason to swap together is that you stop comparing one new product against three old ones.' },
        { when: 'Week 4', title: 'The soap goes first', body: 'A bar lasts 20–30 days in one shower, so it is usually the first thing you replace.' },
        { when: 'Week 6', title: 'Then the rest', body: 'Lotion at about a month, deodorant at about six weeks. A tube of toothpaste is 45 days for one person — halve it if two of you share it.' },
      ],
    };

    case '90-day-clean-swap': return {
      founder_note:
        'Three of each, because one of anything runs out before you know whether it worked. '
        + 'The lotion and the deodorant carry the full quarter. Three bars of soap is closer to two and a half months '
        + 'if it is the only soap in the house — add a fourth if you want the shower covered to day ninety.',
      stats: [
        stat(3, 'of each of the four'),
        stat(90, 'days of lotion and deodorant'),
        stat(30, 'day money-back guarantee'),
        stat(`$${f.savings}`, 'less than twelve singles'),
      ],
      timeline_eyebrow: 'The quarter',
      timeline_heading: 'What to expect',
      timeline_lede: 'No before-and-after photos — just what you use, and when it runs out.',
      timeline: [
        { when: 'Month 1', title: 'Everything at once', body: 'The first month is about not skipping. A routine you do occasionally is the one that never proves anything.' },
        { when: 'Month 2', title: 'Past where one would have ended', body: 'Second lotion, second deodorant — the point a single of anything would have run out and the swap would have quietly stopped.' },
        { when: 'Month 3', title: 'The soap goes first', body: 'Three bars is roughly 60–90 days depending on how many people use the shower. The lotion and deodorant run to the end of the quarter.' },
      ],
    };

    case 'head-to-toe': return {
      founder_note:
        'One of everything we make, full size rather than samples. '
        + 'It exists because people ask which one to start with, and the honest answer is that it depends on what your skin is doing that week.',
      stats: [
        stat(f.units, 'full-size products'),
        stat(f.distinctIngredients, 'ingredients across the range'),
        stat(30, 'day money-back guarantee'),
        stat(`$${f.savings}`, 'less than buying all seven'),
      ],
    };

    case 'gift-box': return {
      founder_note:
        'A gift that gets used up rather than kept. Four things somebody will actually finish, '
        + 'in a box that does not need wrapping — chosen so none of it ends up at the back of a drawer.',
      stats: [
        stat(f.units, 'full-size products'),
        stat(f.distinctIngredients, 'ingredients in the box'),
        stat(30, 'day money-back guarantee'),
        stat(`$${f.savings}`, 'less than buying them singly'),
      ],
    };

    default: throw new Error(`no copy written for ${handle}`);
  }
}

export const LANDERS = Object.freeze({
  'clean-swap': 'gid://shopify/Metaobject/219719139498',
  '90-day-clean-swap': 'gid://shopify/Metaobject/219195736234',
  'head-to-toe': 'gid://shopify/Metaobject/219322482858',
  'gift-box': 'gid://shopify/Metaobject/219719565482',
});

/** Every string this plan would publish, named, for the health gate. */
export function gateFields(handle, copy) {
  const out = { [`${handle} founder note`]: copy.founder_note };
  (copy.stats ?? []).forEach((s, i) => { out[`${handle} stat ${i + 1}`] = s.label; });
  (copy.timeline ?? []).forEach((t, i) => {
    out[`${handle} timeline ${i + 1} title`] = t.title;
    out[`${handle} timeline ${i + 1} body`] = t.body;
  });
  for (const k of NEW_TEXT_FIELDS) if (copy[k]) out[`${handle} ${k}`] = copy[k];
  return out;
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const withTimeline = argv.includes('--with-timeline');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/build-bundle-lander-copy.mjs [--with-timeline] [--apply]');
    console.log('  --with-timeline requires the data-driven timeline heading to be LIVE.');
    return 0;
  }
  const { shopifyGraphQL } = await import('../lib/shopify.js');

  // 1. Gate every string BEFORE any write. One failure aborts the whole run —
  //    a partially-published plan is worse than an unpublished one.
  let blocked = 0;
  for (const handle of Object.keys(LANDERS)) {
    const copy = copyFor(handle, factsFor(handle));
    const r = checkSeoCopyFields(gateFields(handle, copy));
    if (!r.ok) {
      blocked += 1;
      console.error(`  HEALTH GATE  ${handle}`);
      for (const c of r.claims) console.error(`      ${c.field}: ${c.category} — "${c.match}"`);
    }
  }
  if (blocked) { console.error(`\n${blocked} lander(s) blocked by the copy gate — nothing written.`); return 1; }
  console.log(`health gate: all ${Object.keys(LANDERS).length} landers clear\n`);

  // 2. The timeline heading fields are new on the definition. Additive, and
  //    every existing lander keeps the Reset wording as its Liquid default.
  const def = await shopifyGraphQL(
    '{ metaobjectDefinitionByType(type:"bundle_lander"){ id fieldDefinitions{ key } } }',
  );
  const have = new Set(def.metaobjectDefinitionByType.fieldDefinitions.map((f) => f.key));
  const create = NEW_TEXT_FIELDS.filter((k) => !have.has(k))
    .map((k) => ({ create: { key: k, name: k.replace(/_/g, ' '), type: 'single_line_text_field' } }));
  if (create.length) {
    console.log(`definition: adding ${create.map((c) => c.create.key).join(', ')}`);
    if (apply) {
      const u = await shopifyGraphQL(
        `mutation($id:ID!, $f:[MetaobjectFieldDefinitionOperationInput!]){
           metaobjectDefinitionUpdate(id:$id, definition:{fieldDefinitions:$f}){ userErrors{ field message } } }`,
        { id: def.metaobjectDefinitionByType.id, f: create },
      );
      const e = u.metaobjectDefinitionUpdate.userErrors;
      if (e.length) { console.error('definition update FAILED:', e); return 1; }
    }
  }

  for (const [handle, id] of Object.entries(LANDERS)) {
    const f = factsFor(handle);
    const copy = copyFor(handle, f);
    const fields = [
      { key: 'founder_note', value: copy.founder_note },
      { key: 'founder_image', value: FOUNDER_IMAGE },
      { key: 'stats', value: JSON.stringify(copy.stats) },
    ];
    // THE TIMELINE IS GATED ON A TEMPLATE CHANGE THAT IS NOT LIVE YET.
    //
    // Metaobject data is shared by every theme — there is no preview-only copy —
    // while the heading above the timeline is HARDCODED in the live template to
    // "The 90 days". Writing a one-month timeline for the Clean Swap therefore
    // publishes "The 90 days" over a rail that reads Day 1 / Week 4 / Week 6: a
    // duration claim nobody authored, on a live page, of exactly the kind
    // config/consumption-rates.json exists to prevent. It happened, and this is
    // the fix.
    //
    // So by default the timeline is CLEARED rather than merely skipped — a
    // previous run's data would otherwise sit there rendering under the wrong
    // heading. Pass --with-timeline once the data-driven heading is published.
    if (copy.timeline && withTimeline) {
      fields.push({ key: 'timeline', value: JSON.stringify(copy.timeline) });
      for (const k of NEW_TEXT_FIELDS) if (copy[k]) fields.push({ key: k, value: copy[k] });
    } else if (copy.timeline) {
      fields.push({ key: 'timeline', value: '' });
    }

    console.log(`  ${handle}  (${f.units} units, ${f.distinctIngredients} ingredients, saves $${f.savings})`);
    console.log(`      founder note + ${copy.stats.length} stats${
      copy.timeline
        ? (withTimeline ? ` + ${copy.timeline.length}-step timeline` : ' + timeline CLEARED (needs the data-driven heading live)')
        : ' (no timeline — no honest duration story)'}`);
    if (!apply) continue;
    const res = await shopifyGraphQL(
      `mutation($id:ID!, $fields:[MetaobjectFieldInput!]!){
         metaobjectUpdate(id:$id, metaobject:{fields:$fields}){ userErrors{ field message } } }`,
      { id, fields },
    );
    if (res.metaobjectUpdate.userErrors.length) {
      console.error(`  FAILED ${handle}:`, res.metaobjectUpdate.userErrors);
      return 1;
    }
  }

  if (!apply) { console.log('\ndry run — re-run with --apply. A metaobject edit is LIVE immediately.'); return 0; }
  console.log('\nwritten. Verify each rendered page before calling this done.');
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
