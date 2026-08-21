# Ad Studio

Generates publish-ready **static ad creatives** for Real Skin Care — headline, body
copy, comparison columns and the product itself baked into one finished frame — for
Meta (feed/Stories/Reels) and Google Demand Gen.

This is not the same job as `agents/creative-packager`. The packager turns an
**approved master** into placement-sized crops for Ad Builder / Studio, and
deliberately produces text-free images with a Photoshop-guide overlay. Ad Studio
produces the finished ad itself, copy included, end to end, with no manual
finishing step.

> **An accepted render is checked, not curated.** The gate checks text, the volume marking,
> whether the rendered product is physically our product, and whether the frame is usable —
> copy clear of the platform's UI chrome, and legible at thumb size. What it does **not** do
> is decide the ad is *good*: that is a 1-5 score recorded on every accepted frame, never a
> pass/fail. Rank by `critique.score`; do not read `ok: true` as "ship it".

Spec: `docs/superpowers/specs/2026-08-14-ad-studio-design.md`
Plan: `docs/superpowers/plans/2026-08-14-ad-studio.md`

## Usage

```bash
node agents/ad-studio/index.js --product <handle> --formats <key1,key2,...> \
  [--variant <name>] [--targets <spec>] [--variations <n>] [--max-renders <n>] [--dry-run] [--job-id <id>]
```

| Flag | Required | Meaning |
|---|---|---|
| `--product` | yes | Product handle — must exist in both `data/product-images/manifest.json` and `data/brand/product-catalog.json`, and its manifest entry must carry a `unitCount` (see below). |
| `--variant` | no | Scent/variant name (e.g. `coconut-breeze`). Selects `data/product-images/<imageDir>/<variant>/` for reference photos and is folded into the product's label strings (see below). Omit for a single-variant product. |
| `--formats` | **yes** | Comma-separated format keys from `agents/ad-studio/formats.js` (`us-vs-them`, `ingredient-callout`, `manifesto`, `problem-aware`, `top-x-review`, `offer-focused`, `testimonial`, `stat-stack`, `state-contrast`, `fact-hook`, `spec-panel`, plus `giveaway-entry` while a giveaway is running — see below). **Required.** It used to be optional, and omitting it meant the whole rotation — eleven formats today, 66 renders ≈ $8.58 at the current defaults and 297 (≈$38.61) at 3 variations across all 6 targets, from a flag nobody typed. An unknown key is rejected with the valid list. |
| `--targets` | no | Which platform targets to render. `all`, `meta`, `demand-gen`, or `<platform>=<ratio>` (e.g. `meta=9:16`), comma-separated. Default **`meta`** — all three Meta ratios, see below. |
| `--variations` | no | Variations per concept — each is one render per selected target. Default `1`, maximum `10`. |
| `--max-renders` | no | Hard ceiling on render attempts for the whole run, retries included. Default `120` (≈$15.60). On reaching it the run stops rendering, still writes `run.json`, and lists every skipped artifact under `budget`. |
| `--flexible` | no | Build ONE Meta **flexible ad** rather than a loose set of plates. See below. Mutually exclusive with `--brief`. |
| `--dry-run` | no | Generates copy and runs the claim gate, prints the result, and exits before any image is rendered. See below. |
| `--job-id` | no | Progress reporting for the dashboard. Writes stage-by-stage state into `data/reports/ad-studio/jobs/<id>.json`, which the Ad Studio tab polls. Set by the dashboard's launch route; a human never types it. The file is CLAIMED (status `running`, this process's pid) immediately after argument parsing, before any network call — the route refuses a second launch only while a job is pending-and-fresh or claimed-and-alive, so claiming late is how two paid runs start at once. **With no `--job-id` nothing is written and the CLI behaves exactly as before.** |

**The default run is deliberately the cheapest useful one:** one format, one variation,
all three Meta ratios — **6 renders ≈ $0.78** (a Meta target bills the plate and its
comp — see Cost below). Everything above that is opted into.

**Why 9:16 is not in the default target set.** Meta draws its own UI over the top ~14% and
bottom ~20% of a Stories/Reels frame, and `critique.js` hard-fails ad copy placed there.
All six `layoutBrief`s run a headline to the top edge and a bar to the bottom edge, and
the image model keeps doing so even when the render prompt names the bands explicitly
(`buildRenderPrompt`'s `SAFE ZONE` block). **Measured: 6 of 6 attempts across two live
runs failed**, at 3 paid attempts each. `--targets meta=9:16` still works and is the right
flag the day a vertical-first format exists — it is just not something to pay for by
accident. The gate is correct here; the layouts are what need to change.

Example — the one-concept proving run used before any batch:

```bash
node agents/ad-studio/index.js --product coconut-lotion --variant coconut-breeze \
  --formats ingredient-callout --dry-run
```

### `--flexible` — the 3-2-2 flexible ad

```bash
node agents/ad-studio/index.js --product foaming-hand-soap \
  --flexible --formats problem-aware,testimonial,manifesto
```

Produces **3 plates + 2 primary texts + 2 headlines** as one deliverable: `flexible-ad.json`
and `flexible-ad.md` alongside `run.json`. Six renders ≈ $0.78, same as the default run.

**Why this shape.** Twelve combinations (3 × 2 × 2) share a **single learning pool**, so
every impression feeds one bucket instead of splitting signal across twelve ads that each
accumulate too slowly to mean anything. At $30/day and a modelled ~$2.50 per entry, three
ad sets is ~28 entries/ad set/week — under the ~50 conversions Meta wants to exit the
learning phase. Consolidated it is ~84/week, and learning can actually exit. That
arithmetic is the entire argument; see
`.claude/skills/marketing-paid-creative-testing/SKILL.md` for the source.

The mode **narrows** the run rather than widening it, and refuses anything that would
quietly produce a different structure:

| Constraint | Why |
|---|---|
| exactly 3 `--formats` | Three *distinct* cold openings, so no two ads chase the same person. Three variations of one format would be three ads competing for one buyer. |
| exactly 1 target (default `meta=4:5`) | All three plates share one aspect ratio. Mixing ratios asks Meta to decide creative *and* shape at once, which this budget cannot separate. 4:5 is the tallest ratio served in-feed without giving up the ~14%/~20% margins 9:16 loses to UI. |
| `--variations` fixed at 1 | Each format contributes exactly one plate. |
| Meta only | Demand Gen has no flexible-ad equivalent. |
| 2 primary texts, 2 headlines, all distinct | Two *phrasings* of one angle give the shared pool nothing to learn — that is the whole reason for writing two. Case-insensitive duplicates are rejected. |
| ≤40 char headlines, ≤125 char primary texts | Meta truncates rather than wrapping, and a truncated headline is a different headline. |

The ad-level copy is a **second copy call** through the **same two gates**
(`assertNoHealthClaims`, then `assertClaimsSourced`) with no relaxation — it is the text
Meta renders to a buyer, so if anything it is more exposed than type an operator sets by
hand. The rules block itself lives once, in `copy.js`'s `buildClaimRules`, and is shared
with the plate path.

A plate that failed verification still appears in the manifest, flagged — you have two
usable plates, not a silent 2-2-2, and you need to know which.

**This never touches Meta.** It writes a manifest a human carries into Ads Manager. Build
it as ONE ad with all three images attached; three ads split the data three ways, which is
the failure the structure exists to avoid.

## The stages

1. **Format rotation** (`formats.js`, `selectFormats`) — a forced rotation over data,
   not an LLM call. One concept per selected format so a batch cannot collapse into
   six variants of one idea. Each format also declares `pairsImagesWithLabels`, which
   the verification stage reads.

   **Each format carries TWO briefs, and they are not interchangeable.** `layoutBrief`
   describes the finished advertisement — its columns, rules, pills, bars and ingredient
   cut-outs. `plateBrief` describes the ad base: the ground the product stands on, and the
   size and position it occupies. Nothing else. The plate used to be rendered from
   `layoutBrief` with the furniture negated underneath ("leave that area EMPTY"), and on
   2026-08-15 that produced a 1:1 plate carrying wood slices, greenery, a coconut and a
   second half-faded bottle — because `ingredient-callout`'s layout brief asks in so many
   words for "a small photorealistic cut-out image of that ingredient", and a vivid
   positive instruction beats a negation sitting below it. Both `formats.js` (at load) and
   `buildRenderPrompt` throw on a missing brief, so there is no path back to the fallback.

   **A plate may have a scene where one meshes** (`plateSetting`, per format). The first
   cut of this forbade every setting on every format, which flattened `problem-aware` and
   `top-x-review` into the same studio shot as the rest and threw away the one thing those
   two formats are for. That was an over-correction: what put a coconut and a wood slice on
   the bad plate was the finished ad's **ingredient row**, not the existence of a room.

   | setting | formats | what may share the frame |
   |---|---|---|
   | `studio` | `us-vs-them`, `ingredient-callout`, `manifesto`, `offer-focused`, `testimonial`, `stat-stack`, `state-contrast` | nothing — a plain even ground and the product |
   | `scene` | `problem-aware`, `top-x-review` | a coherent real place, with incidental objects |

   In **both** settings a plate brief may never name ad furniture (columns, rules, pills,
   bars, badges, icons, checklists, headlines), ingredient or botanical styling (a coconut,
   a sprig, scattered seeds — that is artwork the operator places, and it is literally what
   went wrong), or a unit count. **A scene is a PLACE, not ingredient styling:**
   `problem-aware` may have a bathroom counter and still may not have a coconut on it.
   `formats.js` throws at load if a format has no `plateSetting` — no default, because
   `studio` would silently strip a setting off a format that wants one and `scene` would
   silently license props on one that does not.
   **Three formats added 2026-08-15 from reference creatives that are running** — Bonafide
   (quote-led), Magic Spoon / MUD\WTR (stats radiating off a centred hero), and a kids'
   supplement before/after. All three were added as **data only**: no zone name is
   hard-coded anywhere downstream, so twelve formats cost the same logic as six.

   **`giveaway-entry`, added 2026-08-18, is the tenth — and the first conditional one.**
   It carries `requiresGiveaway: true`, which is a *sourcing* fact rather than a style flag:
   every factual line it asks for ("36 bars", "entries close September 14, 2026") can only be
   traced to the `giveaway` claim source, and that source exists only while an Entry Period is
   open (`lib/giveaway-claim-source.js`). So it is filtered out of the default rotation and out
   of the awareness join whenever no giveaway is running — `selectFormats()` with no keys
   returns every format except this one — while `--formats giveaway-entry` still resolves it by
   name, because naming a format explicitly is an operator decision and the claim gate is the
   right place for that decision to fail if it was wrong. It is a **lead ad**: it asks for an
   entry, never a purchase, and its brief forbids a price, a discount and a cart. It was added
   rather than folded into `offer-focused` because those two ads differ in the only thing that
   matters about an ad — what it asks the reader to do — and widening `offer-focused` mid-
   campaign would have made the one unambiguous format say two things at once.

   *Style only.* Several of those references carry visibly garbled machine-generated label
   text — `Zaro Sugar`, `Het Flash Relief`, and `tummy discomrfort` in a live Para Guard
   ad. We read their layout and their angle, never their copy, and that garbling is itself
   the argument for plate-first: they baked type into the render and it broke.

   | key | shape | notes |
   |---|---|---|
   | `testimonial` | big customer quote, attribution, product small beneath, star/credibility line | The quote **must be a verbatim review** — `claims.js` enforces it via the `reviews` source. An invented testimonial is the worst thing this pipeline could emit. A supplement disclaimer is required in the finished ad and is set by hand. |
   | `stat-stack` | centred hero with four stats in the corners, joined by hand-drawn arrows | `zoneCapacity: { stats: 4 }` — the references run 4–6 and six crowds a phone-width frame into the product. |
   | `state-contrast` | illustrated before → after with the product between | **Compliance-shaped.** Meta prohibits before-and-after imagery in health and beauty, and `problem-aware`'s brief already encodes that. The reference only gets away with the shape because its states are cartoons. So both states are flat illustration of the *experience* — never a photograph of skin, a body, a face, or a depiction of a condition — and because illustrations are artwork, the operator draws them; the plate is just the product with both state areas empty. |

   **`fact-hook` and `spec-panel`, added 2026-08-18, close the awareness gap.** Until then
   `unaware` and `most-aware` mapped to `null` in `lib/ad-brief-plan.js` — 4 of the 15 angles
   on file could be briefed but never rendered, including the highest-scoring angle we hold
   (`p2a2` "125 chemicals a day", 81). They introduce **two new `awareness` values** rather
   than aliasing onto the existing three, because routing an `unaware` angle to a `problem`
   format would show an ad premised on the reader knowing they have a problem to a reader who
   by definition does not — the "closest available format" substitution the ad-brief README
   refuses. **Cost consequence:** every angle is now renderable, so every angle now spends a
   copy call. A full `coconut-soap` brief run went from 8 paid calls to 11.

   | key | shape | notes |
   |---|---|---|
   | `fact-hook` | one arresting figure dominating the upper half, caption beneath, product small in the lower right like a footnote | `productProminent: false` — the number is the hero and the label is deliberately unreadable, so the verify gate must not demand it back. `headline` carries the **figure itself**. The brief requires the figure be quoted from a named source, never invented, and repeats `problem-aware`'s ban on depicting a skin condition. Studio, not scene: a giant numeral needs a flat field, and a counter would put texture exactly where the largest type lands. |
   | `spec-panel` | restrained headline, a vertical list of plain factual rows down one half, product hero opposite with its label legible | `productProminent: true` — a transparency pitch whose own label cannot be read defeats itself. `zoneCapacity: { specRows: 5 }`. Every row must be a plain verifiable fact, never a benefit promise or a claim of effect; the most-aware reader has already decided and wants facts to act on. |

2. **Copy** (`copy.js`, model: `claude-opus-4-8`) — exact per-zone strings plus a
   `claims` array. Every factual claim must name a `sourceId` (`pdp`, `catalog`,
   `brandKit`, `reviews`) and quote its evidence verbatim.
3. **Health-claim gate** (`health-claims.js`, `assertNoHealthClaims`) — runs on every zone
   of every format, **before** the sourcing gate, and throws with no override. A cosmetic
   may say what it does to the appearance and feel of skin; it may not name a disease,
   name a drug or prescription treatment, claim to heal/cure/treat/prevent/reverse, or
   assert clinical, dermatologist or FDA backing.

   It exists because **sourcing is not sufficiency.** On 2026-08-16 the `testimonial`
   format returned a verbatim, correctly-sourced Judge.me review — *"I have tried
   prescription strength lotions, steroids... to no avail.... Until Real Skin Care!!!!"* —
   and the sourcing gate passed it, correctly. But the FTC holds an advertiser responsible
   for claims an endorsement *conveys* (16 CFR 255), and the FDA treats marketing material
   **including testimonials** as evidence of intended use, which is what turns a cosmetic
   into an unapproved drug. Meta likewise holds advertisers responsible for third-party
   quotes; its enforcement is automated and inconsistent, which is the trap — passing
   review is not a safe harbour.

   Prevention as well as detection: `selectQuotableReviews` withholds reviews carrying such
   language from the writer entirely, so it never spends a call choosing one. Ordinary
   cosmetic vocabulary is deliberately untouched — moisturize, absorb, soothe, soften,
   dry skin, sensitive skin — and the word boundaries are tested so "heal" never fires on
   "healthy" nor "cure" on "manicure".
4. **Claim gate** (`claims.js`, `assertClaimsSourced`) — checks every factual claim's
   evidence actually appears in its named source and **throws, stopping the whole
   run**, if any claim is unsourced or its evidence doesn't match. Runs after every
   copy call, `--dry-run` or not.
5. **Render** (`render.js`, model: `gemini-3-pro-image` @2K) — **one generative pass**
   per variation per platform target, conditioned on up to 4 real reference
   photographs **and the manifest's prose description of the physical product**
   (`PHYSICAL FORM` in the prompt). The product is generated in-scene, never composited.

   **How many units belong in the frame is per-product data, not a constant.** Every
   manifest entry carries `unitCount`, and the plate prompt demands exactly that many and
   forbids any extra — including a faded, ghosted or partially cropped duplicate. It has
   to be data because four of the eleven RSC products are genuinely multi-unit
   (`foam-soap-bundle` 3, `coconut-oil-lip-balm` 4, `sensitive-skin-starter-set` 3,
   `skincare-starter-set` 2); a hard-coded "exactly one" would reject every correct render
   of those. A missing or invalid `unitCount` **aborts the run** rather than defaulting to
   1 — the same posture as empty `labelStrings`, and for the same reason: a silent default
   is how a wrong assumption ships without anyone deciding it.
6. **Verify** (`verify.js`, model: `claude-sonnet-5`) — five checks, all required:

   - **Per-string checks.** For each requested string, a *pointed* question — does this
     exact character sequence appear, yes or no, and what does that region actually
     say. **Not** an open transcription. A vision model asked to transcribe repairs
     misspellings semantically on the way out, so a transcript-driven gate is blind to
     exactly the corruption class it exists to catch; it reported `FORMULA` where the
     pixels said `FORMLA` and passed the ad on attempt 1. The model's "yes" is then
     re-checked against the text it itself quoted, so a corrupted string has to survive
     two independent answers. A transcript is still collected for `proof.json` but
     decides nothing.
   - **Product volume.** Read-or-`ILLEGIBLE`, on **every** format. `ILLEGIBLE` passes
     (the legitimate small-product case), a value agreeing with the real volume passes,
     a value that contradicts it **fails**. Numbers are compared, not strings, so
     punctuation never fails a render and a wrong number always does. The response's own
     transcript is **also** scanned for a contradicting volume, on every call — not only
     when the direct reading is missing. That gate is how the 2026-08-15 plate passed: the
     response carried both `8 fl. oz • 236ml` (correct, off the hero bottle) and
     `8 fl. oz . 230ml` (wrong, printed on a ghost second bottle), and because the direct
     answer was right the scan never ran. The old justification for gating it — that the
     scan "can only ever FAIL a render, never pass one" — was always the argument for
     running it unconditionally.
   - **Defects — the question is inverted per mode.** On a **finished frame**, any of the
     ad's own typeset copy that is obscured, cut off at the frame edge, or garbled fails
     the render; a live frame had the product bottle sitting on top of the word "actually"
     in its own closing line and the verifier silently reconstructed it. On a **plate**
     that question has no correct answer — the copy zones are empty *by specification*,
     because Demand Gen mixes the text assets in at serve time — so asking it failed 5 of
     18 plates on a live run for reporting empty header bars and blank list rows as
     "obscured". A plate is asked the opposite question instead: **what text is PRESENT
     that should not be.** Absence is never a defect there; any lettering, word or number
     anywhere but the product's own printed label is, spelled correctly or not (the same
     run rendered `A LIBCDEFGHIJKLM NOPQRSTUVWXYZ` into a bar that was supposed to be
     clean). Stray text on a plate is the more expensive defect of the two — the copy
     layer cannot remove pixels. `normalizeDefects` backstops the prompt: on a plate, a
     defect entry that quotes no rendered characters (a bracketed description of a region,
     or the word "blank") is a report of absence and is dropped. Text printed on the
     *product's* label is out of scope in **both** modes — arc-set badge micro-copy cannot
     be read reliably at any render size, and asking about it made the verifier reject a
     known-good control.
   - **Product fidelity — is the rendered product actually our product?** The verify call
     carries the first **two reference photographs** alongside the render, and asks a
     *pointed* question per attribute: `silhouette`, `closure`, `labelLayout`,
     `labelGraphics`, `containerColour` (`FIDELITY_ATTRIBUTES` in `verify.js`). Never one
     open "does this match?" — R1's finding again: an open question is answered towards
     yes. Answers are three-valued and follow `volumeVerdict`'s proven shape:
     `CANNOT_TELL` **passes** (the small-product case on `manifesto`/`problem-aware`),
     `MISMATCH` **fails**, and a response carrying *no* fidelity answers at all while
     reference photos were sent **fails** — a check that returns nothing is
     indistinguishable from a check that was never wired up. Runs in **both** modes:
     unlike the defect question this one does not invert, and a plate is nothing but the
     product. With no reference photos on file the check is off, never a hard fail.

     Why it exists: a live `ingredient-callout` frame was **accepted on attempt 1** with a
     bottle that had no black accent bar, no leaf illustration, and the badge micro-copy
     set beside a flat glyph instead of inside the circular badge. Every expected string
     was present and correctly spelled, so four text checks had nothing to fail. A human
     rejected it in one glance. `tests/fixtures/ad-studio/accepted-wrong-bottle-2026-08-14.png`
     is that frame.

     **Two narrowings are load-bearing and were each paid for with a false positive.**
     The first cut rejected a *real photograph* of the product, reporting gloss bands and
     a shoulder gradient as label graphics. So: (a) photographic styling — lighting,
     gloss, specular, shadow, background, angle, crop — is named in the prompt as never a
     mismatch; and (b) `labelGraphics` asks only whether the **reference's** elements are
     missing, moved or reshaped, and explicitly not whether extra elements appeared,
     because every false positive found was an "extra" that turned out to be a highlight.
     Do not widen either one back.

     **A third narrowing, 2026-08-15: `labelGraphics` judges SHAPE AND PLACEMENT ONLY,
     never micro-copy.** The badge carries arc-set text no vision model reads reliably at
     render size. Both live rejects were eyeballed: the 9:16 badge "looks fine" — a false
     positive that cost three paid attempts — and the 4:5 badge was "definitely garbled",
     but that frame was independently rejected for stray `"HOIXIM HEADLINE"` text baked
     into a plate. So the narrowing loses no true positive. It is the same exclusion
     `buildLabelStrings` already applies, for the same reason, and the same lesson as
     `productProminent`: when a check demands something unreadable, accept "cannot read
     it" rather than burning the retries.
   - **Scene inventory — plates only.** The verifier lists **every** distinct object in the
     frame and classifies each as `product-unit`, `surface` or `other`. The count of
     product units must equal the product's `unitCount`, and there must be no `other`
     objects at all. An empty inventory on a plate **fails** as unreported.

     **Two live-run corrections, both paid for with false positives (2026-08-15).** The
   first cut asked an OPEN "list every object, including anything faint, blurred or
   ghosted" and added "if there is a second bottle you are unsure about, list it". On the
   9:16 plate — a tall frame that is mostly empty gradient by design — that produced a
   confabulated second bottle in **9 of 9 vision calls across three prompt wordings**,
   burning the full retry budget on a frame that pixel inspection proved was correct. The
   1:1 and 4:5 of the same run passed 3/3. De-biasing the wording did not fix it, and
   majority voting cannot: the confabulation is *consistent*, so N calls buy the same
   wrong answer N times. Two changes did fix it, and they are R1's lesson again — pointed
   beats open, and never ask a vision model to strain:

   - a unit counts only if the model can resolve **both a closure and a body** on it;
   - an object the model itself describes as blurred, out-of-focus, faint or possible is
     **background, in every bucket** (`isUnresolvedObject`) — filtered in code, the same
     shape and justification as `isAbsenceReport`. Filtered entries are returned as
     `unresolved` and written to `proof.json`, never silently dropped.

   The real 2026-08-15 ghost carried a *readable* wrong volume (`8 fl. oz . 230ml`), so it
   clears the resolution bar comfortably; and the unconditional transcript volume scan
   catches that frame independently. The second correction: the leaf illustration **printed
   on the bottle's label** was classified as a stray object in 4 of 6 calls, which would
   have failed every studio plate of a product whose label has artwork on it. Label artwork
   is part of the product and is now excluded explicitly.

   **The stray rule follows `plateSetting`; the unit count never does.** On a `scene`
   plate an `other` object is the deliverable, so strays are recorded in `proof.json` but
   do not fail the frame — a human can still see if it drifted into a prop pile. The unit
   count is absolute in every setting: a ghost second bottle is wrong in a bathroom too.
   `setting` defaults to `studio`, the strict side, so a caller that forgets to thread it
   gets the tighter gate.

   Why it exists: the 2026-08-15 plate carried a ghost second bottle, a wood slice,
     greenery and a coconut, and passed everything above. Each check had a reason not to
     see it — `FIDELITY_ATTRIBUTES` are phrased about *the* product, singular, so the
     verifier silently picked one unit and judged that; the volume transcript scan was
     gated; and the stray-text rule correctly exempts text on the product's own label,
     which exempted the ghost bottle's wrong volume twice over. **The generalisable shape:
     every check assumed exactly one product in the frame. When adding a check here, ask
     what it assumes about how many of something is present.**

     It is an inventory, not a unit count, and that is the point: a hard-coded "exactly
     one" would fail every genuine multi-unit product, while an inventory handles bundles
     naturally *and* still catches a ghost bottle. Its output — "a wood slice, a coconut, a
     second partially-rendered bottle" — is actionable where "count: 2" is not. The
     verifier is **never told how many units to expect**: that would be R1's exact failure
     mode, an open question answered towards the number in the prompt. `inventoryVerdict`
     does the comparison in code. Finished frames are not inventoried — their `layoutBrief`
     asks for the furniture, so "does this belong" has no answer there.

   - **Pairing**, on **finished frames** of formats that pair a picture with a label.
     Not applied to Demand Gen plates: a plate is text-free by construction, so it has
     no labels to pair anything with, and demanding pairings there made every plate of
     a pairing format an unavoidable hard fail.

   Text matching is anchored at token boundaries — an unanchored substring match
   accepted `18 fl. oz.` for an expected `8 fl. oz.`, the exact false spec this gate
   exists to stop. `renderWithRetry` retries up to 3 attempts total before accepting
   the failure.

   **The model is Sonnet, not Haiku, on purpose.** Haiku auto-corrected `TTHAN`/`FORMLA`
   into clean text and passed a corrupted ad. This is one vision call guarding a ~$0.13
   render that nobody else reads before it goes live; do not drop it back to save
   pennies on the cheapest call in the pipeline.
6. **Layout critique** (`critique.js`, model: `claude-sonnet-5`) — a **second, separate**
   vision call, run only on a frame that already passed stage 5, and only on **finished
   frames** (a plate carries no typeset copy, so neither check has an answerable question
   and the call is skipped rather than paid for). Split in two on purpose:

   - **Part A — objective, HARD FAIL, feeds the existing retry loop.**
     **Safe zone:** on **9:16 only**, is any of the ad's own copy inside the bands Meta
     draws its UI over? Meta unified Stories and Reels onto one 9:16 safe zone in March
     2026 — top 14%, sides 6%, bottom 20% (Stories) to 35% (Reels). The gate uses the
     **Stories** depth; Reels' bottom 35% plus the top 14% puts half the frame off-limits
     and these six formats were not laid out for that, so a frame that clears Stories but
     not Reels is reported in the notes for a human to weigh. 1:1 and 4:5 are **not**
     gated — nothing is drawn over a feed image, so placement there is a preference, and
     gating a preference costs three paid renders every time it fires. The bands are
     stated to the model as **fractions** ("the top one-seventh"), never percentages: a
     vision model eyeballs a fraction far more reliably than it estimates 14%, and the
     whole check rests on that estimate.
     **Legibility:** on every finished ratio, can the copy be read at thumb size —
     contrast and size only, never typeface or colour taste.
     Both are three-valued; `CANNOT_TELL` passes, the same tolerance `volumeVerdict`
     gives `ILLEGIBLE`.

   - **Part B — subjective, RECORDED, never blocks.** A 1-5 quality score with notes,
     written to `proof.json` and `run.json`. Making "is this a good ad?" a hard fail
     would reject good work and pay for three attempts doing it — the exact
     false-positive class that cost two rounds on the fidelity check. The score exists to
     **rank accepted frames**, which the UI spec says is where the operator's time goes.

   **Why a separate call and not more sections in `buildVerifyPrompt`.** That prompt's
   central instruction is *"You are NOT reading for meaning. Do not repair, complete,
   normalize or auto-correct anything"* — a deliberately literal pixel read, arrived at
   over five fix rounds. Art direction is the opposite instruction. Asking one call to do
   both contradicts its own framing and risks a gate that was expensive to stabilise.

7. **Package** (`packaging.js`) — writes the six platform artifacts (3 Meta finished
   frames + 3 Demand Gen text-free plates) and buckets the concept's copy into Demand
   Gen's headline/long-headline/description fields.

## Output layout

```
data/creatives/ad-studio/<run-id>/
  run.json                        # totals, models, per-concept/variation results
  <concept-slug>/                 # concept-slug is the format key, e.g. ingredient-callout
    copy.json                     # { zones, claims } for this concept
    demand-gen-assets.json        # headlines/longHeadlines/descriptions/dropped
    v1/
      finished-1x1.png            # Meta, baked copy
      finished-4x5.png
      finished-9x16.png
      plate-1_91x1.png            # Demand Gen, text-free except the product's own label
      plate-1x1.png
      plate-4x5.png
      proof.json                  # per-artifact { ok, attempts, reasons, missing, transcript, ... }
    v2/ ...
    v3/ ...
```

`run.json` also carries `cost` (`renders`, `perRenderUsd`, `estimatedUsd`), `budget`
(`maxRenders`, `stopped`, `skipped[]`), and:

- **`ranking[]`** — accepted frames, best `critique.score` first. The frame worth looking
  at is the first line of the file, not something found by opening every PNG. Rejected
  frames are excluded: a frame that failed the gate is not a candidate to ship, whatever
  an art director thought of its composition. Unscored accepted frames sort last.
- **`scoreSummary`** — this run's mean against the rolling baseline.

## The score baseline

Every scored frame is appended to **`data/reports/ad-studio/scores.jsonl`** (one row per
frame: run id, product, format, variation, artifact, score, ok). Rejected frames are
included — excluding them would bias the baseline upward by construction.

The baseline is read BEFORE the current run's rows are appended, so a run is never
compared against a baseline containing itself. Below 50 observations the summary says so
rather than reporting a delta: six frames is not a baseline, and a delta off n=6 invites
reading noise as a trend. Scores are only really comparable **within a format** —
`manifesto` renders the product small and understated, `us-vs-them` is a comparison table,
and they are not being judged on the same thing. `byFormat` is the number that means
something.

This file is a few bytes per frame and must outlive the images, which
`scripts/prune-ad-studio.mjs` deletes on a 90-day window.

## Housekeeping

**Every run auto-archives its output**, on the success path, the failure path and on SIGINT/SIGTERM — a run that crashed or was interrupted used to leave its images only in the worktree, where `git worktree remove --force` destroys them. The mechanism is shared (`lib/archive-run-output.js`); `agents/creative-packager` uses it too. At the end of a run it copies
`data/creatives/ad-studio/<runId>/` to the same path under the **main checkout**, found via
git's common dir. Run output is gitignored, which inside a worktree means untracked — and
`git worktree remove --force` deletes untracked files. That is how a set of sample plates
was destroyed before anyone had seen them. Set `AD_STUDIO_ARCHIVE_DIR` to send it somewhere
else; running in the main checkout no-ops, because the destination is already the source.
A failed copy warns and never fails the run — the images are on disk by then, and turning a
successful paid run into a crash over a backup is strictly worse.

**Every run enforces a disk budget on `data/creatives/` before it exits** (`lib/creatives-budget.js`) — 10 GiB locally, and 4 GiB on the production server via `CREATIVES_BUDGET_BYTES` (that box has ~9.9 GB free of 24 GB, and a ceiling above the free disk can never fire before the disk fills). The ceiling is read from `process.env` first and then from `.env` (`configuredBudgetBytes()`), so a hand-run agent and the weekly cron sweep get the server's value even though neither has `.env` in its environment. Purge is tiered and stops as soon as the total fits — rejected frames past a 7-day grace, then Ad Studio images from runs older than 14 days, then Creatives-tab sessions idle 30+ days. JSON is never touched, and the run just written is never eligible, so a sweep can never eat the frames you are about to look at. If it cannot free enough it warns instead of reporting success. The sweep runs on every exit path — normal completion and SIGINT/SIGTERM alike. `npm run creatives-budget -- --apply` is the same sweep by hand.

`data/creatives/ad-studio/` is gitignored (one default run is ~137 MB of 2K renders) and
accumulates with every run. The production box has a 24 GB disk and a full one has
already cost this project four days of cron (see CLAUDE.md's Server Deployment notes) —
`scripts/prune-ad-studio.mjs` exists so this directory doesn't do that again.

Policy — "keep what we need, ditch the rest":

- **Keep forever, any age:** every JSON file (`run.json`, `copy.json`, `proof.json`,
  `demand-gen-assets.json`). A few KB each, and the permanent record of what happened —
  a run stays auditable at a few KB even after its images are gone.
- **Delete, after a grace period (default 7 days):** image artifacts belonging to a
  **rejected** variation. Inspect a failure the day it happens, not a month later — the
  rejected frame's `proof.json` survives regardless, so the reason is never lost.
- **Delete, unconditionally (default 90 days):** image artifacts from runs older than
  the retention window, accepted or not.

Accepted vs. rejected is read from `run.json`'s `results[].variations[].ok`, never
inferred from filenames. A run with no readable `run.json` (aborted mid-run) has its
images treated as rejected and subject to the grace period — never treated as accepted,
never skipped.

```bash
node scripts/prune-ad-studio.mjs                                    # dry run (default) — prints the plan, deletes nothing
node scripts/prune-ad-studio.mjs --apply                            # actually delete
node scripts/prune-ad-studio.mjs --rejected-days 3 --run-days 60 --apply
```

**Dry-run is the default, not `--apply`.** This inverts the repo's usual
apply-by-default agent convention (see CLAUDE.md's Autonomy Principle) on purpose — the
directory is gitignored, so deleted bytes are gone for good, and the safe mode has to be
the one you get by accident.

## Cost

Every platform target is an **independent render** — the three Demand Gen plates are not
free crops of the Meta frames.

| | renders | ≈ cost |
|---|---|---|
| **Default** — one format, one variation, `--targets meta` | **6** | **$0.78** |
| One format, `--variations 3`, Meta | 18 | $2.34 |
| One format, one variation, `--targets all` | 9 | $1.17 |
| One format, `--variations 3`, `--targets all` | 27 | $3.51 |
| Eleven formats, `--variations 3`, `--targets all` | 297 | $38.61 |
| `--max-renders` default ceiling | 120 | $15.60 |

**A Meta target bills two renders.** The plate is rendered and gated, then a comp is
derived from it as the operator's layout reference — and that derived pass takes a
budget slot like any other render. Demand Gen plates get no comp, so they bill one.
Every row above follows from that; `lib/ad-studio-cost.js` is the one implementation
and `tests/lib/ad-studio-cost.test.js` pins these numbers.

Retries are charged. A frame that needs all 3 attempts costs 3 plate renders, so a
nominally 6-render run can bill 12 in the worst case.

**The Gemini image model has a hard quota of 250 renders per project per day.** A default
full-rotation run is 162, so a single one plus retries can exhaust the day — the API then
returns 429 with a ~19h retry delay and every remaining target of the run errors out
(per-target resilience keeps the run alive and still writes `run.json`). Scope runs with
`--formats`; do not discover this ceiling mid-batch.

The **layout critique** adds one more Sonnet call, but only on finished frames that
already passed verify — roughly **$0.01 each, under $1 on a default run**.

At ~$0.13 per Gemini 3 Pro 2K render, plus one **Sonnet** vision call per render for the
verify gate — ~$0.04 on a 2K frame now that the call also carries two reference
photographs for the fidelity check (~14k input tokens), so still under a third of the
render it is guarding. That is the whole argument for
raising it off Haiku: the gate is the cheapest thing in the pipeline and the only thing
between a corrupted headline and a live ad. `--dry-run` costs one Opus copy call per
format and renders nothing. Scope a run with `--formats` and `--variations` rather than
relying on the ceiling.

## Global constraints (non-obvious, do not relax)

- **Single-pass render only.** A rendered image (finished or plate) is never fed back
  into a second generative pass. Design-probe evidence: a second pass over a
  text-free plate spelled every word correctly while shifting the supporting
  ingredient photos one row against their labels — jojoba captioned as coconut oil.
  A text-only gate would have shipped that ad.
- **No cutout compositing.** `data/brand/cutouts/` is never read by this agent. The
  product is generated in-scene, conditioned on real reference photographs, so
  lighting, contact shadow and perspective match the rest of the frame.
- **The manifest's physical description reaches BOTH the renderer and the gate.**
  `manifestEntry.productDescription` was being mined for label strings and volume
  markings and then dropped — so the renderer was told exactly what the label *said* and
  nothing about what the bottle *was*, while the description on file already read "tall,
  slim lotion bottle shape" and "a black horizontal accent bar behind the variant name
  text". It rendered neither, and the gate had no shape to compare against. It now flows
  through `product.physicalDescription` into `buildRenderPrompt`'s `PHYSICAL FORM` block
  and into `buildVerifyPrompt`'s fidelity section. The sister agent learned this first
  (PR #314, "faithful product renders … pass product descriptions"); do not un-learn it
  here. A product whose manifest entry has a thin `productDescription` gets a weaker
  render and a weaker check — improving that prose is the cheapest quality lever in this
  pipeline.
- **Exact label strings, every time.** `product.labelStrings` (built by
  `buildLabelStrings` in `index.js` from quoted label text and the volume marking in
  the manifest's `productDescription`, plus `--variant`) is named literally in every
  render prompt — every format, both modes — and is additionally folded into the
  verification gate's expected-text list for formats that declare
  `productProminent: true`. That flag is a **legibility** judgement, not a priority
  one: `manifesto` renders the product "small and understated at the bottom center"
  and `problem-aware` "present but not dominant", and no vision model can read a 6pt
  brand mark off those, so demanding it back would fail every attempt and burn the
  retries. The model is still told exactly what the label says on those formats, so it
  still cannot invent a volume.

  **The flag no longer switches the label check off — only the hard expected strings.**
  It used to strip `labelStrings` out of the gate's expected set wholesale, so on
  `manifesto` and `problem-aware` a wrong label was not merely un-demanded, it was
  *un-checked*. That is how a live frame shipped `4 FL oz / 118ml` on an 8 fl. oz.
  bottle with `ok: true` on attempt 1. The **volume marking** is now verified on every
  format regardless of the flag, tolerant of illegibility and intolerant of falsehood
  (`verify.js`'s `volumeVerdict`, wired through `expectedForFormat`'s `volumeStrings`).
  Do not widen the flag back into an off switch for the volume.

  **The volume is checked once, and never by the per-string check.**
  `expectedForFormat` subtracts the volume markings from the expected set in *both*
  modes; every other label string (brand mark, product type, variant name) is demanded
  back exactly as before on a `productProminent` format. The two mechanisms have
  different strictness and were contradicting each other inside one verdict:
  `volumeVerdict` compares numbers and tolerates punctuation, because the manifest
  writes `8 fl. oz. (236ml)` while the bottle prints `8 fl. oz - 236ml`; the per-string
  check demands the literal sequence and failed it. A live run rejected three targets
  whose volume `volumeVerdict` had just reported as `"status": "match"`. If the volume
  gate ever needs to be stricter, make `volumeVerdict` stricter — do not re-add the
  volume to the expected set.

  One thing the duplicate was accidentally covering moved into `volumeVerdict` with it:
  the verifier answering `"productVolume": "ILLEGIBLE"` while transcribing a readable,
  wrong volume elsewhere in the same response (a live plate reported `ILLEGIBLE` and
  transcribed `0 fl. oz. • 236ml` — a misrendered `8`). `volumeVerdict` falls back to
  the response's transcript when, and only when, it has no direct reading, and that
  fallback can only *fail* a render, never pass one.

  **`main()` aborts if this list comes back empty** — an empty
  list is exactly how the image model invents a volume that was never on the bottle
  (a design probe rendered `6 fl. oz.` on a 2 fl oz bottle when the label text
  wasn't named). There is no flag to skip this check.

  **Net weight counts as a volume marking.** `readVolume` understood fluid ounces and
  millilitres only, so the lip balm (`0.15 oz • 4.25g`) and the bar soap (`3.4 oz • 84g`)
  were invisible to `volumeVerdict` — it reported `no-volume-on-file` and passed any
  weight the model invented. Worse, since `expectedForFormat` only subtracts *recognised*
  markings from the expected set, those two stayed in it and were checked by the strict
  literal matcher instead — the exact mechanism R2b removed for the lotion after it
  rejected three correct renders over punctuation. Weight is now parsed alongside volume
  (`wtOz`, `g`). The weight pattern deliberately cannot match a *fluid* ounce marking:
  `8 fl. oz.` puts `fl.` between the number and `oz`, which `\s*` cannot cross.

  It holds only **spec-bearing** label text — brand mark, product type, variant name
  and above all the volume marking. Two things are deliberately excluded:

  - **The catalog title** (`data/brand/product-catalog.json`) — marketing/SEO copy,
    not text printed on the physical label. Feeding it in both told the image model
    to print it on the bottle and made the verify gate require it to appear.
  - **Badge inscriptions** — the "Organic Coconut Oil + Essential Oils" style
    micro-copy set on a curved arc inside a small circular badge. It is decorative,
    no product spec is falsifiable through it, and at roughly 8px on a curve the
    verify gate's vision model cannot transcribe it reliably (on a plate that was in
    fact correct it read `["ORGANIC","COCONUT","ESSENTIAL OIL"]` — a dropped word
    and a lost plural). Requiring text that cannot be read back rejects good renders
    and burns three paid attempts per target.

  The badge rule keys on the manifest naming the element next to the quote — either
  `...circular badge noting "..."` or `..."..." badge, ...` — and is anchored tight
  on both sides. **Do not loosen it.** An earlier unanchored version reached past the
  previous quote and silently ate `"hand soap"` and `"toothpaste"`, which are product
  types and very much spec-bearing; `tests/agents/ad-studio-orchestrator.test.js`
  now pins the volume marking and the variant name against exactly that.
- **The claim gate hard-blocks, with no override.** `assertClaimsSourced` is never
  wrapped in try/catch. An unsourced factual claim stops the entire run before
  anything is rendered — money is never spent on a concept with an unverifiable
  claim in it.

## Requires

`ANTHROPIC_API_KEY` in `.env` always (copy + claim gate run even under `--dry-run`).
`GEMINI_API_KEY` only when not running `--dry-run`.
