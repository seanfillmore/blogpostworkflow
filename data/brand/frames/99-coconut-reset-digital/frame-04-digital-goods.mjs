/**
 * 90-Day Coconut Reset — frame 4 (benefit callout).
 *
 * Media plan §6: "Make $34 of digital goods visible and specific." The value
 * stack totals $220, of which $34 is two PDFs. A PDF is invisible in a
 * photograph, so the page asserts value the eye cannot find — the exact shape of
 * a trust leak. The failure mode is a stock document icon or a floating PDF
 * badge, which reads as padding and actively devalues the $121.
 *
 * The plan's three rules for this frame, and how each is met:
 *
 * 1. "Show the actual page content, not the container. If a shopper can read
 *    three real words off it, it is a product; if they can only see a cover, it
 *    is a badge." — Both images here are the REAL PDFs rendered at 200dpi:
 *    page 10 of the Routine & Tracker (its actual 12-week grid) and page 6 of the
 *    Field Guide ("How to read any label in 30 seconds"). Nothing is mocked up,
 *    and nothing is generated. The tracker grid is shown blank because that is
 *    how it ships — the plan suggested drawing a few ticks into it, which would
 *    mean editing the product to flatter it.
 *
 * 2. "Give them physical presence." — The tracker is staged as a printed sheet
 *    with one lotion bottle standing against it; the guide is on a tablet screen.
 *    Mixed physical/digital staging is what makes a PDF feel like an object. Only
 *    ONE bottle appears: the six-unit shot is frame 1's job and importing it here
 *    would split the focal point.
 *
 * 3. "Price the line items on-image, not the total." — The two prices are read
 *    from `bundle.value_stack` at render time. The $220 total is deliberately
 *    absent; it already computes itself in the template, and restating it here
 *    would recreate the literal-vs-data drift that caused an earlier bug.
 */

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';

const money = (n) => `$${Number(n) % 1 === 0 ? Number(n).toFixed(0) : Number(n).toFixed(2)}`;

/** The two digital line items, in the order the value stack lists them. */
function digitalItems(ctx) {
  const stack = JSON.parse(ctx.need('value_stack'));
  return stack.filter((row) => row.digital === true);
}

export default {
  product: '99-coconut-reset-digital',
  name: 'frame-04-digital-goods',
  width: 2048,
  height: 2048,
  reads: ['value_stack'],

  /**
   * The frame states two product names and two prices. All four come from the
   * value stack, so the only way they can be wrong is if the stack changes shape
   * — which is what this checks. A frame that priced a guide the buy box no
   * longer credits would be worse than no frame.
   */
  verify(ctx) {
    const items = digitalItems(ctx);
    if (items.length !== 2) {
      throw new Error(`expected 2 digital items in bundle.value_stack, found ${items.length}: `
        + JSON.stringify(items.map((i) => i.label)));
    }
    for (const item of items) {
      if (!item.label?.trim()) throw new Error('a digital value-stack row has no label');
      if (!(Number(item.amount) > 0)) throw new Error(`"${item.label}" has no positive amount`);
    }
  },

  alt(ctx) {
    const [tracker, guide] = digitalItems(ctx);
    return `Two digital guides included with the 90-Day Coconut Reset: the ${tracker.label}, `
      + `shown as a printed twelve-week tracking grid beside a bottle of Body Lotion, and the `
      + `${guide.label}, shown on a tablet open to its page on how to read an ingredient label. `
      + `Both are emailed within minutes of ordering.`;
  },

  html(ctx) {
    const [tracker, guide] = digitalItems(ctx);
    const sheet = ctx.asset('data/brand/digital-pages/tracker-grid.png');
    const method = ctx.asset('data/brand/digital-pages/guide-method.png');
    const bottle = ctx.asset('data/brand/digital-pages/one-lotion.png');

    const caption = (label, amount) => `
      <div style="margin-top:34px;text-align:center;">
        <div style="font-family:Cabin;font-weight:700;font-size:46px;color:${BLACK};line-height:1.2;">${label}</div>
        <div style="font-family:Outfit;font-weight:600;font-size:40px;color:${BLACK};opacity:.5;margin-top:10px;">${money(amount)} value</div>
      </div>`;

    return `<div style="
      width:100%;height:100%;background:${SAND};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:74px 80px 150px;text-align:center;">

      <div style="font-family:Outfit;font-weight:300;font-size:36px;letter-spacing:.34em;
                  text-transform:uppercase;color:${BLACK};opacity:.45;margin-bottom:32px;">
        Included with every Reset
      </div>

      <div style="font-family:Cabin;font-weight:700;font-size:116px;line-height:1.05;
                  color:${BLACK};letter-spacing:-.022em;margin-bottom:16px;">
        Both guides, in your<br>inbox in five minutes.
      </div>

      <div style="width:132px;height:6px;background:${GREEN};border-radius:3px;margin:30px 0 46px;"></div>

      <div style="display:flex;align-items:flex-end;justify-content:center;gap:70px;width:100%;">

        <!-- printed sheet + one bottle -->
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="position:relative;width:900px;height:640px;">
            <div style="position:absolute;left:0;top:20px;width:860px;transform:rotate(-1.6deg);
                        background:#fff;padding:16px 16px 26px;border-radius:4px;
                        box-shadow:0 26px 44px rgba(64,48,26,.24), 0 3px 6px rgba(64,48,26,.14);">
              <img src="${sheet}" style="width:100%;display:block;">
            </div>
            <img src="${bottle}" style="position:absolute;right:-6px;bottom:-14px;height:496px;
                 filter:drop-shadow(0 16px 22px rgba(64,48,26,.26));">
          </div>
          ${caption(tracker.label, tracker.amount)}
        </div>

        <!-- tablet -->
        <div style="display:flex;flex-direction:column;align-items:center;">
          <!-- A tablet, not a phone. Page 6's heading and lower paragraphs run the full
               page width, so there is no narrow column to crop for a phone screen — every
               attempt sheared the ends off the lines. A letter-format guide is read on a
               tablet anyway. Screen aspect matches the crop exactly, so nothing is cut
               and nothing is letterboxed. -->
          <div style="width:812px;height:744px;background:#141414;border-radius:30px;padding:22px;
                      box-shadow:0 26px 44px rgba(64,48,26,.26), 0 3px 6px rgba(64,48,26,.16);">
            <div style="width:100%;height:100%;background:#fff;border-radius:12px;overflow:hidden;">
              <img src="${method}" style="width:100%;display:block;">
            </div>
          </div>
          ${caption(guide.label, guide.amount)}
        </div>
      </div>
    </div>`;
  },
};
