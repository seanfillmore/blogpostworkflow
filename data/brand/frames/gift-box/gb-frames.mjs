/**
 * Gift Box — the five buildable frame builders.
 *
 * The media plan specs seven. Two of them (the open box, the closed box in
 * hands) are MUST-SHOOT and cannot be composited from anything we own; one more
 * (full-size vs a department-store bath set) rests on a premise the plan itself
 * says to "verify on a shelf before shipping the frame", and that verification
 * has not happened. Those three are deliberately absent — see the note at the
 * bottom of this file.
 *
 * Each builder is called once per kit, because `main-product.liquid` sets its
 * `gang_exist` flag on the first scoped media and never clears it: on a
 * multi-variant product every media must be scoped, so frames identical across
 * kits still exist three times. Five frames x three kits = fifteen media.
 */

import {
  INK, GREEN, PAPER, RULE, WASH, money, cutout, unit, scaled,
  LABEL, UNITS_PER, DISPLAY_ORDER, kitsFor, inOrder, assertBundle,
  ingredientUnion, assertAbsent, assertNoUnscentedClaim, altWithin512,
} from './gb-common.mjs';

const PRICE = 62;
const kitNamed = (name) => {
  const k = kitsFor().find((x) => x.name === name);
  if (!k) throw new Error(`config/bundles.json has no "${name}" kit of gift-box`);
  return k;
};

function assertKit(ctx, kitName) {
  assertBundle(ctx, { price: PRICE });
  if (!ctx.variants.some((v) => v.title === kitName)) {
    throw new Error(`no live variant titled "${kitName}" — a frame must depict a kit somebody can actually buy`);
  }
  return kitNamed(kitName);
}

const eyebrow = (t) => `<div style="font-family:Outfit;font-weight:300;font-size:34px;letter-spacing:.34em;
  text-transform:uppercase;color:${INK};opacity:.45;">${t}</div>`;

// ─────────────────────────────────────────────────────────────────────────────
// Frame 1 — grid / multi-SKU, per kit. What is actually in the box they chose.
//
// The lip balm is drawn as FOUR tubes. One purchased unit of that SKU is a
// four-pack, and the media plan is explicit that a single-tube photo understates
// the box — which matters more here than anywhere else, because the buyer is
// comparing $62 against a mall gift set and counting what the recipient gets.
// ─────────────────────────────────────────────────────────────────────────────
export function contentsFrame(kitName) {
  const PX_PER_CM = 40;
  return {
    product: 'gift-box',
    name: `frame-01-contents-gb-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      const kit = assertKit(ctx, kitName);
      if (new Set(kit.components.map((c) => c.kind)).size !== 4) {
        throw new Error('frame 1 claims four distinct products');
      }
      const balm = kit.components.find((c) => c.kind === 'lipbalm');
      if (!balm) throw new Error('no lip balm in the kit, but the frame draws a four-pack');
      if (UNITS_PER.lipbalm !== 4) throw new Error('UNITS_PER.lipbalm is no longer 4 — re-check the SKU before drawing four tubes');
      assertNoUnscentedClaim(this.alt());
    },

    alt() {
      const kit = kitNamed(kitName);
      const parts = inOrder(kit).map((c) => `${LABEL[c.kind]} in ${c.variant}${UNITS_PER[c.kind] > 1 ? ` (${UNITS_PER[c.kind]}-pack)` : ''}`);
      return altWithin512(`Everything in the ${kitName} Gift Box, shown to scale: ${parts.join(', ')}. Four full-size products, ${money(PRICE)}.`);
    },

    html(ctx) {
      const kit = kitNamed(kitName);
      const shelf = scaled(DISPLAY_ORDER[0], PX_PER_CM);
      const column = (c) => `
        <div style="display:flex;flex-direction:column;align-items:center;width:340px;">
          ${unit({ src: ctx.asset(cutout(c.slug)), slug: c.slug, pxPerCm: PX_PER_CM, count: UNITS_PER[c.kind], overlap: 0.28, boxH: shelf })}
          <div style="font-family:Cabin;font-weight:700;font-size:46px;color:${INK};margin-top:30px;text-align:center;">
            ${LABEL[c.kind]}${UNITS_PER[c.kind] > 1 ? ` ×${UNITS_PER[c.kind]}` : ''}
          </div>
          <div style="font-family:Outfit;font-weight:400;font-size:33px;color:${INK};opacity:.55;margin-top:8px;text-align:center;line-height:1.25;">
            ${c.variant}
          </div>
        </div>`;

      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:space-between;
        padding:96px 60px 88px;box-sizing:border-box;text-align:center;">
        <div>
          ${eyebrow(`${kitName} kit`)}
          <div style="font-family:Cabin;font-weight:700;font-size:128px;line-height:1.03;
                      color:${INK};letter-spacing:-.024em;margin-top:24px;">Four full-size things.</div>
        </div>
        <div style="display:flex;align-items:flex-start;justify-content:center;gap:20px;
                    background:${WASH};border-radius:34px;padding:74px 44px 58px;">
          ${inOrder(kit).map(column).join('')}
        </div>
        <div>
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 30px;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:64px;color:${INK};">Nothing in here is a sample.</div>
          <div style="font-family:Outfit;font-weight:400;font-size:40px;color:${INK};opacity:.6;margin-top:14px;">
            ${money(PRICE)}, shipped free
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 2 — text-only. The $62 sticker, answered with arithmetic.
//
// Media plan #7. The gift buyer has a budget and is checking whether $62 of body
// care is a real $62. Every figure is read at render time; the saving is the
// value stack against the price, and free shipping is stated as a fact about the
// order rather than counted as value — it starts at $45 site-wide, so a $62 box
// would ship free whatever we put in it.
// ─────────────────────────────────────────────────────────────────────────────
export function valueFrame(kitName) {
  return {
    product: 'gift-box',
    name: `frame-02-value-gb-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      assertKit(ctx, kitName);
      const live = ctx.variants.find((v) => v.title === kitName);
      const compare = Number(live.compareAtPrice);
      const stack = JSON.parse(ctx.need('value_stack'));
      const sum = stack.filter((r) => !r.digital).reduce((a, r) => a + Number(r.amount), 0);
      if (sum !== compare) {
        throw new Error(`the value stack sums to ${money(sum)} but compare-at is ${money(compare)} — they must agree before a frame prints a saving`);
      }
      if (compare <= PRICE) throw new Error(`compare-at ${money(compare)} is not above the price ${money(PRICE)}; there is no saving to print`);
    },

    alt(ctx) {
      const compare = Number(ctx.variants.find((v) => v.title === kitName).compareAtPrice);
      return altWithin512(`${money(compare)} of full-size Real Skin Care product in the ${kitName} Gift Box, sold for ${money(PRICE)} and shipped free.`);
    },

    html(ctx) {
      const compare = Number(ctx.variants.find((v) => v.title === kitName).compareAtPrice);
      const saving = compare - PRICE;
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:150px 130px;box-sizing:border-box;text-align:center;">
        ${eyebrow(`${kitName} kit`)}
        <div style="font-family:Cabin;font-weight:700;font-size:300px;line-height:.92;
                    color:${INK};letter-spacing:-.03em;margin-top:40px;">${money(compare)}</div>
        <div style="font-family:Outfit;font-weight:300;font-size:56px;letter-spacing:.26em;
                    text-transform:uppercase;color:${INK};opacity:.5;margin-top:22px;">of product</div>
        <div style="width:190px;height:9px;background:${GREEN};margin:64px 0 52px;border-radius:5px;"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:132px;line-height:1.05;color:${INK};">
          You pay ${money(PRICE)}.
        </div>
        <div style="font-family:Outfit;font-weight:400;font-size:46px;line-height:1.5;
                    color:${INK};opacity:.62;margin-top:56px;max-width:1400px;">
          ${money(saving)} less than buying the four separately — and it ships free.
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 3 — benefit callout. "Will they actually use it?"
//
// Media plan #4, and the sharpest thing in that spec: the giver has been burned
// by candles and bath sets that sat unopened. This frame is the only one that
// speaks to the RECIPIENT's behaviour rather than the box's contents, which is
// why it stays text — a photograph of four products cannot say "these get
// finished".
// ─────────────────────────────────────────────────────────────────────────────
export function finishFrame(kitName) {
  return {
    product: 'gift-box',
    name: `frame-03-finish-gb-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      const kit = assertKit(ctx, kitName);
      // The claim is that all four are consumables. A box that ever contains a
      // durable (a dish, a tin, a tool) makes "they'll finish it" false.
      const consumable = ['lotion', 'deodorant', 'soap', 'lipbalm'];
      for (const c of kit.components) {
        if (!consumable.includes(c.kind)) throw new Error(`${c.kind} is not a consumable — "four things they'll finish" is no longer true`);
      }
      assertNoUnscentedClaim(this.alt());
    },

    alt() {
      const kit = kitNamed(kitName);
      return altWithin512(`The ${kitName} Gift Box holds four things that get used up — `
        + `${inOrder(kit).map((c) => LABEL[c.kind].toLowerCase()).join(', ')} — rather than an ornament that gets displayed.`);
    },

    html() {
      const kit = kitNamed(kitName);
      const row = (c, i) => `
        <div style="display:flex;align-items:center;gap:28px;padding:24px 0;${i ? `border-top:3px solid ${RULE};` : ''}">
          <div style="width:22px;height:22px;border-radius:50%;background:${GREEN};flex:none;"></div>
          <div style="font-family:Cabin;font-weight:700;font-size:60px;color:${INK};">${LABEL[c.kind]}</div>
          <div style="font-family:Outfit;font-weight:300;font-size:38px;color:${INK};opacity:.45;margin-left:auto;">${c.variant}</div>
        </div>`;
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;justify-content:space-between;
        padding:110px 130px 100px;box-sizing:border-box;">
        <div style="text-align:center;">
          ${eyebrow(`${kitName} kit`)}
          <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.05;
                      color:${INK};letter-spacing:-.024em;margin-top:24px;">Four things they'll<br>finish.</div>
          <div style="font-family:Outfit;font-weight:400;font-size:52px;color:${INK};opacity:.55;margin-top:26px;">
            Not one thing they'll display.
          </div>
        </div>
        <div>${inOrder(kit).map(row).join('')}</div>
        <div style="text-align:center;">
          <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:0 auto 26px;"></div>
          <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};opacity:.62;">
            Full sizes, not travel minis.
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 4 — educational infographic. Safe to give to someone who reacts.
//
// Media plan #5, and the frame with the most ways to go wrong. The persona is
// the giver buying for a friend whose skin reacts to everything, evidenced in
// personas.md by a literal gift purchase. So the claim has to be about what is
// NOT in the box — and every absence here is asserted against
// config/ingredients.json before it renders.
//
// It deliberately does NOT say "unscented" (two kits ship a Calming Lavender
// deodorant), and does NOT say "vegan" or "no palm oil" (the lip balm carries
// organic beeswax and organic red palm oil). assertNoUnscentedClaim guards the
// first; the second is simply never claimed.
// ─────────────────────────────────────────────────────────────────────────────
const ABSENT = ['sodium lauryl sulfate', 'sodium laureth sulfate', 'paraben', 'phthalate', 'aluminium', 'aluminum'];
export function gentleFrame(kitName) {
  return {
    product: 'gift-box',
    name: `frame-04-gentle-gb-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      assertKit(ctx, kitName);
      assertAbsent(ABSENT);
      const union = ingredientUnion();
      if (union.length < 4 || union.length > 20) throw new Error(`ingredient union is ${union.length} — re-check config/ingredients.json before printing a count`);
      assertNoUnscentedClaim(this.alt() + this.html());
    },

    alt() {
      const n = ingredientUnion().length;
      return altWithin512(`The ${kitName} Gift Box is built from ${n} base ingredients across its four products, `
        + `with no SLS, no parabens, no phthalates and no synthetic fragrance — scent, where there is any, is essential oil.`);
    },

    html() {
      const union = ingredientUnion();
      const nots = ['synthetic fragrance', 'SLS or SLES', 'parabens', 'phthalates', 'aluminium'];
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;justify-content:space-between;
        padding:110px 120px 96px;box-sizing:border-box;">
        <div style="text-align:center;">
          ${eyebrow('For a friend who reacts to everything')}
          <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.04;
                      color:${INK};letter-spacing:-.024em;margin-top:24px;">${union.length} ingredients.<br>Nothing to react to.</div>
        </div>

        <div style="display:flex;gap:40px;">
          <div style="flex:1;background:${WASH};border-radius:28px;padding:44px 40px;">
            <div style="font-family:Outfit;font-weight:300;font-size:30px;letter-spacing:.26em;text-transform:uppercase;
                        color:${INK};opacity:.5;margin-bottom:24px;">What's in it</div>
            ${union.map((i) => `<div style="font-family:Outfit;font-weight:400;font-size:33px;color:${INK};opacity:.85;padding:9px 0;line-height:1.3;">${i}</div>`).join('')}
          </div>
          <div style="flex:1;padding:44px 8px;">
            <div style="font-family:Outfit;font-weight:300;font-size:30px;letter-spacing:.26em;text-transform:uppercase;
                        color:${INK};opacity:.5;margin-bottom:24px;">What isn't</div>
            ${nots.map((n) => `<div style="display:flex;align-items:center;gap:20px;padding:14px 0;">
              <div style="width:34px;height:6px;background:${GREEN};border-radius:3px;flex:none;"></div>
              <div style="font-family:Cabin;font-weight:700;font-size:44px;color:${INK};">${n}</div></div>`).join('')}
          </div>
        </div>

        <div style="text-align:center;">
          <div style="font-family:Outfit;font-weight:400;font-size:40px;line-height:1.5;color:${INK};opacity:.62;max-width:1600px;margin:0 auto;">
            Scent, where there is any, is essential oil — never synthetic fragrance.
          </div>
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame 5 — text-only. Proof borrowed from the catalogue.
//
// "of the four products inside" is load-bearing in the headline and the alt
// text: the box itself has no reviews, and without the qualifier the frame
// implies it does. Same rule every other bundle in this roster carries.
// ─────────────────────────────────────────────────────────────────────────────
function star(i, pct) {
  const d = 'M50 4 L61.8 35.9 L96 37.8 L69.2 59.4 L77.9 92.5 L50 73.9 L22.1 92.5 L30.8 59.4 L4 37.8 L38.2 35.9 Z';
  return `<svg viewBox="0 0 100 100" width="176" height="176" aria-hidden="true">
    <defs><clipPath id="gb${i}"><rect x="0" y="0" width="${(pct * 100).toFixed(3)}" height="100"/></clipPath></defs>
    <path d="${d}" fill="${INK}" opacity=".16"/><path d="${d}" fill="${INK}" clip-path="url(#gb${i})"/></svg>`;
}

export function reviewsFrame(kitName) {
  return {
    product: 'gift-box',
    name: `frame-05-reviews-gb-${kitName.toLowerCase()}`,
    width: 2048,
    height: 2048,

    verify(ctx) {
      assertKit(ctx, kitName);
      const value = Number(ctx.need('rating_value'));
      const count = Number(ctx.need('rating_count'));
      if (!Number.isFinite(value) || value <= 0 || value > 5) throw new Error(`rating_value out of range: ${value}`);
      if (!Number.isInteger(count) || count <= 0) throw new Error(`rating_count is not a positive integer: ${count}`);
      if (count < 25) throw new Error(`only ${count} reviews — too thin to carry a proof frame`);
    },

    alt(ctx) {
      return altWithin512(`${Number(ctx.need('rating_value')).toFixed(2)} out of 5 stars from ${ctx.need('rating_count')} `
        + `customer reviews of the four products inside the Gift Box.`);
    },

    html(ctx) {
      const value = Number(ctx.need('rating_value'));
      const count = Number(ctx.need('rating_count'));
      const stars = Array.from({ length: 5 }, (_, i) => star(i, Math.min(1, Math.max(0, value - i)))).join('');
      return `<div style="width:100%;height:100%;background:${PAPER};
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:150px 130px;box-sizing:border-box;text-align:center;">
        ${eyebrow('The Gift Box')}
        <div style="display:flex;gap:28px;margin:80px 0 52px;">${stars}</div>
        <div style="font-family:Cabin;font-weight:700;font-size:380px;line-height:.92;color:${INK};letter-spacing:-.03em;">${value.toFixed(2)}</div>
        <div style="width:190px;height:9px;background:${GREEN};margin:70px 0 58px;border-radius:5px;"></div>
        <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1.18;color:${INK};max-width:1650px;">
          ${count} reviews of the four<br>products inside.
        </div>
        <div style="font-family:Outfit;font-weight:400;font-size:44px;line-height:1.5;color:${INK};opacity:.62;margin-top:52px;max-width:1300px;">
          You are not gambling on the contents.
        </div>
      </div>`;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The three spec frames that are NOT here, and why.
//
// #1 "Arrives in this." and #2 "You don't have to wrap it." — MUST-SHOOT. The
//    whole $62 rests on the box arriving giftable, and that is a photographic
//    claim: there is no photograph of a production Gift Box anywhere in this
//    repo or on the product. A composite of four cut-out products cannot make
//    it, and a GENERATED box would be inventing packaging we would then have to
//    ship. The media plan hard-gates this shoot on mid-September for Q4 gifting;
//    from 2026-08-02 that is roughly six weeks of lead time, and it is the
//    critical path for this bundle.
//
// #6 "Full-size. Not sample-size." — the plan's own note says to "verify the
//    mini-size premise on a shelf before shipping the frame". That verification
//    has not happened, and a comparison frame whose opposing column is an
//    assumption about someone else's product is exactly the kind of claim this
//    pipeline exists to stop. Frame 1's "Nothing in here is a sample" and frame
//    3's "Full sizes, not travel minis" make the same point about OUR products
//    only, which needs no shelf.
// ─────────────────────────────────────────────────────────────────────────────
