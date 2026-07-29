# Build Million Dollar Emails With Claude Design In Minutes

**Creator:** Jayde Emails  
**Video:** https://www.youtube.com/watch?v=wo6-XJY1tZ0  
**Published:** 2026-05-07  
**Inferred era cues:** Published 2026-05-07; "over the last two weeks we've had the biggest AI updates in terms of design ever"; Claude Design with high-fidelity mode, design systems, and Figma file import; Brandfetch; Milled email archive; ChatGPT in-chat image generation with aspect-ratio presets; explicit "in 2026, you no longer need a design team"  

A head-to-head tool test of Claude Design versus ChatGPT image generation for producing e-commerce marketing emails, rated on speed, output quality, and repeatability. The creator demonstrates two Claude paths — a one-off design project (screenshot the brand's site, upload three or four reference emails pulled from Milled, answer the tool's clarifying questions) and a persisted "design system" (Figma export, Brandfetch-sourced logos/fonts/colors, brand story text, transparent product images, plus the agency's own high-converting email formula) — concluding the persisted system produces a near-shippable email in about ten minutes. ChatGPT is faster and produces better hero imagery but is harder to edit region-by-region. Closes with an agency pitch gated at $50k/mo revenue and the argument that AI shifts teams from production to strategy.

Found 10 tactics: 3 adopted, 7 rejected.

## Adopted

### Instead of briefing a fresh project each time, create a persisted 'design system' containing logos, fonts, colors, brand story copy, transparent product images, and an exported Figma file of layouts you like, so every subsequent email generation inherits it. — 6/10

**Why it works:** Output quality is bounded by context. Storing the brand constraints and layout exemplars once as a durable object means each new email starts from full brand context rather than re-supplying it, so quality is repeatable instead of dependent on how good that day's prompt was.

**Evidence:** Side-by-side demonstration: the one-off project produced a rough starting point, the persisted design system produced what the creator calls 'the perfect email' he could copy straight into his ESP in roughly ten minutes. Practitioner assertion, no open/click/revenue data.

**Fit:** Platform-mechanics class, but the video is contemporaneous with the feature so no staleness discount applies. Email is the only owned retention surface and retention is the binding constraint, so a solo operator with no designer gets real leverage from making brand context reusable at near-zero cost. Additive over the existing brand-kit tactic only in the persistence mechanic (store once as a system, not per-email). Capped at 6 because the demo's best inputs — a Figma export of previously approved designs and a library of layouts 'the owner likes' — do not exist here and must be substituted with competitor reference emails, and because this is a production-speed lever, not a revenue lever.

**Target skill:** `marketing-email-design-production` (edit)

### Deliberately keep the initial design brief vague so the tool asks clarifying questions (audience, offer type, tone, module list, length, number of variations), then answer those questions instead of trying to write a complete brief up front. — 6/10

**Why it works:** The tool's question set surfaces decisions you would otherwise omit — who the email is for, whether it is a launch or a subscribe-and-save push, which modules to include — so answering prompts produces a more complete spec than a monologue brief, with less writing effort.

**Evidence:** Demonstrated live: he gave a one-line brief plus a website screenshot, answered roughly eight clarifying questions, and the tool 'spat out everything without me needing to give any edits.' Single demonstration, no comparison against a full brief.

**Fit:** Mostly durable-principle class (a briefing habit, not a UI feature), so age is not the limiter. Free, solo-executable, and it lands on the live email surface that carries the 18–22.5% repeat rate. Its real value here is that the question list doubles as a checklist — 'which audience, which single ask, which modules' — for a solo operator who has no strategist to force those decisions. Capped at 6 because it is a workflow habit rather than a revenue mechanism, and the decisions it surfaces (one ask per email, which awareness level) are already owned by other skills.

**Target skill:** `marketing-email-design-production` (edit)

### Pull three or four reference emails from a public email archive (Milled) for brands whose design you admire and hand them to the generator as explicit inspiration rather than describing the look in words. — 6/10

**Why it works:** An archive lets you search any brand's actual sends on demand, so you can assemble concrete exemplars in minutes instead of waiting for competitor emails to arrive in your inbox; explicit visual targets give the generator something to imitate rather than a generic average.

**Evidence:** Demonstrated live pulling Liquid IV and Ring Pop sends off Milled and uploading them as inspo; he shows the ungrounded output first, then the grounded one, and asserts the grounded version is better. No performance data.

**Fit:** Durable principle class (competitive reference gathering); the named archive is a small platform dependency but the practice survives it. Free and solo-executable, and it fixes the practical weakness in the existing email-channel gap analysis, which requires subscribing and then waiting for sends — an archive gives instant access to Native, Dr. Squatch, Every Man Jack and Harry's reorder, education, and win-back emails, which is exactly where the binding retention constraint lives. Held at 6 because it is an access-method refinement to an already-adopted practice, and copying a well-funded brand's visual polish does not by itself move revenue — the angle and flow-format gaps are what matter.

**Target skill:** `marketing-competitor-messaging-teardown` (edit)

## Rejected

### Split the work across tools — generate the hero visual in ChatGPT because its image quality is highest, then upload it into Claude as the asset and do layout and editing there. — 4/10

**Rejected because:** Fast-decaying tool-comparison claim with no revenue mechanism, and AI-generated hero imagery of real physical SKUs risks product misrepresentation across Shopify and Amazon.

**Fit reasoning:** Fast-decaying platform-mechanics class — a claim about the relative image quality of two specific model releases, which is precisely the kind of statement that will be false within a year. Also carries a real hazard here: Real Skin Care sells 12 physical SKUs that must look identical across Shopify and Amazon, and an AI-generated hero visual of a deodorant stick is a misrepresentation risk the existing skill already warns about. No revenue mechanism attached — it is a production-speed preference.

### Use the tool's region-select or click-to-edit function to change a headline, color, or block rather than re-prompting the whole design. — 3/10

**Rejected because:** Duplicates an existing tactic in marketing-email-design-production; re-adding it degrades skill selection accuracy without new information.

**Fit reasoning:** Durable-ish workflow habit and genuinely cheap, but marketing-email-design-production already carries this exact tactic ('name one to three specific issues and fix them with the tool's direct edit function rather than re-prompting'). Adding it again would degrade skill triggering without adding a mechanism.

### Screenshot the brand's entire website (and its story/about page) and upload it so the tool can extract branding, colors, and voice. — 3/10

**Rejected because:** Restates the brand-kit assembly and paste-the-URL tactics already in marketing-email-design-production, and the URL method is the better version of the same idea.

**Fit reasoning:** Durable principle class, so age is not the issue — the problem is duplication. marketing-email-design-production already covers both halves: assembling logo/color/font/voice inputs, and pasting the product or home page URL so the tool pulls imagery and content directly (which is strictly less manual than screenshotting). No additive mechanism for a solo operator.

### Write out your own high-converting email formula (hero visual, headline, primary CTA, ingredient/benefit infographic, secondary CTA) and give it to the generator so every output follows a proven conversion structure. — 3/10

**Rejected because:** Duplicates the fixed email skeleton and universal-rules tactics already in marketing-email-design-production; the storage-location wrinkle is covered by the design-system tactic adopted above.

**Fit reasoning:** Durable principle class, and the idea is sound — but marketing-email-design-production already carries a fixed email skeleton (preheader, headline, hero, primary CTA, body, secondary CTA, footer CTA) plus the universal-rules checklist. The only new wrinkle is storing the skeleton inside the persisted design system, which is already captured in the design-system tactic above.

### A beautifully designed email is worthless if it targets the wrong people, so strategy and human interpretation still gate the output. — 1/10

**Rejected because:** Motivational framing with no stated mechanism; the actionable form of the idea is already covered by marketing-awareness-level-messaging.

**Fit reasoning:** True but purely motivational framing with no stated mechanism — it names no segment, no targeting method, and nothing testable. The actionable version (match the message to the reader's awareness level, segment repeat buyers separately) is already owned by marketing-awareness-level-messaging.

### Use the AI output as a foundation to hand to your design team so they don't have to ideate from scratch. — 0/10

**Rejected because:** Requires a design team to hand the draft to; Real Skin Care is a solo operator with no designer.

**Fit reasoning:** Presupposes a design team. Real Skin Care is a solo operator with no team, no agency, and no designer — the entire premise of the tactic is absent.

### AI production capability shifts the value of an agency from making assets to building systems and pulling cross-brand performance data, so brands doing over $50k/mo should hire one to own the strategy layer. — 0/10

**Rejected because:** Requires hiring an agency and is explicitly gated at $50k/mo revenue; Real Skin Care runs ~$2,700/mo solo.

**Fit reasoning:** Requires an agency, and is explicitly gated at $50k/mo — roughly 18x Real Skin Care's ~$2,700/mo combined revenue. It is also a sales pitch rather than a testable mechanism.

## Skills touched

- `marketing-email-design-production` (edit)
- `marketing-competitor-messaging-teardown` (edit)
