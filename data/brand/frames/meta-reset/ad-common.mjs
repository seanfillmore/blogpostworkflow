/**
 * Shared layout for the Meta statics, built to the reference ads in ~/Downloads/Ads.
 *
 * The first pass was typographic and Sean's read was blunt and correct: nothing
 * on them said skincare or lotion. Every one of the seven reference ads does
 * three things those did not —
 *
 *   1. the PRODUCT is the hero: large, centred, category readable in a second
 *   2. a SATURATED colour field, not a flat cream page
 *   3. benefit pills and proof arranged around the product
 *
 * Product art is the real cutout photography in data/brand/cutouts, never a
 * generated bottle. A generated render of this bottle garbled the badge text
 * ("OOWANG COCONUT OIL") and invented a volume (110ml against a real 118ml) —
 * exactly the failure marketing-product-image-stack warns about. Compositing a
 * photograph makes the label correct by construction rather than by luck.
 *
 * Sean, on quantity: the ad does not need to show three of each — the claim can
 * live in the text. So one bottle and one jar, hero-sized, and the ninety-day
 * arithmetic is carried by a pill.
 */
export const INK = '#1a1b18';
export const GREEN = '#4a8b3c';
export const DEEP = '#33502c';
export const MINT = '#e3ecdc';
export const PAPER = '#ffffff';

export const LOTION = 'data/brand/cutouts/component-lotion-coconut-breeze.png';
export const JAR = 'data/brand/cutouts/component-cream-coconut-breeze.png';

/** A benefit pill. Reference ads run three or four; more and none of them read. */
export const pill = (text) => `
  <div style="background:${PAPER};border-radius:999px;padding:17px 30px;
              font-family:Outfit;font-weight:600;font-size:29px;color:${INK};
              box-shadow:0 3px 14px rgba(26,27,24,.10);white-space:nowrap;">${text}</div>`;

/** Five stars, drawn not photographed, so nothing here can drift out of date. */
export const stars = (size = 30) => {
  const s = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;">
    <path fill="#4a8b3c" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01z"/></svg>`;
  return `<div style="display:flex;gap:5px;">${s.repeat(5)}</div>`;
};

/**
 * The shell every ad shares: colour field, soft disc behind the product, headline
 * at the top. Keeps the set recognisable as one campaign.
 */
export const shell = ({ bg, disc, headline, sub, body, footer }) => `
  <div style="width:100%;height:100%;background:${bg};box-sizing:border-box;
              padding:74px 62px 62px;display:flex;flex-direction:column;
              align-items:center;text-align:center;position:relative;overflow:hidden;">

    <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);
                width:760px;height:760px;border-radius:50%;background:${disc};"></div>

    <div style="position:relative;z-index:1;width:100%;">
      <div style="font-family:Cabin;font-weight:700;font-size:76px;line-height:1.02;
                  letter-spacing:-.028em;color:${INK};">${headline}</div>
      ${sub ? `<div style="font-family:Outfit;font-weight:400;font-size:32px;line-height:1.35;
                  color:${INK};opacity:.62;margin-top:16px;">${sub}</div>` : ''}
    </div>

    <!-- Bounded, not flex:1. With flex:1 a tall cutout grew the row until the
         pills and the brand line were pushed off the canvas entirely. -->
    <div style="position:relative;z-index:1;flex:1;min-height:0;width:100%;display:flex;
                align-items:center;justify-content:center;">
      <div style="height:100%;display:flex;align-items:flex-end;justify-content:center;">${body}</div>
    </div>

    ${footer ? `<div style="position:relative;z-index:1;width:100%;">${footer}</div>` : ''}
  </div>`;
