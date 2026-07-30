---
name: marketing-email-design-production
description: Use when you have to actually build the email asset rather than decide what it says — assembling a persisted brand kit / design system (logo, colors, fonts, written voice, layout exemplars), briefing an AI design tool, laying out preheader/hero/CTA structure, and getting a finished design into Klaviyo or another ESP for campaigns and post-purchase flows.
---

# Email Design Production

## Assemble the brand kit once as a persisted design system — logo files with transparent background, primary/secondary brand colors, fonts split by headline/body/CTA, an explicit written brand voice, brand story copy, transparent product images, and layout exemplars (a Figma export of designs you like, or competitor reference emails) — and have every later email generation inherit it rather than re-briefing a fresh project each time.

**Why it works:** The generator has no defaults that match your brand, so quality is bounded by the specificity of the inputs. Encoding brand constraints once removes the per-email design decisions; storing them as a durable object rather than re-supplying them per project means each new email starts from full brand context, so quality is repeatable instead of dependent on how good that day's prompt was.

**Evidence offered:** One creator demonstrated a single email produced in one prompt with no edits (practitioner assertion plus a viral LinkedIn giveaway). A second creator showed a side-by-side: the one-off project produced a rough starting point, while the persisted design system produced what he calls 'the perfect email' he could copy straight into his ESP in roughly ten minutes. No open, click, or revenue data on the emails themselves.

**Fit here (6/10):** Platform-mechanics class but published weeks after Claude Design's launch, so no staleness penalty applies. Email is the one owned retention surface and retention is the binding constraint, so removing the design bottleneck for a solo operator with no designer has real leverage at near-zero cost. Capped at 6 because the best inputs in both demos — '10 best past-performing emails filtered by all-time campaign revenue' and a Figma export of previously approved layouts 'the owner likes' — presume a campaign history and a design archive that don't exist here; only the brand-kit half (logo, colors, fonts, voice doc, brand story, transparent product shots) is fully usable, it must be written from scratch rather than mined from past sends, and the layout exemplars must be substituted with competitor reference emails. Also a production-speed lever, not a revenue lever.

*Source: Jordan O'Connor — "how to design klaviyo emails with claude design (full playbook)" (JTwdMs_rqxA)*
*Source: Jayde Emails — "Build Million Dollar Emails With Claude Design In Minutes" (wo6-XJY1tZ0)*

## Deliberately keep the initial brief vague so the tool asks clarifying questions — audience, offer type, tone, module list, length, number of variations — then answer those questions instead of trying to write a complete brief up front.

**Why it works:** The tool's question set surfaces decisions you would otherwise omit — who the email is for, whether it is a launch or a subscribe-and-save push, which modules to include — so answering prompts produces a more complete spec than a monologue brief, with less writing effort.

**Evidence offered:** Demonstrated live: a one-line brief plus a website screenshot, roughly eight clarifying questions answered, and the tool 'spat out everything without me needing to give any edits.' Single demonstration, no comparison against a full brief.

**Fit here (6/10):** Mostly durable-principle class (a briefing habit, not a UI feature), so age is not the limiter. Free, solo-executable, and it lands on the live email surface that carries the 18–22.5% repeat rate. Its real value here is that the question list doubles as a checklist — 'which audience, which single ask, which modules' — for a solo operator who has no strategist to force those decisions. Capped at 6 because it is a workflow habit rather than a revenue mechanism, and the decisions it surfaces (one ask per email, which awareness level) are already owned by other skills.

*Source: Jayde Emails — "Build Million Dollar Emails With Claude Design In Minutes" (wo6-XJY1tZ0)*

## Don't download and upload product images — paste the product page or homepage URL and let the tool pull imagery and content from the page directly.

**Why it works:** The tool can read and extract assets from a live page, so the manual export-download-reupload loop is wasted labor.

**Evidence offered:** Creator says he was 'blown away' that this worked; single demonstration, no comparison.

**Fit here (7/10):** Platform-mechanics class, but the video is essentially contemporaneous with the feature so age is not a problem. This is the single cheapest time saver in the video for a solo operator with 12 SKUs and no designer: every Shopify PDP already carries product photography, so building a post-purchase or campaign email becomes a URL paste rather than an asset hunt. Zero cost, no traffic or attribution required, and it sits on the live retention surface.

*Source: Jordan O'Connor — "how to design klaviyo emails with claude design (full playbook)" (JTwdMs_rqxA)*

## Because the generator sources its content from the page URL you give it, the product page must already contain the reviews, benefits, ingredients and FAQs you want in the email — a mediocre product page produces a mediocre email.

**Why it works:** Downstream assets inherit the quality of the source they are derived from; the email cannot contain a benefit, proof point, or objection answer that does not exist on the page it was built from.

**Evidence offered:** Assertion, stated as a rule ('if you have an okay landing page, your email is going to reflect that'); no data.

**Fit here (7/10):** Durable principle class — this is about content dependency, not a tool feature, so age is irrelevant. It gives the CRO stage of the gated sequence a second payoff: completing the PDP (results timeline, guarantee, review quotes, FAQ) does not just convert visitors, it becomes the source library every email and Amazon A+ block is generated from. Zero cost, solo-executable, no traffic assumption. Not higher because the specific PDP elements to add are already owned by the conversion-friction-audit and offer-construction skills; the additive claim here is the ordering — finish the page before generating anything derived from it.

*Source: Jordan O'Connor — "how to design klaviyo emails with claude design (full playbook)" (JTwdMs_rqxA)*

## Fix one email skeleton and reuse it: preheader, headline, hero image, primary CTA, body section, secondary CTA, footer with a third CTA.

**Why it works:** A predetermined structure removes layout decisions from every send and guarantees the elements that carry the click are always present in the same order, so quality does not depend on how inspired you were that day.

**Evidence offered:** Presented as the structure the creator's agency uses across many clients, illustrated by the demo email; no test data.

**Fit here (6/10):** Durable principle class (asset structure), so age is irrelevant. Useful for a solo operator who has to produce welcome, transition-period, and reorder emails without a designer — a fixed skeleton makes the post-purchase flow a fill-in exercise. Held at 6 because it is a campaign-promo skeleton: an education email that has to explain the natural-deodorant transition period will not fit hero-image-plus-three-CTAs cleanly, so it needs an education variant with a longer body block before it serves the retention constraint.

*Source: Jordan O'Connor — "how to design klaviyo emails with claude design (full playbook)" (JTwdMs_rqxA)*

## Pick the email's format from its job before applying any layout rule: designed and image-led for promotional campaigns, plain-text and link-light for education, onboarding and reorder nudges. Mobile-first always. One ask per objective, with at most two destinations.

**Why it works:** "Universal" email rules are really promo-campaign rules. Inbox providers classify heavily designed, link-dense, promotion-worded mail as promotional, so the same styling that helps a sale announcement stand out pushes an education email out of the primary tab — where a transition-period explanation has to land to do its job. Within a send, the ask is what converts, so the constraint that matters is one *objective*, not one *link*: a second link earns its place only when it serves a different reader stage (keep-reading vs buy-now) with a clear reason to pick one.

**Evidence offered:** Two practitioners in direct conflict. O'Connor's agency rules were "at least three CTAs, images doing most of the selling, exactly one offer or ask per email" — internally contradictory on link count, and asserted from agency practice with no figures. Hormozi reports the opposite for his own sends ("if we put more money stuff in an email it tends to get a higher percentage in the promo tab") and pushes back explicitly on one-link orthodoxy, also without controlled data. Neither ran a test; the reconciliation below is ours, not either source's.

**Fit here (7/10):** The split is what makes both usable. Real Skin Care's highest-value email work is a small set of post-purchase and reorder flows whose whole point is explaining the natural-deodorant transition period — exactly the content that dies as an image-led promo layout, and exactly where the 18–22.5% repeat rate is decided. Promo campaigns for a launch or a bundle still want the designed treatment. Raised above the original 6 because resolving the contradiction is worth more than either rule alone; not higher because link-level performance is unreadable at ~54 orders/month, so this is a default to build on, not a tested result.

*Sources: Jordan O'Connor — "how to design klaviyo emails with claude design (full playbook)" (JTwdMs_rqxA); Alex Hormozi — "Learn Email Marketing in 39 Minutes!" (pLhQOYMGa88)*

## When the first generated version is close, name one to three specific issues and fix them with the tool's direct edit function rather than re-prompting, because each new prompt burns usage and tokens.

**Why it works:** Regeneration is both costlier and non-deterministic — it can degrade parts that were already right — while a targeted manual edit changes only the defective element at no marginal token cost.

**Evidence offered:** Demonstrated live by editing text inside the tool; cost reasoning asserted, with a general warning that usage adds up at scale.

**Fit here (6/10):** Platform-mechanics class and freshly published, so no decay discount. Relevant because it is a cost-control rule for an operation running ~$2,700/mo total revenue where per-email tooling spend has to stay trivial, and because it protects a design that already passes muster from being regenerated worse. Scored 6 rather than higher because it is a workflow habit, not a revenue lever, and the specific edit affordance is exactly the kind of UI detail that changes within a year or two.

*Source: Jordan O'Connor — "how to design klaviyo emails with claude design (full playbook)" (JTwdMs_rqxA)*

## Don't use an AI design tool when you already have a simple templated weekly campaign process, when the brand is premium/luxury or you are precious about brand consistency, or when the email needs GIFs — it will cost more hassle than it saves.

**Why it works:** The tool's advantage is producing novel layouts fast; where the layout is already fixed or where exact asset fidelity matters, generation introduces variance and rework instead of removing work.

**Evidence offered:** Stated from experience, including that the tool can silently alter images and products; no examples.

**Fit here (6/10):** Durable principle class (tool-selection judgment), age irrelevant. Genuinely load-bearing here because Real Skin Care's highest-value email work is a small set of repeating post-purchase and reorder flows, which is precisely the templated case the creator says not to generate — so the honest read is: use generation once to build each flow template, then stop and reuse. It also flags the real risk that a generator alters product imagery, which matters when the same 12 SKUs must look identical across Shopify and Amazon.

*Source: Jordan O'Connor — "how to design klaviyo emails with claude design (full playbook)" (JTwdMs_rqxA)*

## Never ship an email with a defaulted preheader — write the preview text deliberately, pulling the most valuable or curiosity-inducing nugget forward.

**Why it works:** The preview line is the second thing a reader sees after the subject and functions like a video thumbnail: it either extends the subject's promise or wastes the slot. Left to the client default it renders whatever the email opens with — "Hey John," a view-in-browser link, an unsubscribe preamble — which spends the reader's only pre-open signal on filler.

**Evidence offered:** Claims a 24% increase on his own sends and cites reporting that one in four recipients read the preview before deciding to open; notes the edit takes ten seconds. No underlying data shown, and the 24% figure is unattributed.

**Fit here (8/10):** The highest-value item in its source video for this business and a genuine gap — the copy-angles skill mentions preview text only in passing under curiosity loops, and nothing owns the never-default rule. Free, one field, no traffic or attribution needed, and it applies to every campaign on the surface where retention is decided. **Cost caveat:** ten seconds is right for a *campaign*, but a Klaviyo flow's email content cannot be edited through the API (405/404) — retrofitting the live welcome, post-purchase and reorder flows means replacing each flow against a corrected library template, so budget that as flow rebuilds rather than a field edit.

*Source: Alex Hormozi — "Learn Email Marketing in 39 Minutes!" (pLhQOYMGa88)*

## Open with a self-contained payoff and close with a PS: reward the reader in the first glance for opening, and put the ask or a final reward in the postscript.

**Why it works:** Two ends of the same reading pattern. Attention is top-and-bottom heavy, so the opening line and the PS get disproportionate reads while the middle is skimmed. Front-loading something usable — a quote, a one-line insight, the answer itself — reinforces the act of opening, which is what makes the *next* send get opened; the PS then catches the skimmer who never read the body. Behaviour recurs because it was rewarded afterward, so a send that delivers nothing usable quietly costs future opens.

**Evidence offered:** Asserted as rules ("not having a PS statement is PS stupid"), demonstrated in teardowns of two of his own sends. No open-rate or click data.

**Fit here (7/10):** Durable reading-behaviour principle, age irrelevant, free. It also fits the content this catalog actually needs: the transition-period, storage and oral-care usage emails are naturally "one usable thing per send," and the PS is a concrete addition to the skeleton above, which ended at a footer CTA — not the same as an ask carried in body copy. Not higher because the effect surfaces as open rate on a small list, which is both noisy and, post-ATT, unreliable to read.

*Source: Alex Hormozi — "Learn Email Marketing in 39 Minutes!" (pLhQOYMGa88)*

## Bridge the CTA to what the reader just read — never paste a generic reusable ask across assets.

**Why it works:** The CTA is the part of the asset that does the converting, so a jarring topic switch at the ask is where the click is lost. A bridge sentence that follows from the content the reader just consumed makes the destination feel like the next step rather than an unrelated pitch.

**Evidence offered:** Assertion plus his own examples of matching each video's CTA to its audience, and a self-critique of an email that pitched a workshop after a testimonial lesson — though he notes that email "still did really well," so there is no clean comparison.

**Fit here (6/10):** Concretely: a transition-period education email bridges to the specific deodorant reorder or refill bundle, not a generic "shop all" — which matters because a page that earns attention with no matching buy path is the exact failure the Prime Directive calls a bug. Held at 6 because the skill already enforces one ask and its placement; the additive claim is narrower (the bridge sentence and the destination must follow the email's subject matter), and nothing here is measurable at ~54 orders/month.

*Source: Alex Hormozi — "Learn Email Marketing in 39 Minutes!" (pLhQOYMGa88)*
