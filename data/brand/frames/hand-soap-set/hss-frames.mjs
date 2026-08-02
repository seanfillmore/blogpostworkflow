/**
 * Hand Soap Set — four frame builders producing ten media.
 *
 * Read hss-common.mjs's header for why the stack is shaped this way. In short:
 * two options, one scoping slot per media, so the count and the scent are
 * carried by different frames and the two unscoped frames must sort first.
 *
 *   frame-01-range      unscoped   the four scents, one shot
 *   frame-02-reviews    unscoped   catalogue proof
 *   frame-03-config-*   Configuration x3   what you get, and what it costs
 *   frame-04-scent-*    Scent x5           the bottle, and what is in it
 */

import {
  INK, GREEN, PAPER, RULE, WASH, money, cutout, unit, scaled, natural,
  LABEL, SCENTS, scentSlug, configurations, countsFor, oilsFor, assertLivePrice, altWithin512,
} from './hss-common.mjs';

const eyebrow = (t) => `<div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
  text-transform:uppercase;color:${INK};opacity:.45;">${t}</div>`;

// ─────────────────────────────────────────────────────────────────────────────
// Frame 1 — UNSCOPED. The four scents.
//
// Shown for all fifteen variants, and honest for all fifteen because it depicts
// the OPTION SET rather than anyone's box: the Scent option really does offer
// these four, individually or as Variety. It leads the gallery and is the
// og:image, which is right — this product's page currently has no images at all,
// so the first thing it needs to say is what the product physically is.
// ─────────────────────────────────────────────────────────────────────────────
export function rangeFrame() {
  const PX_PER_CM = 30;
  return {
    product: 'hand-soap-set',
    name: 'frame-01-range-hss',
    width: 2048,
    height: 2048,

    verify(ctx) {
      const opt = ctx.product.options?.find?.((o) => o.name === 'Scent');
      const values = opt?.values ?? [];
      for (const s of SCENTS) {
        if (values.length && !values.includes(s)) throw new Error(`the Scent option no longer offers "${s}" — it has: ${values.join(', ')}`);
        natural(scentSlug(s));
      }
    },

    alt: () => altWithin512(`The four Real Skin Care foaming hand soap scents shown together — ${SCENTS.join(', ')} — `
      + `available singly or as a Variety set.`),

    html(ctx) {
      const shelf = scaled('handsoap', PX_PER_CM);
      const col = (s) => `
        <div style="display:flex;flex-direction:column;align-items:center;width:330px;">
          ${unit({ src: ctx.asset(cutout(scentSlug(s))), slug: scentSlug(s), pxPerCm: PX_PER_CM, boxH: shelf })}
          <div style="font-family:Cabin;font-weight:700;font-size:44px;color:${INK};margin-top:30px;text-align:center;line-height:1.15;">${s}</div>
        </div>`;
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:space-between;
        padding:100px 60px 92px;box-sizing:border-box;text-align:center;">
        <div>
          ${eyebrow('Foaming hand soap')}
          <div style="font-family:Cabin;font-weight:700;font-size:132px;line-height:1.03;
                      color:${INK};letter-spacing:-.026em;margin-top:24px;">Four scents.</div>
        </div>
        <div style="display:flex;align-items:flex-start;justify-content:center;gap:16px;
                    background:${WASH};border-radius:34px;padding:72px 36px 56px;">
          ${SCENTS.map(col).join('')}
        </div>
        <div>
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 28px;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:62px;color:${INK};">One for every sink.</div>
          <div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};opacity:.6;margin-top:14px;">
            Pick one scent, or one of each.
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 2 — UNSCOPED. Catalogue proof.
//
// Must also sort before every scoped media. "of the hand soap in this set" is
// load-bearing: the set itself has no reviews.
// ─────────────────────────────────────────────────────────────────────────────
function star(i, pct) {
  const d = 'M50 4 L61.8 35.9 L96 37.8 L69.2 59.4 L77.9 92.5 L50 73.9 L22.1 92.5 L30.8 59.4 L4 37.8 L38.2 35.9 Z';
  return `<svg viewBox="0 0 100 100" width="176" height="176" aria-hidden="true">
    <defs><clipPath id="hs${i}"><rect x="0" y="0" width="${(pct * 100).toFixed(3)}" height="100"/></clipPath></defs>
    <path d="${d}" fill="${INK}" opacity=".16"/><path d="${d}" fill="${INK}" clip-path="url(#hs${i})"/></svg>`;
}

export function reviewsFrame() {
  return {
    product: 'hand-soap-set',
    name: 'frame-02-reviews-hss',
    width: 2048,
    height: 2048,

    verify(ctx) {
      const value = Number(ctx.need('rating_value'));
      const count = Number(ctx.need('rating_count'));
      if (!Number.isFinite(value) || value <= 0 || value > 5) throw new Error(`rating_value out of range: ${value}`);
      if (!Number.isInteger(count) || count <= 0) throw new Error(`rating_count is not a positive integer: ${count}`);
      if (count < 25) throw new Error(`only ${count} reviews — too thin to carry a proof frame`);
    },

    alt: (ctx) => altWithin512(`${Number(ctx.need('rating_value')).toFixed(2)} out of 5 stars from ${ctx.need('rating_count')} `
      + `customer reviews of the foaming hand soap in this set.`),

    html(ctx) {
      const value = Number(ctx.need('rating_value'));
      const count = Number(ctx.need('rating_count'));
      const stars = Array.from({ length: 5 }, (_, i) => star(i, Math.min(1, Math.max(0, value - i)))).join('');
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:150px 130px;box-sizing:border-box;text-align:center;">
        ${eyebrow('Hand Soap Set')}
        <div style="display:flex;gap:28px;margin:80px 0 52px;">${stars}</div>
        <div style="font-family:Cabin;font-weight:700;font-size:380px;line-height:.92;color:${INK};letter-spacing:-.03em;">${value.toFixed(2)}</div>
        <div style="width:190px;height:9px;background:${GREEN};margin:70px 0 58px;border-radius:5px;"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1.18;color:${INK};max-width:1650px;">
          ${count} reviews of the<br>hand soap in this set.
        </div>
        <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.5;color:${INK};opacity:.62;margin-top:52px;">
          The set is new. The soap is not.
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 3 — scoped to CONFIGURATION. What you get and what it costs.
//
// Type only, deliberately. The scent is unknown at this point — a Configuration
// frame is shown for all five scents of its configuration — so drawing bottles
// here would show a Pure Unscented pump to somebody who picked Orange Zest.
// That is the same variant-blindness that was just removed from the lander's
// grid, and it is not worth re-introducing for decoration.
// ─────────────────────────────────────────────────────────────────────────────
export function configFrame(configName) {
  const config = configurations().find((c) => c.name === configName);
  if (!config) throw new Error(`config/bundles.json has no "${configName}" configuration of hand-soap-set`);
  const { pumps, lotions } = countsFor(config);

  return {
    product: 'hand-soap-set',
    name: `frame-03-config-${configName.toLowerCase().replace(/[^a-z0-9]+/g, '')}-hss`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      const n = assertLivePrice(ctx, { configName, price: config.price, compareAt: config.compareAt });
      if (n !== config.scents.length) {
        throw new Error(`config/bundles.json lists ${config.scents.length} scents for "${configName}" but ${n} live variants match`);
      }
      if (config.compareAt <= config.price) throw new Error(`no saving to print: compare-at ${config.compareAt} vs price ${config.price}`);
    },

    alt: () => altWithin512(`The ${configName} Hand Soap Set — ${pumps} full-size foaming hand soap pumps`
      + `${lotions ? ` and ${lotions} body lotion` : ''}, ${money(config.price)} against ${money(config.compareAt)} bought separately.`),

    html() {
      const saving = config.compareAt - config.price;
      const line = (label, n) => `
        <div style="display:flex;align-items:baseline;justify-content:space-between;padding:26px 0;border-bottom:3px solid ${RULE};">
          <div style="font-family:Cabin;font-weight:700;font-size:74px;color:${INK};">${n} ×</div>
          <div style="font-family:Outfit;font-weight:400;font-size:52px;color:${INK};opacity:.8;">${label}</div>
        </div>`;
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;justify-content:space-between;
        padding:120px 130px 104px;box-sizing:border-box;">
        <div style="text-align:center;">
          ${eyebrow('This configuration')}
          <div style="font-family:Cabin;font-weight:700;font-size:${configName.length > 12 ? 104 : 140}px;line-height:1.04;
                      color:${INK};letter-spacing:-.026em;margin-top:24px;">${configName.replace(/\+/g, '<br>+')}</div>
        </div>
        <div>
          ${line(LABEL.handsoap, pumps)}
          ${lotions ? line(LABEL.lotion, lotions) : ''}
        </div>
        <div style="text-align:center;">
          <div style="width:190px;height:9px;background:${GREEN};margin:0 auto 40px;border-radius:5px;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:150px;line-height:1;color:${INK};letter-spacing:-.03em;">
            ${money(config.price)}
          </div>
          <div style="font-family:Outfit;font-weight:400;font-size:44px;color:${INK};opacity:.62;margin-top:22px;">
            ${money(config.compareAt)} bought separately — you save ${money(saving)}.
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 4 — scoped to SCENT. The bottle, and what is actually in it.
//
// Says nothing about how many, so it is true for all three configurations of its
// scent. The ingredient list is read from config/ingredients.json at render time:
// this soap is ONE base ingredient plus, where it is scented, essential oil, and
// the Pure Unscented bottle is a genuinely one-ingredient product. That is worth
// stating exactly rather than approximately.
// ─────────────────────────────────────────────────────────────────────────────
export function scentFrame(scent) {
  const isVariety = scent === 'Variety';
  return {
    product: 'hand-soap-set',
    name: `frame-04-scent-${scent.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-hss`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      const opt = ctx.product.options?.find?.((o) => o.name === 'Scent');
      if (opt && !opt.values.includes(scent)) throw new Error(`"${scent}" is not a Scent option value — it has: ${opt.values.join(', ')}`);
      if (isVariety) { SCENTS.forEach((s) => natural(scentSlug(s))); return; }
      natural(scentSlug(scent));
      const { base, oils } = oilsFor(scent);
      if (base.length !== 1) throw new Error(`the soap base is now ${base.length} ingredients — this frame states it as one`);
      if (/unscented/i.test(scent) && oils.length) throw new Error(`"${scent}" now lists essential oils: ${oils.join(', ')}`);
      if (!/unscented/i.test(scent) && !oils.length) throw new Error(`"${scent}" lists no essential oils, so the frame has nothing to name`);
    },

    alt() {
      if (isVariety) return altWithin512(`The Variety Hand Soap Set — one pump of each scent: ${SCENTS.join(', ')}.`);
      const { base, oils } = oilsFor(scent);
      return altWithin512(`Real Skin Care ${scent} foaming hand soap — ${base[0]}`
        + `${oils.length ? `, scented only with ${oils.join(', ')}` : ', and nothing else'}.`);
    },

    html(ctx) {
      if (isVariety) {
        const PX = 30;
        const shelf = scaled('handsoap', PX);
        return `<div style="width:100%;height:100%;background:${PAPER};
          display:flex;flex-direction:column;align-items:center;justify-content:space-between;
          padding:110px 60px 100px;box-sizing:border-box;text-align:center;">
          <div>
            ${eyebrow('Variety')}
            <div style="font-family:Cabin;font-weight:700;font-size:136px;line-height:1.03;
                        color:${INK};letter-spacing:-.026em;margin-top:24px;">One of each.</div>
          </div>
          <div style="display:flex;align-items:flex-start;justify-content:center;gap:16px;
                      background:${WASH};border-radius:34px;padding:72px 36px 56px;">
            ${SCENTS.map((s) => `<div style="display:flex;flex-direction:column;align-items:center;width:330px;">
              ${unit({ src: ctx.asset(cutout(scentSlug(s))), slug: scentSlug(s), pxPerCm: PX, boxH: shelf })}
              <div style="font-family:Cabin;font-weight:700;font-size:44px;color:${INK};margin-top:30px;line-height:1.15;">${s}</div>
            </div>`).join('')}
          </div>
          <div>
            <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 28px;"></div>
            <div style="font-family:Outfit;font-weight:400;font-size:44px;color:${INK};opacity:.62;">
              A different scent at every sink.
            </div>
          </div>
        </div>`;
      }

      const { base, oils } = oilsFor(scent);
      const PX = 58;
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;align-items:center;justify-content:center;gap:90px;
        padding:120px 120px;box-sizing:border-box;">
        <div style="flex:none;">
          ${unit({ src: ctx.asset(cutout(scentSlug(scent))), slug: scentSlug(scent), pxPerCm: PX })}
        </div>
        <div style="flex:1;max-width:900px;">
          ${eyebrow('Foaming hand soap')}
          <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.04;
                      color:${INK};letter-spacing:-.026em;margin:22px 0 44px;">${scent}</div>
          <div style="width:150px;height:8px;background:${GREEN};border-radius:4px;margin-bottom:44px;"></div>
          <div style="font-family:Outfit;font-weight:300;font-size:30px;letter-spacing:.26em;text-transform:uppercase;
                      color:${INK};opacity:.5;margin-bottom:22px;">The whole list</div>
          ${base.map((b) => `<div style="font-family:Cabin;font-weight:700;font-size:46px;color:${INK};padding:10px 0;line-height:1.25;">${b}</div>`).join('')}
          ${oils.map((o) => `<div style="font-family:Outfit;font-weight:400;font-size:38px;color:${INK};opacity:.78;padding:8px 0;line-height:1.3;">${o}</div>`).join('')}
          ${oils.length
            ? ''
            : `<div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};opacity:.6;margin-top:26px;line-height:1.4;">
                 That is the entire ingredient list. No essential oils at all.
               </div>`}
        </div>
      </div>`;
    },
  };
}
