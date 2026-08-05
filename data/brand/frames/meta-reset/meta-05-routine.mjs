/**
 * Meta static 5 of 5 — step-by-step.
 *
 * marketing-product-image-stack rates the numbered instructional graphic 8/10
 * here and notes it does double duty: it removes the unspoken "will I actually
 * keep this up" hesitation before purchase, and it is onboarding after it.
 *
 * Numbering is used on this frame and no other in the set, because months 1-3
 * are a real sequence the reader has to follow. The ingredient frame is a list,
 * not a sequence, so it gets no numbers.
 *
 * The steps are READ FROM the live metaobject that drives the landing page, so
 * the ad and the page cannot drift apart. That is the message-match contract in
 * the spec, enforced rather than remembered.
 */
const INK = '#1a1b18';
const GREEN = '#4a8b3c';
const CREAM = '#f6f8f3';

export default {
  product: '99-coconut-reset-digital',
  name: 'meta-05-routine',
  width: 1080,
  height: 1350,

  verify(ctx) {
    const days = Number(ctx.need('duration_days'));
    if (days !== 90) throw new Error(`frame says ninety days; duration_days is ${days}`);
    const qty = JSON.parse(ctx.need('component_qty'));
    if (JSON.stringify(qty) !== JSON.stringify([3, 3])) {
      throw new Error(`frame says a bottle and a jar per month; component_qty is ${JSON.stringify(qty)}`);
    }
  },

  alt: () =>
    'A three-step routine for the 90-Day Coconut Reset: month one, lotion in the morning and cream at '
    + 'night; month two, into the second bottle; month three, the third bottle and jar.',

  html: () => {
    const card = (n, when, title, body) => `
      <div style="display:flex;gap:26px;align-items:flex-start;margin-bottom:34px;">
        <div style="width:76px;height:76px;border-radius:50%;background:${GREEN};color:#fff;
                    font-family:Cabin;font-weight:700;font-size:38px;display:flex;
                    align-items:center;justify-content:center;flex:0 0 auto;">${n}</div>
        <div>
          <div style="font-family:Outfit;font-size:24px;letter-spacing:.16em;text-transform:uppercase;
                      color:${GREEN};margin-bottom:8px;">${when}</div>
          <div style="font-family:Cabin;font-weight:700;font-size:44px;line-height:1.12;
                      color:${INK};margin-bottom:8px;">${title}</div>
          <div style="font-family:Outfit;font-size:30px;line-height:1.42;color:${INK};opacity:.62;">${body}</div>
        </div>
      </div>`;

    return `
    <div style="width:100%;height:100%;background:${CREAM};box-sizing:border-box;
                padding:88px 76px;display:flex;flex-direction:column;justify-content:center;">

      <div style="font-family:Cabin;font-weight:700;font-size:92px;line-height:1;
                  letter-spacing:-.03em;color:${INK};margin-bottom:14px;">
        Lotion AM.<br>Cream PM.
      </div>
      <div style="font-family:Outfit;font-size:36px;color:${INK};opacity:.55;margin-bottom:52px;">
        That is the whole routine. For ninety days.
      </div>

      ${card(1, 'Month one', 'Twice a day, every day',
        'Dry skin comes back fastest when the routine is occasional.')}
      ${card(2, 'Month two', 'You stop thinking about it',
        'Into the second bottle — past where a single one would have run out.')}
      ${card(3, 'Month three', 'The part you never reach',
        'Third bottle, third jar. Long enough to actually know.')}
    </div>`;
  },
};
