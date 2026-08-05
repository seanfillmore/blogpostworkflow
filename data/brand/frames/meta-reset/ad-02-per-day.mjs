/**
 * Ad 2 — price, answered rather than dodged.
 *
 * "Hard budget ceiling around $15 for body lotion, skeptical of anything above
 * it" — 4 mentions, data/context/voice-of-customer.md. $121 is eight times that,
 * so the ad re-denominates the number instead of arguing with it.
 *
 * Every figure is derived from live Shopify data. verify() crashes the build if
 * the price moves far enough to make the headline stale.
 */
import { INK, GREEN, MINT, PAPER, LOTION, JAR, pill, shell } from './ad-common.mjs';

const perDay = (ctx) => {
  const price = Number(ctx.variants[0].price);
  const days = Number(ctx.need('duration_days'));
  return Math.round((price / days) * 100) / 100;
};

const stackTotal = (ctx) =>
  JSON.parse(ctx.variants[0].mf?.value_stack || ctx.need('value_stack'))
    .filter((r) => !r.digital)
    .reduce((s, r) => s + Number(r.amount || 0), 0);

export default {
  product: '99-coconut-reset-digital',
  name: 'ad-02-per-day',
  width: 1080,
  height: 1350,

  verify(ctx) {
    const days = Number(ctx.need('duration_days'));
    if (days !== 90) throw new Error(`frame divides by ninety; duration_days is ${days}`);
    const price = Number(ctx.variants[0].price);
    if (!(price > 0)) throw new Error('variant price is missing');
    for (const v of ctx.variants) {
      if (Number(v.price) !== price) throw new Error('variants priced differently; one per-day figure would be wrong');
    }
    const d = perDay(ctx);
    if (d < 1 || d > 2) throw new Error(`per-day figure ${d} is outside the range this layout was set for`);
    const total = stackTotal(ctx);
    if (!(total > price)) throw new Error(`value ${total} must exceed price ${price} for the savings pill`);
  },

  alt: (ctx) =>
    `Real Skin Care Coconut Breeze body lotion and body cream with the words: $${perDay(ctx)} a day. `
    + `$${Math.round(Number(ctx.variants[0].price))} for ninety days of both formulas.`,

  html: (ctx) => {
    const price = Math.round(Number(ctx.variants[0].price));
    const total = stackTotal(ctx);
    return shell({
      bg: MINT,
      disc: 'rgba(255,255,255,.55)',
      headline: `$${perDay(ctx)} a day.`,
      sub: `$${price} for ninety days of lotion and cream. Not $15 a bottle, over and over.`,
      body: `
        <div style="display:flex;align-items:flex-end;justify-content:center;height:100%;">
          <img src="${ctx.asset(LOTION)}" style="height:100%;width:auto;object-fit:contain;display:block;">
          <img src="${ctx.asset(JAR)}" style="height:44%;width:auto;object-fit:contain;display:block;
                                              margin-left:-40px;">
        </div>`,
      footer: `
        <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:26px;">
          ${pill(`$${total} of product`)}${pill('90 days of both')}${pill('30-day guarantee')}
        </div>
        <div style="font-family:Cabin;font-weight:700;font-size:38px;color:${GREEN};">
          The 90-Day Coconut Reset
        </div>`,
    });
  },
};
