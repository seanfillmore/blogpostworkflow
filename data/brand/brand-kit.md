# Real Skin Care — Brand Kit

Source: `Real Skin Care Brand Kit.pdf` (4 pages, supplied 2026-07-29). Machine-readable
companion: [`brand-kit.json`](./brand-kit.json), which is what
`scripts/klaviyo-email-audit.mjs` audits against.

This is the artifact `marketing-email-design-production` asks for in its first
section — "assemble the brand kit once as a persisted design system … and have every
later email generation inherit it." It did not exist until now, which is the direct
cause of the email incoherence measured below.

## Colours

| Swatch | Hex | Role |
|---|---|---|
| Black | `#000000` | Logo, headlines, body text, primary button fill |
| Sand | `#EDE5D8` | The only warm tone — section backgrounds, blocks, the leaf flourish beside headings |
| Green | `#C1DF6D` | Accent only — leaf mark, sub-headings, a single highlighted phrase |
| Grey | `#EDEDED` | Dividers, subtle panels, shadow bases |

The source document uses green sparingly: one accent word per page plus the leaf
shape. Treat it as an accent, never a background fill.

## Typography

**The identity PDF and the live site disagree, and the site wins for email.**

The PDF specifies **Mont** (Bold / Semibold / Book). The live site does not use it —
`realskincare.com` serves **Cabin** for headings and **Outfit** for body from Shopify's
font CDN (verified 2026-07-30 from the theme's `--font-heading-family` and
`--font-body-family`). Since the goal is cohesion from site to inbox, email follows the
site. Mont is retained above as a record of the identity document, not as the rule.

Email stacks:

```css
/* headings */
font-family: Cabin, 'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif;
/* body */
font-family: Outfit, 'Helvetica Neue', Helvetica, Arial, sans-serif;
```

Name the real site font first — it renders in Apple Mail and iOS Mail, a large share of
opens. Then fall back to the closest widely-installed face. Cabin is a humanist sans, so
**Trebuchet MS** is the nearest universally-installed match and keeps some character in
headings. Outfit is geometric with a tall x-height and has no true web-safe equivalent,
so body falls to **Helvetica/Arial** — neutral, and most legible at small sizes. Using
different fallbacks preserves the heading/body distinction even when web fonts are
stripped.

> **The single biggest cohesion gain is here, not in colour.** All 22 live emails lead
> with `Georgia, serif`. Moving from a serif to either sans stack closes more of the
> visual gap than any palette change.

Worth deciding deliberately at some point: whether the site should move to Mont, or the
identity document should be updated to match the site. Right now they are two different
brands typographically.

## Logo

- **Wordmark:** `real` in an italic high-contrast serif, with a leaf-shaped counter
  replacing the stem terminal of the *r*, above `SKIN CARE` in widely letterspaced
  sans caps.
- **Monogram:** the lowercase *r* with its leaf terminal, standalone (page 4, top right).
- **Colorways supplied:** black, white, sand, green, grey — all transparent.

Files belong in [`data/brand/logo/`](./logo/) — see the README there for expected
filenames. Two things still to settle: the files need hosting at a URL before any
Klaviyo template can reference them, and the green colorway reads as a softer sage than
palette green `#C1DF6D`, so sample it and reconcile before use.

## Design elements

Hairline rule · soft elliptical drop shadow · sand circle · sand rectangle · draped
white fabric cutout · soft diagonal light-and-shadow overlay · green leaf shape
(echoing the logo's *r*) · wooden circular podium for product shots.

## Email application

Not from the PDF — the PDF is a visual identity document and says nothing about email.
Derived from the kit plus `marketing-email-design-production`:

| Element | Rule |
|---|---|
| Body background | `#FFFFFF`; `#EDE5D8` for alternating section blocks |
| Body text | Outfit → Helvetica/Arial, `#000000` |
| Headline | Cabin → Trebuchet MS, `#000000` |
| Accent | `#C1DF6D` on **one** element per email maximum. Not button fills, not backgrounds. |
| Primary button | `#000000` fill, `#FFFFFF` label |
| Divider | `#EDEDED`, or the black hairline rule |

Off-brand signals to reject: **any serif body stack** (Georgia above all — it is what
all 22 live emails use); purple or blue gradients; Inter/Roboto/system-only font stacks;
`#C1DF6D` as a large background; more than one accent colour per email.

## Measured state of the live emails (2026-07-30)

`scripts/klaviyo-email-audit.mjs` against the 8 live Klaviyo flows: **22 emails, 0 of
them on-brand.** All 22 fail on the same three counts.

The failure is not randomness — it is a **near-miss palette**, which is exactly what
reads as incoherent:

| Brand | In use instead |
|---|---|
| Sand `#EDE5D8` | `#E6DED1`, `#F5F1EA` |
| Green `#C1DF6D` | `#2F5E3F` (a dark forest green — a different colour entirely) |
| Black `#000000` | `#2B2B2B`, `#3D3D3D` |
| Grey `#EDEDED` | `#6B6B6B`, `#9A9385` |

All 22 also declare `Georgia, serif, Helvetica, Arial, sans-serif` — a serif-led stack
carrying neither site font, so the type contradicts the website in every email, and none
carries the brand neutral or accent at all.

**All 22 templates are `editor_type: CODE`**, so every one can be corrected by
`PATCH /api/templates/{id}`. See `scripts/klaviyo-email-audit.mjs` for how the content
is reached and what was verified.

## Known gaps in this kit

1. **Logo files not yet in the repo.** All five transparent colorways exist — drop point
   and expected filenames are at [`data/brand/logo/`](./logo/).
2. **Logo files are not hosted.** Klaviyo references images by URL, so they need
   uploading to Klaviyo or the Shopify CDN and the URLs recording here before any
   template can use them.
3. **Green colorway may not be `#C1DF6D`.** The supplied green logo reads as a softer
   sage than palette green. Sample the file and reconcile.
4. **No transparent-background product images catalogued** — a required brand-kit input
   per the email skill.
5. **No layout exemplars.** The skill's own fit note records that the "ten best
   past-performing emails" input doesn't exist here and competitor reference emails
   must substitute.
6. **Mont vs Cabin/Outfit.** The identity document and the live site specify different
   typefaces. Not a blocker — email follows the site — but worth resolving deliberately
   rather than leaving two definitions of the brand in circulation.
