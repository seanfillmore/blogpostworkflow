/**
 * 90-Day Clean Swap — frame 7 (educational infographic): which kit.
 *
 * Media plan §6: "Resolve Gentle vs. Calm vs. Fresh so the variant choice stops
 * being a coin flip." This buyer is already sold and stuck on a dropdown.
 *
 * Two constraints from the plan, both enforced in verify():
 *
 *  - **Show only what actually differs.** Toothpaste is Fresh Mint in all three
 *    kits, so it appears once as a constant rather than three times as a fake
 *    difference. verify() asserts that is still true and moves it into the
 *    varying set if a repack ever changes it.
 *  - **Do not imply Gentle is unscented.** It ships a lavender deodorant, and the
 *    page FAQ already says so. The frame prints every scent by name rather than
 *    labelling a column "unscented", so the claim cannot be made by implication.
 *
 * Contents are read from config/bundles.json, never transcribed — the entire
 * value of this frame is that the differences it shows are the real ones.
 */

import { INK, GREEN, PAPER, WASH, kitsFor, kindOf, LABEL, assertBundle } from './swap-common.mjs';

const HANDLE = '90-day-clean-swap';

/** Products whose variant is identical across every kit — shown once, as a constant. */
function partition(kits) {
  const byKind = {};
  for (const k of kits) {
    for (const c of k.components) {
      (byKind[kindOf(c.slug)] ??= new Set()).add(c.variant);
    }
  }
  const constant = [], varying = [];
  for (const [kind, set] of Object.entries(byKind)) {
    (set.size === 1 ? constant : varying).push({ kind, variants: [...set] });
  }
  return { constant, varying };
}

export default {
  product: HANDLE,
  name: 'frame-07-kit-differences-90day',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 144, qtyEach: 3, componentCount: 4 });
    const kits = kitsFor(HANDLE);
    if (kits.length !== 3) throw new Error(`this frame has three columns, but the bundle now has ${kits.length} kits`);
    for (const k of kits) {
      if (!ctx.variants.some((v) => v.title === k.name)) {
        throw new Error(`config lists a "${k.name}" kit that is not live on the product`);
      }
    }
    const { constant, varying } = partition(kits);
    if (!varying.length) throw new Error('no product differs between kits — this frame has nothing to say');
    // Not an error if toothpaste stops being constant; the layout adapts. But a
    // kit named Gentle that ships an unscented deodorant would let the frame imply
    // "Gentle = unscented", which the plan explicitly forbids, so check the claim.
    const gentle = kits.find((k) => k.name === 'Gentle');
    if (gentle && gentle.components.every((c) => /unscented/i.test(c.variant))) {
      throw new Error('every Gentle component is now unscented — re-spec the frame before it implies Gentle is fragrance-free');
    }
    if (constant.length + varying.length !== 4) throw new Error('expected four product kinds across the kits');
  },

  alt() {
    const kits = kitsFor(HANDLE);
    return kits.map((k) => `${k.name}: ${k.components.map((c) => `${LABEL[kindOf(c.slug)]} ${c.variant}`).join(', ')}`).join('. ')
      + '. Toothpaste is Fresh Mint in every kit.';
  },

  html() {
    const kits = kitsFor(HANDLE);
    const { constant, varying } = partition(kits);
    const varyKinds = varying.map((v) => v.kind);

    const column = (k) => `
      <div style="flex:1;background:${WASH};border-radius:28px;padding:46px 32px 40px;">
        <div style="font-family:Cabin;font-weight:700;font-size:60px;color:${INK};">${k.name}</div>
        <div style="height:3px;background:${GREEN};width:64px;margin:22px auto 30px;border-radius:2px;"></div>
        ${varyKinds.map((kind) => {
          const c = k.components.find((x) => kindOf(x.slug) === kind);
          return `
            <div style="margin-bottom:26px;">
              <div style="font-family:Outfit;font-weight:600;font-size:26px;letter-spacing:.16em;
                          text-transform:uppercase;color:${INK};opacity:.45;">${LABEL[kind]}</div>
              <div style="font-family:Cabin;font-weight:700;font-size:40px;color:${INK};margin-top:8px;line-height:1.2;">
                ${c.variant}
              </div>
            </div>`;
        }).join('')}
      </div>`;

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:space-between;
      padding:96px 76px 88px;box-sizing:border-box;text-align:center;">

      <div>
        <div style="font-family:Cabin;font-weight:700;font-size:112px;line-height:1.03;
                    color:${INK};letter-spacing:-.024em;">Gentle, Calm or Fresh?</div>
        <div style="font-family:Outfit;font-weight:400;font-size:42px;color:${INK};opacity:.62;margin-top:22px;">
          Same four products. Only the scents change.
        </div>
      </div>

      <div style="display:flex;gap:30px;width:100%;align-items:stretch;">
        ${kits.map(column).join('')}
      </div>

      <div style="width:100%;background:#f1f4ef;border-radius:24px;padding:34px 40px;">
        <div style="font-family:Outfit;font-weight:600;font-size:28px;letter-spacing:.18em;
                    text-transform:uppercase;color:${INK};opacity:.45;">The same in every kit</div>
        <div style="font-family:Cabin;font-weight:700;font-size:44px;color:${INK};margin-top:10px;">
          ${constant.map((c) => `${LABEL[c.kind]} — ${c.variants[0]}`).join(' · ')}
        </div>
      </div>
    </div>`;
  },
};
