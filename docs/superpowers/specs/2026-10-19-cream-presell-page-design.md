# Coconut Moisturizer pre-sell page: design

Date: 2026-10-19. Owner: Sean. Status: draft for approval (decisions from Sean folded in 2026-10-19).

## Why

Meta ads for the Coconut Moisturizer (Coconut Breeze body cream, 4oz, $28, handle `coconut-moisturizer`) send cold traffic straight to the product page, and it does not convert. Shopify's funnel for that traffic: **569 sessions, 5 added to cart, 5 reached checkout, 5 ordered (0.87%)**. Everyone who adds to cart buys, so checkout is not the problem. The leak is the first screen: strangers land and leave without trying to buy.

The ads all make one promise. The best performer (Everitt Moder, Trybe, ad `d2a32715`: $320 spent, 12 add-to-carts, 5 orders) says **"7 Simple Ingredients vs 20+ in most lotions"** over a Coconut Breeze jar. The product page does not pay that off:

1. "7 ingredients" never appears above the fold, and further down the page says "Three ingredients, three jobs," which reads as a contradiction.
2. The ad links to the Coconut Breeze variant (`variant=44179428475050`) but the page opens with **Pure Unscented** selected.
3. The preselected pack is **4 jars at $84**, so the first button a stranger sees asks for $84 for a product they have never tried.

The creative test campaign (`120249631730870173`) is paused: $522 spent, 8 orders, $65 per order, over the $60 stop rule. This page is meant to be in place before it relaunches.

## What we are building

Two things, in this order of priority:

**A. A pre-sell page** between the ad and the purchase, in listicle form (Sean chose this over a label-comparison page and a founder letter): *"5 reasons people are switching to a 7-ingredient body cream this winter."* It carries the ad's promise forward and ends on a single $28 jar.

**B. Product page fixes** on `product.landing-page-cream`: open on the scent the link asks for, and preselect 1 jar instead of 4.

## Goals

- Raise ad-click to order conversion for moisturizer traffic above the current 0.87% baseline.
- First screen on a phone restates the ad: 7 ingredients vs 20+, Coconut Breeze, real creator photo.
- The ask is easy: 1 jar, $28, Coconut Breeze preselected (Sean: "Default to the $28 jar and we can look at upsells to bring the AOV up").

## Non-goals

- Raising AOV on this page. Upsells come later; One Click Upsell already runs post-purchase.
- Pre-sell pages for other products.
- Relaunching or restructuring the Meta campaign (see "Handoff" below).
- SEO. This page is for paid traffic; it should be `noindex` and stay out of the sitemap so it does not compete with the product page or collections.

## Anti-goals (would make this a failure even if it works)

- Any health or drug claim on a page with a buy button (commercial surface): no condition named beside the product, no heal/cure/treat/repair. Run all copy through `checkSeoCopyFields` from `lib/seo-copy-health-gate.js` on the default commercial surface.
- An invented quote, review or creator statement. Reviews are verified Judge.me reviews quoted word for word; creators appear through their own photos, not words put in their mouths.
- A page that looks like independent editorial or news. It is clearly Real Skin Care's page.
- Naming a competitor brand.
- Naming petroleum ingredients (mineral oil, petrolatum) anywhere, even negated.
- Em dashes in customer-facing copy.
- Built in Replo or any page builder (Replo is retired). Do not reuse the old Replo drafts `5-reasons-health-conscious-people` or `sales-page-v1`.

## The page

Built as theme code: a new section plus a new page template (e.g. `templates/page.presell-cream.json` + `sections/presell-listicle.liquid`), assigned to a new Shopify page (handle suggestion: `coconut-body-cream`). Mobile-first; nearly all traffic is Meta on a phone. Header kept minimal (logo, no mega menu distractions); the announcement bar can stay.

### First screen (phone, above the fold)

- Eyebrow: "Winter skin" (or similar).
- Headline: "5 reasons people are switching to a body cream with a 7-ingredient base this winter" (wording per the ingredient ruling below).
- A Trybe creator photo of the cream in use. Real Skin Care has the rights to use these images on its own site (Sean, 2026-10-19).
- Star rating line from real review data (the product shows 27 reviews; use the live count).
- Reason #1 starts on this screen.

### The five reasons

Each reason: a short bold line, two or three sentences, and an image (creator photo or product/texture shot). Copy below is direction, not final.

1. **You can read the whole label.** The 7-ingredient base listed in full, next to a real drugstore lotion label with 20+ ingredients. Base ingredients come from `config/ingredients.json` → `cream.base_ingredients`: purified spring water, organic virgin coconut oil, organic plant-based emulsifying wax, organic palm stearic, organic grapefruit seed extract, organic beeswax, organic red palm oil.
   - **Ingredient wording (Sean, 2026-10-19):** "7 ingredient cream base with the addition of essential oils for scented variations." So the page says **"7-ingredient base"** everywhere, never "a 7-ingredient cream" flat, and states that scented versions add their scent on top (Pure Unscented is the base alone). The headline becomes e.g. "5 reasons people are switching to a body cream with a 7-ingredient base." *(My call for accuracy:* `config/ingredients.json` lists Coconut Breeze's addition as "organic coconut oil extract", not an essential oil, so the page's scent line must read true for Coconut Breeze, e.g. "plus a natural scent from essential oils or coconut extract", and the Coconut Breeze buy box can show its full list.)
   - **The comparison label (Sean, 2026-10-19):** Palmer's coconut lotion (Palmer's Coconut Oil Formula body lotion), "one we have used before." Copy its full ingredient list word for word from the current label on the manufacturer's site or packaging, and record the source URL and date in the PR so the claim can be re-checked. *(My call:* the brand name stays off the page, shown as "a popular drugstore coconut lotion", per the no-competitor-names rule; the ingredient count shown must be the real count from that label.)
2. **It's thick enough for heels, hands and elbows.** Goes on like butter, works in, no slick film. A verified review here (e.g. Nicole H.: "This is THE moisturizer for Wisconsin winters for my whole family...").
3. **A little goes a long way.** About a month of nightly use per jar, under $1 a day (the claim the product page already makes).
4. **The scent is natural, not added fragrance.** Light coconut scent from coconut extract (other scents from essential oils); no synthetic fragrance, no parabens. Must not claim the scent comes from the base oil alone.
5. **Try it for 30 days.** If you don't like it, email us and we refund you; you don't have to send it back (the real policy).

Between reasons 3 and 4, or after 5: a short block of 2-3 verified reviews.

Optional, builder's judgement: the two honest notes from the product page ("beeswax firms in the cold, warm it between your fingers"; "real coconut oil can separate a little"). They build trust and pre-empt a return.

### The buy box

- At the bottom of the page, plus a sticky "Get Coconut Breeze, $28" button on phones that scrolls to it (or buys directly).
- Product image, name, $28, the 30-day guarantee line, "Ships in 1-2 business days."
- Scent picker with **Coconut Breeze preselected**; the other four scents available.
- Quantity fixed at 1. No pack ladder, no subscription widget (Recurpay must not inject one; see how `product.landing-page-cream` suppresses it).
- The button skips the cart page: it adds the jar with `/cart/add.js` (the storefront add-to-cart call) and then sends the shopper to `/checkout`. Rationale: store-wide, ~71% of carts never start checkout, and this traffic needs no cart page. **Not a bare `/cart/<variant>:1` permalink** *(builder check, my call)*: the theme has no `fbq` of its own, so the Meta pixel runs through Shopify's Facebook & Instagram app, which fires AddToCart on a storefront cart add. A permalink skips that event, and `ad-test-monitor` pauses any creative that spends ~one average order with no add-to-cart, so every pre-sell creative could be killed early. Verify AddToCart arrives in Meta before ads point here.

## Product page fixes (`product.landing-page-cream`)

1. **Default pack**: the ladder's `ladder_default` is `coconut-moisturizer-4-pack`. Change it to `coconut-moisturizer` (1 jar) for this template only. Other products' ladders are out of scope.
2. **Scent from the link**: when the URL carries `?variant=<id>` of the 1-jar product, the scent picker must open on that scent (today it shows Pure Unscented for a Coconut Breeze link). The quantity ladder builds its own scent dropdown and ignores `?variant`, so this is a fix in the ladder's script, matched by scent name against how the 4-pack names its variants. Verify the 4-jar option, if a shopper switches to it, carries the same scent across.
3. Leave the "Three ingredients, three jobs" section for now unless the builder finds a non-contradicting rename that is trivial; flag it rather than rewrite the page.

## Measurement

- Ad-test attribution counts Shopify orders whose `landing_site` carries the test tag (`trybe=` or the campaign `utm_campaign`). The pre-sell page will be the landing page, so ads pointing at it must carry the same tags, and nothing may strip them. `config/ad-tests.json` landing tags must still match.
- Meta pixel: the page must fire `PageView` and, on the buy button, `AddToCart` (and checkout fires `InitiateCheckout`/`Purchase` as today), so the campaign can optimize and `ad-test-monitor`'s add-to-cart graduation rule still works.
- Success read: session → order rate for traffic landing on the pre-sell page vs the 0.87% product-page baseline, judged after a meaningful sample (the existing graduation rule uses $150 spend per creative).

## Constraints

- Theme changes are not auto-deployed; `git pull` on the server does not change the live theme. Push to the live theme (`148782940330`) deliberately and verify the rendered page. Keep `\/` escaping in theme JSON.
- Work in a branch and PR (worktree `feature/cream-presell-page`).
- Test on a real phone viewport before pointing ads at it.

## Handoff (not part of this build)

Repointing the moisturizer ads to the new page and relaunching the campaign is a separate step, Sean's call, done in the Monday creative batch per the campaign's cadence.

## Creator videos (Sean, 2026-10-19: "use videos as well as statics")

The page uses 2-3 approved Trybe videos of the Coconut Moisturizer alongside the statics, each placed beside the reason it matches. Sean has the rights to use Trybe creator content on the site. Candidates (approved submissions, `products` = Coconut Moisturizer | 4oz):

- **Rebecca West**, "When was the last time you turned your body cream around and read the label?..." → reason #1.
- **Kaitlynn Eliason**, "Ever wonder what butter feels like on your skin?..." → reason #2 (also running in ads).
- **Kristin Crane**, "I just shaved... my legs are as dry as the Sahara Desert..." → reason #2 or #3 (real dry-skin moment).
- **Marianne Dike** (four videos, "keep it simple" angle) → alternate.
- **Exclude Marvin Aboagye**'s video: it says the cream has "6 ingredients", which is the lotion's count.

Rules:
- Every clip's transcript (Trybe `transcript.text`) passes `checkSeoCopyFields` on the commercial surface before it goes on the page, and its on-screen product must be the cream jar (flip-top jar, not a pump).
- Muted, looping, autoplay, `playsinline`, with burned-in or overlaid captions so it works on mute; a poster frame; tap to unmute is optional.
- Lazy-loaded (only fetched near the viewport) and hosted in Shopify Files. **No video above the fold**: the first screen keeps a still so the page loads fast on a phone.
- Keep each file small (compressed, short); check the page on a throttled mobile connection.

## Images *(my call)*

Sean has the rights to Trybe creator images. Prefer, in order: the creatives already approved and run in the moisturizer ads (they show the Coconut Breeze jar), then approved Trybe submissions for `coconut-moisturizer` that the visual review marks LOOKS READY, then the PDP's real in-use photo (`cream-in-use-real.jpg`). Never use a submission flagged for showing the wrong product (e.g. a pump bottle). Product-page images are archived/handled per the image rules in CLAUDE.md; this page only references them.

## Left to the builder

Visual design (match the brand: Outfit/existing theme fonts, cream/green palette), exact copy within the rules above, image choice and order, whether the sticky button scrolls or buys directly, page handle.
