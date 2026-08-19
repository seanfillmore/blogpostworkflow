# Setting type on an Ad Studio plate

A plate carries **no text**. The operator sets every headline, badge and bar in Photoshop, so
type colour is decided *after* rendering and is not something the render can get right or
wrong. What a plate decides is the **ground** — and the ground decides which colours are
legible on it.

This file exists because that pairing was worked out once, from measured contrast, and would
otherwise be re-derived by eye every time.

## The brand palette

From `data/brand/brand-kit.json` (`palette_hexes`, and `colors` for the roles):

| token | hex | role in the brand |
|---|---|---|
| black | `#000000` | primary — logo, headlines, body text, primary button fill |
| sand | `#EDE5D8` | warm neutral — section backgrounds, blocks |
| green | `#AEDEAC` | accent — the leaf mark, sub-headings, highlights |
| grey | `#EDEDED` | cool neutral — dividers, subtle panels |

## The finding that matters

**Three of the four brand colours are the same luminance.** Sand, green and grey are all
light neutrals. Contrast ratios of each palette colour as type against each plate ground:

| ground | black | sand | green | grey | white |
|---|---|---|---|---|---|
| sand `#EDE5D8` | **16.8** | — | 1.2 | 1.1 | 1.2 |
| green `#AEDEAC` | **13.8** | 1.2 | — | 1.3 | 1.5 |
| grey `#EDEDED` | **17.9** | 1.1 | 1.3 | — | 1.2 |
| charcoal `#000000` | — | **16.8** | **13.8** | **17.9** | **21.0** |

1.1–1.5:1 is not "weak", it is **invisible**. So:

- **On the three light grounds — sand, green, grey — black is the only usable type colour.**
- **`charcoal-contrast` is the only plate where the palette opens up.** Sand, green, grey and
  white are all excellent on it. If you want a coloured headline, that is the plate.

## Getting colour onto a light plate anyway

Reverse the type out of a black block. `giveaway-entry`'s own `layoutBrief` already calls for
one — *"a bold badge or ribbon"* for the entry CTA and *"a solid black bar across the very
bottom"* — so this is the format's existing furniture, not a new device:

- green on black — **13.8:1**
- sand on black — **16.8:1**

That makes green or sand legible on **any** plate, inside the badge and the bottom bar, while
body and headline type on the ground itself stays black.

## Rules

1. Body and headline type directly on a light ground: **black**.
2. Coloured type: either on `charcoal-contrast`, or reversed out of a black block.
3. Green is an **accent**, per the brand kit — a rule, an underline, a badge fill, a
   sub-heading. It is not a body-text colour anywhere.
4. Never introduce a colour outside `palette_hexes`. A giveaway ad is the asset that reaches
   cold audiences; it is the worst place for an off-brand frame. One plate rendered its
   *label* type in brown and had to be re-rendered — brown is not in the palette.

## Recomputing this

If a plate treatment adds a new ground, or the palette changes, recompute rather than
guessing — the numbers above are the whole point:

```js
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const L = h => { const n = parseInt(h.slice(1), 16);
  return 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255); };
const contrast = (a, b) => { const x = L(a), y = L(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
```

Read it as: **7+ excellent, 4.5+ good, 3+ large type only, below 3 unusable.** Ads are not
held to WCAG, but a giveaway ad is read at feed scale on a phone, where anything under 4.5
stops being an ad and starts being a texture.

## Where the plate treatments are defined

`agents/ad-studio/formats.js` → `giveaway-entry.plateVariants`. Each entry names its ground
hex, and a test asserts every ground stays inside `palette_hexes`.
