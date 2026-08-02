/**
 * 90-Day Clean Swap — frame 6 (us-vs-them): read both labels.
 *
 * Media plan §6: "Win the ingredient argument against the drugstore 'gentle'
 * default." Nobody is named on the frame — same rule as the Reset's comparison
 * and the Sensitive Skin Set's: we contrast against the category, and the real
 * products stay recorded in data/brand/reference/ for traceability.
 *
 * ── Why two categories and not one ──────────────────────────────────────────
 * The specced headline was "Coconut oil, not petrolatum." It does not survive
 * contact with the panel: the published lotion list Sean supplied contains no
 * petrolatum, so the frame would have been contrasting against something that is
 * not there. Sean supplied a toothpaste panel on 2026-08-02, so the frame now
 * runs two categories and argues from what the labels actually say.
 *
 * Count alone is the weaker half here — 34 against 6 is stark, 13 against 8 is
 * not — so each row also names the specific things in their list that are absent
 * from ours. Every one of those names is asserted below to be present in the
 * comparison panel and absent from our own ingredients, so the frame cannot make
 * a contrast the data does not support.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK, GREEN, PAPER, WASH, assertBundle } from './swap-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', 'brand', 'reference', f), 'utf8'));
const ING = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

const ours = (key, variant) => {
  const p = ING[key];
  const v = p.variations.find((x) => x.name === variant);
  return [...p.base_ingredients, ...(v?.essential_oils ?? [])];
};

const ROWS = [
  {
    category: 'Body lotion',
    ourList: () => ours('lotion', 'Pure Unscented'),
    panel: 'comparison-lotion.json',
    callouts: ['Fragrance (Parfum)', 'Phenoxyethanol', 'Propylene Glycol'],
  },
  {
    category: 'Toothpaste',
    ourList: () => ours('toothpaste', 'Fresh Mint'),
    panel: 'comparison-toothpaste.json',
    callouts: ['Sodium Lauryl Sulfate', 'Titanium Dioxide', 'Blue 1'],
  },
];

export default {
  product: '90-day-clean-swap',
  name: 'frame-06-ingredients-90day',
  width: 2048,
  height: 2048,

  verify(ctx) {
    assertBundle(ctx, { price: 144, qtyEach: 3, componentCount: 4 });

    for (const r of ROWS) {
      const panel = read(r.panel);
      const theirs = panel.ingredients;
      const mine = r.ourList();

      if (!(mine.length < theirs.length)) {
        throw new Error(`${r.category}: ours is ${mine.length} and theirs is ${theirs.length} — the frame's shape assumes ours is shorter.`);
      }
      if (/leading|best.?selling|number one|#1/i.test(panel.labelOnFrame)) {
        throw new Error(`${r.category}: comparison label "${panel.labelOnFrame}" makes a ranking claim we cannot support`);
      }
      for (const c of r.callouts) {
        const inTheirs = theirs.some((i) => i.toLowerCase().includes(c.toLowerCase()));
        if (!inTheirs) throw new Error(`${r.category}: "${c}" is not on the comparison panel — the frame cannot contrast against it`);
        const inOurs = mine.some((i) => i.toLowerCase().includes(c.toLowerCase().split(' (')[0]));
        if (inOurs) throw new Error(`${r.category}: "${c}" is in OUR list too — that contrast is false`);
      }
    }
  },

  alt() {
    const l = read('comparison-lotion.json').ingredients.length;
    const t = read('comparison-toothpaste.json').ingredients.length;
    return `Ingredient comparison. Our body lotion has ${ours('lotion', 'Pure Unscented').length} ingredients `
      + `against ${l} in a conventional coconut oil lotion; our Fresh Mint toothpaste has `
      + `${ours('toothpaste', 'Fresh Mint').length} against ${t} in a conventional toothpaste.`;
  },

  html() {
    const row = (r) => {
      const panel = read(r.panel);
      const mine = r.ourList();
      return `
        <div style="display:flex;gap:28px;width:100%;align-items:stretch;margin-bottom:34px;">
          <div style="flex:1;background:${WASH};border-radius:26px;padding:40px 40px 34px;text-align:left;">
            <div style="font-family:Outfit;font-weight:600;font-size:28px;letter-spacing:.18em;
                        text-transform:uppercase;color:${GREEN};">${r.category} · ours</div>
            <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1;color:${INK};margin-top:12px;">${mine.length}</div>
            <div style="font-family:Outfit;font-weight:400;font-size:30px;line-height:1.4;color:${INK};opacity:.66;margin-top:16px;">
              ${mine.map((i) => i.replace(/^organic /, '')).join(' · ')}
            </div>
          </div>
          <div style="flex:1;background:rgba(247,248,245,.55);border-radius:26px;padding:40px 40px 34px;text-align:left;">
            <div style="font-family:Outfit;font-weight:600;font-size:28px;letter-spacing:.18em;
                        text-transform:uppercase;color:${INK};opacity:.45;">${panel.labelOnFrame}</div>
            <div style="font-family:Cabin;font-weight:700;font-size:96px;line-height:1;color:${INK};opacity:.6;margin-top:12px;">${panel.ingredients.length}</div>
            <div style="margin-top:18px;">
              ${r.callouts.map((c) => `
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
                  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                    <path d="M5 5 L19 19 M19 5 L5 19" stroke="${INK}" stroke-opacity=".4" stroke-width="3" stroke-linecap="round"/>
                  </svg>
                  <div style="font-family:Cabin;font-weight:700;font-size:34px;color:${INK};opacity:.72;">${c}</div>
                </div>`).join('')}
              <div style="font-family:Outfit;font-weight:400;font-size:27px;color:${INK};opacity:.5;margin-top:12px;">
                None of these is in ours.
              </div>
            </div>
          </div>
        </div>`;
    };

    return `<div style="width:100%;height:100%;background:${PAPER};
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:80px 76px;box-sizing:border-box;text-align:center;">

      <div style="font-family:Cabin;font-weight:700;font-size:118px;line-height:1.03;
                  color:${INK};letter-spacing:-.026em;">Read both labels.</div>
      <div style="width:120px;height:6px;background:${GREEN};border-radius:3px;margin:30px auto 44px;"></div>

      ${ROWS.map(row).join('')}

      <div style="font-family:Outfit;font-weight:400;font-size:34px;color:${INK};opacity:.58;margin-top:8px;">
        Ours printed in full. Theirs is the published panel, brand not named.
      </div>
    </div>`;
  },
};
