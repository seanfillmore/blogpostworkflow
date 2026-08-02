/**
 * Sensitive Skin Set — frame 6 (grid/multi-SKU): the first-subscription gift.
 *
 * Added to the stack 2026-08-01. The gift is worth $26 at retail on a $46.80
 * order and appears on the PDP exactly once, as the last line inside a collapsed
 * accordion. The only place it was ever stated visually was the old v20.webp —
 * the image whose labels are unreadable. So the gift was, in practice, invisible.
 *
 * ── Why this frame is a composite of real photographs ───────────────────────
 * v20.webp's composition was right all along: the bar soap and the lip balms
 * beside the lotion and cream are the gift, not strays (Sean, 2026-08-01), and
 * `coconut-oil-lip-balm` is itself a four-pack SKU so four tubes is one item.
 * What was wrong was every printed figure on it — "0 fl. oz · 300ml" on a real
 * 8 fl oz / 236ml bottle, "2 Lin · 8.ia" on a 3.4 oz bar, and all four balms
 * reading "moisturizing broom".
 *
 * That damage is in the *product labels*, baked into the plate. render-frame.mjs
 * lays down overlay glyphs, not the printing on a jar, so re-generating the
 * plate would only re-roll the same class of error. Per marketing-ai-product-
 * imagery — prefer a real photo where one exists — every item here is keyed out
 * of real Pure Unscented product photography and never redrawn:
 *
 *   lotion, cream  — the approved Reset cutouts (PR #401), labels already signed off
 *   bar soap       — real_skin_care_bar_soap_unscented_1.jpg, keyed and masked to the bar
 *   lip balm       — real_skin_care_lip_balm_pure_unscented.jpg, exact tube crop
 *
 * Nothing is generated, so no label can drift. Volumes read 8 fl. oz · 236ml,
 * 4 fl. oz · 118ml, 3.4 oz · 84g and 0.15 oz · 4.25g because that is what is
 * printed on the actual products.
 *
 * ── One job ────────────────────────────────────────────────────────────────
 * Per marketing-product-image-stack's one-job-one-persona rule this frame answers
 * only "what does subscribing add?". "What does $46.80 buy" is frame 1's job and
 * is deliberately not merged in — merging them would also blur the contingency
 * the verify() guard below exists to protect.
 */

import { INK, GREEN, PAPER, RULE, money, item, CUTOUT, assertSetIntact, PRICE } from './set-common.mjs';

/**
 * The gift is contingent on starting a subscription. A frame that shows four
 * items without saying so misrepresents the $46.80 one-time purchase, so stating
 * the condition is a build-time requirement rather than a copy preference.
 *
 * Both strings below are checked, not just the headline. The first version of
 * this guard tested only HEADLINE, and against /subscrib/ — which passes
 * "subscribe" and fails "subscription", because the stem is subscrip-. Sean's
 * chosen headline tripped it on the "p", not on anything being wrong. Two
 * lessons kept here: match the stem, and let the condition live anywhere in the
 * frame, since the green rule states it just as plainly as the headline does.
 */
const HEADLINE = 'Free with your first subscription: $26 of extras.';
const CONDITION_RULE = '+ free when you subscribe';
const STATES_CONDITION = /subscri(be|bing|ption|ber)/i;

/** Four products to fit, so a tighter scale than frames 1 and 3. Shared basis. */
const PX_PER_CM = 30;

export default {
  product: 'sensitive-skin-starter-set',
  // The frame states the gift's retail value, and the gift is two other products.
  // Their prices are read live so the figure cannot go stale in the JPEG.
  related: ['coconut-oil-lip-balm', 'coconut-soap'],
  name: 'frame-06-subscription-gift',
  width: 2048,
  height: 2048,

  /**
   * Four independent ways this frame can become a lie, each of which stops the
   * build rather than shipping a confident wrong claim:
   *   1. the gift offer is withdrawn or reworded off the PDP
   *   2. either gift product is repriced, so "$26" is wrong
   *   3. the set is repriced away from $46.80
   *   4. the headline loses the subscription condition
   */
  async verify(ctx) {
    const balm = ctx.related['coconut-oil-lip-balm'];
    const soap = ctx.related['coconut-soap'];

    // The offer is written into the bespoke lander template, not into
    // descriptionHtml or any metafield — checked 2026-08-01, the product's only
    // metafields are judgeme/reviews/bundle rating fields. So it can only be
    // asserted against the rendered page, which is also the surface the buyer reads.
    const page = (await ctx.livePage()).toLowerCase();
    const offerStated = page.includes('subscribe')
      && page.includes('lip balm')
      && (page.includes('bar soap') || page.includes('hand & body soap'));
    if (!offerStated) {
      throw new Error(
        'the live product page no longer states the first-subscription gift (subscribe + lip balm + bar soap). '
        + 'This frame exists only to surface that offer — pull the frame rather than re-rendering it.');
    }

    const gift = balm.priceOf('Pure Unscented') + soap.priceOf('Pure Unscented');
    if (gift !== 26) {
      throw new Error(
        `this frame states a ${money(26)} gift, but Pure Unscented lip balm (${money(balm.priceOf('Pure Unscented'))}) `
        + `+ bar soap (${money(soap.priceOf('Pure Unscented'))}) now totals ${money(gift)}. Re-spec the headline.`);
    }

    // Price, contents, quantities and variant, shared with frames 1 and 3.
    assertSetIntact(ctx);

    if (!STATES_CONDITION.test(HEADLINE) && !STATES_CONDITION.test(CONDITION_RULE)) {
      throw new Error(
        'neither the headline nor the divider names the subscription condition. The gift is '
        + 'contingent — a frame showing four items without it misrepresents the one-time purchase.');
    }
  },

  alt() {
    return 'Sensitive Skin Set — Pure Unscented Body Lotion and Body Cream, shown with the free '
      + 'Pure Unscented Lip Balm four-pack and Unscented Bar Soap that ship with a first subscription order.';
  },

  html(ctx) {
    const balm = ctx.related['coconut-oil-lip-balm'];
    const soap = ctx.related['coconut-soap'];
    const A = (p) => ctx.asset(p);

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:96px 88px 88px;box-sizing:border-box;text-align:center;">

      <div>
        <div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
                    text-transform:uppercase;color:${INK};opacity:.45;">
          Pure Unscented
        </div>

        <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1.06;
                    color:${INK};letter-spacing:-.022em;margin-top:26px;">
          ${HEADLINE}
        </div>
      </div>

      <div>
        <div style="display:flex;align-items:flex-end;justify-content:center;gap:84px;">
          ${item({ src: A(CUTOUT.lotion), cm: 'lotion', pxPerCm: PX_PER_CM,
            name: 'Body Lotion', note: '8 fl. oz · 236ml' })}
          ${item({ src: A(CUTOUT.cream), cm: 'cream', pxPerCm: PX_PER_CM,
            name: 'Body Cream', note: '4 fl. oz · 118ml' })}
        </div>

        <div style="font-family:Outfit;font-weight:600;font-size:46px;letter-spacing:.14em;
                    text-transform:uppercase;color:${INK};opacity:.62;margin-top:44px;">
          The set · ${money(PRICE)}
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:30px;width:100%;">
        <div style="flex:1;height:2px;background:${RULE};"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:54px;color:${GREEN};white-space:nowrap;">
          ${CONDITION_RULE}
        </div>
        <div style="flex:1;height:2px;background:${RULE};"></div>
      </div>

      <div style="display:flex;align-items:flex-end;justify-content:center;gap:110px;">
        ${item({ src: A(CUTOUT.balm), cm: 'balm', count: 4, pxPerCm: PX_PER_CM,
          name: 'Lip Balm 4-Pack', note: money(balm.priceOf('Pure Unscented')) })}
        ${item({ src: A(CUTOUT.soap), cm: 'soap', pxPerCm: PX_PER_CM,
          name: 'Bar Soap', note: money(soap.priceOf('Pure Unscented')) })}
      </div>
    </div>`;
  },
};
