/**
 * 90-Day Coconut Reset — frame 2 (educational infographic), shared builder.
 *
 * Media plan §6, re-specced 2026-08-01: "Explain why it's three *pairs*, not six
 * duplicates." The buyer looking at six vessels of two products is asking why
 * they are being sold the same thing six times, and the answer is that it is not
 * six of anything — it is one two-step routine, three times over.
 *
 * ── How this is built, and why ──────────────────────────────────────────────
 * The first version sliced the hero photo into two rectangles and put captions
 * under them. Rejected, correctly: the seam showed, the crop cut the bottles
 * through their label, and two green panels sat on sand with no integration.
 *
 * The second attempt was to let gemini-3-pro-image lay the whole frame out. Its
 * composition and lighting are excellent, and its label fidelity is unusable — it
 * redraws the product rather than moving it, and returned "230ml", "235ml",
 * "255ml" and "6 fl oz" against a real 8 fl oz / 236ml, plus a garbled ORGANIC
 * COCONUT OIL seal, on every attempt including one that asked only for a
 * backdrop swap. A wrong volume on a cosmetic is an accuracy problem.
 *
 * So the hero — which Sean generated from the stored product photos and has
 * reviewed and approved, labels correct — is the source of truth for pixels. It
 * is keyed to transparency by scripts/cutout-product.mjs and composited here.
 * Each row is a separate PNG so it can carry its own grounding shadow instead of
 * having one clipped at a crop boundary. Nothing regenerates the product, so the
 * labels cannot drift; type is laid down by the renderer, so glyphs are exact.
 */

const BLACK = '#000000';
const SAND = '#EDE5D8';
const GREEN = '#AEDEAC';

// Rows are sized by HEIGHT, not width. The two plates are generated separately so
// their pixel scales differ, and a shared display width made the near-square
// lotion row a thousand pixels tall and pushed the closing line off the canvas.
// Height is also the honest axis: the 8 oz bottle really is about twice the 4 oz
// jar, so fixing the heights in that ratio keeps the relative scale truthful
// rather than letting whatever the generator returned decide it.
const LOTION_H = 660;
const CREAM_H = 330;

function row(src, naturalW, naturalH, targetH) {
  const w = Math.round((naturalW / naturalH) * targetH);
  return `<img src="${src}" style="width:${w}px;height:${targetH}px;display:block;
    filter:drop-shadow(0 18px 24px rgba(64,48,26,.22)) drop-shadow(0 3px 4px rgba(64,48,26,.16));">`;
}

function caption(text) {
  return `<div style="font-family:Outfit;font-weight:600;font-size:38px;letter-spacing:.16em;
                      text-transform:uppercase;color:${BLACK};opacity:.62;margin-top:34px;">${text}</div>`;
}

export function routineFrame({ name, variant, lotions, creams }) {
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
     * nightly.") survived the repack as a falsehood. So it is checked against the
     * live roster — if the Reset is repacked, this stops building rather than
     * quietly lying.
     */
    verify(ctx) {
      const qty = JSON.parse(ctx.need('component_qty'));
      if (!Array.isArray(qty) || qty.length !== 2) {
        throw new Error(`expected 2 components, bundle.component_qty is ${JSON.stringify(qty)}`);
      }
      const [l, c] = qty;
      if (l !== 3 || c !== 3) {
        throw new Error(
          `this frame states three lotions and three creams, but the bundle now ships ${l} and ${c}. `
          + `Re-spec the frame before re-rendering — do not adjust the crop.`);
      }
      if (!ctx.variants.some((v) => v.title === variant)) {
        throw new Error(`no variant titled "${variant}" — a frame must depict a kit somebody can actually buy`);
      }
    },

    alt() {
      return `Three ${variant} Body Lotion bottles and three ${variant} Body Cream jars from the `
        + `90-Day Coconut Reset, shown as a daily lotion and an overnight cream, three of each for three months.`;
    },

    html(ctx) {
      return `<div style="
        width:100%;height:100%;background:${SAND};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:96px;text-align:center;">

        <div style="font-family:Outfit;font-weight:300;font-size:36px;letter-spacing:.36em;
                    text-transform:uppercase;color:${BLACK};opacity:.45;margin-bottom:34px;">
          ${variant}
        </div>

        <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.04;
                    color:${BLACK};letter-spacing:-.022em;margin-bottom:26px;">
          Daily lotion.<br>Overnight cream.
        </div>

        ${row(ctx.asset(lotions.file), lotions.w, lotions.h, LOTION_H)}
        ${caption('Three lotions · every morning')}

        <div style="width:132px;height:6px;background:${GREEN};border-radius:3px;margin:40px 0 30px;"></div>

        ${row(ctx.asset(creams.file), creams.w, creams.h, CREAM_H)}
        ${caption('Three creams · every night')}

        <div style="font-family:Cabin;font-weight:700;font-size:60px;color:${BLACK};margin-top:46px;">
          One pair a month. Ninety days.
        </div>
      </div>`;
    },
  };
}
