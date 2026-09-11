/**
 * Body Lotion — "6 ingredients. That's the whole bottle." Shared builder for the
 * PDP gallery frame and its Amazon twin.
 *
 * Structure borrowed from a supplement ad (count headline, product centred, every
 * ingredient labelled around it, offer badge, guarantee bar) with the argument
 * flipped: theirs sells MORE ingredients, ours sells FEWER. What was deliberately
 * NOT borrowed, each for a reason that would otherwise ship a wrong claim:
 *
 *  - NO AMOUNTS. Milligram doses are a supplement convention; a cosmetic declares
 *    none, and there is no sourced percentage to print.
 *  - NO OUTCOME CLAIM OR RESULTS GUARANTEE. The guarantee bar states the live
 *    refund policy, verified against the rendered page below.
 *  - EVERY INGREDIENT, INCLUDING THE TWO THAT DO NOT PHOTOGRAPH. Leaving purified
 *    spring water or the emulsifying wax off to look "purer" is the false
 *    "no water" claim product-optimizer published on 2026-09-10, drawn instead of
 *    written.
 *  - NO GENERATED INGREDIENT PHOTOGRAPHY. One picture per labelled ingredient is
 *    exactly the image/label pairing that drifted before (jojoba captioned as
 *    coconut oil). Names are type; the only photograph is the real bottle cutout.
 *
 * "SIX" IS TRUE FOR ONE SCENT. Pure Unscented has no essential oils; the scented
 * versions add one to four. This frame hangs at product level, and the
 * landing-page-lotion template (hide_variants: true) shows product-level media for
 * EVERY selected scent — so a shopper looking at Rose Petal sees it too. Hence the
 * kicker names the scent, the bottle IS the Pure Unscented bottle, and a visible
 * line states what the scented versions add, with the range DERIVED from
 * config/ingredients.json rather than typed.
 *
 * LABEL WORDING COMES FROM THE LIVE PAGE, NOT THE CONFIG, WHERE THEY DIFFER. The
 * config calls it "organic plant-based emulsifying wax"; the Ingredients tab a
 * shopper reads says "plant-based emulsifying wax". The frame uses the weaker
 * claim, and verify() fails the build if any label is not on the rendered page.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shopifyGraphQL } from '../../../../lib/shopify.js';
import { checkSeoCopyFields } from '../../../../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../../../../agents/ad-studio/health-claims.js';
import { forbiddenEvenNegated } from '../../../../scripts/pdp-lotion-cream-sections.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LOTION = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8')).lotion;

const BLACK = '#000000';
const GROUND = '#F4F4F2';
const GREEN = '#AEDEAC';

const SCENT = 'Pure Unscented';
const CUTOUT = 'data/brand/cutouts/component-lotion-pure-unscented.png';
const SUBSCRIPTION_PERCENT = 15;

/**
 * The six labels, in the order the live Ingredients tab lists them. Each must
 * appear on the rendered PDP (checked in verify), and the count must equal the
 * config's base list for this scent (also checked), so neither source can drift
 * away from the frame unnoticed.
 */
const LABELS = [
  'Purified spring water',
  'Organic virgin coconut oil',
  'Organic jojoba',
  'Plant-based emulsifying wax',
  'Organic grapefruit seed extract',
  'Organic red palm oil',
];

function scentedRange() {
  const counts = LOTION.variations.map((v) => v.essential_oils.length).filter((n) => n > 0);
  return { min: Math.min(...counts), max: Math.max(...counts) };
}

function copy({ offer }) {
  const { min, max } = scentedRange();
  return {
    kicker: `${SCENT} Body Lotion`,
    headline1: `${LABELS.length} ingredients.`,
    headline2: "That's the whole bottle.",
    footnote: `Scented versions add ${min}–${max} named essential oils, each one listed on the page.`,
    badge: offer ? `Subscribe & save ${SUBSCRIPTION_PERCENT}%` : null,
    guarantee: offer ? "Try it for 30 days. Don't love it? Full refund — no need to send it back." : null,
  };
}

export function ingredientsFrame({ name, offer }) {
  return {
    product: 'coconut-lotion',
    name,
    width: 2048,
    height: 2048,
    reads: [],

    async verify(ctx) {
      const c = copy({ offer });
      const base = LOTION.base_ingredients;
      const pure = LOTION.variations.find((v) => v.shopify_option === SCENT);
      if (!pure) throw new Error(`config/ingredients.json has no "${SCENT}" lotion variation`);
      if (pure.essential_oils.length !== 0) throw new Error(`${SCENT} lists essential oils — the "whole bottle" headline would be false`);
      if (base.length !== LABELS.length) {
        throw new Error(`frame labels ${LABELS.length} ingredients but config/ingredients.json lists ${base.length} — fix the frame, not the headline`);
      }
      if (!ctx.variants.some((v) => v.title === SCENT)) throw new Error(`no "${SCENT}" variant on coconut-lotion`);

      const page = (await ctx.livePage()).toLowerCase();
      for (const label of LABELS) {
        if (!page.includes(label.toLowerCase())) throw new Error(`label "${label}" is not on the live PDP — the frame would disagree with the Ingredients tab`);
      }

      if (offer) {
        if (!/30 days/.test(page) || !/send (it|the product) back/.test(page)) {
          throw new Error('the live PDP no longer states the 30-day no-return refund — the guarantee bar would be stale');
        }
        const r = await shopifyGraphQL(`{ productByIdentifier(identifier:{handle:"coconut-lotion"}) {
          sellingPlanGroups(first:10){nodes{sellingPlans(first:20){nodes{name pricingPolicies{
            ... on SellingPlanFixedPricingPolicy { adjustmentType adjustmentValue {
              ... on SellingPlanPricingPolicyPercentageValue { percentage } } } } }}}} } }`);
        const plans = r.productByIdentifier.sellingPlanGroups.nodes.flatMap((g) => g.sellingPlans.nodes);
        if (!plans.length) throw new Error('coconut-lotion has no selling plans — the subscribe badge would be false');
        for (const p of plans) {
          const pol = p.pricingPolicies[0];
          if (pol?.adjustmentType !== 'PERCENTAGE' || pol.adjustmentValue?.percentage !== SUBSCRIPTION_PERCENT) {
            throw new Error(`selling plan "${p.name}" is not ${SUBSCRIPTION_PERCENT}% off — the badge would be wrong`);
          }
        }
      }

      const text = [c.kicker, c.headline1, c.headline2, c.footnote, c.badge, c.guarantee, ...LABELS].filter(Boolean);
      const gate = checkSeoCopyFields(Object.fromEntries(text.map((t, i) => [`frame text ${i + 1}`, t])));
      if (!gate.ok) throw new Error(`SEO health gate: ${gate.blocking.map((v) => v.match).join(', ')}`);
      const flagged = text.filter((t) => hasHealthClaim(t));
      if (flagged.length) throw new Error(`ad-copy health gate: ${flagged.join(' | ')}`);
      const forbidden = forbiddenEvenNegated();
      const named = text.find((t) => forbidden.some((w) => t.toLowerCase().includes(w)));
      if (named) throw new Error(`names a never-name ingredient: "${named}"`);
    },

    alt() {
      const c = copy({ offer });
      return [
        `${SCENT} body lotion bottle surrounded by its ${LABELS.length} ingredients: ${LABELS.map((l) => l.toLowerCase()).join(', ')}.`,
        c.footnote,
        offer ? `Subscribe and save ${SUBSCRIPTION_PERCENT}%. Try it for 30 days with a full refund, no need to send it back.` : '',
      ].filter(Boolean).join(' ');
    },

    html(ctx) {
      const c = copy({ offer });
      const bottle = ctx.asset(CUTOUT);
      const left = LABELS.slice(0, 3);
      const right = LABELS.slice(3);

      // Sizes are set for a PHONE, not this 2048px canvas: the gallery renders
      // around 390px wide, a 0.19 scale, so anything under ~60px here drops below
      // ~11px on the device. The first render set the footnote at 40px — the one
      // line that keeps "6 ingredients" true for the scented versions was the
      // least readable text in the frame.
      const label = (text, side) => `
        <div style="display:flex;align-items:center;gap:20px;flex-direction:${side === 'left' ? 'row-reverse' : 'row'};">
          <div style="width:20px;height:20px;border-radius:50%;background:${GREEN};border:3px solid ${BLACK};flex:0 0 auto;"></div>
          <div style="width:52px;height:3px;background:${BLACK};opacity:.35;flex:0 0 auto;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:66px;line-height:1.08;color:${BLACK};
                      text-align:${side === 'left' ? 'right' : 'left'};width:700px;text-wrap:balance;">${text}</div>
        </div>`;

      const column = (items, side) => `
        <div style="display:flex;flex-direction:column;justify-content:space-around;height:${offer ? 900 : 1000}px;
                    align-items:${side === 'left' ? 'flex-end' : 'flex-start'};">
          ${items.map((t) => label(t, side)).join('')}
        </div>`;

      // Top-right corner of the FRAME, the one area nothing else occupies. The
      // first render hung it off the bottle's shoulder, where it hid the cap and
      // the first label's connector — a badge may never cover the product.
      const badge = c.badge ? `
        <div style="position:absolute;right:70px;top:60px;width:330px;height:330px;border-radius:50%;
                    background:${GREEN};border:6px solid ${BLACK};display:flex;align-items:center;justify-content:center;
                    text-align:center;transform:rotate(8deg);">
          <div style="font-family:Cabin;font-weight:700;font-size:50px;line-height:1.02;color:${BLACK};">
            Subscribe<br>&amp; save<br><span style="font-size:100px;">${SUBSCRIPTION_PERCENT}%</span>
          </div>
        </div>` : '';

      // text-wrap:balance, because at phone-legible size this line is two lines,
      // and an unbalanced wrap left "back." alone on the second.
      const bar = c.guarantee ? `
        <div style="margin-top:34px;background:${BLACK};border-radius:28px;padding:26px 56px;width:100%;
                    font-family:Outfit;font-weight:600;font-size:60px;line-height:1.18;color:#FFFFFF;text-align:center;
                    text-wrap:balance;">
          ${c.guarantee.replace("Don't", 'Don&#39;t').replace('it? ', 'it?<br>')}
        </div>` : '';

      return `<div style="position:relative;width:100%;height:100%;background:${GROUND};display:flex;flex-direction:column;
                          align-items:center;padding:${offer ? 80 : 120}px 80px ${offer ? 70 : 120}px;">
        ${badge}

        <div style="font-family:Outfit;font-weight:600;font-size:48px;letter-spacing:.24em;text-transform:uppercase;
                    color:${BLACK};opacity:.6;">${c.kicker}</div>

        <div style="font-family:Cabin;font-weight:700;font-size:188px;line-height:1.0;color:${BLACK};
                    letter-spacing:-.02em;margin-top:18px;text-align:center;">${c.headline1}</div>
        <div style="font-family:Cabin;font-weight:700;font-size:112px;line-height:1.05;color:${BLACK};
                    letter-spacing:-.015em;text-align:center;">${c.headline2.replace("That's", 'That&#39;s')}</div>
        <div style="width:200px;height:14px;background:${GREEN};border-radius:7px;margin:34px 0 20px;"></div>

        <div style="display:flex;align-items:center;justify-content:center;gap:36px;flex:1 1 auto;">
          ${column(left, 'left')}
          <img src="${bottle}" style="height:${offer ? 900 : 1040}px;width:auto;filter:drop-shadow(0 30px 40px rgba(0,0,0,.14));">
          ${column(right, 'right')}
        </div>

        <div style="font-family:Outfit;font-weight:600;font-size:54px;line-height:1.2;color:${BLACK};opacity:.75;margin-top:18px;text-align:center;">
          ${c.footnote}
        </div>
        ${bar}
      </div>`;
    },
  };
}
