# Bundle media plan

Frame-by-frame image specification for all 10 bundles. Written 2026-07-28.

Companion to `docs/bundle-marketing-plan.md` (positioning and channel) and `docs/bundle-landing-architecture.md` (how the template works). This document covers only imagery: what frame goes where, what job it does, and where the picture comes from.

---

## 0. Decisions needed before this is executed

> **All three resolved 2026-07-31 — do not re-raise them.**
>
> 1. **Ingredient claims — `config/ingredients.json` is correct and is the source of truth.** The copy was the wrong side and has been fixed: "no palm oil" now appears nowhere live, and the Gift Box lander discloses *"Contains beeswax in the lip balm, so this box is not vegan."* The Clean Swap's "Vegan and cruelty-free" is accurate because its four components carry no beeswax. **The table below stands and should be treated as the authority** — it is what the Reset's frame 6 note is derived from.
> 2. **Head-to-Toe frame 3 — dissolved, then rebuilt.** The bundle repriced to **$87** on 2026-07-31, so $105 ÷ 7 = $15.00 no longer holds ($12.43). The frame was cut on the grounds that it depended on that exact arithmetic. **Reversed 2026-08-02 and shipped:** the tension was never the division, it was landing *on* the $15 ceiling, and $12.43 is under it. Rebuilt as a RENDER that divides at render time and refuses to build at ≥$15. The stack still leads on completeness — the price frame sits at slot 3.
> 3. **Reset digital-goods frame — buildable.** Both PDFs are real: Routine & Tracker **5.2 MB**, Field Guide **9.1 MB**, live on the CDN and delivered by Klaviyo flow `XFdcu6`.

The original text of the three, kept because the ingredient table is still the working reference:

**1. ⚠️ Ingredient claims that contradict `config/ingredients.json` — blocks any on-image ingredient frame.**

Two live landers (The Clean Swap, Gift Box) carry "no SLS, no parabens, no synthetic fragrance, no palm oil. Vegan and cruelty-free." The config says otherwise:

| Component | Palm | Animal-derived |
|---|---|---|
| Lotion (6 ingredients) | organic red palm oil | — |
| Cream (7) | palm stearic, organic red palm oil | organic beeswax |
| Lip balm (3) | organic red palm oil | organic beeswax |
| Bar soap, hand soap, deodorant, toothpaste | — | — |

So "no palm oil" is false for anything containing the lotion, cream or lip balm — which is The Clean Swap, the Gift Box, Head-to-Toe, the Coconut Reset and the Sensitive Skin Set. "Vegan" is additionally false for the Gift Box, Head-to-Toe, the Reset and the Sensitive Skin Set, all of which carry beeswax via the cream or lip balm. PR #364's Hand Soap Set copy inherited the same line.

Either the copy is wrong or the config is stale. **Until that is resolved, no frame in this document may carry an ingredient claim**, and several specced frames depend on the answer. If the config is stale it is a bigger problem than the copy — `agents/blog-post-writer` and the specificity checks read from it, so a wrong ingredient list propagates into published content.

**2. Head-to-Toe frame 3 breaks a stated rule and needs a veto or a nod.** `docs/bundle-marketing-plan.md` rule 1 says bundles never lead with savings-vs-single, to avoid inviting per-unit comparison. Frame 3 is specced as "$105. Seven products. $15 each." anyway, because $105 ÷ 7 = exactly $15.00 — landing *on* the price ceiling the VOC file documents rather than above it. It sits at slot 3, not slot 1, so completeness still leads. It is the one frame in the plan worth an explicit decision.

**3. The Coconut Reset's digital-goods frame may be unbuildable.** Its value stack counts a $19 90-Day Routine & Tracker and a $15 Field Guide. If those PDFs are stubs, photographing them as $34 of value is fabrication — and the playbook still lists an unconfirmed test order for the flow that delivers them. The fix in that case is the guide, not the frame.

---

## 1. Read this first — the three surfaces

Images on a bundle lander come from three different places, and they behave differently. Specifying a frame without knowing which surface it lands on is how you end up with art nobody can install.

| Surface | Scope | Populated from | Today |
|---|---|---|---|
| **Product gallery** | Per product | `product.images` | The main surface. Empty on 5 of 10 bundles. |
| **"What's in the box" cards** | Per product | The *component* products' own images, resolved through `bundle.components` | Already working. Inherits the component library automatically — no per-bundle work needed. |
| **Hero background** | ⚠️ **Shared by every lander** | `section.settings.bg_image_desktop` / `_mobile` on `templates/product.bundle-landing.json` | ONE image (`hero-desktop.webp`) behind all five landers. |

**The hero is the constraint that shapes this whole plan.** Because it is a section setting on a shared template, there is no such thing as a per-bundle hero image today. Every "hero" frame in this document is therefore marked **BLOCKED-ON-THEME** and is engineering work, not art direction: the fix is to read the image from a product metafield with the section setting as fallback — the same shape as the `bundle.rating_value` and `bundle.duration_days` fixes made on 2026-07-27.

This is the fourth instance of one pattern on this template: **a per-product value that doesn't exist gets replaced by a shared constant.** Anything added here should follow the rule those fixes established — absent data yields absent output, never an invented stand-in.

---

## 2. What already exists

> **Re-measured 2026-08-01.** The 2026-07-28 table below is **stale** — it predates a product rebuild and three repricings. Current state:
>
> | Bundle | Price | Images | Note |
> |---|--:|--:|---|
> | **90-Day Coconut Reset** | **$121** | **12 (6 per scent)** | Rebuilt as a new product (`8500970881194` → `8566372303018`); the old 3 images did not survive. The 2 present were generated by Sean from the stored product photos, reviewed by him, and shipped 2026-07-31, one per variant. |
> | Bar Soap 4-Pack | $39 | 5 | placeholder |
> | Head-to-Toe | **$87** | 2 | placeholder |
> | Sensitive Skin Set | $46.80 | 1 | placeholder; alt text missing |
> | 90-Day Clean Swap | **$144** | 1 | placeholder |
> | Hand Soap Set | $44/59/72 | **0** | 15 variants |
> | The Clean Swap | $59 | **0** | |
> | Gift Box | $62 | **0** | |
> | Deodorant 4-Pack | $53 | **0** | |
> | Toothpaste 3-Pack | $34 | **0** | |
>
> **Sean confirmed 2026-07-31 that the images on the four non-zero bundles are placeholders, not finished assets.** So all ten bundles need imagery designed — six from nothing, four by replacement. Do not treat the four as done and skip them. The Reset's 2 are the only finished assets in the roster.

The original 2026-07-28 table, kept for the component counts below it:

| Bundle | Price | Template | Images | Alt text |
|---|--:|---|--:|---|
| 90-Day Coconut Reset | $99 | lander | 3 | ✅ 3/3 |
| Bar Soap 4-Pack | $39 | PDP | 5 | ✅ 5/5 |
| Head-to-Toe | $87 | lander | 2 | ✅ 2/2 |
| 90-Day Clean Swap | $144 | lander | 1 | ✅ 1/1 |
| Sensitive Skin Set | $46.80 | bespoke | 1 | ❌ 0/1 |
| The Clean Swap | $59 | lander | **0** | — |
| Gift Box | $62 | lander | **0** | — |
| Hand Soap Set | $44/59/72 | PDP | **0** | — |
| Deodorant 4-Pack | $53 | PDP | **0** | — |
| Toothpaste 3-Pack | $34 | PDP | **0** | — |

The component SKUs, by contrast, hold **46**:

| Component | Images |
|---|--:|
| `coconut-lotion` | 11 |
| `organic-foaming-hand-soap` | 9 |
| `coconut-moisturizer` | 6 |
| `coconut-oil-lip-balm` | 6 |
| `coconut-oil-deodorant` | 5 |
| `coconut-soap` | 5 |
| `coconut-oil-toothpaste` | 4 |

This is the single most important fact in the plan. **The bundles are not starting from nothing — they are starting from 46 photographs of exactly the products inside them.** Most of what follows is composition and art direction over existing assets, not a shoot. The shoot list in §5 is deliberately short.

---

## 3. Production routing

Every frame in this document carries a `Source`. There are four, and the boundary between the last two is a hard line, not a preference:

- **REUSE `<handle>`** — an existing component photograph, used as-is or cropped. Free.
- **COMPOSITE `<handles>`** — existing component photographs arranged into a new frame (grid, row, counter scene). Free, and where most of the value is.
- **GENERATE (Ad Builder)** — the reference-driven pipeline in `agents/creative-packager`. Per `project_creatives_ad_builder`: feed it the product image plus a **text** style brief, never the reference image itself, and use `gemini-3-pro-image-preview` at 2K when the frame carries legible text (Flash fails at text). Appropriate for backgrounds, texture, scale and typographic frames.
- **RENDER (`scripts/render-frame.mjs`)** — *added 2026-08-01.* Type over a brand field, laid out in HTML/CSS and screenshotted at 2048² in the real brand faces (Cabin/Outfit, vendored in `data/brand/fonts/`). Free, exact, and **reproducible**: the frame module reads its figures from live Shopify metafields at render time, so re-running after a data change regenerates a correct asset. Every frame module must export a `verify(ctx)` that throws when live data contradicts the frame — a wrong claim becomes a failed build instead of a confident JPEG.
- **MUST-SHOOT** — requires a camera and the physical product.

### ⚠️ Scoping gallery media to a variant — the alt-text `#` convention

A variant holds one media, so variant *attachment* cannot scope a gallery of
several frames. This theme does it through **alt text**, verified in the live
theme on 2026-08-01 rather than assumed:

```
sections/main-product.liquid
  if media.alt contains '#' and section.settings.hide_variants == false
    gang_connect     = media.alt | split: '#' | last     → "scent_coconut-breeze"
    gang_option_name = gang_connect | split: '_' | first → "scent"
    ... compares against option.name|handleize and option.selected_value|handleize
    match → class "gang__active"
  alt = media.alt | escape | split: '#' | first          → the visible alt

assets/section-main-product.css
  [data-gang-option]              { display: none; }
  [data-gang-option].gang__active { display: block; }
```

**⚠️ Scoping forces a section re-render, and that used to eat the scroll position.**
`assets/product-info.js` computed `shouldSwapProduct` as *"different product OR any
`li[data-gang-option]` exists"*, then derived `shouldFetchFullPage` from it. Adding
scoped media therefore made every variant change replace the whole of `<main>`,
which discards scroll: measured on the Reset, changing scent moved scrollY from
**700 to 4485 — the exact bottom of the page**. Patched so only a genuinely
different product fetches the full page; a scoped gallery re-renders just the
`product-info` section, which is where all the media live anyway.

That fixed the jump-to-bottom but not a second, subtler jump. `HTMLUpdateUtility`
does `insertBefore(newNode, oldNode)` and only hides the old node on the *next*
statement, so for one frame the document holds both copies with the new one above.
The browser's scroll anchoring compensates by scrolling down about the height of
the inserted section and never undoes it — measured at **+1765px**, landing the
visitor on "What's NOT in any bottle or jar". `handleSwapProduct` now pins
`window.scrollY` across the swap. Verified held at scroll 300, 1150 and 2600, in
both directions, with the gallery still showing 3 of 6.

Both edits live in `assets/product-info.js` — a **shared** file, so a theme update
will revert them and the jump returns on any product with a scoped gallery.
Pristine vendor copy: `theme/backup/assets/product-info.js`; patched copy is
vendored at `theme/assets/product-info.js`.

**Format:** `<real alt text>#<option-name-handle>_<option-value-handle>`
e.g. `…three of each for three months.#scent_coconut-breeze`

The suffix is stripped from the rendered alt, so accessibility and SEO are
unaffected. `hide_variants` must be **false** on the section or the theme skips
the branch entirely (it is false on `product.bundle-landing.json`).

**🚨 `gang_exist` is sticky, and this bites.** In the media loop `gang_connect` is
reset every iteration but `gang_exist` is not — it is assigned `false` once,
before the loop, and only ever set true. So the moment one media is scoped, every
media rendered *after* it also gets `data-gang-option`, with an empty connect it
can never match, and the CSS hides it **for every variant**. It stays in the
admin, returns 200 from the CDN, and simply never renders.

This happened here: scoping the heroes and routine frames silently hid the
review-proof frame on both scents. The fix is that **once anything is scoped,
everything must be** — an asset that is genuinely true of all variants gets
duplicated, one per option value. That is why the Reset carries two identical
copies of frame 5.

`scripts/set-media-variant-scope.mjs` applies the convention from a scope file,
derives the suffix from the product's real options so it cannot name a value that
does not exist, is idempotent, and refuses to run when it would strand a media.

---

### ⚠️ A Shopify variant holds exactly ONE media — the hero owns that slot

Learned the hard way on 2026-08-01, and it shapes how every bundle's stack gets installed. `ProductVariantAppendMediaInput` takes a **`mediaIds` list**, and the reference docs describe the mutation as *"appending"* media to variants — both of which say you can attach several. You cannot. The API refuses in two different ways:

- appending to a variant that already has an image → `The given variant already has attached media`
- passing two ids in one call → `Only one mediaId is allowed per media input`

**Detaching first is not the workaround.** A detach that succeeds followed by an append that fails leaves the variant with *no image at all* — that is a live regression on a product page, and it happened here before it was caught and restored.

The rule that follows: **a bundle's hero takes the variant slot, and every later frame is attached at product level.** Per-scent frames stay honest by naming their scent on the image itself (the Reset's routine frames carry `COCONUT BREEZE` / `PURE UNSCENTED` as the eyebrow), which is what keeps a gallery containing both scents unambiguous rather than misleading. `scripts/upload-product-images.mjs` now preflights every named variant **before uploading a single byte** and refuses the batch with an instruction to drop the `variant` key.

**RENDER vs GENERATE — prefer RENDER for anything typographic.** A generative model approximates the typeface, cannot be relied on to spell a figure like "4.84", and bakes the result in permanently. Three bundles repriced on 2026-07-31 and the Reset's review count moves every week; a number baked into a generated JPEG is the one thing a metafield edit cannot correct. So frames whose content is *type over a colour field* go to RENDER, and GENERATE is reserved for frames that need a photographic scene the compositor cannot assemble. This supersedes the original routing of Reset frame 5 (and the equivalent text-only frames on the other bundles) to the Ad Builder.

**The line between GENERATE and MUST-SHOOT:** anything depicting *what arrives in the box* must match what ships. A customer who receives a physical gift box has to get that box in the image. Where an asset is AI-generated, it must be grounded in the stored product photography and audited against the real packaging before it goes live — labels, volumes and counts. Lifestyle context, texture, ingredient and scale frames may be generated or composited; the contents themselves may not. This is not a stylistic rule — a generated photograph of packaging that doesn't exist is a misrepresentation of the goods.

---

## 4. Rules every frame obeys

From the house image-stack doctrine:

1. **One job, one persona per frame.** Two jobs split the focal point and the message reaches nobody. It is the most common failure mode in this format.
2. **Headline first in the visual hierarchy**, then the product, then supporting elements. Every frame below states its **1-second read** — if a viewer can't get it in a second, the frame is dead regardless of how good it looks.
3. **Cover the format rotation**: educational infographic, headliner, benefit callout, us-vs-them comparison, transformation, grid/multi-SKU, text-only. A missing format is a gap in who you can convert. Infographic and text-only borrow credibility from organic formats and read less like ads.
4. **Transformation is the commonest gap** — and the hardest to do honestly for body care. Where a truthful one can't be shot, it is left out and said so rather than faked.

---

## 5. The shoot list

Everything that genuinely needs a camera, across all ten bundles. Seven items in four sessions — the rest of the ~56 frames route to REUSE, COMPOSITE or GENERATE off the existing 46 component photos.

| Session | Subject | For | Why it can't be composited | Lead time |
|---|---|---|---|---|
| **A** | **The packed Gift Box** — two setups: open with contents nested, and closed | Gift Box | The buyer receives a physical box. A generated one would depict goods that may not match what ships. There is also a live review complaining the tissue wrapping arrived torn, so there is negative evidence to overwrite. | ⚠️ **Q4 — mid-September.** The long pole, and the only calendar-bound item here |
| **B** | **Twelve-unit contents flat-lay**, overhead, three kit versions | 90-Day Clean Swap | Upgrade, no longer a blocker — frame 1 ships as a real-photo composite (2026-08-02). Volume is the whole $144 argument and a shoot still beats a composite. | Single session, three set changes |
| **C** | **Hands before/after lotion**, one model, two exposures ~20 min apart | Hand Soap Set | Blocks the only frame that sells the $59/$72 step-up over the $44 base | One session |
| **D** | **Supply still-life** — six full units vs. six genuinely used (3 empty bottles, 3 spent jars) | 90-Day Coconut Reset | Blocked on having authentically emptied units; fake empties are a fabrication | Gated on real empties |
| **—** | **Customer 90-day skin pairs** | 90-Day Coconut Reset | Not a photo session — a recruitment programme through the replenishment flow. Day-0 photos must be collected *before* anyone starts, so it can only ever start today | ⏳ 90 days from whenever it starts |
| **—** | **Fresh-kit variant photography** *(contingent)* | Head-to-Toe | Only if the audit finds no primary images for Geranium Flower deodorant, Sweet Tangerine lip balm, Orange Zest hand soap, Tea Tree bar soap | Audit first — may be zero work |

**The customer-transformation programme is the one item where delay is irreversible.** Every other frame can be built later at the same cost. That one cannot: a 90-day before/after started in October cannot exist before January, and there is currently no day-0 photograph of anyone who then used the box.

---

## 5b. Component photo gaps

Found while specifying the stacks. These are defects in the *existing* library that degrade the auto-rendered "what's in the box" cards on pages nobody has to touch otherwise — all fixable by recrop, none needing a shoot.

| Component | Problem | Affects |
|---|---|---|
| `coconut-oil-lip-balm` | Photographed as a **single tube**, but the Gift Box ships a **4-pack** — the card visually undersells a $15 line item | Gift Box, Head-to-Toe |
| `organic-foaming-hand-soap` | Featured image is one fixed scent, so the card mismatches every buyer who chose a different one | Hand Soap Set (15 variants), Head-to-Toe |
| `coconut-oil-toothpaste` | Thinnest library at 4 images, and the least familiar product in the range — worth verifying at card size | Clean Swap, 90-Day Clean Swap, Head-to-Toe |

---

## 6. Frame stacks

<!-- Media fragment: Head-to-Toe (now $87) and The 90-Day Coconut Reset (now $121). Product-gallery image stacks. Frames are specced, not produced. -->

### Head-to-Toe — $87

> **✅ SHIPPED 2026-08-02.** Five frames × two kits = **10 media**, live and verified on the
> storefront: each kit shows exactly its own five and neither leaks into the other. The two
> placeholder images are deleted (both were the same Coconut Breeze *body lotion*
> photograph, captioned "all seven Real Skin Care products"); a record is in
> `data/backups/products/head-to-toe.media-before-2026-08-02.json`.
>
> The stack that shipped is **1** contents · **2** head-to-toe routine · **3** per-product
> price · **4** kit difference · **5** reviews — spec frames 1, 2, 3, 4 and 6 renumbered.
>
> ### 🚨 Frame 7 shipped wrong and was pulled the same day
>
> It went live reading **"60 DAYS of everything"**. Sean caught it immediately: *"How is
> that 60 days if we sell 3 of each for 90 days? This is a one month supply."* He is right,
> and the store's own catalogue says so — the 90-Day Clean Swap is three of each for ninety,
> so one of each is thirty.
>
> The measured position is worse than the arithmetic. **A box lasts as long as the first
> thing in it runs out**, and `config/consumption-rates.json` puts the body cream at ~28
> days per unit — so this box stops being "everything" after about four weeks while its
> deodorant (~90 days) is still nearly full. Those rates are reorder gaps, so each is an
> *upper* bound; the true figure is lower still.
>
> The frame's `verify()` had asserted `duration_days` was a positive integer. It was — it
> was 60. **A metafield is not evidence.** `lib/supply-duration.js` is now the evidence, and
> it rejects the claim that shipped while still accepting the 90-Day's genuine 90.
>
> **The frame was not the only surface saying it, and not the first.** The lander's
> value-stack panel renders `{% if days %}Everything in your {{ days }}-day box{% endif %}`,
> so the page had been reading **"Everything in your 60-day box"** in body copy since
> `duration_days` was first set — before any frame existed. Captured in the page HTML fetched
> before the metafield was deleted; it now reads "Everything in your box", while the 90-Day
> still correctly reads "Everything in your 90-day box". **The image amplified a claim the
> page was already making**, which is worth knowing: an image is the loudest place a bad
> figure lands, not the place it starts.
>
> One more input fixed while tracing it: `scripts/build-bundle-landing.mjs` read
> `Number(mf.duration_days || 90)`, so a bundle with no duration data printed "duration 90d"
> as confidently as one with. That value only ever reached a console line, never the page —
> but an invented operator-facing number is exactly how a wrong figure gets trusted and
> re-published, which is the whole mechanism above. It now prints "not set", and validates
> against `lib/supply-duration.js` when a duration *is* set.
>
> It was **not rebuilt at 28 days**, because the honest number showed the frame was
> answering the wrong question. This bundle's own personas here are the discovery shopper
> and the gifter; neither buys on supply duration, and "$87 for four weeks" argues against a
> box whose actual argument is breadth. **Duration belongs to the Clean Swaps.**
>
> **Spec frame 5 (us-vs-them, "seven swaps") also did not ship**: it is the only frame here
> that makes an ingredient claim, and §0's block on ingredient claims is only partly lifted.
> "No aluminium / SLS / parabens / synthetic fragrance" is checkable against
> `config/ingredients.json` and would build; "no palm oil" and "vegan" remain **false** for
> this bundle, which contains the cream and the lip balm. A frame one careless edit away
> from a false claim was not worth shipping for coverage.
>
> **Spec frame 2 shipped as type, not as a composite.** Seven products stacked vertically
> at one honest scale puts the lip balm at ~60px, which fails the phone-size read; and
> drawing the same seven again in a row would be frame 1 doing frame 2's job. The
> body-part list carries the argument on its own.
>
> Also corrected on the live product: `global.title_tag` and `global.description_tag` both
> still priced this bundle at **$105**, two days after it moved to $87. Nothing read those
> figures from the price; they were typed. That is the same class of error as the media
> plan telling people to print $159 on the 90-Day, and it is why every frame in
> `data/brand/frames/head-to-toe/` derives its numbers at render time.

The copy on this page can *say* "one of everything we make" but it cannot make the buyer **count to seven**, and counting to seven is the entire purchase decision. At $87 against a measured ~$15 lotion price ceiling, the shopper's first instinct is to divide — so the imagery either wins the division or loses the sale. This buyer is the discovery shopper who wants to find their favourite before committing to any one SKU, plus the non-Q4 gifter; both are choosing breadth on purpose, which means the stack is a range shot, not a routine shot. Two jobs dominate: **prove the seven products are real and distinct** (the page had 2 images, so breadth was asserted and never shown), and **reframe the unit of purchase** so $87 is compared against a shelf, not against a bottle. The 46 existing component photos make almost all of this a compositing job rather than a shoot.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|---|
| 1 | Grid/multi-SKU | Prove seven distinct products exist | Discovery shopper who has never bought the brand | "Seven different things, one box" | **One of everything we make.** | COMPOSITE `coconut-lotion` + `coconut-moisturizer` + `coconut-oil-deodorant` + `coconut-oil-toothpaste` + `coconut-soap` + `coconut-oil-lip-balm` + `organic-foaming-hand-soap` | M |
| 2 | Benefit callout | Prove the seven cover the whole routine with no gaps | Shopper mentally auditing their own bathroom shelf | "This replaces everything I already buy" | **Nothing else to buy.** | COMPOSITE (same seven) | M |
| 3 | Headliner | Kill the per-unit price objection with a true number | Price-ceiling shopper ("$15 or less, but I want it to work") | "$12.43 a product — under my number" | **$87. Seven products. $12.43 each.** | RENDER `frame-03-per-product` | S |
| 4 | Educational infographic | Make the Gentle vs Fresh choice decidable without scrolling | Buyer stalled at the variant picker | "Two kits, and here's how they differ" | **Gentle or Fresh. Here's the difference.** | COMPOSITE (per-variant shots — see Blocked) | M |
| 5 | Us-vs-them comparison | Convert the clean-swap motive into a reason to buy all seven at once | Reduce-my-chemical-load switcher | "Seven swaps in one purchase" | **Seven swaps. No aluminium, no SLS, no parabens, no synthetic fragrance.** | GENERATE (Ad Builder) | M |
| 6 | Text-only | Borrow the component catalogue's proof for an unreviewed bundle | Sceptic who sees a new bundle with no reviews of its own | "Lots of people have used these" | **4.64 ★ — 295 reviews of the seven products inside.** | GENERATE (Ad Builder) | S |
| ~~7~~ | ~~Benefit callout~~ | ~~Answer "how long does $87 actually last"~~ | — | — | ~~**Sixty days of everything.**~~ **CUT** — the honest answer is ~28 days (the body cream binds), and this bundle's buyers do not buy on duration. See the banner above. | — | — |

**Frame 1** spec: all seven products stood in a single row on a plain bathroom shelf, tallest to shortest — hand soap pump, lotion bottle, cream jar, deodorant, toothpaste tube, bar soap, lip balm — even spacing, one light direction, no props. Headline sits above the row, product row is the second read. Every unit shown must be a real variant from one real kit (do not mix Gentle and Fresh in one frame — that ships something nobody receives).

**Frame 2** spec: the same seven, but arranged head-to-toe down the frame with a one-word label beside each — teeth, lips, underarms, hands, body wash, body, overnight. The bundle's name made literal. This is the frame that earns $87, because it converts "seven products" into "my whole shelf."

**Frame 3** carried a real tension worth naming: `bundle-marketing-plan.md` rule 1 says bundles lead with duration or completeness and **never** with savings-vs-single, precisely to avoid inviting per-unit comparison. Frame 3 deliberately invites it — and at $105 it did so at exactly $15.00 a product, landing *on* the measured ceiling rather than under it. §0 cut the frame when the bundle repriced, on the grounds that the arithmetic it was written around had died.

> **Reversed 2026-08-02, and the reversal is the point.** $87 ÷ 7 = **$12.43**, which is
> comfortably *under* the ceiling — so the thing that made the frame uncomfortable is the
> thing that repricing removed. Both Clean Swaps ship this exact frame. It is rebuilt as a
> RENDER with the figure divided at render time rather than typed, and `verify()` fails the
> build if the per-unit price ever reaches $15: a version of this frame printing $15.50
> would argue against itself, and now it cannot be built at all.

**Frame 5** honesty note: depict the "before" side as generic unbranded conventional packaging with ingredient *categories* named. Do not render CeraVe, Vanicream or Cetaphil packaging, and do not claim those brands contain anything — the four absences claimed are our own formulation facts and are the only claims the frame makes.

**"What's in the box" cards** — no frames needed, but one check: the cards pull each component's own primary image, and the Fresh kit points at Geranium Flower deodorant, Sweet Tangerine lip balm, Orange Zest hand soap and Tea Tree bar soap. Confirm each of those *variants* has a primary image before treating the cards as done; a component with 5 photos does not guarantee 5 scents covered.

### Gaps

- **Transformation — deliberately omitted.** A sampler of seven unrelated products has no single honest before/after. Any transformation frame here would either attribute a skin change to a box containing toothpaste and hand soap, or split its focal point across two jobs. Transformation belongs to the Reset, and putting a weak one here would spend the format's credibility on the wrong page.
- **Educational infographic used once, on variant choice rather than ingredients.** An ingredient-panel infographic is the Reset's job (frame 6 there); repeating it here would be the same asset doing the same job twice across two pages.
- Two benefit callouts (2 and 7) is intentional — they carry different jobs (completeness vs duration) and the rotation asks for coverage, not one-of-each.

### Blocked

1. **~~BLOCKED-ON-THEME~~ — per-bundle hero background. Unblocked, not done.** This read "impossible until the section reads a product metafield"; PR #406 shipped exactly that, so the theme now takes `bundle.hero_desktop` / `hero_mobile` per product with the section setting as fallback. **Nothing is set for Head-to-Toe**, so the lander still renders the shared `hero-desktop.webp`. It is now art direction — a seven-product hero — rather than a Liquid change. Every frame above still works inside the gallery alone.
2. **MUST-SHOOT (contingent) — Fresh-kit variant photography.** Audit the 46 component photos for primary images of Geranium Flower deodorant, Sweet Tangerine lip balm, Orange Zest hand soap and Tea Tree bar soap. Any variant missing one blocks frame 4 and renders a wrong "what's in the box" card. Shoot only the misses.

---

### The 90-Day Coconut Reset — $121

> **Re-specced 2026-08-01.** This stack was written against a bundle of **3 lotions + 1 cream at $99**. The product ships **3 lotions + 3 creams at $121** (`config/bundles.json`, verified live). Frames 1, 2 and 3 were all built on the old 3+1 composition, and frame 2's headline — *"Three daily. One nightly."* — is now **false**. The composition-dependent frames below have been rewritten; the value stack is **$220**, not $158. Do not build from a cached copy of this section.

This page's imagery has one hard problem the copy has already solved in words and lost in pictures: **it contains six vessels of essentially two products, and it costs $121.** The copy explains the routine; a photograph of three identical bottles beside three identical jars reads as "why am I buying three of the same thing, twice" unless a frame assigns the pair a job. The buyer is the lotion customer who has *already repurchased at least once* — they are past persuasion and squarely problem-aware. Their problem is not choosing, it is **running out**, and it is the one thing the gallery has never depicted. Secondarily, $34 of the $220 stated value is two PDFs, and a PDF is invisible in a photograph unless a frame is built for it — right now the page asserts value the eye cannot find, which is the exact shape of a trust leak.

The six-unit composition is *better* material than the four-unit one, because the routine is genuinely a pair: the lander's own "How to Use" tab says **lotion in the morning and after showers, cream at night**, and `whats_in_it_note` says *"Three months of lotion, and three months of overnight cream."* Three matched pairs, one per month, is a system a single frame can teach. Three bottles and a lone jar never was.

**Sequencing honesty — read this before costing the stack.** This lander has no traffic yet, but note *why*: the product was created 2026-07-28 and nothing links to it. It has not underperformed — it has not been given a chance. Its imagery is not the bottleneck; distribution is. Its real traffic is the Klaviyo replenishment (`TAfpnV`) and post-purchase (`VLQaYZ`) flows, not search. So frames are sequenced by whether they also work as flow creative: **frames 1, 4 and 5 pay off immediately** because they can be lifted straight into email. **Frames 2, 6 and 7 only pay off once the page has traffic** — they are gallery-depth assets that answer objections nobody is currently arriving with, and they should be built after the flows are placed, not before. Frame 3b is a 90-day-lead asset that must be *started* now precisely because it cannot be rushed later.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|---|
| 1 | Headliner | Make a quarter's supply the unit of purchase | Repeat lotion buyer who lapses between bottles | "That's a whole quarter of lotion" | **Ninety days. Never run out.** | ✅ **SHIPPED 2026-07-31** — AI-generated by Sean from the stored product photos, reviewed and approved, one per variant | — |
| 2 | Educational infographic | Explain why it's three *pairs*, not six duplicates | Buyer who thinks they're being sold the same thing six times | "A bottle and a jar, three months running" | **Daily lotion. Overnight cream.** | ✅ **LIVE 2026-08-01** — GENERATE plate → cut-out → RENDER, one per scent | — |
| 3 | Transformation (supply) | Show running out being solved, not described | Buyer whose real pain is the empty-bottle gap | "The box lasts the whole quarter" | **This is what ninety days looks like.** | MUST-SHOOT (product still-life, in-house) | M |
| 3b | Transformation (skin) | Show the change instead of claiming the after-state | Dry-winter-skin sufferer wanting proof, not persuasion | "Her skin actually changed" | **Day 1. Day 90.** | MUST-SHOOT (customer-submitted, 90-day lead) | L |
| 4 | Benefit callout | Make $34 of digital goods visible and specific | Buyer who read "$220 value" and can only see $186 of it | "Two real guides, arriving immediately" | **Both guides, in your inbox in five minutes.** | ✅ **LIVE 2026-08-01** — RENDER over real PDF pages | — |
| 5 | Text-only | Transfer the components' proof to the bundle | Sceptic of a bundle with no reviews of its own | "Nearly five stars, lots of reviews" | **4.84 ★ — 135 reviews of the lotion and cream inside.** | ✅ **BUILT 2026-08-01** — RENDER, not generated | — |
| 6 | Us-vs-them comparison | Win on ingredient list length, not price | Switcher defaulting to a drugstore dermatologist pick | "Same job, far shorter list" | **Same job. Shorter list.** | ✅ **LIVE 2026-08-01** — RENDER, 7 vs 34, one per scent | — |
| 7 | Educational infographic | Defuse the comedogenic objection without a claim | Shopper who believes coconut oil clogs pores | "This is for my body, not my face" | **Made for your body, not your face.** | ✅ **LIVE 2026-08-01** — GENERATE figure → key → RENDER | — |

**Frame 1** — **shipped.** Sean supplied two 2048² heroes, generated with the stored product photography as references and reviewed by him before upload — labels verified correct (8 fl. oz · 236ml, 4 fl. oz · 118ml). one per scent, each showing three lotions standing on three creams. Both are attached to their own variant, so a buyer choosing Pure Unscented sees the unscented kit. The original spec called for "the four vessels in a single row"; what shipped is six units stacked, which is both accurate to what ships and a stronger mass argument. Nothing further needed here.

**Frame 2 — live 2026-08-01, one per scent, approved by Sean.** `frame-02-routine.coconut-breeze.mjs` and `frame-02-routine.pure-unscented.mjs`, both thin wrappers over `routine-frame.mjs`. Composited from keyed product plates, so everything depicted carries the approved label wording. Uploaded **product-level** — see the variant-media constraint below.

The spec called for a horizontal 90-day strip cut into three month blocks, each holding one bottle and one jar. **That cut is not possible from the source photography and the frame splits the other way instead.** Measured on the hero: the three bottles have clean background gutters between them (x704–860, x1194–1353), but the three jars touch — one continuous mass from x295 to x1848. Any vertical cut into month columns slices through a jar. The photo cuts cleanly *horizontally*, and that turned out to be the better argument anyway: the rows **are** the routine, and the routine is what the frame has to teach. So it is two bands — the lotion row labelled *three lotions · every morning*, the cream row *three creams · every night* — under the headline **"Daily lotion. Overnight cream."**, closing on *"One pair a month. Ninety days."*

The band boundary is not arbitrary: a column scan finds the bottle's white base ending where the jar's ribbed lid begins (y≈1386 on the Coconut Breeze photo, y≈1404 on the Unscented one, which is framed differently). Cutting on that seam is what makes the two crops read as *resting on* rather than as one photo sliced through a label. An earlier cut at the ink-minimum waist sheared the bottles mid-label and looked like a mistake.

`verify()` reads `bundle.component_qty` and **refuses to build unless it is exactly [3, 3]**. That is the direct lesson of this re-spec: the original frame 2 stated "Three daily. One nightly." and survived a repack as a falsehood because nothing checked it. If the Reset is ever repacked again, this frame fails loudly instead of quietly lying.

**Frame 3 (ships when empties exist)** spec: left half, six sealed full units — three bottles, three jars; right half, the same six after 90 days of real use — three empty bottles and three visibly used jars, same surface, same light, same angle. Caption line: *"One box, one quarter, actual use."* This is an honest transformation of **supply**, not of skin, and it makes the duration claim visible rather than asserted. Do not fake the empties by decanting; if the units must be run down honestly, that is a real lead time and should be scheduled. Note the cost changed with the composition — this now needs **six** genuinely emptied units, not four.

**Frame 3b (start now, lands in ~90 days)** — the priority transformation, and the one the brief is right to want. It **cannot be shot truthfully today**, because there is no day-0 photograph of a customer who then used the box for 90 days. Build it as a process, not an asset: recruit 3–5 real customers through the replenishment flow, collect a day-0 photo of a fixed site (shin, forearm or hands) with a fixed angle, distance and light, re-shoot at day 90, ship no retouching and no cropping that changes scale. Hard constraints: **no eczema, psoriasis, dermatitis or any medical framing, no prescription/steroid comparison, no "healed" or "cured"** — these are moisturisers and the frame's claim is dry skin looking less dry. Ship whichever pairs are genuinely convincing; if none are, ship none. When it lands it takes slot 3 and the supply transformation moves to 4.

**Frame 5 — built and live 2026-08-01.** `data/brand/frames/99-coconut-reset-digital/frame-05-reviews.mjs`, rendered by `scripts/render-frame.mjs` to `data/brand/bundle-images/frame-05-reviews.jpg` (2048², 103 KB), uploaded product-level (the proof is true of both scents). Verified after upload: media `READY` at 2048², CDN `HTTP 200 image/jpeg`, alt text correct, and the file referenced in the rendered storefront HTML at `/products/99-coconut-reset-digital` (page 200). **The Reset now has 3 images.**

The numbers are not typed into the frame; it reads `bundle.rating_value` / `bundle.rating_count` at render time and its `verify()` refuses to build if either is missing, out of range, or backed by fewer than 25 reviews. The "of the lotion and cream inside" clause is load-bearing and is in both the headline and the alt text — without it the frame implies 135 reviews *of the bundle*, which has none.

Provenance checked rather than assumed: 4.84/135 is reproducible from the Judge.me API via `scripts/sync-bundle-ratings.mjs`, which sums the two components' per-product stats. **Do not verify this against the `judgeme.badge` or `reviews.rating_count` metafields on the component products** — those are a shop-level cached aggregate and read an identical 131/4.85 on *every* product, which looks like a per-product figure and is not. That near-miss is worth remembering before the equivalent frame is built for another bundle.

⚠️ **Separately, the lander overstates this.** The `rating_caption` field on the lander metaobject says *"Rated 4.9 by Real Customers"*, but 4.84 rounds to **4.8**. That is a live review claim that is wrong in our favour, and it is a copy fix on the metaobject, not an imagery one. Frame 5 must use 4.84 and must not inherit the 4.9.

**Frame 6 — live 2026-08-01, approved by Sean.** `ingredients-frame.mjs` plus a thin
module per scent.

**Unblocked by a direction, then corrected twice.** The plan required "the comparison
from an actual published INCI panel", which is what had it stuck. Sean, 2026-08-01:
*we are not posting us against a specific product, we are posting us against the lotion
market in general* — and separately supplied a real published panel to contrast against,
with the instruction that **we do not name them**.

The first build got it backwards and is worth recording. It set our full list against a
column of six things we exclude, so the "shorter list" on the frame was **ours** — six
items against seven. The headline argued against the image. Sean caught it.

What ships instead: our real list against their real list, **7 against 34**, both
printed in full, neither named as a brand. Their column needs smaller type in two
sub-columns to fit, which makes the point typographically instead of asserting it. The
claim is not "theirs is bad" — it is "ours is short enough to print, and here it is".

- Our list is imported from `config/ingredients.json`, never retyped.
- Their list lives in `data/brand/reference/comparison-lotion.json`, which records the
  real product for traceability. **Only the `ingredients` array is rendered**; the brand
  name never reaches the frame.
- The label is deliberately non-superlative. "Leading" or "best-selling" would be a
  ranking claim we cannot support; "a conventional coconut oil lotion" needs no support.

**Both traps walked past in the open.** `organic red palm oil` is printed in our list, so
the frame cannot be read as palm-free; the Body Cream count is shown rather than dropped
in favour of the shorter lotion, so its beeswax is not hidden.

`verify()` makes the headline self-verifying — **if our list is ever not the shorter one
the frame stops building**, which is exactly the failure the first version shipped past.
It also blocks a ranking claim in the label. Both exercised.

**Frame 6** original honesty note:**Frame 6** original honesty note: both ingredient lists must be real — ours from `config/ingredients.json`, the comparison from an actual published INCI panel — and the comparison bottle must be unbranded and unnamed. Verify both counts before this ships; an invented number here would be the single most damaging frame in either stack.

Our side of the count, read from `config/ingredients.json` on 2026-08-01, so the frame does not have to re-derive it:

| | Pure Unscented | Coconut Breeze |
|---|--:|--:|
| Body Lotion | **6** | **7** (+ organic coconut oil extract) |
| Body Cream | **7** | **8** (+ organic coconut oil extract) |

**Two traps in this frame, and both are live claims, not style.** The lotion contains **organic red palm oil**; the cream adds **palm stearic** *and* **organic beeswax**. So:

1. **Never imply palm-free.** Both formulas contain palm derivatives. A "clean/short list" frame that a reader completes as "and no palm oil" is a claim we cannot support.
2. **The Reset is not vegan.** The cream contains beeswax. The Clean Swap's "Vegan and cruelty-free" line is accurate *because* it excludes the cream — the Reset includes it, so that line must never be ported across. The lander already handles this correctly (`buybox_bullets` says "beeswax barrier" as a *feature*); the imagery must not contradict it.

What the frame may honestly claim is what the lander already claims: **no synthetic fragrance, no petrolatum, no dimethicone, no lanolin, no parabens, no mineral oil.** Lead with those absences and the count, not with an unqualified "clean".

**Frame 7 — live 2026-08-01, approved by Sean.** `frame-07-body-not-face.mjs`.

**The figure is generated, not drawn.** Three hand-built SVG attempts failed the same
way — bézier outlines, then round-capped strokes — the arms merged into the torso and
the "Hands" marker landed on what read as a hip. It looked like a stick figure, not a
diagram. `gen-body-silhouette.mjs` produces a real anatomical silhouette instead; it
depicts no product, so §3 permits generating it, and `depictsProduct: false` records
that the missing references are deliberate rather than an oversight.

**The markers are measured, not eyeballed** — which is what generating cost us, and
how it was paid back. The silhouette is keyed to alpha and its mask scanned row by
row: at 37% of figure height it resolves into three runs (left arm, torso, right arm),
which is where the elbows are; at 72% into two runs, the legs; at 97% into two feet.
Each anchor is the centre of the relevant run, stored as a fraction of the bounding
box so it holds at any display size.

Two decisions worth keeping:

- **The head is unmarked, not crossed out.** A ✗ over a face argues the belief and
  implies harm, which inverts the frame's job. Absence of a marker is the point.
- **`verify()` refuses to build if the copy drifts into a defence** — it fails on
  "comedogenic", "clog", "pore", "safe", "hypoallergenic", "acne" and similar.
  Exercised: "Non-comedogenic", "Safe for sensitive skin" and "Won't clog pores" all
  block. This is the frame most likely to attract a helpful edit that turns it into a
  claim.

Zone labels are the lander's own How to Use wording. The frame shows no product, so
its content is scent-agnostic — but under the alt-text scoping convention it still
needs one copy per scent, since an unscoped media in a scoped gallery is hidden for
everyone.

**Frame 7** works because it is true and narrow. It does not claim non-comedogenic, does not argue with the belief, and does not need to — it relocates the product. Body silhouette with the application zones marked, face excluded, one line of type.

**"What's in the box" cards** — only two components render here (`coconut-lotion`, `coconut-moisturizer`, 11 and 6 photos on file), so the cards are the best-supplied in the range and need nothing. The one thing to confirm is that the *Pure Unscented* and *Coconut Breeze* variants each have a distinct primary image, or both scent selections render the same card and the variant picker looks broken.

### Digital goods — how $34 of PDF stops looking like filler

The failure mode is a stock document icon or a floating generic PDF badge: it reads as padding and it actively devalues the $121, because the shopper concludes the value stack was inflated to reach $220. Three rules for frame 4:

1. **Show the actual page content, not the container.** Render the 90-Day Routine & Tracker as its real interior spread — a visible 90-cell grid with dates and checkboxes, a few cells already ticked — and the Field Guide as a real interior page with a legible heading and body text. If a shopper can read three real words off it, it is a product; if they can only see a cover, it is a badge.
2. **Give them physical presence.** Stage the tracker as a printed sheet lying beside one lotion bottle, and the Field Guide on a phone screen. Mixed physical/digital staging is what makes a PDF feel like an object. The four bottles do **not** appear in this frame — that is frame 1's job, and importing them splits the focal point.
3. **Price the line items on-image, not the total.** Small labels: *90-Day Routine & Tracker — $19* and *Coconut Skincare Field Guide — $15*, plus the delivery promise in the headline. Both figures are live in the `bundle.value_stack` metafield and were re-verified 2026-08-01. The $220 total already computes itself in the value-stack section of the template (`bundle-landing-architecture.md`); restating it on-image recreates exactly the literal-vs-data drift that produced the earlier total bug. **The frame's job is to make $34 believable, not to re-assert $220.**

**Frame 4 — live 2026-08-01, approved by Sean.** `frame-04-digital-goods.mjs`. Both
documents turned out to be substantial: the Routine & Tracker is **16 letter pages**
and the Field Guide **15**. The frame shows two of them at 200dpi, unmodified —
tracker page 10 (its real twelve-week grid) staged as a printed sheet with one
lotion bottle, and Field Guide page 6 ("How to read any label in 30 seconds") on a
tablet. Prices are read from `bundle.value_stack`, and `verify()` fails if the
stack stops carrying exactly two digital rows with positive amounts.

Two deviations from the spec, both deliberate:

- **A tablet, not a phone.** Page 6's heading and lower paragraphs run the full page
  width, so no narrow column exists to crop for a phone screen — every attempt
  sheared the ends off the lines. A letter-format guide is read on a tablet anyway.
- **The grid is shown blank.** The spec asked for "a few cells already ticked". The
  real page ships empty, and drawing ticks into it would mean editing the product to
  flatter it.

**Field Guide page 15 — "100% Organic Ingredients", corrected 2026-08-01.** I first
flagged this as false on the grounds that the panel opens with purified spring water.
**That was wrong, and Sean was right to push back:** water cannot be organic and is
excluded from the organic-percentage calculation entirely (USDA NOP, 7 CFR 205.302,
which excludes water and salt). Spring water sitting first on the list does not
weaken the claim.

What remains genuinely open is the **emulsifying wax**, and only because the panel
itself draws the distinction: coconut oil, jojoba, grapefruit seed extract and red
palm oil are each written *organic*, while the wax is written *plant-based*. Emulsifying
wax is a processed ingredient, so plant-derived feedstock does not by itself make the
finished wax certified organic — it depends on the process and the supplier's
certification. One ingredient, one supplier question. If it is certified, the claim
stands and the ingredient list should say "organic emulsifying wax"; if it is not, the
claim overstates by that one item.

Not a blocker for any frame, and page 15 is simply not needed — frame 4 uses page 6.

**Precondition — CLEARED 2026-07-31.** Both PDFs are real, not stubs: the 90-Day Routine & Tracker is **5.2 MB** and the Coconut Skincare Field Guide **9.1 MB**, both live on the Shopify CDN and delivered by Klaviyo flow `XFdcu6`. Frame 4 is buildable. Render from the actual interiors — the tracker's real 90-cell grid and a real Field Guide page — never a cover or a badge.

### Gaps

- **Grid/multi-SKU — deliberately omitted.** The Reset contains two distinct SKUs. A grid implies range, and using it here would misrepresent a depth bundle as a breadth bundle — the exact confusion with Head-to-Toe that the two pages need to avoid. Frame 1 gets the visual mass of four units without borrowing the wrong format's promise.
- **No value-stack frame.** The template already renders the stack from `bundle.value_stack` with a computed total. Duplicating it as an image freezes numbers that are designed to move.
- **No savings/anchor frame.** $174 → $121 stays in the buy box where Shopify shows it. Leading a frame with savings invites the per-unit comparison the whole bundle exists to escape. This is also why no frame carries a price: the three bundles repriced on 2026-07-31, and a price baked into a JPEG is the one thing that cannot be corrected by editing a metafield.

### Blocked

1. **BLOCKED-ON-THEME — per-bundle hero background.** Same shared-template constraint as Head-to-Toe (one `hero-desktop.webp` across all five landers). One Liquid change unblocks both bundles; count it once, not twice.
2. **MUST-SHOOT — supply transformation (frame 3).** In-house still-life of six full units vs. six genuinely used ones (three empty bottles, three spent jars). Blocked on having authentically emptied units; schedule the run-down rather than staging it. **Re-specced 2026-08-01: six units, not four** — the run-down is correspondingly bigger.
3. **MUST-SHOOT — customer skin transformation (frame 3b).** A 90-day recruitment-and-collection programme through the replenishment flow, not a photo session. Discrete tasks: write the day-0 request, define the fixed-frame protocol, collect day-0 from 3–5 customers, re-collect at day 90. **Start the recruitment now; the asset cannot be pulled forward later.**
4. ~~**PRECONDITION — confirm both bonus PDFs exist.**~~ **Cleared 2026-07-31** — both are real files on the CDN, delivered by flow `XFdcu6`. Frame 4 is buildable.
5. **BLOCKED-ON-PIPELINE — the generator cannot currently make any of these frames.** Every remaining Reset frame (2, 4, 5, 6, 7) carries legible on-image type, and two independent things in `agents/creative-packager` prevent that:
   - `config/creative-models.js` sets `imageGen: 'gemini-2.5-flash-image'`. §3 of this plan says to use `gemini-3-pro-image-preview` at 2K for any frame carrying legible text, **because Flash fails at text**. The configured model is the one the plan rules out.
   - `agents/creative-packager/index.js` appends the literal string `No text, logos, or labels.` to every image prompt it sends. That is correct for the ad-background path it was written for, and it makes a typographic frame structurally impossible.

   These are the real gate on frames 2, 4, 5, 6 and 7 — not art direction, and not the shoot list. Until a text-capable generate path exists, the only Reset frames that can move are the ones a camera or a compositor produces.

---

# Gift Box & The Clean Swap — product image stack

Both products are live with **zero** images in `product.images`. Everything below is a spec for that gallery
unless marked otherwise. Ratings cited are the aggregate of the component products' reviews and any on-image use
must say so.

Component photo library available to reuse or composite from: `coconut-lotion` (11), `organic-foaming-hand-soap` (9),
`coconut-moisturizer` (6), `coconut-oil-lip-balm` (6), `coconut-oil-deodorant` (5), `coconut-soap` (5),
`coconut-oil-toothpaste` (4).

---

### Gift Box

> **✅ PARTLY SHIPPED 2026-08-02.** Five frames × three kits = **15 media**, live and verified:
> each kit shows exactly its own five. Stack: **1** contents · **2** value · **3** they'll finish
> it · **4** nothing to react to · **5** reviews — spec frames 3, 7, 4, 5 and a review frame
> renumbered. The product had **zero** images before this.
>
> Also fixed: `seo.title` and `seo.description` were **null** — the page had no meta title or
> description at all. Both now derived from live data and asserted before writing (the value
> stack must equal compare-at, and the price must clear the $45 free-shipping floor before the
> copy may say "ships free").
>
> **✅ UNBLOCKED the same day.** Sean supplied the supplier's 3D visualization of the
> 10×8×4in mailer (`data/brand/packaging/mailer-10x8x4-3d-source.pdf`) and confirmed *"that
> is what the gift box looks like."* Spec **#1 "Arrives in this."** and **#2 "You don't have
> to wrap it."** are built and live as frames 6 and 7, and the open box now leads the gallery
> and is the `og:image`. **This was the oldest blocker in this document; it is closed.**
>
> Both boxes were lifted off the flat 216-grey backdrop with `scripts/cut-component.mjs` —
> the same flood fill the product cutouts use, and for the same reason: the box's interior
> pattern is 217 grey, one step from the backdrop, so no colour threshold separates them,
> but the pattern is enclosed by the box and therefore unreachable from a corner. Nothing is
> redrawn.
>
> **What it settles and what it does not.** It settles what the box *looks* like — printing,
> seals, interior pattern, proportions. It does **not** settle that a physical box *arrives*
> undamaged, which is the objection the review corpus actually raises ("wrapped in a thin
> tissue paper which was torn in a few places", 5 mentions). A rendering cannot answer that.
>
> **Spec #1's "all four products nested inside" is still unbuilt, deliberately.** The render
> shows an empty interior at a fixed perspective; compositing bottles into it would
> manufacture a photograph of an arrangement nobody has assembled. Frame 6 therefore claims
> only what a rendering supports — *"A printed box, not a poly bag"* — and `verify()` rejects
> the words photo/photograph/packed/nested/inside in either packaging frame's copy.
>
> **The real shoot is no longer critical path, but it is still the upgrade**: a photograph of
> a delivered box, contents nested, is the one asset that answers the damage objection.
>
> **Spec #6 ("Full-size. Not sample-size.") deliberately not built.** The plan's own note says to
> "verify the mini-size premise on a shelf before shipping the frame," and that has not happened.
> A comparison frame whose opposing column is an assumption about someone else's product is the
> exact class of claim this pipeline exists to stop. Frame 1's "Nothing in here is a sample" and
> frame 3's "Full sizes, not travel minis" make the same point about **our** products only, which
> needs no shelf.
>
> Two claims are now enforced in code rather than left to the next author
> (`data/brand/frames/gift-box/gb-common.mjs`): the word **"unscented"** can never reach a Gift
> Box frame outside a component's own variant name — two of three kits ship a Calming Lavender
> deodorant — and **"vegan" / "no palm oil"** are simply never claimed, because the lip balm
> carries organic beeswax and organic red palm oil.

**What the imagery has to do that the copy can't.** The copy sells the *idea* of a gift that gets used up; it cannot
prove a physical box exists. Every other bundle on this template is a shipment — this one is an object someone hands
to another person, and the entire $62 price rests on it arriving giftable. That is a photographic claim and nothing
else can make it. Our own review corpus says this is the live risk, not a hypothetical: "wrapped in a thin tissue
paper which was torn in a few places... so it may not work out well as a gift" (5 mentions under *who we're not for*),
plus 6 mentions of shipping and packaging failures. A gift buyer who reads that and sees no box photo does not buy.
The second thing imagery must carry is that the *recipient* is a different person from the *buyer* — the buyer never
uses this. So the frames sell the moment of handing it over and the safety of giving it to someone whose skin reacts
to everything, not lotion performance. **Buyer:** the Q4 gift-giver buying for a specific person she can't shop for —
closest match in `personas.md` is the fragrance-sensitive angle p3a1, whose evidence is literally a gift purchase
("Bought for a friend who can't have any scented products. She loves it."), reinforced by the *trigger point*
"buying for someone else — a gift for a person who cannot tolerate any scented products" (4 mentions).

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|---|
| 1 | Headliner | Prove the physical box exists and looks like a gift | Q4 gift-giver, unsure we're a real gift brand | "That's a real box, and I can see what's in it" | **Arrives in this.** | MUST-SHOOT | M |
| 2 | Benefit callout | Kill the wrapping/packaging-integrity objection | Gift-giver shipping straight to the recipient | "I don't have to do anything to it" | **You don't have to wrap it.** | MUST-SHOOT | M |
| 3 | Grid/multi-SKU (×3, variant-linked) | Show exactly what's in the chosen kit | Gift-giver comparing Gentle vs Calm vs Fresh | "Four full-size things, and I know which scents" | **The Gentle kit** *(/ Calm / Fresh)* | COMPOSITE `coconut-lotion` + `coconut-oil-lip-balm` + `coconut-soap` + `coconut-oil-deodorant` | M |
| 4 | Benefit callout | Answer "will they actually use it" | Giver burned by candles and bath sets that sat unopened | "This gets finished, not displayed" | **Four things they'll finish. Not one thing they'll display.** | GENERATE (Ad Builder) | S |
| 5 | Educational infographic | De-risk giving it to someone with reactive skin | Buying for the friend who reacts to everything | "Safe to give to a picky-skin person" | **For the person who reacts to everything.** | COMPOSITE `coconut-soap` + `coconut-lotion` | S |
| 6 | Us-vs-them comparison | Beat the department-store bath set at the same price | Giver deciding between us and a mall gift set | "Theirs is minis, ours is full-size" | **Full-size. Not sample-size.** | COMPOSITE `coconut-lotion` + `coconut-soap` | M |
| 7 | Text-only | Overcome the $62 sticker on a body-care gift | Price-checking giver with a ~$50 gift budget | "The math is in my favor" | **$71 of product. $62. Ships free, in the box.** | GENERATE (Ad Builder) | S |

**Frame notes (art direction, not optional):**

- **#1** — box open, lid lifting off in-frame at a slight angle, all four products nested inside and identifiable,
  shot on a plain warm surface. Headline top-third, box lower two-thirds. The lid must be the actual production box.
- **#2** — the closed box held in two hands at giving scale, no ribbon or props added that we don't ship. If we do not
  include a ribbon, do not photograph one. Shoot this at the same session as #1.
- **#3** — flat lay on white, each product captioned with its variant name from `config/bundles.json` (e.g. "Body Lotion —
  Pure Unscented"). Three versions, attached to the Gentle / Calm / Fresh variants so the gallery swaps with the picker.
  The lip balm slot must show **four tubes**, not one — this is a 4-pack and a single-tube photo understates it.
- **#5** — no-SLS / no-parabens / no-synthetic-fragrance card. **Do not print the word "unscented" on this frame.**
  The Gentle kit contains a Calming Lavender deodorant; the site's own FAQ says "we don't make an unscented deodorant,
  so we won't call the box unscented." The honest line is "no synthetic fragrance — scent, where there is any, is
  essential oil."
- **#6** — our column may only make claims we can verify off our own spec sheet (8oz lotion, full-size deodorant,
  full-size bar, 4-pack balm). The opposing column is generic ("typical bath gift set: travel minis"), names no brand,
  and shows no recognizable trade dress. Verify the mini-size premise on a shelf before shipping the frame.
- **#7** — value stack is real: $30 + $15 + $15 + $11 = $71 of product, sold at $62, with $6 shipping absorbed.
  Set on flat color, no product. This is the frame that borrows organic credibility, so no ad furniture.

**Gaps**

- **Transformation — deliberately omitted.** There is no truthful before/after for a gift box. The buyer never uses the
  product, so any skin transformation shown here would be attributed to the wrong person, and the one real before/after
  we own (the mother's month-apart eczema photos) is of `coconut-moisturizer`, which is **not in this box** — using it
  here would be a misattributed claim. The transformation slot for this cluster is carried by The Clean Swap (#4).
- **Us-vs-them against CeraVe/Vanicream/Cetaphil — omitted.** Those are the rivals for a lotion purchase, not a gift
  purchase; nobody gift-boxes Cetaphil. The relevant rival at $62 in Q4 is the bath gift set, which is what #6 targets.

**Blocked**

- **MUST-SHOOT — Gift Box packaging session.** One shoot, two setups: (a) box open with contents nested, (b) closed box
  in hands. Requires production boxes in hand plus one unit of each Gentle-kit component. **Hard-gated by the
  mid-September date** — this is the only item on either bundle that cannot be produced from existing assets or
  generation, so book it first and treat its lead time as the critical path for Q4 gifting.
- **BLOCKED-ON-THEME — per-bundle hero image.** `bg_image_desktop` / `bg_image_mobile` are section settings on the
  `bundle-landing` template shared by all five landers, so all five currently render `hero-desktop.webp`. The Gift Box
  wants a distinct gifting hero and cannot have one until a Liquid change reads the hero from a product metafield with
  the section setting as fallback. **This is engineering work, not art direction** — one change unblocks all five landers.
- **Component photo inadequacy — `coconut-oil-lip-balm`.** The "what's in the box" card renders the component's own
  images, which show the balm as a single tube; this bundle ships a **4-pack**. Needs one 4-tube photo added to the
  lip balm product so the card stops understating the $15 line item. Small shoot or composite from the existing 6.

---

### The Clean Swap

**What the imagery has to do that the copy can't.** The copy lists four products; the gallery has to make them read as
**one routine** rather than four unrelated things bundled to hit a price. Lotion, deodorant, toothpaste and soap live in
different aisles in every store the buyer has ever shopped — nothing in her experience says they belong together, and a
list won't fix that, only a single frame showing all four in one place at one moment will. The second job is arithmetic:
this store's buyers carry a hard ~$15 ceiling on a body lotion ("I'm hoping to spend around $15 or less", 4 mentions),
so $59 reads as expensive until it's shown as four things at $14.75 each — that reframe is a visual, not a sentence.
Third, imagery has to de-risk the *category* switch, because the objection is that natural products don't work: bar soap
strips (4 mentions), coconut oil is comedogenic (6 mentions), natural oils feel like "a greasy baked good" (5 mentions).
**Buyer:** the whole-family household switcher (p5, 16 mentions) crossed with the ingredient-label reader (p2, 25 mentions)
— someone mid-way through a deliberate decision to lower the household's chemical load, who has already swapped one
thing and is looking for the rest.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|---|
| 1 | Headliner | Make four categories read as one routine | Household switcher, mid-swap | "That's my whole morning in one box" | **Everything you touch before 8am.** | COMPOSITE all four components | M |
| 2 | Grid/multi-SKU (×3, variant-linked) | Show exactly what the chosen kit contains | Shopper comparing Gentle vs Calm vs Fresh | "Four full-size products, these scents" | **The Gentle kit** *(/ Calm / Fresh)* | COMPOSITE `coconut-lotion` + `coconut-oil-deodorant` + `coconut-oil-toothpaste` + `coconut-soap` | M |
| 3 | Text-only | Break the ~$15-per-item price ceiling | Price-checking switcher who thinks $59 is a lot | "That's under fifteen dollars each" | **Four products. $14.75 each.** | GENERATE (Ad Builder) | S |
| 4 | Transformation | Show the change, honestly | Switcher staring at a cluttered counter | "Nine bottles become four" | **Nine half-used bottles. Then four.** | COMPOSITE `coconut-lotion` + `coconut-oil-deodorant` + `coconut-oil-toothpaste` + `coconut-soap` | M |
| 5 | Us-vs-them comparison | Name what's leaving the bathroom | Ingredient-label reader auditing the swap | "I'm removing SLS, aluminum, parabens, fluoride" | **The four things you're swapping out.** | GENERATE (Ad Builder) | S |
| 6 | Benefit callout | Kill the greasy/comedogenic coconut objection | The anti-grease convert (p4) | "Coconut, but it sinks in" | **Coconut oil that's gone before you get dressed.** | REUSE `coconut-lotion` | S |
| 7 | Educational infographic | Explain why one oil runs the whole routine | Label reader who distrusts "natural" marketing | "Same base ingredient in all four" | **One oil. Four products. No SLS in any of them.** | COMPOSITE `coconut-soap` + `coconut-oil-toothpaste` | M |

**Frame notes (art direction, not optional):**

- **#1** — the four products standing on a real bathroom counter in morning light, lotion bottle in hand mid-pour,
  toothbrush and a folded towel in frame for scale and context. Not a white-background product shot — the whole point
  is the counter. Headline across the top third; the four products must all be legible at thumbnail size, which means
  no more than four objects plus the hand.
- **#2** — flat lay on white, variant names captioned from `config/bundles.json`. Three versions, variant-linked to the
  Kit picker. Note Gentle and Calm differ only in the bar soap (Pure Unscented vs Calming Lavender) and Fresh changes
  all four — the Fresh grid is the one that has to look visibly different, so shoot/composite it distinctly.
- **#3** — $69 of product at $59, four items, $14.75 each. Type only, flat color, no product, no ad furniture. This is
  the single highest-leverage frame on the page: it converts the price objection into a price *argument* and it is an
  S-effort text render.
- **#4** — the honest transformation. LEFT: a real cluttered counter, eight-to-nine half-used bottles. RIGHT: the same
  counter, four products. **This is a clutter transformation, not a skin transformation** — do not stage or imply a
  before/after of anybody's skin, and do not reuse the eczema before/after photos, which belong to `coconut-moisturizer`
  and are not in this box. The "before" bottles must be plain, unbranded or label-turned; no recognizable competitor
  trade dress. Shot on the same counter as #1 so the two frames read as one story.
- **#5** — checklist card: SLS, aluminum, parabens, synthetic fragrance, fluoride out; coconut-oil base in. Claims about
  the "before" column are category-level statements about conventional formulas, which are defensible; do not name or
  depict a specific brand. Fluoride belongs in this column for this bundle only — the Gift Box has no toothpaste in it.
- **#6** — reuse the best texture/absorption frame from the 11 `coconut-lotion` images; a rubbed-in forearm with no
  visible sheen. This is the frame that answers the store's most repeated product objection, so it earns a gallery slot
  even though it's about one of the four SKUs.
- **#7** — the shared-base explainer: saponified coconut oil in the bar, coconut oil in the lotion, coconut oil in the
  toothpaste. Borrows organic-infographic credibility, so keep it diagrammatic and undesigned-looking.

**Optional 8th frame (only if the rating is used at all):** benefit callout carrying **"4.64 from 205 reviews — of the
four products inside this box."** The qualifier is not a footnote, it is part of the headline; there is no review count
on the bundle SKU itself and an unqualified "4.64 (205)" on-image would misrepresent that. Same rule for the Gift Box
(4.78 from 175). Effort S, GENERATE.

**Gaps**

- **None in the rotation.** All seven formats are covered on this page: educational infographic (#7), headliner (#1),
  benefit callout (#6), us-vs-them (#5), transformation (#4), grid/multi-SKU (#2), text-only (#3). This is the bundle
  that carries the transformation slot for the pair, because the counter-clutter change is real and shootable where a
  gift-box transformation is not.
- **Deliberately not shown: the step up to the 90-Day Clean Swap ($144).** It belongs in page copy and the FAQ, not in
  the gallery. A frame selling the bigger box would violate one-job-per-frame and would argue against the purchase the
  visitor is on the page to make.

**Blocked**

- **BLOCKED-ON-THEME — per-bundle hero image.** Same single ticket as the Gift Box: `bg_image_desktop` /
  `bg_image_mobile` are section settings on the shared `bundle-landing` template, so The Clean Swap cannot have a
  bathroom-counter hero distinct from the other four landers without a Liquid change reading the hero from a product
  metafield (section setting as fallback). Count it once, as engineering.
- **Component photo inadequacy — `coconut-oil-toothpaste` (4 images).** Thinnest library of any component and the least
  familiar product in the box. The "what's in the box" card renders its own photos; check that at least one is a clean
  straight-on shot on white before launch, and add one if not. No shoot needed if an existing frame crops acceptably.
- **MUST-SHOOT — none.** Every frame here is reusable, compositable or generatable from the existing 40-image component
  library. This bundle can ship its full stack without a camera, which is why it should not wait on the Gift Box shoot.

---

### Cross-cutting note (copy, not imagery — flagging so it isn't repeated on-image)

Both landers currently carry `rating_caption: "Rated 4.9 by Real Customers"` in `config/bundles.json`, while the actual
component aggregates are **4.64 (205 reviews)** for The Clean Swap and **4.78 (175)** for the Gift Box. The on-image
specs above use the true numbers with the "reviews of the products inside" qualifier. The 4.9 caption is a separate
copy fix outside this fragment's scope, but no frame should be built to match it.

---

# Media fragment — Hand Soap Set & The 90-Day Clean Swap

Scope: product-gallery image stacks for two bundles. Frames are specced, not produced.
Doctrine applied: one job + one persona per frame, headline-first hierarchy, 1-second comprehension, full format rotation.

**Effort key:** `S` = typeset or crop from assets on file (<1h). `M` = new composite or generated set-piece (half-day). `L` = new photography, or a multi-version shoot (day+).

**Source key:** `REUSE <handle>` = existing product photo, recropped. `COMPOSITE <handles>` = built from existing product photography. `GENERATE (Ad Builder)` = real product image + text style brief through the Ad Builder recipe. `MUST-SHOOT` = camera required.

---

### Hand Soap Set

> **✅ SHIPPED 2026-08-02.** Thirteen media, live and verified across all **12** variants. The
> product had **zero** images and null SEO title/description before this.
>
> **The two-option problem, and the way out.** This is the only bundle with two options —
> Configuration (3 values) × Scent (5) — and the theme's gang convention scopes a media to
> exactly ONE option/value pair. Fifteen fully-specific contents frames cannot exist. So the
> two facts are carried by different frames:
>
> | frames | scope | carries |
> |---|---|---|
> | `frame-01-scent-*` (4) | Scent | the bottle and its real oil list — **leads** |
> | `frame-02-config-*` (3) | Configuration | the count **and the price** — type only |
> | `frame-03-range-*` (3) | Configuration | the four scents |
> | `frame-04-reviews-*` (3) | Configuration | catalogue proof |
>
> A buyer who has chosen both sees four images: their scent's bottle, their configuration's
> count and price, the range, the proof. The configuration frames are deliberately
> typographic — a Configuration-scoped frame is shown for all five of its scents, so drawing
> a Pure Unscented pump there would show the wrong bottle to four buyers in five.
>
> ### Variety was removed, 2026-08-02
>
> Sean: *"Actually, don't offer variety at all."* The three Variety variants are deleted
> (15 → 12) and Shopify dropped the value from the Scent option. Zero orders had ever
> referenced them across 1,259 scanned, and the 104 units of notional inventory were
> released with them.
>
> **The variants were the easy part. The copy that outlived them was the risk** — three
> surfaces promised a mixed set the moment the option stopped existing:
>
> - the range frame's footer, *"Pick one scent, or one of each"*
> - its alt text, *"available singly or as a Variety set"*
> - the SEO meta description, *"One scent or one of each"*
>
> All three are rewritten, and a test now asserts that no frame source, no alt text and no
> roster entry offers a mixed set. Removing an option is never just removing the option.
>
> ### ⚠️ Every media is scoped, and that is the second lesson
>
> The first version left the range and reviews frames **unscoped** and sorted them first —
> the only safe place for an unscoped media, because `gang_exist` is sticky. It passed every
> check: 15/15 variants showed exactly the right set.
>
> It was still wrong, and Sean caught it on the storefront: *"The main image does not change
> no matter what scent or configuration you choose."*
>
> **The gallery shows the first media that is not hidden, and an unscoped media is never
> hidden.** So an unscoped lead is the main image for every variant — the buyer changes their
> selection and the big picture does not move. That is in direct tension with the ordering
> guard, and the tension is real rather than a bug in either rule:
>
> - an unscoped media is only *safe* first (sticky `gang_exist`);
> - a media that is first and unscoped *pins* the main image.
>
> On a multi-variant product you have to pick, and **scoping everything is almost always the
> answer** — duplicating a universal frame once per option value costs three identical JPEGs.
> `set-media-variant-scope.mjs` now warns when a multi-variant product has an unscoped lead.
>
> **A media scopes to one option, so the main image can track exactly one of the two.** Scent
> leads, because Scent is the choice that changes what the product looks like; Configuration
> changes the count and price, and frame 2 sits immediately behind it carrying both.
>
> **⚠️ It needed its own template, and that is the finding worth carrying.** The theme gates
> the entire scoping branch on `main-product.hide_variants == false`. On `templates/product
> .json` — the default PDP, which this product used — it is **true**, so the suffixes were
> written and were completely inert: all ten images showed for every variant, including a
> $72 frame to a $44 buyer. Nothing reported it.
>
> `scripts/set-media-variant-scope.mjs` documented that precondition from the day it was
> written and **never actually checked it**. It does now, following the product's own
> `templateSuffix` because settings are per template. `templates/product.hand-soap-set.json`
> is a copy of the default PDP differing in that one setting — safe here only because this
> product has no variant-attached media, which the creation script verifies.
>
> **Follow-up: move it to `bundle-landing`.** That is the better home — it is a bundle, and
> the lander's per-variant value panel and "What's in the box" grid are metafield-driven,
> so they would handle all 15 combinations exactly without the gang convention at all. It
> needs a `bundle_lander` metaobject this product does not have (heading, subheading, CTA,
> bullets, buybox bullets, FAQ, tabs) — customer-facing positioning copy, not a mechanical
> migration.
>
> **This page may not say "ships free".** The cheapest configuration is **$44** against a
> **$45** free-shipping floor. No frame claims it and the SEO description asserts against it.

The copy can name the three configurations but it cannot make the buyer *feel* which one is theirs — a `Configuration` × `Scent` matrix with 15 cells reads as homework in text, and this page currently has zero images to soften it. What the imagery has to do is convert a pricing table into a choice: show that this is one product sold in three sizes, show the scent axis as a menu rather than a dropdown, and make the +lotion step-up feel like a reason rather than an upsell. The buyer is a household stocker — someone who has decided their hand soap should stop being a grocery-aisle afterthought and is now buying for every sink at once, usually a homeowner, often also the person in the house whose hands are wrecked from washing. Because a 15-cell matrix cannot be served by per-variant gallery images, every frame here is deliberately variant-agnostic or explicitly configuration-labelled; the gallery sells the *system*, and the "What's in the box" cards handle the specific basket.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|---|---|---|---|---|---|---|---|
| 1 | Grid/multi-SKU | Convert the configuration matrix into a visible three-way choice, using the exact selector wording | Undecided shopper who just landed and is weighing how much to buy | "One product, three sizes — I pick one" | **One set, three ways.** | COMPOSITE `organic-foaming-hand-soap` + `coconut-lotion` | M |
| 2 | Headliner | Make a single pump look worth its unit price; establish what the product physically is | Ingredient-checker who flips bottles over at the grocery store | "Premium foaming coconut hand soap" | **Foaming coconut hand soap. No SLS.** | REUSE `organic-foaming-hand-soap` | S |
| 3 | Grid/multi-SKU | Turn the Scent dropdown into a menu, and make "Variety" legible as an option | Scent-curious buyer deciding kitchen vs. bath | "Four scents, and I can mix them" | **Four scents — pick one, or one of each.** | COMPOSITE `organic-foaming-hand-soap` | M |
| 4 | Benefit callout | Land the household-coverage payoff — this is a whole-house order, not a bottle | Homeowner stocking every sink in one go | "This covers the whole house" | **One order. Every sink.** | GENERATE (Ad Builder) | M |
| 5 | Transformation | Justify the +lotion configurations with the actual problem they solve | Over-washer with dry, tight hands — nurse, parent, cook | "Washing does that; the lotion fixes it" | **Wash all day. Hands still fine.** | MUST-SHOOT | L |
| 6 | Educational infographic | Own the coconut-oil base and the four exclusions before the buyer goes looking | Label-reader avoiding SLS and synthetic fragrance | "Coconut-oil base, none of the bad stuff" | **Coconut oil base. No SLS, no parabens, no synthetic fragrance.** | GENERATE (Ad Builder) | M |
| 7 | Us-vs-them comparison | Beat the grocery-aisle default on the two axes that matter | Comparison shopper currently buying a supermarket "natural" foaming soap | "Theirs has things mine doesn't" | **Read the back of the other one.** | GENERATE (Ad Builder) | S |
| 8 | Text-only | Supply proof at the moment the $44+ price registers | Hesitant first-timer who has never bought soap at this price | "Lots of people rate these highly" | **4.81 out of 5 — from 138 reviews of the products in this set.** | GENERATE (Ad Builder) | S |

### Frame notes (build-critical)

- **#1 must survive a 200px thumbnail crop** — it is also the collection tile and cart thumbnail. Three clusters maximum, captions at ≥1/12 of frame height. Caption each cluster with the option value verbatim — `4 pumps` / `3 pumps + body lotion` / `4 pumps + body lotion` — so the image maps 1:1 onto the selector.
- **#1 carries no dollar figures.** Prices belong to `config/bundles.json` and the buy box; baking $44/$59/$72 into a raster is the same drift bug the lander hero already shipped once. The image says *what*, the page says *how much*.
- **#1 lotion scent:** render the Pure Unscented lotion and caption "lotion scent follows your selection where available" — true, since only the Coconut Breeze configurations ship a Coconut Breeze lotion.
- **#3** carries a subcaption "Scent options — configuration chosen separately" so a four-bottle row is never mistaken for a contents claim.
- **#4** carries "Shown: the 4-pump set" in-frame. This is the only other frame depicting a count, and it is labelled.
- **#5** is shot as the same pair of hands, same day, before and after lotion. No skin-condition claim, no medical language — the change shown is moisturization, which is what actually happens.
- **#7** compares against "conventional foaming hand soap" as a category. Do not name Method, Mrs. Meyer's or any brand on-image.

### Gaps

No rotation format is omitted — all seven are covered, with grid/multi-SKU used twice (#1, #3) because this product has two independent choice axes and grid is the only format that shows a choice rather than asserting one. What is deliberately absent:

- **No duration or per-use cost frame.** Hand soap is a replenishment product with no defensible supply window, and the store just pulled a false "90-day supply" claim off two pages. Nothing here says how long anything lasts.
- **No per-variant gallery.** 15 cells cannot be honestly served by assigned variant images, and a partial set is worse than none — a buyer on `3 pumps + Orange Zest` seeing a four-bottle photo is exactly the failure this stack is built to avoid.
- **No skin before/after.** #5 shows moisturization, not a repaired hand. Anything stronger is not truthfully shootable.

### Blocked

1. **MUST-SHOOT — frame #5, hands before/after lotion.** One model, one session, controlled lighting, two exposures ~20 minutes apart. Blocks the only frame that sells the $59/$72 step-up.
2. **BLOCKED-ON-THEME — this product has no hero surface at all.** `hand-soap-set` is still on the default PDP template (`templateSuffix: null`), so the gallery is the entire visual argument. When the lander in review ships on `bundle-landing`, it inherits the one shared `hero-desktop.webp` along with the other four bundles.
3. **BLOCKED-ON-THEME — per-bundle hero background.** `bg_image_desktop` / `bg_image_mobile` are section settings on the shared `bundle-landing` template, so all landers render one hero. Fix mirrors the pattern already used for hero prose: have `sections/hero-landing-section.liquid` read a per-product image (metaobject field or `bundle.hero_image` product metafield) and fall back to the section setting. Engineering task, not art direction. Until it lands, do not spec a distinct hero for any bundle.
4. **Component card inadequacy — `organic-foaming-hand-soap` featured image.** The `whats-in-it` cards render each component's *featured* image, which is one fixed scent. A buyer on Variety, or on any scent other than the featured one, sees a card that does not match their basket. Nine images are on file; the fix is a scent-neutral featured image (bottle with an unbranded or generic-label crop), not new photography. No gap on `coconut-lotion` — 11 images on file, adequate for the +lotion configurations' card.

### Three-configuration note

The stack stays true across all 15 variants by keeping contents depiction to exactly two of eight frames, both explicitly labelled:

- **Frames 2, 3, 5, 6, 7, 8 make no claim about the box.** They show the product itself, the scent menu, an outcome, ingredients, a category comparison and aggregate ratings. Every one of those is equally true for a $44 four-pump-lavender buyer and a $72 variety-plus-lotion buyer.
- **Frame 1 shows all three configurations simultaneously**, each captioned with its exact option value. It cannot mislead about "the box" because it does not assert one — it asserts a choice, which is the literal truth of a three-configuration product.
- **Frame 4 is the single lifestyle frame that shows a count**, and carries "Shown: the 4-pump set" in-frame.
- **No frame states a price**, so the gallery cannot drift out of sync with the three price points.
- The per-variant truth is delegated to the two surfaces that derive it from data: the buy box and the "What's in the box" cards, which read `components` directly.

Net effect: there is no variant among the 15 for which any frame in this gallery is false.

---

### The 90-Day Clean Swap

> **🚨 Repriced. Every $159 below is stale — the live price is $144.** Verified against
> Shopify 2026-08-02: all three variants are **$144**, compare-at **$207**. The spec's
> own frame-3 note calls its figures "drift-bound to `price: 159`" and asks for a flag if
> either changes; the price changed and nothing flagged it, which is the argument for
> frames deriving their numbers rather than being audited for them.
>
> What that changes:
> - Frame 3's headline is **"$207 of products. $144."**, not $159.
> - Frame 3's secondary is **"12 products — $12.00 each"**, not $13.25. ($144 ÷ 12 = exactly $12.00.)
> - The $12.00 figure now sits *below* the ~$15 ceiling the VOC file documents rather
>   than near it, so the price-framing argument is stronger than when this was written.
>
> Verified and unchanged: `rating_value` 4.64 and `rating_count` 205 for frame 8, and
> `component_qty` [3,3,3,3]. Compare-at is product-only and honest — the `value_stack`
> product lines sum to exactly $207.
>
> **Shipping in the value stack was raised $6 → $12 on 2026-08-02** (Sean: twelve
> full-size units do not ship for $6, and the 6-unit Coconut Reset already claimed $12 —
> the heaviest bundle in the range was claiming the lowest shipping value). The lander
> templates its figures from the metafield, so this propagated on its own and is verified
> live: **total value $219** (was $213) and **"You save $75"** (was $69).
>
> Frame 3 is unaffected — it prints $207 (product-only compare-at) against $144, not the
> value-stack total. **Do not build any frame on $213.**
>
> **Frame 1 is not blocked.** See the frame notes below — the Sensitive Skin Set shipped
> its contents frame as a composite of real component photography on 2026-08-01, and that
> approach applies here.

At $144 against a ~$47 store AOV this is the largest single ask in the catalogue, and the copy has already said everything it can — "three months of all four" is an accurate sentence that does nothing to the gut. Twelve full-size products photographed together is arithmetic the eye does in under a second, and it is the one argument that cannot be made in text. The imagery has two jobs the copy cannot reach: make the volume visible, and break the perceived ~$15 ceiling by reframing $144 as twelve purchases rather than one. The buyer is someone already mid-switch — they have replaced one or two products, their shelf is half clean and half drugstore, and they are tired of doing it one bottle at a time. They are not price-shopping a lotion; they are buying the end of a project. That is why the shelf, not the skin, is where the transformation lives.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|---|---|---|---|---|---|---|---|
| 1 | Grid/multi-SKU | Make twelve units visible at once — the volume argument | Sticker-shocked visitor deciding whether $144 is a lot or a little | "That is a genuinely large amount of product" | **12 full-size products. One box.** | COMPOSITE (was MUST-SHOOT) | M |
| 2 | Headliner | Frame the purchase as finishing the switch, not buying a box | Someone who has been swapping products one at a time for months | "I can do the whole routine in one order" | **Swap your whole routine at once.** | COMPOSITE `coconut-lotion` + `coconut-oil-deodorant` + `coconut-oil-toothpaste` + `coconut-soap` | M |
| 3 | Educational infographic | Break the ~$15 ceiling by pricing per product instead of per box | Buyer who balks at $30 for a lotion | "Each thing costs less than buying it alone" | **$207 of products. $144.** | COMPOSITE `coconut-lotion` + `coconut-soap` | M |
| 4 | Instructional / step-by-step | Set expectations for the switch so the adjustment period does not read as failure | Buyer worried about swapping four products at once | "There is a rough patch, it is short, and they told me up front" | **Switching everything at once? Here is what to expect.** | RENDER | S |
| 5 | Benefit callout | Sell the absence of reordering as the real product | The person who runs out of deodorant on a Tuesday | "I stop thinking about this for a while" | **Nothing to reorder for months.** | GENERATE (Ad Builder) | M |
| 6 | Us-vs-them comparison | Win the ingredient argument against the drugstore "gentle" default | Cross-shopping CeraVe / Vanicream / Cetaphil on ingredients | "Theirs is petrolatum, mine is coconut oil" | **Coconut oil, not petrolatum.** | GENERATE (Ad Builder) | M |
| 7 | Educational infographic | Resolve Gentle vs. Calm vs. Fresh so the variant choice stops being a coin flip | Buyer already sold, stuck on which kit | "Three kits, and here is the scent difference" | **Gentle, Calm or Fresh — here's what changes.** | GENERATE (Ad Builder) | M |
| 8 | Text-only | Deliver proof at the price objection, attributed honestly | Last-mile hesitant buyer at 3× their normal order | "Real ratings, and they're on the products inside" | **4.64 out of 5 — from 205 reviews of the products in this box.** | GENERATE (Ad Builder) | S |

### Frame notes (build-critical)

- **#1 is the whole page.** Overhead, three rows of four or four rows of three, one clean surface, product-only, no props competing for the focal point. Shoot **three versions** — Gentle, Calm and Fresh differ in lotion, deodorant and soap variants — and assign them as Shopify variant images. Unlike the Hand Soap Set, three variants is a tractable number, so this gallery *can* and *should* be variant-accurate at the contents frame.
- **#1 is a COMPOSITE of real component photography** — revised 2026-08-02. The original rule ("contents depiction must match what ships; compositing is reserved for lifestyle, texture, ingredient and scale") was written against *generated* composites, which redraw labels and cannot be trusted. A composite of keyed, unretouched product photographs at one true physical scale does not have that failure mode: no label is redrawn, so what is depicted is exactly what ships. The Sensitive Skin Set shipped on this basis 2026-08-01. A real flat-lay is still better and remains on the shoot list; it is no longer a blocker.
- **#3 dollar figures are read from live Shopify at render time**, not bound to a config value and audited. The original note bound them to `price: 159` and asked for a flag if it changed; it changed to $144 and nothing flagged it. The frame now derives both numbers and its `verify()` fails the build if `price × 12` no longer equals the per-unit figure it prints. Secondary line: "12 products — $12.00 each." That is division of two stated numbers, not a duration or per-day claim.
- **#4 replaced the shelf before/after, 2026-08-02.** Sean: no transformation frames for now. What went in instead is the format the rotation was actually missing — instructional/step-by-step — grounded entirely in copy already on the lander rather than in anything new:

  > *"Do I have to switch everything at once?"* — "No, but most people find it easier. **Swapping one product at a time drags the adjustment out.**"
  > *"Is there an adjustment period with natural deodorant?"* — "Often yes — **usually one to two weeks** as your body adapts. It passes."

  Those two answers are the whole frame. It says the switch has a rough patch, that it is one to two weeks, and that doing all four at once shortens it rather than multiplying it — which turns the bundle's biggest objection ("four changes at once sounds worse") into its argument.

  This is the one frame in the stack that pays twice. `marketing-product-image-stack` rates a numbered step-by-step at 8/10 here specifically because misuse during the deodorant transition is a named driver of the 18-22.5% repeat rate: a buyer who quits in week one never reorders, and no amount of gallery work downstream recovers them. Conversion asset and retention asset in one slot.

  WARNING: no day count beyond "one to two weeks", and no promise about outcome. The FAQ says "often yes" and "it passes"; the frame may not upgrade either into a guarantee.
- **#5** may say "months" — three units each of lotion, deodorant, toothpaste and bar soap clears a quarter against measured reorder gaps with room to spare. Do **not** put a specific day count on the frame; "months" is defensible, "90 days of everything" invites the same audit that killed the claim on two other pages.
- **#6** describes the comparison target as "conventional drugstore 'gentle' lotion" in-frame. Name no brand on the image; the brands belong in the page copy where they can be discussed, not in a raster that circulates.
- **#7** must show only what actually differs between kits — toothpaste is Fresh Mint in all three, so it appears once as a constant. Do not imply Gentle is unscented; it ships a lavender deodorant, and the page FAQ already says so.

### Gaps

Every rotation format except transformation is covered, with educational infographic used twice (#3, #7) because this product has two distinct comprehension problems, a price-framing one and a variant-selection one, and collapsing them into one frame would put two jobs in one image. What is deliberately absent:

- **No transformation frame of any kind.** Sean, 2026-08-02: not doing before/after right now. The shelf swap that used to occupy slot 4 is cut, not deferred into a blocker. There is also no truthful, reproducible *skin* transformation to shoot for a four-product routine box, so the format stays out on both counts.
- **No unboxing or packaging-beauty frame.** `packaging: 0` — there is no custom box, and imagery implying one would misrepresent what arrives.
- **No lifestyle-model frame.** Twelve products is the argument; a person holding one bottle actively undercuts the volume read that #1 exists to deliver.

### Blocked

1. **Nothing blocks the stack.** Every frame is buildable today. The only former blocker, frame #1's twelve-unit flat-lay, ships as a composite of real component photography (see frame notes); a real overhead shoot stays a worthwhile *upgrade* on the session-B list, but it is not gating. Frame #4's shelf before/after was cut outright on 2026-08-02, not deferred.
2. **BLOCKED-ON-THEME — per-bundle hero background** (same task as the Hand Soap Set entry; one Liquid change unblocks both, plus the other three landers on `bundle-landing`). Without it, the 90-Day Clean Swap's hero is the shared `hero-desktop.webp` regardless of what this stack specifies. This stack requests a distinct hero — frame #1's flat-lay, cropped wide — and until the Liquid change lands, that request is engineering work, not an art request.
3. **Component card check — `coconut-oil-toothpaste`.** Four images on file, the thinnest library of any component in this box, and it is the SKU most likely to have a weak featured image standing in as a "What's in the box" card on a $144 page. Verify the featured image reads at card size before launch; if not, it is a recrop, not a shoot. `coconut-lotion` (11), `coconut-oil-deodorant` (5) and `coconut-soap` (5) are adequate.

---

### Sensitive Skin Set — $46.80

> **🚨 The one live image has fabricated labels. Read before building.** `v20.webp`
> (2048², no alt) is AI-generated and was never audited.
>
> **Its composition is right.** The **hand & body soap and lip balm four-pack** beside the
> lotion and cream are the **free gift with a first subscription** — the PDP says
> "Subscribe and your first order ships with a free Pure Unscented Lip Balm and a free
> Unscented Bar Soap", and `coconut-oil-lip-balm` is itself a four-pack SKU, so four tubes
> is one gift item. Confirmed by Sean 2026-08-01. An earlier draft of this note called
> these "products not in the box"; that was wrong and is retracted.
>
> **Every printed figure on it is fabricated.** The lotion reads `0 fl. oz · 300ml`
> against a real 8 fl. oz · 236ml; the cream `4 fl. oz · 150ml` against a real 118ml; the
> soap's net weight is `2 Lin · 8.ia` against a real 3.4 oz · 84g, under a made-up
> barcode; all four lip balms read **"moisturizing broom"**. Replace it rather than adding
> alt text, and never use it as a reference **for label text** — its staging is fine to
> reference.
>
> **The gift is a conversion finding, not just a caption.** It is $26 at retail on a
> $46.80 order and appears on the PDP exactly once, inside a collapsed accordion. It gets
> its own frame — see frame 6, added to the stack below.
>
> **Corrections to the stack below**, from what shipped on the Reset 2026-08-01:
> frame 1 is a **bottle and a jar**, not "two jars"; frame 4 must **not name CeraVe or
> Vanicream** — we contrast against the lotion market in general, using the real 34-item
> panel in `data/brand/reference/comparison-lotion.json` whose brand never reaches a
> frame. Frame 4's "Nine ingredients" verifies against `config/ingredients.json`, but see
> the grapefruit-seed-extract question in the handoff first.
>
> **One variant, so no alt-text scoping is needed here at all** — that convention only
> applies where variants exist. Full brief: `docs/handoffs/2026-08-01-sensitive-skin-set.md`.


**One photograph.** The store's designated hero offer, the only bundle that has sold a unit in three months, and the only bundle with any search presence at all (211 impressions, position 34.9) — and its gallery contains a single image with no alt text. Of everything in this document this is the largest gap between a product's importance and its imagery.

Its buyer is problem-aware and cautious: fragrance-free is the one attribute they filter on, and they have been let down by products that claimed "gentle". The imagery's job is to remove doubt, not to excite. It sits on its own bespoke template with real conversion history, so frames go in the gallery and nothing here touches the shared lander.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|--:|
| 1 | Grid/multi-SKU | Show exactly what arrives — two jars, nothing else | Buyer deciding what $46.80 buys | Two products, clean white, priced | *Two products. One routine.* | COMPOSITE `coconut-moisturizer` + `coconut-lotion` | S |
| 2 | Educational infographic | Prove "fragrance-free" means no masking fragrance either | Fragrance-sensitive buyer who has been burned | A short ingredient list, no asterisk | *No fragrance. Not even "unscented" fragrance.* | GENERATE | M |
| 3 | Benefit callout | Separate the two jars' jobs — lotion daily, cream overnight | Buyer who doesn't know why they need both | Day / night split | *Day lotion. Night cream.* | COMPOSITE `coconut-lotion` + `coconut-moisturizer` | S |
| 4 | Us-vs-them | Beat CeraVe/Vanicream on ingredient count, not on claims | Comparison shopper cross-checking three tabs | Two columns, ours shorter | *Nine ingredients. Theirs has thirty.* | GENERATE | M |
| 5 | Text-only | Carry the real proof — 135 component reviews at 4.84 | Buyer wanting reassurance before checkout | A rating and a number | *4.84 from 135 reviews of the products inside* | GENERATE | S |
| **6** | Grid/multi-SKU | Make the first-subscription gift visible instead of leaving it in an accordion | Buyer weighing one-time vs subscribe | Four items, two of them flagged free | *Subscribe: your first box adds $26 free.* | COMPOSITE of real photos — cutouts of `coconut-lotion` + `coconut-moisturizer` + `coconut-soap` + `coconut-oil-lip-balm`, all Pure Unscented | S |

⚠️ **Frame 6 must state the condition on the image.** The gift is contingent on starting a
subscription; a frame that shows four items without the word *subscribe* would misrepresent
the $46.80 one-time purchase. `verify()` must fail the build if the headline omits it.

**Gaps:** no transformation frame. A truthful before/after for a fragrance-free moisturiser needs real customer photography over weeks, and inventing one would imply a dermatological outcome these are not entitled to claim.

**Blocked:** none. Every frame here is composable from existing assets today.

---

### Bar Soap 4-Pack — $39

Five images already, the best-covered bundle in the range, so this is a top-up rather than a build. It is a subscription and cross-sell vehicle reached from replenishment flows, not a destination — the buyer arriving here has already decided to buy bar soap and is choosing quantity and scent. Imagery should answer "which scents, and how much do I save", nothing more ambitious.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|--:|
| 1 | Grid/multi-SKU | Show all four scents side by side, labelled | Repeat buyer choosing a variety pack | Four labelled bars | *Four bars. Pick your four.* | REUSE `coconut-soap` | S |
| 2 | Benefit callout | Make the per-bar saving explicit | Price-checking replenisher | $9.75 a bar vs $11 | *$9.75 a bar instead of $11* | GENERATE | S |

**Gaps:** rotation deliberately unused. This page does not need an infographic or a comparison — the buyer is past that, and adding frames to a converting cross-sell page risks slowing it down.

**Blocked:** none.

---

### Deodorant 4-Pack — $53 · Toothpaste 3-Pack — $34

Both have **zero images**, and both are pure replenishment vehicles reached from the Klaviyo flow rather than from search. They need the minimum that makes them legible in an email and a cross-sell module — which is exactly the collection-tile frame in §7 item 2, plus one scent-choice frame each.

| # | Bundle | Format | One job | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|--:|
| 1 | Deodorant 4-Pack | Grid/multi-SKU | Show the four scent choices | Four labelled tubes | *Four months. Four scents.* | REUSE `coconut-oil-deodorant` | S |
| 2 | Deodorant 4-Pack | Benefit callout | Per-unit saving | $13.25 vs $15 | *$13.25 each instead of $15* | GENERATE | S |
| 3 | Toothpaste 3-Pack | Grid/multi-SKU | Show the three tubes | Three labelled tubes | *Three tubes. One order.* | REUSE `coconut-oil-toothpaste` | S |
| 4 | Toothpaste 3-Pack | Benefit callout | Per-unit saving | $11.33 vs $13 | *$11.33 a tube instead of $13* | GENERATE | S |

⚠️ **Do not put duration or per-day claims on either of these.** Measured consumption is 90 days per deodorant and 61 per toothpaste, so a 4-pack is roughly a year of deodorant — a "4-month supply" frame would be false in the same way the "90-day box" claim was on two landers before it was removed on 2026-07-27.

**Blocked:** none.

---

## 7. Sequencing

Ranked by return per unit of effort. The frame-level "build first" picks from each stack, reconciled:

| Order | Item | Why here |
|--:|---|---|
| 1 | **Start the Coconut Reset 90-day recruitment programme** | The only item where delay is irreversible — day-0 photos must be collected before anyone starts. Costs an email, not a shoot. |
| 2 | **Gift Box packaging shoot** (session A) | Only calendar-bound deliverable; mid-September for Q4. Also blocks distribution — a bundle with no image can't go in a collection tile, a cross-sell module or an email. |
| 3 | **Collection-tile frame ×10**, one composite each | Cheapest work here and a *prerequisite* for the distribution work that gets these pages an audience. |
| 4 | **Head-to-Toe frame 1** — seven-product grid | Page asserts breadth with 2 images; 46 component photos make it a composite, not a shoot. At 2.6× CAC it is paid-eligible the moment tracking clears. |
| 5 | **Hand Soap Set frame 1** — three-configuration ladder | Fastest fix on a page rendering zero images, and the gallery is its entire visual argument (`templateSuffix: null`, so no hero at all). |
| 6 | **90-Day Clean Swap frame 1** — twelve-unit flat-lay (session B) | Biggest single argument in the range: the whole $144 case in one image, on the page with one photo. |
| 7 | **The per-bundle hero Liquid change** | One change unblocks all five landers. Engineering, not art. |
| 8 | Everything else, per bundle, in stack order | |

One caveat that should govern how much gets built at once: **these pages have no audience yet, and no data either.** Nine of the ten bundles were created between 2026-07-25 and 2026-07-28 — they are days old. An earlier draft of this document cited "0 search impressions in 90 days" as evidence the landers were failing; that was a 90-day window measured against pages that did not exist for 88 of those days, which is arithmetic on an empty set rather than a finding.

What is actually known: only the Sensitive Skin Set has meaningful history (created 2026-03-05) — 211 impressions, average position 34.9, and the one bundle sale across 45 orders since May. Every other bundle is **unmeasured, not underperforming**.

The sequencing below is unchanged, but the reason matters: build distribution first because nothing has been pointed at these pages yet, not because they were tried and failed. Imagery converts traffic; it does not create it.

Items 1–3 are the exception and should proceed regardless: item 1 because delay is irreversible, and items 2–3 because they are *preconditions* for the distribution work rather than alternatives to it. Items 4–8 will earn their keep once the bundles have collection placement and cross-sell entry points. Several frames were deliberately chosen to double as Klaviyo flow creative, since the flows — not search — are these pages' realistic near-term traffic source.

---

## 8. Alt text

Twelve images exist across the bundles and one lacks alt text: the Sensitive Skin Set's single gallery image. Every frame added under this plan ships with alt text describing the *contents*, not the composition — "four foaming hand soap pumps in Coconut Breeze, Lemongrass, Lavender and Unscented" rather than "product grid on white". `agents/technical-seo fix-alt-text` handles the backfill.
