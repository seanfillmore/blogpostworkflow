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

const INK = '#1a1b18';
const GREEN = '#4a8b3c';
const PAPER = '#ffffff';
const RULE = '#e4e8e0';

/** The gift is contingent on starting a subscription. A frame that shows four
 *  items without saying so misrepresents the $46.80 one-time purchase, so the
 *  word is a build-time requirement rather than a copy preference. */
const HEADLINE = 'Subscribe and your first box adds $26 free.';

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/**
 * Every product is drawn to ONE scale, so the frame is honest about relative size.
 *
 * This is not cosmetic. marketing-ai-product-imagery lists wrong physical scale as
 * a defect to reject an asset over — a buyer who reads a 0.15 oz lip balm as the
 * size of a 3.4 oz soap bar has been misled, and "smaller than expected" is a
 * return driver. The four cutouts come from four different shoots at four
 * different pixel densities, so their native sizes say nothing about each other;
 * the Reset's routine-frame hit the same problem and notes it in its own header.
 *
 * So the sizing basis is the real object, measured as the apparent height of what
 * each cutout actually depicts (the cream jar and the soap bar are both shot at a
 * slight top angle, so their apparent height exceeds their true height).
 */
const PX_PER_CM = 30;
const APPARENT_CM = { lotion: 17.2, cream: 6.4, soap: 8.0, balm: 6.8 };
const scaled = (key) => Math.round(APPARENT_CM[key] * PX_PER_CM);

function item({ src, w, h, cm, name, note, count = 1 }) {
  const targetH = scaled(cm);
  const width = Math.round((w / h) * targetH);
  const img = `<img src="${src}" style="width:${width}px;height:${targetH}px;display:block;
    filter:drop-shadow(0 14px 20px rgba(26,27,24,.16)) drop-shadow(0 2px 3px rgba(26,27,24,.12));">`;
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;">
    <div style="height:${targetH}px;display:flex;align-items:flex-end;gap:${count > 1 ? 14 : 0}px;">
      ${img.repeat(count)}
    </div>
    <div style="font-family:Cabin;font-weight:700;font-size:48px;color:${INK};margin-top:28px;text-align:center;">${name}</div>
    <div style="font-family:Outfit;font-weight:400;font-size:38px;color:${INK};opacity:.6;margin-top:10px;text-align:center;">${note}</div>
  </div>`;
}

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

    const price = Number(ctx.variants.find((v) => v.title === 'Default Title')?.price);
    if (price !== 46.8) {
      throw new Error(`this frame prints $46.80, but the set now sells for ${money(price)}.`);
    }

    if (!/subscrib/i.test(HEADLINE)) {
      throw new Error(
        'the headline no longer names the subscription condition. The gift is contingent — '
        + 'a frame showing four items without it misrepresents the one-time purchase.');
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
          ${item({ src: A('data/brand/cutouts/sensitive-set-lotion.png'), w: 360, h: 1240, cm: 'lotion',
            name: 'Body Lotion', note: '8 fl. oz · 236ml' })}
          ${item({ src: A('data/brand/cutouts/sensitive-set-cream.png'), w: 735, h: 670, cm: 'cream',
            name: 'Body Cream', note: '4 fl. oz · 118ml' })}
        </div>

        <div style="font-family:Outfit;font-weight:600;font-size:46px;letter-spacing:.14em;
                    text-transform:uppercase;color:${INK};opacity:.62;margin-top:44px;">
          The set · ${money(46.8)}
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:30px;width:100%;">
        <div style="flex:1;height:2px;background:${RULE};"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:54px;color:${GREEN};white-space:nowrap;">
          + free when you subscribe
        </div>
        <div style="flex:1;height:2px;background:${RULE};"></div>
      </div>

      <div style="display:flex;align-items:flex-end;justify-content:center;gap:110px;">
        ${item({ src: A('data/brand/cutouts/sensitive-set-lip-balm.png'), w: 368, h: 1680, cm: 'balm', count: 4,
          name: 'Lip Balm 4-Pack', note: money(balm.priceOf('Pure Unscented')) })}
        ${item({ src: A('data/brand/cutouts/sensitive-set-bar-soap.png'), w: 1491, h: 1491, cm: 'soap',
          name: 'Bar Soap', note: money(soap.priceOf('Pure Unscented')) })}
      </div>
    </div>`;
  },
};
