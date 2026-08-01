# Handoff — bundle creative production

**Written:** 2026-07-31
**For:** a fresh session picking up creative work on the 10 bundles
**Prerequisite reading:** `docs/bundle-media-plan.md` (frame stacks, shoot list, rules), then `docs/bundle-marketing-plan.md` (per-bundle playbook, angle, channel)

## Context you need first

Sean is **not** running paid traffic and is **not** pushing for sales. Do not raise sales figures, conversion, or inventory levels — restocking happens when traffic starts, and it is explicitly a non-issue until then. The entire goal is **building the foundation to scale to $1M/yr**. Creative is the current gap.

## The three blockers in the media plan are all cleared

`docs/bundle-media-plan.md` §0 lists three decisions "not mine to settle". All three are resolved as of 2026-07-31 — do not re-raise them:

1. **Ingredient claims — resolved, no work needed.** "no palm oil" appears nowhere live. The Gift Box lander already discloses *"Contains beeswax in the lip balm, so this box is not vegan."* Clean Swap's "Vegan and cruelty-free" is accurate — its four components (lotion, deodorant, toothpaste, soap) contain no beeswax, which `config/ingredients.json` places only in cream and lip balm. **`config/ingredients.json` is correct and is the source of truth**; the copy was already fixed.
2. **Head-to-Toe frame 3 — dissolved.** It was specced as "$105. Seven products. $15 each." The bundle repriced to **$87** on 2026-07-31, so per-item is $12.43 and the arithmetic the frame depended on no longer holds. Cut it; the frame stack leads on completeness like every other bundle.
3. **Coconut Reset digital-goods frame — buildable.** Both PDFs are real, not stubs: the Routine & Tracker is **5.2 MB** and the Field Guide **9.1 MB**, both live on the Shopify CDN and delivered by Klaviyo flow `XFdcu6`.

## The actual state of bundle imagery

Measured live 2026-07-31. The media plan's "What already exists" table (§2) is **stale** — it predates a product rebuild.

| Bundle | Images | Note |
|---|--:|---|
| Bar Soap 4-Pack | 5 | placeholder |
| Head-to-Toe | 2 | placeholder |
| Sensitive Skin Set | 1 | placeholder; alt text missing |
| 90-Day Clean Swap | 1 | placeholder |
| **90-Day Coconut Reset** | **0** | ⚠️ **was 3.** See below |
| Hand Soap Set | 0 | 15 variants |
| The Clean Swap | 0 | |
| Gift Box | 0 | |
| Deodorant 4-Pack | 0 | |
| Toothpaste 3-Pack | 0 | |

**All ten bundles need new imagery designed.** Sean confirmed 2026-07-31 that the images on the four non-zero bundles are placeholders, not finished assets — so the count above is a measure of what exists, not of what is usable. Six bundles start from nothing; the other four start from something that has to be replaced.

Do not treat the four as "done" and skip them.

### The Reset lost its images in a product rebuild

The Reset was rebuilt as a new product — **`8500970881194` → `8566372303018`** (the old ID now 404s). The three stopgap images recorded in `project_growth_plan_1m` did not survive. It is **live, ACTIVE since 2026-07-29, at $121**, and it is the highest-contribution bundle in the roster with **zero images**. Highest-value creative target.

## Prices changed 2026-07-31 — the plans are stale

Both plan documents quote old prices. Current, and canonical in `config/bundles.json`:

| Bundle | Plan says | Actually |
|---|--:|--:|
| 90-Day Coconut Reset | $99 | **$121** (MSRP $174, 30% off) |
| 90-Day Clean Swap | $159 | **$144** (MSRP $207, 30% off) |
| Head-to-Toe | $105 | **$87** (MSRP $125, 30% off) |

Any frame carrying a price must use the live figure. Better: carry no price at all — the buy box already renders price and strike-through.

## Rules that constrain every frame

From the media plan, and they are not negotiable:

- **Anything depicting what arrives in the box must be real.** Lifestyle, texture, ingredient and scale frames may be generated or composited; contents may not. A generated photo of packaging that doesn't exist misrepresents the goods.
- **Never mix variants in one frame.** Showing Gentle and Fresh units together ships a kit nobody receives.
- **No medical framing** on any skin transformation — no eczema, psoriasis, dermatitis, no prescription comparison, no "healed" or "cured". These are moisturisers; the claim is dry skin looking less dry.
- **Bundles lead with duration or completeness, never savings-vs-single** (`bundle-marketing-plan.md` rule 1) — leading with savings invites the per-unit comparison the bundle exists to escape.
- **Verify any ingredient count against `config/ingredients.json`** before it goes on an image. The media plan calls an invented number here "the single most damaging frame in either stack."

## What genuinely needs a camera

Media plan §5 — seven items in four sessions; the other ~56 frames route to REUSE, COMPOSITE or GENERATE from the existing 46 component photos.

The one item where **delay is irreversible**: the customer 90-day skin pairs for the Reset. It is a recruitment programme through the replenishment flow, not a shoot, and day-0 photos must be collected before anyone starts. A pair started in October cannot exist before January. Everything else costs the same later as now.

Session A (packed Gift Box) is calendar-bound to **Q4, mid-September**.

## Component photo defects — recrops, no shoot needed

Media plan §5b. These degrade the auto-rendered "what's in the box" cards:

- `coconut-oil-lip-balm` — shot as a single tube, but the Gift Box ships a **4-pack**; the card undersells a $15 line
- `organic-foaming-hand-soap` — featured image is one fixed scent, mismatching most of the 15 Hand Soap Set variants
- `coconut-oil-toothpaste` — thinnest library at 4 images, and the least familiar product in the range

Found 2026-08-01 while fixing the "What's in the box" layout:

- **`coconut-moisturizer` is 3000×1497 — a 2:1 frame, while `coconut-lotion` is 2000×2000 square.** In the card grid this rendered one card at exactly twice the other's height. Worked around in CSS (`aspect-ratio:4/3` + `object-fit:contain`, so every card is one box regardless of source shape), but the real fix is a square recrop. **Featured images for card use should be square.**
- Both featured shots have content touching the frame edge — the lotion's "Made in the USA" badge bleeds off the right, the cream's wordmark runs to the edge. Contained in a card box they read as cropped. A recrop wants padding around the subject.

## Suggested order

1. **90-Day Coconut Reset** — live, best margin, zero images, and its frame stack is already fully specced (§6)
2. **Start the customer-transformation recruitment** — the only irreversible clock
3. **The three component recrops** — cheap, no shoot, improves cards on pages nobody otherwise touches
4. Then the remaining five zero-image bundles
5. Then replace the placeholders on the four that have some

## The Reset's lander copy is now correct — do not "fix" it again

Applied and verified live 2026-07-31, after Sean confirmed the box ships **3 lotions + 3 creams**:

- `subheading` and the "What's Inside" tab now say three creams. Every singular-cream string is gone from the live page.
- `bundle.value_stack` free-shipping line corrected **$6 → $12** (six items at that weight really would cost a customer ~$12), so total value is **$220**, not $214.
- A savings line was added as the first `buybox_bullets` entry, written with the `[[TOTAL]]` / `[[PRICE]]` / `[[SAVINGS]]` tokens.

The page now renders **$220 of value → $121 today, you save $99**. Those figures are computed from `bundle.value_stack` — change the metafield, not the copy. Previous values are in `data/reports/reset-copy-fix/before.json`.

## Tooling that exists

- `node scripts/bundle-margin-report.mjs` — live price, cost, weight, contribution per bundle
- `node scripts/sync-bundle-cost-weight.mjs` — derives bundle cost/weight from components; run after any roster change
- `npm run verify-bundle-contents` — roster vs Shopify drift; currently reports "Roster matches Shopify"
- `config/bundles.json` is the single source of truth for contents **and price** — `build-bundle.mjs` re-asserts prices from it onto Shopify, so a stale roster silently reverts live prices

## Related memory

`project_bundle_roster_source_of_truth`, `project_growth_plan_1m` (its $99 bundle section carries a 2026-07-31 correction block at the top), `project_klaviyo_email_rebuild`.
