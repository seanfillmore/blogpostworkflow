/**
 * Head-to-Toe — the six frame builders.
 *
 * Each builder is called once per kit, so every media in the gallery belongs to
 * exactly one variant. That is not a stylistic choice: `sections/main-product
 * .liquid` sets its `gang_exist` flag as soon as it meets one scoped media and
 * never clears it, so an UNSCOPED image sitting after a scoped one is hidden for
 * every variant. On a two-variant bundle that means every media must be scoped,
 * and the four frames whose content is identical across kits still have to exist
 * twice. Six frames x two kits = twelve media.
 *
 * Every figure is read at render time and asserted in verify(). This bundle is
 * the reason that rule exists: it repriced $105 -> $87 on 2026-07-31 and its own
 * SEO title still read "$105" on 2026-08-02, because the number was typed once
 * and nobody was told when it moved.
 */

import {
  INK, GREEN, PAPER, RULE, WASH, money, cutout, unit, natural, scaled,
  LABEL, BODY_PART, BODY_ORDER, HEIGHT_ORDER, kitsFor, inOrder, assertBundle, altWithin512,
} from './h2t-common.mjs';

const PRICE = 87;
const kitNamed = (name) => {
  const k = kitsFor().find((x) => x.name === name);
  if (!k) throw new Error(`config/bundles.json has no "${name}" kit of head-to-toe`);
  return k;
};

/** Every builder asserts the kit is real and buyable before it draws anything. */
function assertKit(ctx, kitName) {
  assertBundle(ctx, { price: PRICE });
  if (!ctx.variants.some((v) => v.title === kitName)) {
    throw new Error(`no live variant titled "${kitName}" — a frame must depict a kit somebody can actually buy`);
  }
  return kitNamed(kitName);
}

const eyebrow = (text) => `<div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
  text-transform:uppercase;color:${INK};opacity:.45;">${text}</div>`;

// ─────────────────────────────────────────────────────────────────────────────
// Frame 1 — grid / multi-SKU. Prove seven distinct products exist.
//
// The page says "one of everything we make" and cannot make anyone count to
// seven; counting to seven is the purchase decision. Drawn tallest to shortest
// so the range itself is the composition, and at ONE physical scale, so the lip
// balm reads as a twelfth the height of the hand soap — which it is.
//
// Every unit shown is a real variant from ONE real kit. Mixing Gentle and Fresh
// into one frame would ship a photograph of a box nobody receives.
// ─────────────────────────────────────────────────────────────────────────────
export function contentsFrame(kitName) {
  const PX_PER_CM = 33;
  return {
    product: 'head-to-toe',
    name: `frame-01-contents-h2t-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      const kit = assertKit(ctx, kitName);
      if (kit.components.length !== 7) throw new Error(`frame 1 draws seven products; the kit holds ${kit.components.length}`);
      const kinds = new Set(kit.components.map((c) => c.kind));
      if (kinds.size !== 7) throw new Error(`frame 1 claims seven DISTINCT products; the kit holds ${kinds.size} distinct kinds`);
    },

    alt() {
      const kit = kitNamed(kitName);
      const parts = inOrder(kit, HEIGHT_ORDER).map((c) => `${LABEL[c.kind]} in ${c.variant}`);
      return altWithin512(`All seven products in the Head-to-Toe ${kitName} kit, shown to scale: ${parts.join(', ')}. ${money(PRICE)} for the box.`);
    },

    html(ctx) {
      const kit = kitNamed(kitName);
      const shelf = scaled(HEIGHT_ORDER[0], PX_PER_CM);
      // No per-product variant caption. At seven columns it can only be ~28px, which
      // is 5.3px once the frame is 390px wide on a phone — present but unreadable,
      // which is the failure the 1-second check exists to catch. The scents are the
      // job of frames 2 and 4, and the kit is named in the eyebrow; this frame's job
      // is only that there are seven distinct products, so the copy that does not
      // serve it comes off and the label that does gets bigger.
      const column = (c) => `
        <div style="display:flex;flex-direction:column;align-items:center;width:216px;">
          ${unit({ src: ctx.asset(cutout(c.slug)), slug: c.slug, pxPerCm: PX_PER_CM, boxH: shelf })}
          <div style="font-family:Cabin;font-weight:700;font-size:46px;color:${INK};margin-top:30px;text-align:center;line-height:1.14;">
            ${LABEL[c.kind]}
          </div>
        </div>`;

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:space-between;
        padding:96px 56px 88px;box-sizing:border-box;text-align:center;">

        <div>
          ${eyebrow(`${kitName} kit`)}
          <div style="font-family:Cabin;font-weight:700;font-size:124px;line-height:1.03;
                      color:${INK};letter-spacing:-.024em;margin-top:24px;">One of everything<br>we make.</div>
        </div>

        <!-- flex-START, not flex-end. The products already share a floor because every
             unit() box is the shelf height and aligns its image to the bottom of it.
             Aligning the COLUMNS to the bottom instead lifts any column whose variant
             name wraps to two lines — "Calming Lavender" did — so six captions sat on
             one baseline and the seventh floated above them. -->
        <div style="display:flex;align-items:flex-start;justify-content:center;gap:16px;
                    background:${WASH};border-radius:34px;padding:70px 40px 54px;">
          ${inOrder(kit, HEIGHT_ORDER).map(column).join('')}
        </div>

        <div>
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 30px;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:64px;color:${INK};">Seven full-size products.</div>
          <div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};opacity:.6;margin-top:14px;">
            ${money(PRICE)} for the box
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 2 — benefit callout. The bundle's name, made literal.
//
// "Seven products" is a number. "Teeth, lips, underarms, hands, shower, body,
// overnight" is the buyer's own shelf, and that is the frame that earns $87 —
// it converts a count into a replacement.
//
// Deliberately type-only. The honest way to draw seven products at one scale is
// frame 1's row; repeating it here with different captions would be the same
// asset doing two jobs, and a vertical stack of seven at true scale puts the lip
// balm at 60px, which fails the phone-size read that this whole gallery is
// checked against.
// ─────────────────────────────────────────────────────────────────────────────
export function routineFrame(kitName) {
  return {
    product: 'head-to-toe',
    name: `frame-02-routine-h2t-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      const kit = assertKit(ctx, kitName);
      for (const k of BODY_ORDER) {
        if (!kit.components.some((c) => c.kind === k)) throw new Error(`frame 2 names a ${k} the ${kitName} kit does not contain`);
        if (!BODY_PART[k]) throw new Error(`no body-part word for ${k}`);
      }
      if (new Set(Object.values(BODY_PART)).size !== BODY_ORDER.length) {
        throw new Error('two products map to the same body-part word — the frame would read as a duplicate row');
      }
    },

    alt() {
      const kit = kitNamed(kitName);
      const rows = inOrder(kit, BODY_ORDER).map((c) => `${BODY_PART[c.kind].toLowerCase()} (${LABEL[c.kind]})`);
      return altWithin512(`What the Head-to-Toe ${kitName} kit covers, head to toe: ${rows.join(', ')}. Seven products, nothing else to buy.`);
    },

    html() {
      const kit = kitNamed(kitName);
      const row = (c, i) => `
        <div style="display:flex;align-items:baseline;justify-content:space-between;
                    padding:30px 0 26px;${i ? `border-top:3px solid ${RULE};` : ''}">
          <div style="font-family:Cabin;font-weight:700;font-size:86px;color:${INK};letter-spacing:-.02em;">
            ${BODY_PART[c.kind]}
          </div>
          <div style="text-align:right;">
            <div style="font-family:Outfit;font-weight:400;font-size:52px;color:${INK};opacity:.78;">${LABEL[c.kind]}</div>
            <div style="font-family:Outfit;font-weight:300;font-size:38px;color:${INK};opacity:.45;margin-top:4px;">${c.variant}</div>
          </div>
        </div>`;

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;justify-content:space-between;
        padding:104px 120px 96px;box-sizing:border-box;">

        <div style="text-align:center;">
          ${eyebrow(`${kitName} kit`)}
          <div style="font-family:Cabin;font-weight:700;font-size:132px;line-height:1.02;
                      color:${INK};letter-spacing:-.026em;margin-top:22px;">Nothing else<br>to buy.</div>
        </div>

        <div>${inOrder(kit, BODY_ORDER).map(row).join('')}</div>

        <div style="text-align:center;">
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 26px;"></div>
          <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};opacity:.62;">
            Seven products. ${money(PRICE)} for the box.
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 3 — headliner. Kill the per-unit objection with a true number.
//
// docs/bundle-marketing-plan.md rule 1 says bundles never lead with savings, to
// avoid inviting per-unit comparison. This frame invites it on purpose, and sits
// at slot 3 so completeness still leads.
//
// The media plan cut this frame when the bundle repriced, because it was written
// around $105 / 7 = exactly $15.00 landing ON the price ceiling the VOC file
// documents, and that arithmetic died with the old price. At $87 the division
// gives $12.43, which is comfortably UNDER the ceiling — so the objection that
// motivated cutting it is the thing that is now gone. Both Clean Swaps ship this
// frame. It is rebuilt here with the figure derived, never typed, and a guard
// that stops the build if the per-unit price ever reaches the ceiling: a version
// of this frame printing $15.50 would argue against itself.
// ─────────────────────────────────────────────────────────────────────────────
const PRICE_CEILING = 15;
export function perProductPriceFrame(kitName) {
  return {
    product: 'head-to-toe',
    name: `frame-03-per-product-h2t-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      const kit = assertKit(ctx, kitName);
      const per = PRICE / kit.components.length;
      if (per >= PRICE_CEILING) {
        throw new Error(`${money(PRICE)} over ${kit.components.length} products is $${per.toFixed(2)} each, at or above the `
          + `$${PRICE_CEILING} ceiling the VOC file documents. This frame argues against itself at that number — re-spec it.`);
      }
      const stack = JSON.parse(ctx.need('value_stack'));
      const sum = stack.reduce((a, l) => a + Number(l.amount), 0);
      const compare = Number(ctx.variants[0].compareAtPrice);
      if (sum !== compare) {
        throw new Error(`the value stack sums to ${money(sum)} but compare-at is ${money(compare)}. `
          + `They must agree before a frame prints a saving.`);
      }
    },

    alt(ctx) {
      const n = kitNamed(kitName).components.length;
      const compare = Number(ctx.variants[0].compareAtPrice);
      return altWithin512(`${money(PRICE)} for ${n} full-size Real Skin Care products — $${(PRICE / n).toFixed(2)} each, `
        + `against ${money(compare)} bought separately.`);
    },

    html(ctx) {
      const n = kitNamed(kitName).components.length;
      const per = (PRICE / n).toFixed(2);
      const compare = Number(ctx.variants[0].compareAtPrice);

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:140px 120px;box-sizing:border-box;text-align:center;">

        ${eyebrow(`${kitName} kit`)}

        <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.06;
                    color:${INK};letter-spacing:-.024em;margin-top:34px;">${money(PRICE)}.<br>Seven products.</div>

        <div style="width:190px;height:9px;background:${GREEN};margin:64px 0 44px;border-radius:5px;"></div>

        <div style="font-family:Cabin;font-weight:700;font-size:340px;line-height:.9;
                    color:${INK};letter-spacing:-.03em;">$${per}</div>
        <div style="font-family:Outfit;font-weight:300;font-size:64px;letter-spacing:.3em;
                    text-transform:uppercase;color:${INK};opacity:.5;margin-top:30px;">each</div>

        <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.5;
                    color:${INK};opacity:.62;margin-top:76px;max-width:1400px;">
          ${money(compare)} if you bought the seven separately.
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 4 — educational infographic. Make Gentle vs Fresh decidable.
//
// The buyer stalled at the variant picker cannot see what the two kits differ
// on without opening both. Read from config/bundles.json, so the frame cannot
// drift from what ships.
//
// The toothpaste is Fresh Mint in BOTH kits. It is drawn as a shared row rather
// than as a difference — printing it in two columns would invent a distinction
// and undercut the six that are real.
// ─────────────────────────────────────────────────────────────────────────────
export function kitDifferenceFrame(kitName) {
  return {
    product: 'head-to-toe',
    name: `frame-04-kits-h2t-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      assertKit(ctx, kitName);
      const kits = kitsFor();
      if (kits.length !== 2) throw new Error(`frame 4 compares two kits; the product now has ${kits.length}`);
      const [a, b] = kits;
      const differing = BODY_ORDER.filter((k) => {
        const ca = a.components.find((c) => c.kind === k), cb = b.components.find((c) => c.kind === k);
        return ca.variant !== cb.variant;
      });
      if (!differing.length) throw new Error('the two kits are identical — there is nothing for this frame to explain');
      if (a.price !== b.price) throw new Error(`the kits are priced differently (${money(a.price)} vs ${money(b.price)}); the frame implies one price`);
    },

    alt() {
      const [a, b] = kitsFor();
      const diff = BODY_ORDER
        .map((k) => [k, a.components.find((c) => c.kind === k), b.components.find((c) => c.kind === k)])
        .filter(([, ca, cb]) => ca.variant !== cb.variant)
        .map(([k, ca, cb]) => `${LABEL[k]} ${ca.variant} or ${cb.variant}`);
      return altWithin512(`How the Head-to-Toe kits differ — ${a.name} versus ${b.name}: ${diff.join('; ')}. Same seven products, same ${money(PRICE)}.`);
    },

    html() {
      const [a, b] = kitsFor();
      const row = (k, i) => {
        const ca = a.components.find((c) => c.kind === k);
        const cb = b.components.find((c) => c.kind === k);
        const same = ca.variant === cb.variant;
        const cell = (text, muted) => `<div style="flex:1;font-family:Outfit;font-weight:400;font-size:42px;
          color:${INK};opacity:${muted ? '.42' : '.85'};text-align:center;line-height:1.2;">${text}</div>`;
        return `<div style="display:flex;align-items:center;padding:26px 0 22px;${i ? `border-top:3px solid ${RULE};` : ''}">
          <div style="width:400px;font-family:Cabin;font-weight:700;font-size:46px;color:${INK};">${LABEL[k]}</div>
          ${same
            ? `<div style="flex:1;display:flex;align-items:center;justify-content:center;gap:20px;">
                 <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};opacity:.85;">${ca.variant}</div>
                 <div style="font-family:Outfit;font-weight:300;font-size:28px;letter-spacing:.2em;text-transform:uppercase;
                             color:${GREEN};border:3px solid ${GREEN};border-radius:999px;padding:6px 22px;">both kits</div>
               </div>`
            : `${cell(ca.variant, false)}${cell(cb.variant, false)}`}
        </div>`;
      };

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;justify-content:space-between;
        padding:100px 96px 92px;box-sizing:border-box;">

        <div style="text-align:center;">
          ${eyebrow('Two kits, one price')}
          <div style="font-family:Cabin;font-weight:700;font-size:126px;line-height:1.02;
                      color:${INK};letter-spacing:-.026em;margin-top:22px;">${a.name} or ${b.name}.<br>Here's the difference.</div>
        </div>

        <div>
          <div style="display:flex;align-items:center;padding-bottom:20px;">
            <div style="width:400px;"></div>
            <div style="flex:1;font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.28em;
                        text-transform:uppercase;color:${INK};opacity:.5;text-align:center;">${a.name}</div>
            <div style="flex:1;font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.28em;
                        text-transform:uppercase;color:${INK};opacity:.5;text-align:center;">${b.name}</div>
          </div>
          <div style="background:${WASH};border-radius:28px;padding:24px 44px 30px;">
            ${BODY_ORDER.map(row).join('')}
          </div>
        </div>

        <div style="text-align:center;">
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 26px;"></div>
          <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};opacity:.62;">
            Same seven products. Same ${money(PRICE)}.
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 5 — text-only. Borrow the catalogue's proof for a bundle with none.
//
// "of the seven products inside" is load-bearing in BOTH the headline and the
// alt text. Without it the frame implies 295 reviews of a bundle that has zero,
// which is the difference between proof and a misrepresentation. Same rule the
// Reset, the Sensitive Skin Set and both Clean Swaps carry.
// ─────────────────────────────────────────────────────────────────────────────
function star(i, pct) {
  const d = 'M50 4 L61.8 35.9 L96 37.8 L69.2 59.4 L77.9 92.5 L50 73.9 L22.1 92.5 L30.8 59.4 L4 37.8 L38.2 35.9 Z';
  return `<svg viewBox="0 0 100 100" width="176" height="176" aria-hidden="true">
    <defs><clipPath id="h${i}"><rect x="0" y="0" width="${(pct * 100).toFixed(3)}" height="100"/></clipPath></defs>
    <path d="${d}" fill="${INK}" opacity=".16"/>
    <path d="${d}" fill="${INK}" clip-path="url(#h${i})"/>
  </svg>`;
}

export function reviewsFrame(kitName) {
  return {
    product: 'head-to-toe',
    name: `frame-05-reviews-h2t-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      assertKit(ctx, kitName);
      const value = Number(ctx.need('rating_value'));
      const count = Number(ctx.need('rating_count'));
      if (!Number.isFinite(value) || value <= 0 || value > 5) throw new Error(`rating_value out of range: ${value}`);
      if (!Number.isInteger(count) || count <= 0) throw new Error(`rating_count is not a positive integer: ${count}`);
      if (count < 25) throw new Error(`only ${count} reviews — too thin to carry a proof frame; media plan §4 rule 1`);
    },

    alt(ctx) {
      return altWithin512(`${Number(ctx.need('rating_value')).toFixed(2)} out of 5 stars from ${ctx.need('rating_count')} `
        + `customer reviews of the seven products included in the Head-to-Toe box.`);
    },

    html(ctx) {
      const value = Number(ctx.need('rating_value'));
      const count = Number(ctx.need('rating_count'));
      const stars = Array.from({ length: 5 }, (_, i) => star(i, Math.min(1, Math.max(0, value - i)))).join('');

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:150px 130px;box-sizing:border-box;text-align:center;">

        ${eyebrow('Head-to-Toe')}

        <div style="display:flex;gap:28px;margin:80px 0 52px;">${stars}</div>

        <div style="font-family:Cabin;font-weight:700;font-size:380px;line-height:.92;
                    color:${INK};letter-spacing:-.03em;">${value.toFixed(2)}</div>

        <div style="width:190px;height:9px;background:${GREEN};margin:70px 0 58px;border-radius:5px;"></div>

        <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1.18;color:${INK};max-width:1650px;">
          ${count} reviews of the seven<br>products in this box.
        </div>

        <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.5;
                    color:${INK};opacity:.62;margin-top:52px;max-width:1300px;">
          The box is new. What is in it is not.
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// There is no frame 6, and the reason is worth keeping.
//
// The spec's frame 7 answered "how long does $87 actually last", and it shipped
// on 2026-08-02 reading "60 DAYS of everything". Sean caught it the same day:
// the 90-Day Clean Swap sells THREE of each product for 90 days, so one of each
// is thirty. The store's own arithmetic contradicted the frame by 2x.
//
// The measured position is worse. config/consumption-rates.json puts the body
// cream at ~28 days per unit, and a box lasts as long as the FIRST thing in it
// runs out — so Head-to-Toe stops being "everything" after about four weeks,
// while its deodorant (~90 days) is still nearly full. Every one of those rates
// is a reorder gap, so every one is an upper bound; the true figure is lower.
//
// The frame's verify() had checked that duration_days was a positive integer. It
// was: it was 60. A metafield is not evidence, and asserting a typed number is
// well-formed is not the same as asserting it is true. lib/supply-duration.js is
// now the evidence, and any future duration claim goes through it.
//
// The frame was not rebuilt at 28 days, because the honest number showed the
// frame was answering the wrong question. This is the discovery-and-gifting
// bundle — the media plan's own personas for it are "the shopper who wants to
// find their favourite before committing to any one SKU" and "the non-Q4
// gifter". Neither buys on supply duration, and $87 for four weeks argues
// against a box whose actual argument is breadth. Duration belongs to the Clean
// Swaps, where three of each genuinely is a season.
// ─────────────────────────────────────────────────────────────────────────────
