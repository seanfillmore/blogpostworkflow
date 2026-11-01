#!/usr/bin/env node
/**
 * Remove product-subject drug-property and gum/plaque claims, and fix misstated
 * formulas, across eleven live toothpaste posts and one deodorant post.
 *
 * Dry by default. `--apply` writes. `--slug <handle>` limits the run to one post.
 * Operator asked for the sweep on 2026-10-10 ("Review the posts and edit as necessary").
 *
 * ⚠️  RUN THIS ON THE PRODUCTION SERVER: `agents/publisher` republishes from the
 * server-only `data/posts/<handle>/content.html` mirrors. Same reason as
 * remediate-toothpaste-safety-claims.mjs.
 *
 * HOW THE LIST WAS BUILT. Every live article mentioning toothpaste or linking the
 * product (45 posts, 802 sentences in our voice) was screened for (a) ingredients our
 * formula does not contain, (b) the claim gate's blocking tier, and (c) drug-property,
 * plaque, gum-health and whitening wording, then read by hand. The rule is the house
 * line: rewrite when OUR PRODUCT, or "a coconut oil toothpaste" on a page that sells
 * ours, is the subject of a claim, or when a sentence misstates what is in our formula.
 *
 * KEPT, deliberately:
 *   · category explanations of fluoride, hydroxyapatite and remineralization;
 *   · cited ingredient research ("Modern research supports its antibacterial…");
 *   · whitening as stain removal: a cosmetic claim;
 *   · accurate disclosures ("does not contain charcoal, hydroxyapatite, xylitol…");
 *   · `toothpaste-without-sls-…`: frozen locked winner, and its one hit is whitening.
 *
 * FORMULA FACTS (config/ingredients.json): six base ingredients plus two essential
 * oils (Fresh Mint, Cinnamon Spice: 8 total) or four (All Natural: 10). No single
 * flavor carries all four oils except All Natural; Cinnamon Spice has no mint.
 * Deodorant scents carry two to four oils each; no single formula has eight.
 *
 * Mechanics: the shared `runPlan` from remediate-toothpaste-safety-claims.mjs.
 *
 * Usage (on the server):
 *   node scripts/remediate-oral-care-post-claims-2026-10-10.mjs
 *   node scripts/remediate-oral-care-post-claims-2026-10-10.mjs --apply
 */
import { isDirectRun } from '../lib/is-direct-run.js';
import { runPlan } from './remediate-toothpaste-safety-claims.mjs';

const BLOG_ID = 48998449187;
const PULL = 'coconut-oil-pulling-discover-the-oral-health-benefits-and-how-to-incorporate-it-into-your-daily-routine';

export const ARTICLES = {
  'fluoride-free-toothpaste-what-it-is-best-options': { blogId: BLOG_ID, articleId: 577831895210 },
  'best-all-natural-toothpaste-top-picks-for-a-clean-smile': { blogId: BLOG_ID, articleId: 564861960362 },
  'toothpaste-ingredients-to-avoid-for-a-cleaner-smile': { blogId: BLOG_ID, articleId: 563840843946 },
  'sodium-lauryl-sulfate-in-toothpaste-what-you-need-to-know': { blogId: BLOG_ID, articleId: 563829375146 },
  'the-healthiest-deodorant-what-to-look-for-top-picks': { blogId: BLOG_ID, articleId: 563829211306 },
  'coconut-toothpaste-benefits-ingredients-what-to-look-for': { blogId: BLOG_ID, articleId: 563825606826 },
  'vegan-toothpaste-what-it-is-how-to-choose-the-best': { blogId: BLOG_ID, articleId: 563825508522 },
  'charcoal-toothpaste-does-it-work-is-it-safe': { blogId: BLOG_ID, articleId: 563424755882 },
  'can-you-use-coconut-oil-as-toothpaste-what-to-know': { blogId: BLOG_ID, articleId: 563424264362 },
  'no-fluoride-toothpaste-what-to-use-why-it-works': { blogId: BLOG_ID, articleId: 563317997738 },
  'fluoride-free-toothpaste-benefits-how-it-works-best-picks': { blogId: BLOG_ID, articleId: 563282182314 },
  [PULL]: { blogId: BLOG_ID, articleId: 561133191338 },
};

const TP_LINK = '<a href="https://www.realskincare.com/products/coconut-oil-toothpaste">';
const e = (id, handle, before, after, reason) => ({ id, handle, surface: 'body', expectedOccurrences: 1, before, after, reason });

export const PLAN = [
  // ── coconut-oil-pulling: four sentences promise our toothpaste's "antibacterial benefits"
  e('pull-cta-two-minutes', PULL,
    'for the same antibacterial benefits in your normal brushing routine.',
    'and brush with coconut oil in your normal two-minute routine.',
    'Buy box: our toothpaste delivers "the same antibacterial benefits" as oil pulling.'),
  e('pull-complete-routine', PULL,
    'gives you the antibacterial benefits of coconut oil plus gentle polishing action in one step — the most practical daily option for most people.',
    'gives you coconut oil plus gentle polishing action in one step, the most practical daily option for most people.',
    'Linked to our product: "gives you the antibacterial benefits".'),
  e('pull-faq-similar', PULL,
    'gives you similar antibacterial benefits in a two-minute brush.',
    'puts coconut oil into a two-minute brush instead.',
    'FAQ answer linking our product: "similar antibacterial benefits".'),
  e('pull-cta-switch', PULL,
    'Get the antibacterial benefits of coconut oil in a two-minute daily routine with ',
    'Brush with coconut oil in a two-minute daily routine with ',
    'Buy box headline sentence: "Get the antibacterial benefits … with Real Skin Care\'s Coconut Oil Toothpaste".'),

  e('all-natural-antimicrobial-support', 'best-all-natural-toothpaste-top-picks-for-a-clean-smile',
    'coconut oil and myrrh for antimicrobial support, and essential oils for a fresh, clean feel.',
    'coconut oil and myrrh as its base, and essential oils for a fresh, clean feel.',
    '"Real Skin Care\'s toothpaste hits all of these marks … for antimicrobial support": a drug property on our product.'),

  e('sls-antimicrobial-stack', 'sodium-lauryl-sulfate-in-toothpaste-what-you-need-to-know',
    "'s formula uses wildcrafted myrrh powder and organic essential oils of peppermint, spearmint, cinnamon, and clove — a full botanical antimicrobial stack with no synthetic additives.",
    "'s formula uses wildcrafted myrrh powder and, depending on the flavor, organic essential oils of peppermint, spearmint, cinnamon or clove, with no synthetic additives.",
    'Called our formula "a full botanical antimicrobial stack", and listed all four oils as if one flavor carried them.'),

  e('vegan-antimicrobial-properties', 'vegan-toothpaste-what-it-is-how-to-choose-the-best',
    'Our formulas rely on the natural cleaning and antimicrobial properties of coconut oil, baking soda, and plant-based essential oils rather than synthetic active ingredients.',
    'Our formulas rely on coconut oil, baking soda, and plant-based essential oils rather than synthetic additives.',
    '"Our formulas rely on the … antimicrobial properties": a drug property on our product.'),

  e('avoid-natural-antibacterial', 'toothpaste-ingredients-to-avoid-for-a-cleaner-smile',
    `A natural antibacterial that forms the base of ${TP_LINK}our coconut oil toothpaste</a>. It helps reduce harmful oral bacteria without disrupting the microbiome.`,
    `Cold-pressed and unrefined, it forms the base of ${TP_LINK}our coconut oil toothpaste</a> and cleans without harsh foaming detergents.`,
    'Called the base of our toothpaste "a natural antibacterial" that "helps reduce harmful oral bacteria".'),

  e('no-fluoride-antimicrobial-benefits', 'no-fluoride-toothpaste-what-to-use-why-it-works',
    'and brings in the antimicrobial benefits of coconut oil and clove.',
    'and builds on cold-pressed coconut oil.',
    'Our squeeze-bottle toothpaste "brings in the antimicrobial benefits".'),

  e('ff-benefits-plaque-reduction', 'fluoride-free-toothpaste-benefits-how-it-works-best-picks',
    "Fluoride free baking soda toothpaste has strong clinical support for plaque reduction, and it's a core ingredient in Real Skin Care's own formula for exactly these reasons.",
    "Baking soda is one of the most studied gentle cleaners in toothpaste, and it is a core ingredient in Real Skin Care's own formula for exactly these reasons.",
    'Tied our formula to "plaque reduction" (an anti-plaque claim) and said a toothpaste was "a core ingredient" of our formula.'),

  e('ff-what-it-is-gum-health', 'fluoride-free-toothpaste-what-it-is-best-options',
    ' and is being revisited in modern herbalism for its properties in supporting gum health.',
    '.',
    'Myrrh "used in Real Skin Care\'s formula" for "supporting gum health". The history clause is kept.'),

  e('coconut-tp-active-ingredient', 'coconut-toothpaste-benefits-ingredients-what-to-look-for',
    'as its primary active ingredient to target the bacteria behind plaque and bad breath — not just mask them.',
    'as its primary ingredient to clean teeth and freshen breath, rather than just masking odor with flavor.',
    '"Coconut toothpaste" is what we sell; "primary active ingredient to target the bacteria behind plaque" is drug wording.'),

  e('charcoal-ingredient-count', 'charcoal-toothpaste-does-it-work-is-it-safe',
    ' — 10 clean ingredients, no abrasive charcoal, and a formula you can use every day with confidence.',
    ': eight to ten clean ingredients depending on the flavor, no abrasive charcoal, and a formula you can use every day with confidence.',
    'Buy box said "10 clean ingredients"; Fresh Mint and Cinnamon Spice have 8.'),

  e('recipes-note-peppermint', 'can-you-use-coconut-oil-as-toothpaste-what-to-know',
    'includes baking soda and peppermint oil (as found in these recipes)',
    'includes baking soda and, in its mint flavors, peppermint oil (as found in these recipes)',
    'Said our formula includes peppermint; Cinnamon Spice has none.'),
  e('recipes-contains-all-oils', 'can-you-use-coconut-oil-as-toothpaste-what-to-know',
    'and essential oils of peppermint, spearmint, cinnamon, and clove — it does not contain fluoride, xylitol, nHA, or arrowroot.',
    'and, depending on the flavor, essential oils of peppermint, spearmint, cinnamon or clove. It does not contain fluoride, xylitol, nHA, or arrowroot.',
    'Listed all four oils as one formula; only All Natural carries all four.'),

  // ── the deodorant post: surfaced by the same sweep (it links oral-care pages)
  e('deodorant-eight-oils', 'the-healthiest-deodorant-what-to-look-for-top-picks',
    'Our formula uses eight organic essential oils — geranium, cedarwood, tea tree, patchouli, lavender, lemon, rosemary, and frankincense.',
    'Each of our scents uses organic essential oils instead of fragrance: lavender, lemon and rosemary in Calming Lavender; frankincense and sandalwood in Wildcrafted Frankincense; cedarwood, geranium, patchouli and tea tree in Mountain Cedarwood and Geranium Flower.',
    'FALSE: no single deodorant formula has eight oils, and the list omitted sandalwood.'),
  e('deodorant-antimicrobial-ingredients', 'the-healthiest-deodorant-what-to-look-for-top-picks',
    "That's exactly what the antimicrobial ingredients in our formula are targeting.",
    "That's the odor our formula is built to neutralize, with baking soda doing most of the work.",
    '"the antimicrobial ingredients in our formula": a drug property on our product.'),
];

export function main(opts = {}) {
  return runPlan({
    plan: PLAN,
    articles: ARTICLES,
    reportDir: 'oral-care-post-claims-2026-10-10',
    backupTag: 'oral-care-claims',
    ...opts,
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
