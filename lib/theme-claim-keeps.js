/**
 * Theme-template health-claim findings that were READ, JUDGED and deliberately KEPT.
 *
 * `scripts/check-uncovered-copy-surfaces.mjs` is intentionally blunt: its job is to
 * make a human look, not to decide. Nine of its blocking-tier hits are legitimate
 * editorial framing — a customer's own question, a safety referral, a citation, a
 * debunking sentence about a competitor, suitability for a skin type. Re-raising
 * those every morning is how a daily digest row stops being read, which is the
 * failure mode CLAUDE.md names repeatedly.
 *
 * So they live here, each with the reason it stays, and the checker reports them
 * SEPARATELY from new findings. This is the same mechanism as the tea-tree plan's
 * `KEPT` array: "we judged it and kept it" must be distinguishable from "we never
 * looked". A keep whose `field` no longer appears in the corpus is reported as
 * STALE rather than silently dropped, so this list cannot rot into a rule nobody
 * can check.
 *
 * Adding an entry is a judgement call a human makes. The test is the one the whole
 * gate turns on: does a therapeutic verb or disease word take OUR PRODUCT as its
 * subject? If yes it is a claim and must be fixed, never acknowledged.
 */
/**
 * Findings deliberately NOT changed. Each entry is a decision with a reason, not an
 * oversight. `match` is the token the gate flags; `why` is why it stays.
 */
export const ACKNOWLEDGED_KEEPS = [
  {
    field: 'templates/product.landing-page-lotion.json/sections/collapsible-content/blocks/faq-4/settings/row_content',
    why: 'PRESERVATION, not therapy — the lotion twin of the cream keep below: grapefruit seed extract inhibiting bacterial and fungal growth IN THE FORMULA, answering "How is this preserved without parabens?".',
  },
  {
    field: 'templates/product.landing-page-sensitive-skin-set-lander.json/sections/collapsible-content/blocks/faq-eczema/settings/heading',
    why: 'A question the customer asks. CLAUDE.md names "Can I use unscented products if I have eczema?" among the headings that stay.',
  },
  {
    field: 'templates/product.landing-page-sensitive-skin-set-lander.json/sections/collapsible-content/blocks/faq-eczema/settings/row_content',
    why: 'Opens with an explicit disclaimer ("We can\'t make medical claims and don\'t sell our products as treatments") and attributes the outcome to CUSTOMERS reporting, not to the product acting. Softening it would make the page less accurate for the exact buyer asking — the stretch-mark hedging precedent.',
  },
  {
    field: 'templates/product.landing-page-sensitive-skin-set-lander.json/sections/collapsible-content/blocks/faq-baby/settings/row_content',
    why: 'A SAFETY REFERRAL — "if your child has a diagnosed skin condition, ask their provider". Removing it removes safety guidance, the same class as "Signs of Infection — When to See a Doctor".',
  },
  {
    field: 'templates/product.landing-page-sensitive-skin-set-lander.json/sections/stats-hero/settings/custom_liquid',
    why: 'False positive on a CITATION: "North American Contact Dermatitis Group Patch Test Results, 2021-2022" is the name of the organisation publishing the data.',
  },
  {
    field: 'templates/product.landing-page-lip-balm.json/sections/main/blocks/tab-details/settings/content',
    why: 'Subject is COMPETING balms and the sentence DENIES a therapeutic effect — "add menthol to feel \'treated\' — that\'s mild irritation, not healing". Debunking framing.',
  },
  {
    field: 'templates/product.landing-page-lip-balm.json/sections/collapsible-content/blocks/faq-5/settings/row_content',
    why: 'Same debunking framing about competitors\' menthol, with "treated" in scare quotes.',
  },
  {
    field: 'templates/product.landing-page-lotion.json/sections/collapsible-content/blocks/faq-2/settings/row_content',
    why: 'A cited third-party fact about SYNTHETIC FRAGRANCE as a category, not a claim about our product.',
  },
  {
    field: 'templates/product.landing-page-lotion.json/sections/collapsible-content/blocks/faq-3/settings/row_content',
    why: 'Suitability for a skin type ("if you\'re acne-prone, the unscented variation is the most conservative choice"), which CLAUDE.md keeps.',
  },
  {
    field: 'templates/product.landing-page-cream.json/sections/collapsible-content/blocks/faq-6/settings/row_content',
    why: 'PRESERVATION, not therapy: grapefruit seed extract inhibiting growth IN THE JAR, in an answer about shelf life.',
  },
];
