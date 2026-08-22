/**
 * Ad 4 — the whole ingredient list, as the argument.
 *
 * "Reading the actual ingredient list and finding only recognizable words is
 * what closes the sale" — 5 mentions, data/context/voice-of-customer.md. So the
 * list is not summarised into a claim; it is printed.
 *
 * The count is DERIVED from config/ingredients.json. It is eight across both
 * formulas, and it is derived precisely because a typed six shipped to the live
 * lander and was wrong — six is true of the lotion alone.
 *
 * Two entries stay in that a tidier ad would drop, because dropping them would
 * imply things that are not true:
 *   organic red palm oil  → this is not a palm-free product
 *   organic beeswax       → this is not a vegan product
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK, GREEN, MINT, PAPER, LOTION, JAR, shell } from './ad-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INGREDIENTS = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

export function union() {
  const out = [];
  for (const key of ['lotion', 'cream']) {
    for (const i of INGREDIENTS[key].base_ingredients) {
      if (!out.some((x) => x.toLowerCase() === i.toLowerCase())) out.push(i);
    }
  }
  return out;
}

/** Shortened for a pill, without changing what the ingredient is. */
const short = (s) => s.replace(/^organic /i, '').replace(/^purified /i, '')
  .replace('plant-based emulsifying wax', 'plant emulsifying wax');

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export default {
  product: '99-coconut-reset-digital',
  name: 'ad-04-short-list',
  width: 1080,
  height: 1350,

  verify() {
    const ours = union();
    if (ours.length < 3) throw new Error(`union looks truncated: ${JSON.stringify(ours)}`);
    for (const must of ['red palm oil', 'beeswax']) {
      if (!ours.some((i) => i.toLowerCase().includes(must))) {
        throw new Error(`"${must}" is no longer in the union — this ad prints it on purpose`);
      }
    }
    if (ours.length > 12) throw new Error(`${ours.length} pills will not fit this layout`);
  },

  alt: () => {
    const ours = union();
    return `The ${ours.length} ingredients in the 90-Day Coconut Reset, listed in full: ${ours.join(', ')}. `
      + 'Shown with the Coconut Breeze body lotion and body cream.';
  },

  html: (ctx) => {
    const ours = union();
    const chip = (t) => `
      <div style="background:${PAPER};border-radius:999px;padding:13px 22px;
                  font-family:Outfit;font-weight:600;font-size:25px;color:${INK};
                  box-shadow:0 3px 12px rgba(26,27,24,.09);white-space:nowrap;">${cap(short(t))}</div>`;
    return shell({
      bg: MINT,
      disc: 'rgba(255,255,255,.55)',
      headline: `${ours.length} ingredients.<br>That's the whole list.`,
      sub: 'Both formulas. Nothing held back for a footnote.',
      body: `
        <div style="display:flex;align-items:flex-end;justify-content:center;height:100%;">
          <img src="${ctx.asset(LOTION)}" style="height:100%;width:auto;object-fit:contain;display:block;">
          <img src="${ctx.asset(JAR)}" style="height:44%;width:auto;object-fit:contain;display:block;
                                              margin-left:-40px;">
        </div>`,
      footer: `
        <div style="display:flex;gap:11px;justify-content:center;flex-wrap:wrap;margin-bottom:24px;">
          ${ours.map(chip).join('')}
        </div>
        <div style="font-family:Cabin;font-weight:700;font-size:36px;color:${GREEN};">
          The 90-Day Coconut Reset
        </div>`,
    });
  },
};
