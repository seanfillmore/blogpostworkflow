#!/usr/bin/env node
/**
 * Remove product-subject cavity, gum-health and drug-property claims (and a false
 * ingredient claim) from the live post `can-you-use-coconut-oil-as-toothpaste`.
 *
 * Dry by default. `--apply` writes. Operator asked for the fix on 2026-10-10.
 *
 * ⚠️  RUN THIS ON THE PRODUCTION SERVER, for the reason scripts/remediate-toothpaste-
 * safety-claims.mjs gives: `agents/publisher` republishes from the server-only
 * `data/posts/<handle>/content.html` mirror, so a local `--apply` fixes Shopify and
 * leaves the mirror carrying the old copy for the next republish to push back.
 *
 * WHY. Found while widening the claim gate (PR #1062): the FAQ answer "Coconut oil
 * reduces harmful bacteria that cause cavities, which lowers your risk" sat on a page
 * whose three buy boxes sell our coconut oil toothpaste. Reading the whole article
 * turned up worse: all three CTAs said our toothpaste combines coconut oil "with
 * cavity-fighting ingredients" (one: "like xylitol"). Our toothpaste contains NO
 * xylitol (config/ingredients.json: water, coconut oil, baking soda, xanthan gum,
 * myrrh, stevia, essential oils), so those lines were false as well as anticaries
 * drug claims, which a fluoride-free cosmetic toothpaste may not make (21 CFR 355).
 *
 * SCOPE is the house line: rewrite a sentence when OUR PRODUCT (or "a coconut
 * oil-based product") is the subject of a claim. KEPT, deliberately:
 *   · the cited 2025 Clinical Oral Investigations paragraph and the "Reduces Harmful
 *     Bacteria" heading: reported research about the INGREDIENT (the tea-tree
 *     Satchell precedent);
 *   · the DIY recipe's xylitol / calcium carbonate lines: a home recipe, not our formula;
 *   · fluoride and hydroxyapatite explanations: category facts (operator ruling
 *     2026-09-13: naming a mechanism is information);
 *   · the FAQ QUESTION "Does coconut oil prevent cavities?": a question the reader asks.
 *
 * MECHANICS are the shared `runPlan` from remediate-toothpaste-safety-claims.mjs:
 * literal BEFORE/AFTER, asserted occurrence counts, SKIP when live matches neither,
 * every AFTER gated on the editorial surface before anything is fetched, backup before
 * the write, re-read and verify after, mirrors updated in the same run.
 *
 * Usage (on the server):
 *   node scripts/remediate-coconut-toothpaste-article-claims.mjs
 *   node scripts/remediate-coconut-toothpaste-article-claims.mjs --apply
 */
import { isDirectRun } from '../lib/is-direct-run.js';
import { runPlan, ARTICLES as TOOTHPASTE_ARTICLES } from './remediate-toothpaste-safety-claims.mjs';

const HANDLE = 'can-you-use-coconut-oil-as-toothpaste';
export const ARTICLES = { [HANDLE]: TOOTHPASTE_ARTICLES[HANDLE] };

const LINK = '<a href="https://www.realskincare.com/products/coconut-oil-toothpaste">';

export const PLAN = [
  {
    id: 'cta-mess-antibacterial',
    handle: HANDLE,
    surface: 'body',
    expectedOccurrences: 1,
    before: `Our ${LINK}Organic Coconut Oil Toothpaste</a> gives you all the antibacterial benefits of coconut oil in a creamy, easy-to-use formula.`,
    after: `Our ${LINK}Organic Coconut Oil Toothpaste</a> puts cold-pressed coconut oil and baking soda in a creamy, easy-to-use formula.`,
    reason: 'Buy box promised the product delivers coconut oil\'s "antibacterial benefits": a drug property attributed to our product.',
  },
  {
    id: 'cta-best-of-both-xylitol',
    handle: HANDLE,
    surface: 'body',
    expectedOccurrences: 1,
    before: `${LINK}Real Skin Care Toothpaste Collection</a> combines coconut oil's antibacterial power with cavity-fighting ingredients like xylitol. Made without sulfates, artificial sweeteners, or preservatives—perfect for sensitive mouths and families who want clean, effective oral care.`,
    after: `${LINK}Real Skin Care Toothpaste Collection</a> pairs cold-pressed coconut oil with baking soda and myrrh, sweetened with stevia. Made without sulfates, fluoride, glycerin, artificial sweeteners or preservatives, for sensitive mouths and families who want a short ingredient list.`,
    reason: 'FALSE: our toothpaste has no xylitol. Also an anticaries claim ("cavity-fighting") and a drug property, directly above a Shop button.',
  },
  {
    id: 'collection-paragraph-cavity-fighting',
    handle: HANDLE,
    surface: 'body',
    expectedOccurrences: 1,
    before: 'We combine coconut oil\'s antibacterial benefits with cavity-fighting ingredients perfect for sensitive mouths and families seeking clean oral care.',
    after: 'Each one pairs cold-pressed coconut oil with baking soda and myrrh, for sensitive mouths and families seeking clean oral care.',
    reason: 'Same false "cavity-fighting ingredients" claim about our formula, in the body copy.',
  },
  {
    id: 'cta-easiest-cavity-fighting',
    handle: HANDLE,
    surface: 'body',
    expectedOccurrences: 1,
    before: 'No DIY mess, consistent texture, and combined with cavity-fighting ingredients.',
    after: 'No DIY mess and a consistent texture.',
    reason: 'Third CTA repeating the false "cavity-fighting ingredients" claim.',
  },
  {
    id: 'faq-prevent-cavities-answer',
    handle: HANDLE,
    surface: 'body',
    expectedOccurrences: 1,
    before: 'Coconut oil reduces harmful bacteria that cause cavities, which lowers your risk. However, it doesn\'t remineralize enamel the way fluoride or hydroxyapatite does. Think of it as helping prevent the bacteria that cause cavities, but not rebuilding or strengthening enamel once damage starts.',
    after: 'Not on its own. Studies show the lauric acid in coconut oil reduces Streptococcus mutans, one of the bacteria linked to tooth decay, but that is a finding about bacteria, not evidence about cavities. It also does nothing for enamel, which is what fluoride and hydroxyapatite are for, so ask your dentist what fits your teeth.',
    reason: 'Answered "does it prevent cavities" with "lowers your risk" and "helping prevent", on a page selling coconut oil toothpaste. The research is kept and reported accurately; the conclusion it does not support is not.',
  },
  {
    id: 'final-thoughts-gum-health',
    handle: HANDLE,
    surface: 'body',
    expectedOccurrences: 1,
    before: 'or using a coconut oil-based product, you\'re likely to see improvements in gum health and fresher breath.',
    after: 'or using a coconut oil-based product, you\'re likely to notice fresher breath and a cleaner-feeling mouth.',
    reason: 'Promised improved gum health to users of "a coconut oil-based product", which includes ours. Fresh breath is cosmetic; gum health is not.',
  },
];

export function main(opts = {}) {
  return runPlan({
    plan: PLAN,
    articles: ARTICLES,
    reportDir: 'coconut-toothpaste-article-claims',
    backupTag: 'coconut-tp-claims',
    ...opts,
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
