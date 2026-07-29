# Digital assets — scope for a complete build

Scoping document, 2026-07-28. The 90-Day Coconut Reset's value stack claims **$34 of digital goods**. This specifies what has to exist for that claim to be honest, and how to build it so it stays honest.

---

## 1. What exists today

Both assets are **real and live** — this is not a build from zero, and the earlier suspicion that they were stubs was wrong.

| Asset | Claimed | Actual | Delivery |
|---|--:|---|---|
| The 90-Day Calm-Skin Routine & Tracker | **$19** | 4 pages, ~646 words | Klaviyo flow `XEMgA7` (live) |
| The Coconut Skincare Field Guide | **$15** | 4 pages, ~696 words | same flow |

Delivered by *Coconut Reset — Digital Delivery*, subject "Your 90-Day Reset guides are inside 🥥", linking two PDFs on the Shopify CDN. The flow is live and the links resolve.

**What's in them now.** The Tracker covers *Why 90 days* (28-day renewal cycle, 6–12 week judgement window), a two-step daily routine, the damp-skin rule, and a three-phase plan (Reset / Rebuild / …). The Field Guide covers cold-pressed vs refined coconut oil, what the ingredients do, and an in/out irritant table. The writing is good and on-brand.

**The gap is scale, not quality.** Four pages and ~650 words is a well-made leaflet. It is not what a customer pictures when a value stack says $19 — and the value stack is the argument for a $99 price against $118 of physical goods, so the digital line is load-bearing.

**No source in the repo.** Both were produced by Chrome print-to-PDF (`Skia/PDF m146`) as one-off artifacts. There is no HTML, no template, and no way to regenerate them. That is the real problem — see §3.

---

## 2. Why this is worth building properly

- **$34 of margin-free AOV.** Physical value costs COGS; digital value costs one build. On a $99 bundle against a store AOV of ~$47, it is the cheapest lever available for making the price feel fair.
- **Only one bundle claims them.** The Reset does; the other nine don't. A finished library can be attached to the 90-Day Clean Swap, Head-to-Toe and the Sensitive Skin Set at zero marginal cost — the same asset justifying four price points instead of one.
- **They are also lead magnets.** The growth plan gates paid traffic behind Tracking → CRO. A genuinely good Field Guide is an email-capture offer that works during that gate, not after it.
- **The tracker is a retention mechanic.** Retention is the documented constraint (18% repeat rate). A 12-week tracker a customer is actively filling in is a reason to still be engaged on day 80 — which is when the replenishment flow fires.

---

## 3. Build them as generated artifacts, not documents

**This is the most important decision in the scope.** The current PDFs are unversioned binaries with no source, containing claims about ingredients, timings and prices. Today alone, four separate live claims were found to be false because a value lived in one place and drifted from its source: `duration_days`, `rating_value`, the CTA strip, and "no palm oil / vegan".

A hand-made PDF sitting on a CDN is the perfect vector for the fifth. The Field Guide already asserts the ingredient list; if a formulation changes, nothing connects the two.

**So: HTML templates in the repo, rendered to PDF by a script, with every factual claim pulled from existing config rather than typed.**

- Precedent exists — `scripts/generate-analysis-pdf.js` already renders HTML to PDF with `puppeteer`, which is a declared dependency. No new tooling.
- Ingredient claims read from `config/ingredients.json`. If a formulation changes, the guide changes on the next build, and the "in / out" table cannot silently become false.
- Consumption and duration claims read from the measured reorder data, not from marketing intuition.
- Proposed: `scripts/build-digital-assets.mjs [--apply]`, sources under `assets/digital/<slug>/`, output uploaded to the Shopify CDN with the delivery-flow links pointing at stable filenames.

---

## 4. Target specification

"Full-featured" needs a definition or this rebuilds at the same size. Proposed targets:

### The 90-Day Calm-Skin Routine & Tracker — $19

| | Now | Target |
|---|--:|--:|
| Pages | 4 | **16–20** |
| Words | 646 | 2,500–3,500 |

The name promises a tracker and there isn't one. The single largest miss.

- **A real 12-week tracker.** One printable spread per phase, with a daily tick grid, a weekly skin-condition scale, and space for notes. This is the artefact people print and stick on a mirror — it is the product.
- **The three phases expanded** — what to expect in weeks 1–2, 3–6, 7–12, and specifically what "week 2 feels slow" looks like so people don't quit at the known drop-off point.
- **Troubleshooting.** Skin feels greasy; lotion won't absorb; product went solid; a patch got worse. Each with what to do. This is the section that prevents refunds.
- **A day-0 / day-90 photo page** — how to take a comparable photo, same light, same spot. Doubles as the recruitment mechanism for the customer-transformation imagery in `docs/bundle-media-plan.md`, which currently has no day-0 photographs of anyone.
- **Reorder timing** anchored to measured consumption, so the tracker's last page lands where the replenishment flow fires.

### The Coconut Skincare Field Guide — $15

| | Now | Target |
|---|--:|--:|
| Pages | 4 | **12–16** |
| Words | 696 | 2,000–3,000 |

Currently strongest on the ingredient story and thin on everything a sensitive-skin buyer actually asks.

- **The irritant reference expanded into something usable** — the common irritants by name, what they're called on a label, and which product categories hide them. A page someone keeps.
- **Read any label in 30 seconds** — a repeatable method, not a list. This is the part that gets forwarded.
- **Seasonal guidance.** Winter vs summer, why the product firms below 76°F, how routine changes.
- **Which product for which problem**, across the range — genuinely useful, and the natural cross-sell into the other nine bundles.
- **Sourced answers to the top objections** from `data/context/voice-of-customer.md`, in the customers' own words.

---

## 5. Claim discipline

Non-negotiable, given the day this scope was written on:

- Every ingredient statement generated from `config/ingredients.json`. **No hand-typed ingredient lists.**
- No medical or dermatological claims. These are moisturisers. "Dermatologists recommend 6–12 weeks" is an attributable statement about routines; "clinically proven" is not available.
- No "vegan" or "palm-free" claims anywhere — the cream and lip balm contain beeswax, and the lotion, cream and lip balm contain organic red palm oil. The current Field Guide already correctly says "organic beeswax in the cream"; keep that honesty.
- Duration and consumption figures from measured data only.
- If a claim can't be sourced, it doesn't ship. The repo already has `citation-finder` for exactly this discipline on blog content.

---

## 6. Effort and sequencing

| # | Step | Effort |
|--:|---|---|
| 1 | `scripts/build-digital-assets.mjs` + HTML/CSS template, print-stylesheet, rendering one existing PDF as a fidelity check | M |
| 2 | Tracker content — the 12-week grid is the bulk | L |
| 3 | Field Guide content | L |
| 4 | Wire ingredient/consumption data into the templates | S |
| 5 | Upload, repoint flow `XEMgA7`, verify both links from a real send | S |
| 6 | Attach to the other three bundles' value stacks | S |

**Step 1 first, and alone if nothing else gets done.** Once the pipeline exists, content can land incrementally and every future edit is a commit rather than a re-export. Doing content first repeats the current situation with more words in it.

---

## 7. Decisions needed

1. **Do the targets in §4 match what you'd pay $19 and $15 for?** They are my read of the gap, not a given. If the answer is that the value should come down to match a leaflet instead, that is a legitimate and much cheaper answer — but it lowers the Reset's value stack from $158 to ~$130 and weakens the $99 argument.
2. **Should the Field Guide become a lead magnet** (email capture), or stay a purchase benefit only? It changes how hard it sells the range.
3. **Who writes the content?** The build pipeline is mine to do. The 2,500–3,500 words of tracker copy is a content project — it can run through the existing writer/editor gates, but it is not a side effect of the tooling.
