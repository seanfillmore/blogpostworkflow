/**
 * Meta static 3 of 5 — the grid. The quantity IS the message.
 *
 * marketing-product-image-stack lists "everything included in a multipack or
 * kit" as a main-image lever, and the grid as a required format. For this offer
 * they are the same asset: the objection is running out, so six containers in
 * one frame argues the point before a word is read.
 *
 * Uses the REAL cutouts in data/brand/cutouts, never a generated bottle — the
 * compliance rule in marketing-product-image-stack is that a rendered product
 * must match the physical one exactly.
 */
const INK = '#1a1b18';
const GREEN = '#4a8b3c';
const CREAM = '#f6f8f3';

const LOTION = 'data/brand/cutouts/component-lotion-coconut-breeze.png';
const CREAM_JAR = 'data/brand/cutouts/component-cream-coconut-breeze.png';

export default {
  product: '99-coconut-reset-digital',
  name: 'meta-03-in-the-box',
  width: 1080,
  height: 1350,

  verify(ctx) {
    const qty = JSON.parse(ctx.need('component_qty'));
    if (JSON.stringify(qty) !== JSON.stringify([3, 3])) {
      throw new Error(`frame draws three lotions and three creams; component_qty is ${JSON.stringify(qty)}`);
    }
    const comps = JSON.parse(ctx.need('components'));
    if (comps.length !== 2) throw new Error(`frame assumes two components; found ${comps.length}`);
    // If the art is missing, ctx.asset throws — but say why before it does.
    for (const p of [LOTION, CREAM_JAR]) {
      if (!p.endsWith('.png')) throw new Error(`cutout ${p} must be a transparent PNG`);
    }
  },

  alt: () =>
    'Three 8 fl oz bottles of Real Skin Care Body Lotion beside three 4 fl oz jars of Body Cream, '
    + 'in Coconut Breeze — everything included in the 90-Day Coconut Reset.',

  html: (ctx) => {
    const lotion = ctx.asset(LOTION);
    const jar = ctx.asset(CREAM_JAR);
    // Sized by WIDTH, not height. The jar art is landscape and the bottle art is
    // portrait, so equal heights made three jars overflow the canvas while the
    // lotions read as the smaller item — backwards, since the three lotions are
    // the larger half of what arrives.
    const bottle = `<img src="${lotion}" style="width:236px;display:block;object-fit:contain;">`;
    const pot = `<img src="${jar}" style="width:266px;display:block;object-fit:contain;">`;
    return `
    <div style="width:100%;height:100%;background:${CREAM};box-sizing:border-box;
                padding:72px 60px 64px;display:flex;flex-direction:column;
                align-items:center;justify-content:space-between;text-align:center;">

      <div>
        <div style="font-family:Cabin;font-weight:700;font-size:104px;line-height:1;
                    letter-spacing:-.03em;color:${INK};">Ninety days.</div>
        <div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};
                    opacity:.6;margin-top:16px;">Everything that arrives in the box.</div>
      </div>

      <div style="display:flex;gap:14px;align-items:flex-end;justify-content:center;">
        ${bottle}${bottle}${bottle}
      </div>
      <div style="display:flex;gap:8px;align-items:flex-end;justify-content:center;margin-top:-18px;">
        ${pot}${pot}${pot}
      </div>

      <div style="display:flex;gap:56px;align-items:baseline;">
        <div>
          <span style="font-family:Cabin;font-weight:700;font-size:74px;color:${GREEN};">3</span>
          <span style="font-family:Outfit;font-size:34px;color:${INK};opacity:.7;"> Body Lotions</span>
        </div>
        <div>
          <span style="font-family:Cabin;font-weight:700;font-size:74px;color:${GREEN};">3</span>
          <span style="font-family:Outfit;font-size:34px;color:${INK};opacity:.7;"> Body Creams</span>
        </div>
      </div>
    </div>`;
  },
};
