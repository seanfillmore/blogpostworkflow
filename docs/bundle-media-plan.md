# Bundle media plan

Frame-by-frame image specification for all 10 bundles. Written 2026-07-28.

Companion to `docs/bundle-marketing-plan.md` (positioning and channel) and `docs/bundle-landing-architecture.md` (how the template works). This document covers only imagery: what frame goes where, what job it does, and where the picture comes from.

---

## 0. Decisions needed before this is executed

> **All three resolved 2026-07-31 — do not re-raise them.**
>
> 1. **Ingredient claims — `config/ingredients.json` is correct and is the source of truth.** The copy was the wrong side and has been fixed: "no palm oil" now appears nowhere live, and the Gift Box lander discloses *"Contains beeswax in the lip balm, so this box is not vegan."* The Clean Swap's "Vegan and cruelty-free" is accurate because its four components carry no beeswax. **The table below stands and should be treated as the authority** — it is what the Reset's frame 6 note is derived from.
> 2. **Head-to-Toe frame 3 — dissolved, not decided.** The bundle repriced to **$87** on 2026-07-31, so $105 ÷ 7 = $15.00 no longer holds ($12.43). The frame depended on that exact arithmetic; it is cut, and the stack leads on completeness like every other bundle.
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
> | **90-Day Coconut Reset** | **$121** | **2** | Rebuilt as a new product (`8500970881194` → `8566372303018`); the old 3 images did not survive. The 2 present are real photography shipped 2026-07-31, one per variant. |
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
| Head-to-Toe | $105 | lander | 2 | ✅ 2/2 |
| 90-Day Clean Swap | $159 | lander | 1 | ✅ 1/1 |
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
| **B** | **Twelve-unit contents flat-lay**, overhead, three kit versions | 90-Day Clean Swap | Contents depiction must match what ships. Volume is the whole $159 argument and no composite is honest here. | Single session, three set changes |
| **B** | **Shelf before/after**, locked-off tripod, two exposures | 90-Day Clean Swap | Needs a set of conventional products to stage the "before" — sourceable for under $60 | Same session as above |
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

### Head-to-Toe — $105

The copy on this page can *say* "one of everything we make" but it cannot make the buyer **count to seven**, and counting to seven is the entire purchase decision. At $105 against a measured ~$15 lotion price ceiling, the shopper's first instinct is to divide — so the imagery either wins the division or loses the sale. This buyer is the discovery shopper who wants to find their favourite before committing to any one SKU, plus the non-Q4 gifter; both are choosing breadth on purpose, which means the stack is a range shot, not a routine shot. Two jobs dominate: **prove the seven products are real and distinct** (the page currently has 2 images, so breadth is asserted and never shown), and **reframe the unit of purchase** so $105 is compared against a shelf, not against a bottle. The 46 existing component photos make almost all of this a compositing job rather than a shoot.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|---|
| 1 | Grid/multi-SKU | Prove seven distinct products exist | Discovery shopper who has never bought the brand | "Seven different things, one box" | **One of everything we make.** | COMPOSITE `coconut-lotion` + `coconut-moisturizer` + `coconut-oil-deodorant` + `coconut-oil-toothpaste` + `coconut-soap` + `coconut-oil-lip-balm` + `organic-foaming-hand-soap` | M |
| 2 | Benefit callout | Prove the seven cover the whole routine with no gaps | Shopper mentally auditing their own bathroom shelf | "This replaces everything I already buy" | **Nothing else to buy.** | COMPOSITE (same seven) | M |
| 3 | Headliner | Kill the per-unit price objection with a true number | Price-ceiling shopper ("$15 or less, but I want it to work") | "$15 a product — that's my number" | **$105. Seven products. $15 each.** | GENERATE (Ad Builder) over the frame-1 composite | S |
| 4 | Educational infographic | Make the Gentle vs Fresh choice decidable without scrolling | Buyer stalled at the variant picker | "Two kits, and here's how they differ" | **Gentle or Fresh. Here's the difference.** | COMPOSITE (per-variant shots — see Blocked) | M |
| 5 | Us-vs-them comparison | Convert the clean-swap motive into a reason to buy all seven at once | Reduce-my-chemical-load switcher | "Seven swaps in one purchase" | **Seven swaps. No aluminium, no SLS, no parabens, no synthetic fragrance.** | GENERATE (Ad Builder) | M |
| 6 | Text-only | Borrow the component catalogue's proof for an unreviewed bundle | Sceptic who sees a new bundle with no reviews of its own | "Lots of people have used these" | **4.64 ★ — 295 reviews of the seven products inside.** | GENERATE (Ad Builder) | S |
| 7 | Benefit callout | Answer "how long does $105 actually last" | Buyer doing value math after the price has landed | "Two months of everything" | **Sixty days of everything.** | COMPOSITE `coconut-lotion` + `coconut-soap` | S |

**Frame 1** spec: all seven products stood in a single row on a plain bathroom shelf, tallest to shortest — hand soap pump, lotion bottle, cream jar, deodorant, toothpaste tube, bar soap, lip balm — even spacing, one light direction, no props. Headline sits above the row, product row is the second read. Every unit shown must be a real variant from one real kit (do not mix Gentle and Fresh in one frame — that ships something nobody receives).

**Frame 2** spec: the same seven, but arranged head-to-toe down the frame with a one-word label beside each — teeth, lips, underarms, hands, body wash, body, overnight. The bundle's name made literal. This is the frame that earns $105, because it converts "seven products" into "my whole shelf."

**Frame 3** carries a real tension worth naming: `bundle-marketing-plan.md` rule 1 says bundles lead with duration or completeness and **never** with savings-vs-single, precisely to avoid inviting per-unit comparison. Frame 3 deliberately invites it — because $105 ÷ 7 = exactly $15.00, which lands on the measured ceiling rather than above it. It only works at exactly this price, and it is placed at slot 3 so completeness still leads. If that trade is unacceptable, cut frame 3 rather than soften it; a hedged version does no job at all.

**Frame 5** honesty note: depict the "before" side as generic unbranded conventional packaging with ingredient *categories* named. Do not render CeraVe, Vanicream or Cetaphil packaging, and do not claim those brands contain anything — the four absences claimed are our own formulation facts and are the only claims the frame makes.

**"What's in the box" cards** — no frames needed, but one check: the cards pull each component's own primary image, and the Fresh kit points at Geranium Flower deodorant, Sweet Tangerine lip balm, Orange Zest hand soap and Tea Tree bar soap. Confirm each of those *variants* has a primary image before treating the cards as done; a component with 5 photos does not guarantee 5 scents covered.

### Gaps

- **Transformation — deliberately omitted.** A sampler of seven unrelated products has no single honest before/after. Any transformation frame here would either attribute a skin change to a box containing toothpaste and hand soap, or split its focal point across two jobs. Transformation belongs to the Reset, and putting a weak one here would spend the format's credibility on the wrong page.
- **Educational infographic used once, on variant choice rather than ingredients.** An ingredient-panel infographic is the Reset's job (frame 6 there); repeating it here would be the same asset doing the same job twice across two pages.
- Two benefit callouts (2 and 7) is intentional — they carry different jobs (completeness vs duration) and the rotation asks for coverage, not one-of-each.

### Blocked

1. **BLOCKED-ON-THEME — per-bundle hero background.** `bg_image_desktop` / `bg_image_mobile` are section settings on the shared `bundle-landing` template, so all five landers currently render one `hero-desktop.webp`. Head-to-Toe wants a seven-product hero and the Reset wants a four-bottle hero; neither is possible until the section reads a product metafield (e.g. `bundle.hero_image`) with the section setting as fallback. **Count this as a Liquid change, not art direction.** Until it ships, every frame above must work inside the gallery alone.
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
| 2 | Educational infographic | Explain why it's three *pairs*, not six duplicates | Buyer who thinks they're being sold the same thing six times | "A bottle and a jar, three months running" | **Daily lotion. Overnight cream.** | ✅ **BUILT 2026-08-01** — RENDER over the real hero photo, one per scent | — |
| 3 | Transformation (supply) | Show running out being solved, not described | Buyer whose real pain is the empty-bottle gap | "The box lasts the whole quarter" | **This is what ninety days looks like.** | MUST-SHOOT (product still-life, in-house) | M |
| 3b | Transformation (skin) | Show the change instead of claiming the after-state | Dry-winter-skin sufferer wanting proof, not persuasion | "Her skin actually changed" | **Day 1. Day 90.** | MUST-SHOOT (customer-submitted, 90-day lead) | L |
| 4 | Benefit callout | Make $34 of digital goods visible and specific | Buyer who read "$220 value" and can only see $186 of it | "Two real guides, arriving immediately" | **Both guides, in your inbox in five minutes.** | GENERATE (Ad Builder) from the real PDFs | M |
| 5 | Text-only | Transfer the components' proof to the bundle | Sceptic of a bundle with no reviews of its own | "Nearly five stars, lots of reviews" | **4.84 ★ — 135 reviews of the lotion and cream inside.** | ✅ **BUILT 2026-08-01** — RENDER, not generated | — |
| 6 | Us-vs-them comparison | Win on ingredient list length, not price | Switcher defaulting to a drugstore dermatologist pick | "Same job, far shorter list" | **Same job. Shorter list.** | GENERATE (Ad Builder) | M |
| 7 | Educational infographic | Defuse the comedogenic objection without a claim | Shopper who believes coconut oil clogs pores | "This is for my body, not my face" | **Made for your body, not your face.** | COMPOSITE `coconut-lotion` | S |

**Frame 1** — **shipped.** Sean supplied two 2048² heroes, generated with the stored product photography as references and reviewed by him before upload — labels verified correct (8 fl. oz · 236ml, 4 fl. oz · 118ml). one per scent, each showing three lotions standing on three creams. Both are attached to their own variant, so a buyer choosing Pure Unscented sees the unscented kit. The original spec called for "the four vessels in a single row"; what shipped is six units stacked, which is both accurate to what ships and a stronger mass argument. Nothing further needed here.

**Frame 2 — built and live 2026-08-01, one per scent.** `frame-02-routine.coconut-breeze.mjs` and `frame-02-routine.pure-unscented.mjs`, both thin wrappers over `routine-frame.mjs`. Composited from keyed product plates, so everything depicted carries the approved label wording. Uploaded **product-level** — see the variant-media constraint below.

The spec called for a horizontal 90-day strip cut into three month blocks, each holding one bottle and one jar. **That cut is not possible from the source photography and the frame splits the other way instead.** Measured on the hero: the three bottles have clean background gutters between them (x704–860, x1194–1353), but the three jars touch — one continuous mass from x295 to x1848. Any vertical cut into month columns slices through a jar. The photo cuts cleanly *horizontally*, and that turned out to be the better argument anyway: the rows **are** the routine, and the routine is what the frame has to teach. So it is two bands — the lotion row labelled *three lotions · every morning*, the cream row *three creams · every night* — under the headline **"Daily lotion. Overnight cream."**, closing on *"One pair a month. Ninety days."*

The band boundary is not arbitrary: a column scan finds the bottle's white base ending where the jar's ribbed lid begins (y≈1386 on the Coconut Breeze photo, y≈1404 on the Unscented one, which is framed differently). Cutting on that seam is what makes the two crops read as *resting on* rather than as one photo sliced through a label. An earlier cut at the ink-minimum waist sheared the bottles mid-label and looked like a mistake.

`verify()` reads `bundle.component_qty` and **refuses to build unless it is exactly [3, 3]**. That is the direct lesson of this re-spec: the original frame 2 stated "Three daily. One nightly." and survived a repack as a falsehood because nothing checked it. If the Reset is ever repacked again, this frame fails loudly instead of quietly lying.

**Frame 3 (ships when empties exist)** spec: left half, six sealed full units — three bottles, three jars; right half, the same six after 90 days of real use — three empty bottles and three visibly used jars, same surface, same light, same angle. Caption line: *"One box, one quarter, actual use."* This is an honest transformation of **supply**, not of skin, and it makes the duration claim visible rather than asserted. Do not fake the empties by decanting; if the units must be run down honestly, that is a real lead time and should be scheduled. Note the cost changed with the composition — this now needs **six** genuinely emptied units, not four.

**Frame 3b (start now, lands in ~90 days)** — the priority transformation, and the one the brief is right to want. It **cannot be shot truthfully today**, because there is no day-0 photograph of a customer who then used the box for 90 days. Build it as a process, not an asset: recruit 3–5 real customers through the replenishment flow, collect a day-0 photo of a fixed site (shin, forearm or hands) with a fixed angle, distance and light, re-shoot at day 90, ship no retouching and no cropping that changes scale. Hard constraints: **no eczema, psoriasis, dermatitis or any medical framing, no prescription/steroid comparison, no "healed" or "cured"** — these are moisturisers and the frame's claim is dry skin looking less dry. Ship whichever pairs are genuinely convincing; if none are, ship none. When it lands it takes slot 3 and the supply transformation moves to 4.

**Frame 5 — built and live 2026-08-01.** `data/brand/frames/99-coconut-reset-digital/frame-05-reviews.mjs`, rendered by `scripts/render-frame.mjs` to `data/brand/bundle-images/frame-05-reviews.jpg` (2048², 103 KB), uploaded product-level (the proof is true of both scents). Verified after upload: media `READY` at 2048², CDN `HTTP 200 image/jpeg`, alt text correct, and the file referenced in the rendered storefront HTML at `/products/99-coconut-reset-digital` (page 200). **The Reset now has 3 images.**

The numbers are not typed into the frame; it reads `bundle.rating_value` / `bundle.rating_count` at render time and its `verify()` refuses to build if either is missing, out of range, or backed by fewer than 25 reviews. The "of the lotion and cream inside" clause is load-bearing and is in both the headline and the alt text — without it the frame implies 135 reviews *of the bundle*, which has none.

Provenance checked rather than assumed: 4.84/135 is reproducible from the Judge.me API via `scripts/sync-bundle-ratings.mjs`, which sums the two components' per-product stats. **Do not verify this against the `judgeme.badge` or `reviews.rating_count` metafields on the component products** — those are a shop-level cached aggregate and read an identical 131/4.85 on *every* product, which looks like a per-product figure and is not. That near-miss is worth remembering before the equivalent frame is built for another bundle.

⚠️ **Separately, the lander overstates this.** The `rating_caption` field on the lander metaobject says *"Rated 4.9 by Real Customers"*, but 4.84 rounds to **4.8**. That is a live review claim that is wrong in our favour, and it is a copy fix on the metaobject, not an imagery one. Frame 5 must use 4.84 and must not inherit the 4.9.

**Frame 6** honesty note: both ingredient lists must be real — ours from `config/ingredients.json`, the comparison from an actual published INCI panel — and the comparison bottle must be unbranded and unnamed. Verify both counts before this ships; an invented number here would be the single most damaging frame in either stack.

Our side of the count, read from `config/ingredients.json` on 2026-08-01, so the frame does not have to re-derive it:

| | Pure Unscented | Coconut Breeze |
|---|--:|--:|
| Body Lotion | **6** | **7** (+ organic coconut oil extract) |
| Body Cream | **7** | **8** (+ organic coconut oil extract) |

**Two traps in this frame, and both are live claims, not style.** The lotion contains **organic red palm oil**; the cream adds **palm stearic** *and* **organic beeswax**. So:

1. **Never imply palm-free.** Both formulas contain palm derivatives. A "clean/short list" frame that a reader completes as "and no palm oil" is a claim we cannot support.
2. **The Reset is not vegan.** The cream contains beeswax. The Clean Swap's "Vegan and cruelty-free" line is accurate *because* it excludes the cream — the Reset includes it, so that line must never be ported across. The lander already handles this correctly (`buybox_bullets` says "beeswax barrier" as a *feature*); the imagery must not contradict it.

What the frame may honestly claim is what the lander already claims: **no synthetic fragrance, no petrolatum, no dimethicone, no lanolin, no parabens, no mineral oil.** Lead with those absences and the count, not with an unqualified "clean".

**Frame 7** works because it is true and narrow. It does not claim non-comedogenic, does not argue with the belief, and does not need to — it relocates the product. Body silhouette with the application zones marked, face excluded, one line of type.

**"What's in the box" cards** — only two components render here (`coconut-lotion`, `coconut-moisturizer`, 11 and 6 photos on file), so the cards are the best-supplied in the range and need nothing. The one thing to confirm is that the *Pure Unscented* and *Coconut Breeze* variants each have a distinct primary image, or both scent selections render the same card and the variant picker looks broken.

### Digital goods — how $34 of PDF stops looking like filler

The failure mode is a stock document icon or a floating generic PDF badge: it reads as padding and it actively devalues the $121, because the shopper concludes the value stack was inflated to reach $220. Three rules for frame 4:

1. **Show the actual page content, not the container.** Render the 90-Day Routine & Tracker as its real interior spread — a visible 90-cell grid with dates and checkboxes, a few cells already ticked — and the Field Guide as a real interior page with a legible heading and body text. If a shopper can read three real words off it, it is a product; if they can only see a cover, it is a badge.
2. **Give them physical presence.** Stage the tracker as a printed sheet lying beside one lotion bottle, and the Field Guide on a phone screen. Mixed physical/digital staging is what makes a PDF feel like an object. The four bottles do **not** appear in this frame — that is frame 1's job, and importing them splits the focal point.
3. **Price the line items on-image, not the total.** Small labels: *90-Day Routine & Tracker — $19* and *Coconut Skincare Field Guide — $15*, plus the delivery promise in the headline. Both figures are live in the `bundle.value_stack` metafield and were re-verified 2026-08-01. The $220 total already computes itself in the value-stack section of the template (`bundle-landing-architecture.md`); restating it on-image recreates exactly the literal-vs-data drift that produced the earlier total bug. **The frame's job is to make $34 believable, not to re-assert $220.**

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
- **Deliberately not shown: the step up to the 90-Day Clean Swap ($159).** It belongs in page copy and the FAQ, not in
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

At $159 against a ~$47 store AOV this is the largest single ask in the catalogue, and the copy has already said everything it can — "three months of all four" is an accurate sentence that does nothing to the gut. Twelve full-size products photographed together is arithmetic the eye does in under a second, and it is the one argument that cannot be made in text. The imagery has two jobs the copy cannot reach: make the volume visible, and break the perceived ~$15 ceiling by reframing $159 as twelve purchases rather than one. The buyer is someone already mid-switch — they have replaced one or two products, their shelf is half clean and half drugstore, and they are tired of doing it one bottle at a time. They are not price-shopping a lotion; they are buying the end of a project. That is why the shelf, not the skin, is where the transformation lives.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|---|---|---|---|---|---|---|---|
| 1 | Grid/multi-SKU | Make twelve units visible at once — the volume argument | Sticker-shocked visitor deciding whether $159 is a lot or a little | "That is a genuinely large amount of product" | **12 full-size products. One box.** | MUST-SHOOT | L |
| 2 | Headliner | Frame the purchase as finishing the switch, not buying a box | Someone who has been swapping products one at a time for months | "I can do the whole routine in one order" | **Swap your whole routine at once.** | COMPOSITE `coconut-lotion` + `coconut-oil-deodorant` + `coconut-oil-toothpaste` + `coconut-soap` | M |
| 3 | Educational infographic | Break the ~$15 ceiling by pricing per product instead of per box | Buyer who balks at $30 for a lotion | "Each thing costs less than buying it alone" | **$207 of products. $159.** | COMPOSITE `coconut-lotion` + `coconut-soap` | M |
| 4 | Transformation | Show the change honestly — the shelf, not the body | Half-switched buyer looking at their own mixed shelf | "That is my bathroom, before and after" | **Before. After. Same shelf.** | MUST-SHOOT | L |
| 5 | Benefit callout | Sell the absence of reordering as the real product | The person who runs out of deodorant on a Tuesday | "I stop thinking about this for a while" | **Nothing to reorder for months.** | GENERATE (Ad Builder) | M |
| 6 | Us-vs-them comparison | Win the ingredient argument against the drugstore "gentle" default | Cross-shopping CeraVe / Vanicream / Cetaphil on ingredients | "Theirs is petrolatum, mine is coconut oil" | **Coconut oil, not petrolatum.** | GENERATE (Ad Builder) | M |
| 7 | Educational infographic | Resolve Gentle vs. Calm vs. Fresh so the variant choice stops being a coin flip | Buyer already sold, stuck on which kit | "Three kits, and here is the scent difference" | **Gentle, Calm or Fresh — here's what changes.** | GENERATE (Ad Builder) | M |
| 8 | Text-only | Deliver proof at the price objection, attributed honestly | Last-mile hesitant buyer at 3× their normal order | "Real ratings, and they're on the products inside" | **4.64 out of 5 — from 205 reviews of the products in this box.** | GENERATE (Ad Builder) | S |

### Frame notes (build-critical)

- **#1 is the whole page.** Overhead, three rows of four or four rows of three, one clean surface, product-only, no props competing for the focal point. Shoot **three versions** — Gentle, Calm and Fresh differ in lotion, deodorant and soap variants — and assign them as Shopify variant images. Unlike the Hand Soap Set, three variants is a tractable number, so this gallery *can* and *should* be variant-accurate at the contents frame.
- **#1 is MUST-SHOOT, not composite.** Contents depiction must match what ships; compositing is reserved for lifestyle, texture, ingredient and scale frames.
- **#3 dollar figures are drift-bound** to `price: 159` / `compareAtPrice: 207` in `config/bundles.json`. If either changes, this frame is stale and must be regenerated — flag it in whatever tracks bundle price changes. Secondary line on the frame: "12 products — $13.25 each." That is division of two stated numbers, not a duration or per-day claim.
- **#4 is the honest transformation for body care.** Left: a real shelf of conventional products with labels defocused or turned. Right: the same shelf, same camera position, same light, holding the twelve units. No skin claim, no model, nothing that needs a dermatologist to defend. Shoot both exposures in one session without moving the tripod.
- **#5** may say "months" — three units each of lotion, deodorant, toothpaste and bar soap clears a quarter against measured reorder gaps with room to spare. Do **not** put a specific day count on the frame; "months" is defensible, "90 days of everything" invites the same audit that killed the claim on two other pages.
- **#6** describes the comparison target as "conventional drugstore 'gentle' lotion" in-frame. Name no brand on the image; the brands belong in the page copy where they can be discussed, not in a raster that circulates.
- **#7** must show only what actually differs between kits — toothpaste is Fresh Mint in all three, so it appears once as a constant. Do not imply Gentle is unscented; it ships a lavender deodorant, and the page FAQ already says so.

### Gaps

No rotation format is omitted — all seven are covered, with educational infographic used twice (#3, #7) because this product has two distinct comprehension problems, a price-framing one and a variant-selection one, and collapsing them into one frame would put two jobs in one image. What is deliberately absent:

- **No skin before/after.** There is no truthful, reproducible skin transformation to shoot for a four-product routine box, and the shelf swap in #4 does the transformation job with evidence that is actually verifiable.
- **No unboxing or packaging-beauty frame.** `packaging: 0` — there is no custom box, and imagery implying one would misrepresent what arrives.
- **No lifestyle-model frame.** Twelve products is the argument; a person holding one bottle actively undercuts the volume read that #1 exists to deliver.

### Blocked

1. **MUST-SHOOT — frame #1, twelve-unit contents flat-lay, three kit versions.** Single session, overhead rig, three set changes. Blocks the highest-value frame on the highest-value SKU. Requires physical stock of all three kits' variants on hand.
2. **MUST-SHOOT — frame #4, shelf before/after.** Same session, locked-off tripod, two exposures. Needs a set of conventional products to stage the "before" — sourceable for under $60.
3. **BLOCKED-ON-THEME — per-bundle hero background** (same task as the Hand Soap Set entry; one Liquid change unblocks both, plus the other three landers on `bundle-landing`). Without it, the 90-Day Clean Swap's hero is the shared `hero-desktop.webp` regardless of what this stack specifies. This stack requests a distinct hero — frame #1's flat-lay, cropped wide — and until the Liquid change lands, that request is engineering work, not an art request.
4. **Component card check — `coconut-oil-toothpaste`.** Four images on file, the thinnest library of any component in this box, and it is the SKU most likely to have a weak featured image standing in as a "What's in the box" card on a $159 page. Verify the featured image reads at card size before launch; if not, it is a recrop, not a shoot. `coconut-lotion` (11), `coconut-oil-deodorant` (5) and `coconut-soap` (5) are adequate.

---

### Sensitive Skin Set — $46.80

**One photograph.** The store's designated hero offer, the only bundle that has sold a unit in three months, and the only bundle with any search presence at all (211 impressions, position 34.9) — and its gallery contains a single image with no alt text. Of everything in this document this is the largest gap between a product's importance and its imagery.

Its buyer is problem-aware and cautious: fragrance-free is the one attribute they filter on, and they have been let down by products that claimed "gentle". The imagery's job is to remove doubt, not to excite. It sits on its own bespoke template with real conversion history, so frames go in the gallery and nothing here touches the shared lander.

| # | Format | One job | One persona | 1-second read | On-image headline | Source | Effort |
|--:|---|---|---|---|---|---|--:|
| 1 | Grid/multi-SKU | Show exactly what arrives — two jars, nothing else | Buyer deciding what $46.80 buys | Two products, clean white, priced | *Two products. One routine.* | COMPOSITE `coconut-moisturizer` + `coconut-lotion` | S |
| 2 | Educational infographic | Prove "fragrance-free" means no masking fragrance either | Fragrance-sensitive buyer who has been burned | A short ingredient list, no asterisk | *No fragrance. Not even "unscented" fragrance.* | GENERATE | M |
| 3 | Benefit callout | Separate the two jars' jobs — lotion daily, cream overnight | Buyer who doesn't know why they need both | Day / night split | *Day lotion. Night cream.* | COMPOSITE `coconut-lotion` + `coconut-moisturizer` | S |
| 4 | Us-vs-them | Beat CeraVe/Vanicream on ingredient count, not on claims | Comparison shopper cross-checking three tabs | Two columns, ours shorter | *Nine ingredients. Theirs has thirty.* | GENERATE | M |
| 5 | Text-only | Carry the real proof — 135 component reviews at 4.84 | Buyer wanting reassurance before checkout | A rating and a number | *4.84 from 135 reviews of the products inside* | GENERATE | S |

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
| 6 | **90-Day Clean Swap frame 1** — twelve-unit flat-lay (session B) | Biggest single argument in the range: the whole $159 case in one image, on the page with one photo. |
| 7 | **The per-bundle hero Liquid change** | One change unblocks all five landers. Engineering, not art. |
| 8 | Everything else, per bundle, in stack order | |

One caveat that should govern how much gets built at once: **these pages have no audience yet, and no data either.** Nine of the ten bundles were created between 2026-07-25 and 2026-07-28 — they are days old. An earlier draft of this document cited "0 search impressions in 90 days" as evidence the landers were failing; that was a 90-day window measured against pages that did not exist for 88 of those days, which is arithmetic on an empty set rather than a finding.

What is actually known: only the Sensitive Skin Set has meaningful history (created 2026-03-05) — 211 impressions, average position 34.9, and the one bundle sale across 45 orders since May. Every other bundle is **unmeasured, not underperforming**.

The sequencing below is unchanged, but the reason matters: build distribution first because nothing has been pointed at these pages yet, not because they were tried and failed. Imagery converts traffic; it does not create it.

Items 1–3 are the exception and should proceed regardless: item 1 because delay is irreversible, and items 2–3 because they are *preconditions* for the distribution work rather than alternatives to it. Items 4–8 will earn their keep once the bundles have collection placement and cross-sell entry points. Several frames were deliberately chosen to double as Klaviyo flow creative, since the flows — not search — are these pages' realistic near-term traffic source.

---

## 8. Alt text

Twelve images exist across the bundles and one lacks alt text: the Sensitive Skin Set's single gallery image. Every frame added under this plan ships with alt text describing the *contents*, not the composition — "four foaming hand soap pumps in Coconut Breeze, Lemongrass, Lavender and Unscented" rather than "product grid on white". `agents/technical-seo fix-alt-text` handles the backfill.
