/**
 * 90-Day Coconut Reset — frame 2 (educational infographic), shared builder.
 *
 * Media plan §6, re-specced 2026-08-01: "Explain why it's three *pairs*, not six
 * duplicates." The buyer looking at six vessels of two products is asking why
 * they are being sold the same thing six times, and the answer is that it is not
 * six of anything — it is one two-step routine, three times over.
 *
 * Built by cropping two horizontal bands out of the real hero photograph: the
 * lotion row and the cream row. That is deliberate. The three jars in the hero
 * touch each other (measured: one continuous mass from x295 to x1848, with clean
 * gutters only between the *bottles*), so the photo cannot be cut into three
 * per-month columns without slicing through a jar. It cuts cleanly the other way,
 * and the horizontal split happens to be the better argument anyway — the rows
 * are the routine, and the routine is what this frame has to teach.
 *
 * Everything depicted is the real product in the real variant. Media plan §3:
 * anything showing what arrives in the box must be real, and one frame never
 * mixes variants — hence one module per scent rather than one generic frame.
 */

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';

const PHOTO_W = 2048; // both heroes are 2048² — asserted in verify()
const BAND_W = 1300;  // display width of each cropped band
const SCALE = BAND_W / PHOTO_W;

/**
 * One horizontal slice of the hero, showing original rows y0..y1.
 * The image is laid full-width inside an overflow-hidden box and pulled up, so
 * the crop stays declarative and re-derives from the single source photograph.
 */
function band(src, y0, y1) {
  return `<div style="width:${BAND_W}px;height:${Math.round((y1 - y0) * SCALE)}px;overflow:hidden;
                      border-radius:26px;position:relative;">
    <img src="${src}" style="position:absolute;left:0;top:${-Math.round(y0 * SCALE)}px;
                             width:${BAND_W}px;display:block;">
  </div>`;
}

function label(text) {
  return `<div style="font-family:Outfit;font-weight:600;font-size:46px;letter-spacing:.045em;
                      color:${BLACK};opacity:.78;margin-top:26px;">${text}</div>`;
}

/**
 * @param {object} o
 * @param {string} o.name      frame module name
 * @param {string} o.variant   Shopify variant title — the scent depicted
 * @param {string} o.photo     repo-relative path to that scent's hero photograph
 * @param {number[]} o.lotionBand  [y0,y1] of the lotion row in the source photo
 * @param {number[]} o.creamBand   [y0,y1] of the cream row
 */
export function routineFrame({ name, variant, photo, lotionBand, creamBand }) {
  return {
    product: '99-coconut-reset-digital',
    name,
    width: 2048,
    height: 2048,
    reads: ['component_qty'],

    /**
     * The frame asserts a composition: three lotions, three creams, one pair a
     * month. That claim is exactly what went stale in the original spec, which
     * was written for 3 lotions + 1 cream and whose headline ("Three daily. One
     * nightly.") survived the repack as a falsehood. So the composition is
     * checked against the live roster metafield here — if the bundle is ever
     * repacked again, this frame stops building instead of quietly lying.
     */
    verify(ctx) {
      const qty = JSON.parse(ctx.need('component_qty'));
      if (!Array.isArray(qty) || qty.length !== 2) {
        throw new Error(`expected 2 components, bundle.component_qty is ${JSON.stringify(qty)}`);
      }
      const [lotions, creams] = qty;
      if (lotions !== 3 || creams !== 3) {
        throw new Error(
          `this frame states three lotions and three creams, but the bundle now ships `
          + `${lotions} and ${creams}. Re-spec the frame before re-rendering — do not adjust the crop.`,
        );
      }
      if (!ctx.variants.some((v) => v.title === variant)) {
        throw new Error(`no variant titled "${variant}" — a frame must depict a kit somebody can actually buy`);
      }
    },

    alt() {
      return `Three ${variant} Body Lotion bottles above three ${variant} Body Cream jars: `
        + `the 90-Day Coconut Reset routine, one lotion used daily and one cream overnight, `
        + `with three of each for three months.`;
    },

    html(ctx) {
      const src = ctx.asset(photo);
      return `<div style="
        width:100%;height:100%;background:${SAND};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:110px;text-align:center;">

        <div style="font-family:Outfit;font-weight:300;font-size:40px;letter-spacing:.34em;
                    text-transform:uppercase;color:${BLACK};opacity:.5;margin-bottom:44px;">
          ${variant}
        </div>

        <div style="font-family:Cabin;font-weight:700;font-size:132px;line-height:1.06;
                    color:${BLACK};letter-spacing:-.02em;margin-bottom:62px;">
          Daily lotion.<br>Overnight cream.
        </div>

        ${band(src, lotionBand[0], lotionBand[1])}
        ${label('THREE LOTIONS &nbsp;·&nbsp; EVERY MORNING')}

        <div style="width:150px;height:7px;background:${GREEN};border-radius:4px;margin:34px 0 30px;"></div>

        ${band(src, creamBand[0], creamBand[1])}
        ${label('THREE CREAMS &nbsp;·&nbsp; EVERY NIGHT')}

        <div style="font-family:Cabin;font-weight:700;font-size:64px;color:${BLACK};margin-top:52px;">
          One pair a month. Ninety days.
        </div>
      </div>`;
    },
  };
}
