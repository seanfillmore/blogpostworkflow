# how to design klaviyo emails with claude design (full playbook)

**Creator:** Jordan O'Connor  
**Video:** https://www.youtube.com/watch?v=JTwdMs_rqxA  
**Published:** 2026-05-06  
**Inferred era cues:** Claude Design described as launched April 2026; video published May 2026; references Klaviyo, Figma, Canva, ChatGPT, Lovable, LinkedIn virality, and token/usage-based cost — all current-era platform mechanics with essentially no decay yet.  

A walkthrough of the creator's viral playbook for producing e-commerce email designs with Claude Design (Anthropic's design tool, launched April 2026) and shipping them into Klaviyo in roughly 14 minutes. It covers what to upload as a brand kit (past top-performing emails, reference emails from admired brands, logo, colors, fonts, brand voice), a hack where pasting a product URL lets the tool pull images and content instead of manually uploading assets, a fixed email skeleton (preheader, headline, hero, primary CTA, body, secondary CTA, footer CTA), a set of 'universal rules' (three-plus CTAs, image-led selling, minimal copy, mobile-first, one offer per email), a six-step brief-generate-refine-export workflow, three export paths (Claude→Figma→Klaviyo, Claude→Canva→Klaviyo, Claude→Klaviyo directly via HTML or screenshot), and cases where AI design is the wrong tool. Ends in a pitch for the creator's agency installing an 'AI system' in three weeks.

Found 12 tactics: 8 adopted, 4 rejected.

## Adopted

### Don't download and upload product images — paste the product page or homepage URL and let the tool pull imagery and content from the page directly. — 7/10

**Why it works:** The tool can read and extract assets from a live page, so the manual export-download-reupload loop is wasted labor.

**Evidence:** Creator says he was 'blown away' that this worked; single demonstration, no comparison.

**Fit:** Platform-mechanics class, but the video is essentially contemporaneous with the feature so age is not a problem. This is the single cheapest time saver in the video for a solo operator with 12 SKUs and no designer: every Shopify PDP already carries product photography, so building a post-purchase or campaign email becomes a URL paste rather than an asset hunt. Zero cost, no traffic or attribution required, and it sits on the live retention surface.

**Target skill:** `marketing-email-design-production` (edit)

### Because the generator sources its content from the page URL you give it, the product page must already contain the reviews, benefits, ingredients and FAQs you want in the email — a mediocre product page produces a mediocre email. — 7/10

**Why it works:** Downstream assets inherit the quality of the source they are derived from; the email cannot contain a benefit, proof point, or objection answer that does not exist on the page it was built from.

**Evidence:** Assertion, stated as a rule ('if you have an okay landing page, your email is going to reflect that'); no data.

**Fit:** Durable principle class — this is about content dependency, not a tool feature, so age is irrelevant. It gives the CRO stage of the gated sequence a second payoff: completing the PDP (results timeline, guarantee, review quotes, FAQ) does not just convert visitors, it becomes the source library every email and Amazon A+ block is generated from. Zero cost, solo-executable, no traffic assumption. Not higher because the specific PDP elements to add are already owned by the conversion-friction-audit and offer-construction skills; the additive claim here is the ordering — finish the page before generating anything derived from it.

**Target skill:** `marketing-email-design-production` (edit)

### Assemble a reusable brand kit — logo files with transparent background, primary/secondary brand colors, fonts split by headline/body/CTA, an explicit written brand voice, plus your 10 best past-performing emails — and hand it to the AI design tool before asking for any email. — 6/10

**Why it works:** The generator has no defaults that match your brand, so quality is bounded by the specificity of the inputs; encoding brand constraints once makes every later generation consistent and removes the per-email design decisions.

**Evidence:** Demonstrated with one email the creator says was produced in a single prompt with no edits; practitioner assertion plus a viral LinkedIn giveaway. No performance data on the emails themselves.

**Fit:** Platform-mechanics class but published weeks after Claude Design's launch, so no staleness penalty applies. Email is the one owned retention surface and retention is the binding constraint, so removing the design bottleneck for a solo operator with no designer has real leverage at near-zero cost. Capped at 6 because half the input list — '10 best past-performing emails filtered by all-time campaign revenue' — presumes a campaign history and list size that don't exist here; only the brand-kit half (logo, colors, fonts, voice doc) is fully usable, and it must be written from scratch rather than mined from past sends.

**Target skill:** `marketing-email-design-production` (create)

### Fix one email skeleton and reuse it: preheader, headline, hero image, primary CTA, body section, secondary CTA, footer with a third CTA. — 6/10

**Why it works:** A predetermined structure removes layout decisions from every send and guarantees the elements that carry the click are always present in the same order, so quality does not depend on how inspired you were that day.

**Evidence:** Presented as the structure the creator's agency uses across many clients, illustrated by the demo email; no test data.

**Fit:** Durable principle class (asset structure), so age is irrelevant. Useful for a solo operator who has to produce welcome, transition-period, and reorder emails without a designer — a fixed skeleton makes the post-purchase flow a fill-in exercise. Held at 6 because it is a campaign-promo skeleton: an education email that has to explain the natural-deodorant transition period will not fit hero-image-plus-three-CTAs cleanly, so it needs an education variant with a longer body block before it serves the retention constraint.

**Target skill:** `marketing-email-design-production` (edit)

### Codify universal rules that apply to every email regardless of campaign: at least three CTAs, images doing most of the selling, short copy instead of paragraphs, mobile-first layout, and exactly one offer or ask per email. — 6/10

**Why it works:** Rules that hold across all sends are where the ROI comes from rather than the individual design — three CTAs catch readers at different scroll depths, mobile-first matches where the email is actually opened, and a single ask prevents the click from being split across competing destinations.

**Evidence:** Practitioner assertion from agency practice; no open, click, or revenue figures given.

**Fit:** Mostly durable-principle class (one ask per asset, mobile-first, scroll-depth CTAs), so age is not the limiter. Free, solo-executable, and it applies to the live email surface that carries the 18–22.5% repeat rate. Capped at 6 for two reasons: the 'one offer per email' rule restates the one-job-per-asset rule already in marketing-product-image-stack, and 'let images do the selling / less copy' pulls directly against the post-purchase education emails that actually attack churn here, where the explanation of the transition period is the point. Adopt as a checklist with the education-email exception written in.

**Target skill:** `marketing-email-design-production` (edit)

### When the first generated version is close, name one to three specific issues and fix them with the tool's direct edit function rather than re-prompting, because each new prompt burns usage and tokens. — 6/10

**Why it works:** Regeneration is both costlier and non-deterministic — it can degrade parts that were already right — while a targeted manual edit changes only the defective element at no marginal token cost.

**Evidence:** Demonstrated live by editing text inside the tool; cost reasoning asserted, with a general warning that usage adds up at scale.

**Fit:** Platform-mechanics class and freshly published, so no decay discount. Relevant because it is a cost-control rule for an operation running ~$2,700/mo total revenue where per-email tooling spend has to stay trivial, and because it protects a design that already passes muster from being regenerated worse. Scored 6 rather than higher because it is a workflow habit, not a revenue lever, and the specific edit affordance is exactly the kind of UI detail that changes within a year or two.

**Target skill:** `marketing-email-design-production` (edit)

### Don't use an AI design tool when you already have a simple templated weekly campaign process, when the brand is premium/luxury or you are precious about brand consistency, or when the email needs GIFs — it will cost more hassle than it saves. — 6/10

**Why it works:** The tool's advantage is producing novel layouts fast; where the layout is already fixed or where exact asset fidelity matters, generation introduces variance and rework instead of removing work.

**Evidence:** Stated from experience, including that the tool can silently alter images and products; no examples.

**Fit:** Durable principle class (tool-selection judgment), age irrelevant. Genuinely load-bearing here because Real Skin Care's highest-value email work is a small set of repeating post-purchase and reorder flows, which is precisely the templated case the creator says not to generate — so the honest read is: use generation once to build each flow template, then stop and reuse. It also flags the real risk that a generator alters product imagery, which matters when the same 12 SKUs must look identical across Shopify and Amazon.

**Target skill:** `marketing-email-design-production` (edit)

### Collect five to ten emails from brands you admire and feed them in as design and tone reference, especially if you are unhappy with your own current look. — 6/10

**Why it works:** Explicit exemplars give the generator a concrete target to imitate rather than a generic average, and they surface the structural and tonal choices a category leader has already validated.

**Evidence:** Assertion, offered as an optional step; no data.

**Fit:** Durable principle class — competitive reference gathering, not a tool feature. Free and solo-executable: subscribing to Native, Every Man Jack, Dr. Squatch and Harry's lists costs nothing and reveals their retention and reorder messaging, which is the surface where Real Skin Care's binding constraint lives. Scored 6 because it is a close cousin of the ad-library gap analysis already covered, so it belongs as an email-channel extension of that skill rather than a new one, and imitating a well-funded brand's design does not itself move revenue.

**Target skill:** `marketing-competitor-messaging-teardown` (edit)

## Rejected

### The fastest export path is to zoom in, screenshot the generated design, and upload it into Klaviyo as an image email — the creator's agency ships roughly 99% image-based emails. — 4/10

**Rejected because:** Optimizes production speed at the cost of deliverability and click attribution on the single owned retention surface, and the agency-scale conditions that make all-image sends safe (warm domain, high volume, measurable open/click baselines) do not exist at ~54 orders/month.

**Fit reasoning:** Platform-mechanics class and recent, so age is not the objection — the objection is fit. Retention is the binding constraint and email is the only owned retention channel, so trading inbox placement for production speed is the wrong trade for a small, low-volume sender: an all-image email has no live text fallback for blocked images or dark mode, no per-element click data, and a poor image-to-text ratio for spam filtering. An agency with thousands of daily sends and warmed domains can absorb that; a solo operator sending to a small list cannot diagnose the resulting drop.

### Once the brand kit exists you can batch-produce an entire month's email calendar in a couple of hours. — 3/10

**Rejected because:** Duplicates the reuse benefit already contained in the brand-kit tactic, and assumes campaign volume to a list is the lever when retention flows, not campaign cadence, are the binding constraint.

**Fit reasoning:** Durable-principle framing but it is just the reuse implication of the brand-kit tactic already adopted, so promoting it separately duplicates coverage and degrades triggering. It also mis-targets the constraint: volume of promotional campaigns to a small list is not the lever here, whereas a handful of correctly built post-purchase and reorder flows is, and those are covered by marketing-post-purchase-onboarding.

### Spend most of your effort on the brief, because poor input produces poor output. — 2/10

**Rejected because:** Motivational restatement with no concrete mechanism, and duplicates the brand-kit and source-page tactics that do specify what goes into the brief.

**Fit reasoning:** Framing with no stated mechanism beyond a truism — it names no artifact, no checklist, and nothing testable. Whatever is actionable in it is already carried by the brand-kit and complete-product-page tactics above.

### Have an agency install a done-for-you AI email system and all your flows in three weeks. — 0/10

**Rejected because:** Requires hiring an agency; no team or budget exists for it.

**Fit reasoning:** Requires an agency engagement, which is an explicit rejection criterion for a solo operator at ~$2,700/mo combined revenue.

## Skills touched

- `marketing-email-design-production` (create)
- `marketing-competitor-messaging-teardown` (edit)
