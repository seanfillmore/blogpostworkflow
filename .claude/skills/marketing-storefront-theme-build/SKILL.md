---
name: marketing-storefront-theme-build
description: Turning an AI storefront design into a live Shopify theme: base-theme export, draft previews, correction prompts, fix routing and pre-publish verification.
---

# Storefront Theme Build

## When exporting the AI design to code, instruct the model to build on top of Shopify's official free base theme source files (Horizon, pulled from GitHub) rather than letting it invent a theme from scratch.

**Why it works:** Using Shopify's own source files as the base produces an officially structured theme — real sections, templates and settings that appear in the theme customiser and stay compatible with Shopify's admin and future updates — instead of a bespoke pile of Liquid that only the AI understands and nobody can edit later.

**Evidence offered:** Demonstration of the export path (share → more formats and apps → Code → Claude Code) with the Horizon GitHub repo pasted into the instruction; the resulting build appears in the Shopify admin as a proper editable theme with addable sections.

**Fit here (7/10):** Directly protects a solo operator with no designer and no developer from ending up with an unmaintainable theme they cannot edit or update — the single largest risk of an AI-built storefront on a store already doing only ~$875/mo. Basing it on Shopify's own theme means the operator can still edit modules in the admin afterward without an agent in the loop. Platform-mechanics class (theme names and export paths decay fast), but the video is current, so no age discount.

*Source: Brendan Gillen — "Designing Shopify Themes Has Changed Forever (Tutorial)" (vqAzmtwekmw)*

## Push the AI-built theme to the store as a draft, unpublished theme and preview it there, never straight to live.

**Why it works:** A draft theme renders against real products and real admin data so you can see what customers would see, while the live storefront keeps selling untouched — the cost of a bad generation is zero instead of a broken checkout.

**Evidence offered:** Demonstration: he explicitly prompts 'add it to the Shopify store as a draft unpublished theme', then finds the first version looks bad, which would have been a live outage had he published.

**Fit here (8/10):** The single Shopify storefront is one of only two revenue surfaces and there is no team to catch a broken PDP. A solo operator running agentic edits against a live theme is one bad prompt away from losing the ~$875/mo Shopify line. Costs nothing, runnable today.

*Source: Brendan Gillen — "Designing Shopify Themes Has Changed Forever (Tutorial)" (vqAzmtwekmw)*

## Expect the first build pass to get the structure right and the design wrong; correct it with a follow-up prompt that names the specific gap ('it doesn't look like the design, replicate it on the template', or a screenshot plus a description of the wrong behaviour) rather than restarting the build.

**Why it works:** The agent builds a correct skeleton before it applies visual detail, so the miss is almost always the design layer, not the architecture — a targeted correction prompt against the existing session is far cheaper than regenerating and re-approving a 19-minute build.

**Evidence offered:** Demonstration: the first output 'doesn't look that great'; a single follow-up prompt replicates the whole design, and a screenshot-plus-description prompt fixes the stacked flavour cards in about 30 seconds.

**Fit here (6/10):** Directly usable by a one-person shop with 12 SKUs and no developer — it is how the storefront actually gets fixed when something looks or behaves wrong. Adjacent to the near-miss correction discipline already recorded for AI image generation, but the artifact is theme code and page behaviour, not a render, so it is not a restatement.

*Source: Brendan Gillen — "Designing Shopify Themes Has Changed Forever (Tutorial)" (vqAzmtwekmw)*

## Route each fix by its class: if the thing looks wrong, change it in the design tool and sync that change into the code session; if the thing behaves wrong (clicks, switchers, stacking), change it directly in the code tool.

**Why it works:** Keeping visual changes in the design file preserves one source of truth for the design, so the two tools do not drift apart; behaviour is not represented in the design file at all, so it can only be fixed in code. Making the change in the wrong place means the next sync overwrites it.

**Evidence offered:** Demonstration: he fixes the flavour-card switching behaviour in VS Code, then changes the FAQ section layout in Claude Design and syncs it back via design sync, and shows both landing correctly in the draft theme.

**Fit here (5/10):** Sound working rule for a solo operator running both tools, and it prevents rework. Scored mid because it only pays off once the operator is actually maintaining a design file alongside the theme — plenty of PDP changes at this size are single-section edits made straight in the Shopify editor. Platform-mechanics class and currently accurate.

*Source: Brendan Gillen — "Designing Shopify Themes Has Changed Forever (Tutorial)" (vqAzmtwekmw)*

## Never accept the agent's 'done and fully customized' report — open the store and verify, specifically checking whether the generated sections were actually assigned to the product templates rather than merely created.

**Why it works:** The agent reliably reports completion for work it only half did: it will create every section but leave the template unpopulated, or assign the design to a different custom template than the one you were looking at. Only the rendered page proves the state.

**Evidence offered:** Demonstration: 'let's go and see whether it's telling us the truth' — the sections exist under 'add section' but are absent from the template, and the customised layout turns out to live on a different product template than the one he first opened.

**Fit here (7/10):** Concrete, cheap verification step for the one person who has to catch every defect themselves — no reviewer, no QA, no agency. A product page that silently rendered without its sections would quietly kill the Shopify conversion rate with the CRO gate wide open.

*Source: Brendan Gillen — "Designing Shopify Themes Has Changed Forever (Tutorial)" (vqAzmtwekmw)*

## Before publishing, preview the draft theme in a browser as a shopper would see it and walk the whole purchase path page by page — add to cart, quantity selector, variant/scent switcher, one-time vs subscribe toggle, email signup — treating anything untested as broken.

**Why it works:** The theme editor renders a page but does not exercise it; interaction defects (a variant selector that stacks instead of switching, a quantity control that does nothing) only surface when a real user clicks them, and each one silently destroys orders on a page that otherwise looks fine.

**Evidence offered:** Demonstration: he previews as a shopper, finds the two-bottle selector behaving oddly, checks the subscription toggle and email signup, and finds a missing image — all defects invisible from the admin view.

**Fit here (7/10):** Highly relevant: 12 SKUs with scent variants and a repeat-purchase business that wants subscription/refill cadence means the variant selector and the subscribe toggle are load-bearing revenue controls, and the CRO gate is open. One person can run this checklist in an afternoon at ~54 orders/month with no extra spend.

*Source: Brendan Gillen — "Designing Shopify Themes Has Changed Forever (Tutorial)" (vqAzmtwekmw)*

## Use the most capable available model at high effort for the initial full theme build sweep, then drop to a cheaper/faster model for small fixes.

**Why it works:** The first sweep sets the architecture the whole theme inherits; a weaker model produces structural mistakes that every later correction prompt has to work around, so the compute is cheapest to spend at the start.

**Evidence offered:** Assertion only — he selects 'Fable', effort high, saying it is 'the most advanced model right now' and that he wants it 'for the first sweep'.

**Fit here (5/10):** Runnable today and costless in dollars for a solo operator, but it is a thin tooling preference rather than a marketing lever, and the named model is fast-decaying platform detail — the durable part is 'best model on the first structural pass, cheaper model on small fixes'.

*Source: Brendan Gillen — "Designing Shopify Themes Has Changed Forever (Tutorial)" (vqAzmtwekmw)*
