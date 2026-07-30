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

- **Mont Bold** — headlines
- **Mont Semibold** — sub-heads
- **Mont Book** — body

**Mont will not render in most email clients.** It is not web-safe and not a Google
font, so the stack that recipients actually see is:

```css
font-family: 'Mont', 'Montserrat', 'Helvetica Neue', Arial, sans-serif;
```

Montserrat is the closest widely-available geometric sans and *is* a Google font, so
it renders wherever web fonts are supported. Design to the Montserrat fallback, not to
Mont, or the emails will look nothing like the comps.

## Logo

- **Wordmark:** `real` in an italic high-contrast serif, with a leaf-shaped counter
  replacing the stem terminal of the *r*, above `SKIN CARE` in widely letterspaced
  sans caps.
- **Monogram:** the lowercase *r* with its leaf terminal, standalone (page 4, top right).
- **Colorway supplied:** solid black only.

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
| Headline | Mont Bold, `#000000` |
| Accent | `#C1DF6D` on **one** element per email maximum. Not button fills, not backgrounds. |
| Primary button | `#000000` fill, `#FFFFFF` label |
| Divider | `#EDEDED`, or the black hairline rule |

Off-brand signals to reject: purple or blue gradients; Inter/Roboto/system-only font
stacks; `#C1DF6D` as a large background; more than one accent colour per email.

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
with no Mont or Montserrat anywhere, so the type is off-brand in every email, and none
carries the brand neutral or accent at all.

**All 22 templates are `editor_type: CODE`**, so every one can be corrected by
`PATCH /api/templates/{id}`. See `scripts/klaviyo-email-audit.mjs` for how the content
is reached and what was verified.

## Known gaps in this kit

1. **No logo files in the repo.** PNG/SVG with transparent background needed, plus a
   reversed white colorway for dark sections. The PDF supplies black only.
2. **Mont licensing for web/email is unconfirmed.** The fallback stack is what ships.
3. **No transparent-background product images catalogued** — a required brand-kit input
   per the email skill.
4. **No layout exemplars.** The skill's own fit note records that the "ten best
   past-performing emails" input doesn't exist here and competitor reference emails
   must substitute.
5. **"Delightful Signs"** appears as the heading above the palette on page 3. Ambiguous
   whether that names an accent typeface or is decorative copy — deliberately not
   recorded as a font until confirmed.
