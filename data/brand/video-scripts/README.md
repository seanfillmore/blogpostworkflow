# Short-form video shot books

Hooks, body scripts and closes for organic short-form video, written in the
**founder voice** (see [founder-narrative.md](../founder-narrative.md) and
[voice-and-pov.md](../voice-and-pov.md)).

These live here because they had no home. They were authored in a session
scratchpad and published straight to Artifacts, so for two days the only copy of
the source was a temp directory that gets cleared with the session, and the only
copy of the links was a chat transcript. Same failure shape as
`lib/archive-run-output.js` exists to prevent for Ad Studio: work whose only
copy is somewhere that disappears.

## The books

| Product set | Source | Live artifact |
|---|---|---|
| Body lotion (8oz, `coconut-lotion`) | [`lotion-video-scripts.html`](lotion-video-scripts.html) | https://claude.ai/code/artifact/5f04cf5b-5386-4402-b41f-f8b3290e439f |
| Bar soap + foaming liquid soap | [`soap-video-scripts.html`](soap-video-scripts.html) | https://claude.ai/code/artifact/0f9e5795-b110-4678-a979-52f5063b414b |

**Two artifacts, three product sets** — the soap book covers the bar and the
foaming liquid separately, because they are bought by different people against
different objections. The bar's top complaint is that it *disappears* (6
mentions); the liquid's is that it leaves hands *stripped*. One is a value
argument, the other is chemistry, and a script serving both wins neither.

`lotion-founder-copy.json` and `soap-copy.json` are the same copy as structured
data. **They are what the gates were run over**, so the gate results in each
book are reproducible rather than a claim — see below.

## Re-gating after an edit

Every spoken line has been through three gates. Re-run them after changing any
copy; all three are pure functions over strings, so this costs nothing.

```js
import { findHealthClaims } from './agents/ad-studio/health-claims.js';
import { findProductCategoryMisnomers } from './lib/product-category-terms.js';
import { findGoldenThread, sellingVocabulary } from './agents/ad-studio/golden-thread.js';
```

- **`health-claims.js`** — disease names, therapeutic verbs, drug references,
  unsubstantiated backing. A cosmetic may say what it does to skin's appearance
  and feel, never what it treats.
- **`product-category-terms.js`** — describing a cosmetic with a regulated drug
  category name.
- **`golden-thread.js`** — whether the hook's premise swallows the body instead
  of pivoting to the reason the market actually buys. Check `disarmed`, never
  read `goldenThread === false` as "clean".

Last run 2026-09-03: lotion 44/44 and 20/20 clean, soap 68/68 and 24/24 clean.

## Two things no gate catches, and both have already bitten

**1. Substantiation.** *"Outlasts tallow bars costing twice as much"* carries no
disease, no drug, no therapeutic verb — every gate passes it — and it was
**false**. Coconut soap's lauric and myristic acids make small, highly soluble
molecules where tallow's stearic and palmitic make larger insoluble ones, and
retained glycerin is a humectant that speeds dissolution further. Our bar wears
*faster* than tallow, which is what six reviews had been saying. Cut from the
PDP, the theme and this book on 2026-09-05. A comparative performance claim is
an advertising-substantiation question and needs a human, not a regex.

**2. Named competitors.** The liquid soap's review quote is *paraphrased* — the
original names two retailers. Putting the review on screen is the customer's
words and fine; saying them yourself is a comparative claim about named
competitors, which is a different thing.

## The one rule that decides whether any of this works

A hook earns the scroll-stop. **It must not become the video's subject.** Hooks
are grouped in each book by *which script they hand off to*, not by theme,
because the most tempting angles in this category — the ingredient count, the
price, "coconut oil clogs pores" — swallow a video whole if you let them keep
talking. Pick a hook, shoot the script it points at, don't improvise the middle.

## Updating

Edit the HTML here, then republish to the **same** artifact URL so the repo and
the live link do not drift. Publishing without the URL creates a second artifact
and the link in the table above goes stale — which is the drift this directory
exists to stop.
