# Handoff — redesign the remaining 21 Klaviyo emails

**Written:** 2026-07-30
**Status:** Tooling, brand kit and format guidance all shipped. One email (Winback 03)
rebuilt and verified but **not yet pasted into Klaviyo**. 21 remain.
**Prerequisite reading:** `data/brand/email-format-matrix.md`, then
`data/brand/brand-kit.md`. Invoke the `marketing-email-design-production` skill before
building anything.

## The one thing that will waste your afternoon if you skip it

**Flow email content cannot be written through the API.** Measured 2026-07-30:

| Call | Result |
|---|---|
| `GET /api/templates/{id}` | **200** — full HTML |
| `PATCH /api/templates/{id}` | **404** "Template … does not exist" |
| `PATCH /api/flow-messages/{id}` | **405** method_not_allowed |
| `POST` + `PATCH /api/templates` (one you create) | **200** — works |

Identical 404 on revisions `2024-10-15`, `2025-01-15`, `2025-07-15`, so it is not a
versioning artifact. A *library* template is writable; a *flow-owned* one is not. That
distinction has now fooled two people — the project note said "not editable", a previous
session (me) "corrected" it after proving PATCH on a scratch template, and then hit the
404 for real. **Do not re-litigate it. Build the HTML here, paste it there.**

All 22 templates are `editor_type: CODE`, so pasting is a select-all-and-replace in
Klaviyo's code editor, not a block-by-block rebuild.

## Decided: all 21 are full redesigns, not restyles

The remaining 21 have no performance history, so there is no baseline to protect and no
attribution to preserve. Redesign them properly against the matrix — copy included.

This differs from how Winback 03 started. Its first pass was a faithful restyle, which
was the wrong call for a promotional email; it was then rebuilt as a full redesign. Don't
repeat the first pass.

Consequence for the verifier: run it with `--redesign`, which downgrades the copy check
to a warning while still enforcing Klaviyo tags, links, palette and postal address.

## Per-email workflow

```bash
node scripts/klaviyo-email-audit.mjs --dump-html   # refresh audit + pull current HTML
cp data/reports/email-audit/html/<id>.html data/brand/email-rebuild/<id>.before.html
# build data/brand/email-rebuild/<id>.after.html
node scripts/verify-email-rebuild.mjs <id> --redesign
```

Then in Klaviyo: Flows → flow → message → Edit email → code editor → paste → save →
send yourself a preview.

**Check in the preview, every time:** the coupon renders a real code (not literal
`{% coupon_code %}`), the unsubscribe link resolves, the logo loads from the CDN, and
dark mode swaps the logo when you toggle your client's appearance.

## What the verifier catches, and why each check exists

- **Klaviyo tags survive** — a dropped `{% coupon_code %}` ships a broken offer; a dropped
  `{% unsubscribe %}` is a CAN-SPAM violation.
- **No link lost.**
- **Copy** — strict by default, warning under `--redesign`.
- **Every colour on-palette** — against `brand-kit.json`, so it follows the palette
  automatically if that changes.
- **Postal address survives** — CAN-SPAM. It is hardcoded in these templates, not
  injected by Klaviyo.
- **Live drift** — re-fetches the template and warns if it no longer matches
  `.before.html`. These files are a snapshot; pasting over someone's UI edit silently
  reverts their work.

## Format is per-flow, not universal

Read `data/brand/email-format-matrix.md` before designing each one. The short version:

- **Designed, image-led:** Winback, Welcome 03/05, Abandoned Cart, Browse Abandonment
- **Plain, link-light:** Welcome 02/04, Post-Purchase 01/02/04, Replenishment
- **Plain, functional:** Coconut Reset digital delivery — **transactional**, treat with
  the most care of any on the list
- **Split:** Product Review / Cross-Sell — personal ask first, product block second

Blanket "universal email rules" are really promo-campaign rules. Styling an education
email like a sale pushes it out of the primary tab, which is exactly where the
transition-period explanation has to land.

## Brand facts you will need

- Palette: `#000000` · `#EDE5D8` sand · `#AEDEAC` green (accent only, one element per
  email) · `#EDEDED`. **`#C1DF6D` is retired** — finding it means something was built
  from the old PDF palette.
- Type: headings `Cabin, 'Trebuchet MS', 'Segoe UI', Tahoma, sans-serif`; body
  `Outfit, 'Helvetica Neue', Helvetica, Arial, sans-serif`. These are the *live site*
  fonts. The PDF says Mont; the site does not use it and the site wins.
- Logos are hosted — URLs in `brand-kit.json` under `logo.cdn_urls`. Black by default,
  white under `prefers-color-scheme: dark`; the snippet is in `email_rules.dark_mode`.
- Product imagery comes from the live PDP URL, not hand-exported files.

## Known trap: skills load from the main checkout

`Skill` reads `/Users/seanfillmore/Code/Claude/.claude/skills/`, **not your worktree**.
If the main checkout is behind, you get stale guidance — this session invoked
`marketing-email-design-production` and received an 8-section version predating #388,
missing the rule it needed. Before relying on any skill:

```bash
git -C /Users/seanfillmore/Code/Claude pull
```

Note that pull can abort on untracked files (it did here, on the logo drop). Move them
aside rather than deleting, and verify afterwards.

## Immediate next step

Winback 03 (`SCxShR`) is built, verified and unpasted. Paste it, preview it, confirm it
renders, and only then start the other 21 — it is the proof that the whole path works.
