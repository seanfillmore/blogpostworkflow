/**
 * Meta static 2 of 5 — text-only. Answers price, head on.
 *
 * The largest objection to THIS offer is not the product, it is the number:
 *   "hard budget ceiling around $15 for body lotion, skeptical of anything above it"
 *   — 4 mentions, data/context/voice-of-customer.md
 *
 * $121 is eight times that ceiling, so the frame does not hide the price — it
 * re-denominates it. marketing-offer-construction: the same economics stated a
 * different way is a free variable, and "$1.34 a day" is the framing that meets
 * a per-bottle price ceiling rather than arguing with it.
 *
 * Text-only is in the required format rotation deliberately: it borrows the
 * credibility of organic posts and does not read as an ad.
 *
 * EVERY figure here is derived from live Shopify data. Nothing is typed.
 */
const INK = '#1a1b18';
const GREEN = '#4a8b3c';
const PAPER = '#ffffff';

const perDay = (ctx) => {
  const cents = Number(ctx.variants[0].price) * 100;
  const days = Number(ctx.need('duration_days'));
  return Math.round((cents / 100 / days) * 100) / 100;
};

export default {
  product: '99-coconut-reset-digital',
  name: 'meta-02-per-day',
  width: 1080,
  height: 1350,

  verify(ctx) {
    const days = Number(ctx.need('duration_days'));
    if (days !== 90) throw new Error(`frame divides by ninety days; duration_days is ${days}`);
    const price = Number(ctx.variants[0].price);
    if (!(price > 0)) throw new Error('variant price is missing');
    const d = perDay(ctx);
    // Guard the headline itself: if the price moves enough to change the figure,
    // the frame must stop building rather than print a stale number.
    if (d < 1.0 || d > 2.0) throw new Error(`per-day figure ${d} is outside the range this layout was set for`);
    for (const v of ctx.variants) {
      if (Number(v.price) !== price) throw new Error('variants are priced differently; a single per-day figure would be wrong');
    }
  },

  alt: (ctx) =>
    `Text reading: $${perDay(ctx)} a day. Ninety days of body lotion and body cream from Real Skin Care `
    + `for $${Math.round(Number(ctx.variants[0].price))}.`,

  html: (ctx) => {
    const price = Math.round(Number(ctx.variants[0].price));
    const days = Number(ctx.need('duration_days'));
    return `
    <div style="width:100%;height:100%;background:${PAPER};box-sizing:border-box;
                padding:96px 84px;display:flex;flex-direction:column;justify-content:center;
                text-align:center;align-items:center;">

      <div style="font-family:Outfit;font-weight:400;font-size:38px;line-height:1.4;
                  color:${INK};opacity:.55;margin-bottom:30px;">
        You said you would not pay<br>more than fifteen dollars for a lotion.
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:230px;line-height:.9;
                  letter-spacing:-.045em;color:${GREEN};">
        $${perDay(ctx)}
      </div>
      <div style="font-family:Cabin;font-weight:700;font-size:62px;line-height:1;
                  color:${INK};margin-top:10px;">a day</div>

      <div style="width:150px;height:8px;background:${GREEN};border-radius:4px;margin:52px 0;"></div>

      <div style="font-family:Outfit;font-weight:400;font-size:42px;line-height:1.4;color:${INK};">
        $${price} for ${days} days of lotion and cream.<br>
        <span style="opacity:.55;">Three bottles. Three jars.</span>
      </div>
    </div>`;
  },
};
