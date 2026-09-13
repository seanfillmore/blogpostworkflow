#!/usr/bin/env node
/**
 * Restore the "safe for kids" wording that scripts/remediate-toothpaste-safety-claims.mjs
 * (PR #881) removed from live toothpaste blog posts.
 *
 * Dry by default. `--apply` writes. `--slug <handle>` limits the run to one post.
 *
 * ⚠️  RUN THIS ON THE PRODUCTION SERVER, for the same reason #881 had to: the
 * `data/posts/<handle>/content.html` mirrors carrying the live wording exist only there, and
 * `agents/publisher` republishes from them. A local `--apply` would restore Shopify and leave
 * the server's mirror carrying the softened wording for the next republish to push back.
 *
 * WHY. Operator ruling 2026-09-13, verbatim: "Are these products safe for kids is a resounding
 * yes for every single product." #881 treated "safe for kids" and "safe if swallowed" as
 * unsubstantiated safety claims and replaced them with pediatric-dentist referrals. That
 * premise was wrong, so every entry that removed kids wording is reversed here to the wording
 * that was live on 2026-09-12. Each entry names the #881 entry it reverses.
 *
 * WHAT STAYS REMOVED. Two #881 edits took kids wording AND an oral drug claim out of the same
 * sentence, and only the kids half comes back:
 *   · families: "mild, safe if swallowed, and supports natural remineralization"
 *     → "mild and safe if swallowed"
 *   · 7-ingredients CTA: "Safe for kids, free of foaming agents, and supportive of enamel and
 *     gum health" → "Safe for kids, free of foaming agents, and gentle enough for everyday
 *     brushing"
 * The families SERP description regains "Safe for kids and adults" but drops "without harsh
 * ingredients", so it fits the 160-character length gate (the pre-#881 value was 184). Every
 * remineralization, cavity and enamel edit #881 made is untouched.
 *
 * These 15 entries were retired from #881's PLAN in the same change, so re-running that script
 * can never soften the wording again. A test pins that.
 *
 * MECHANICS are #881's runner, imported rather than copied: literal BEFORE and AFTER, an
 * asserted occurrence count, a SKIP when live matches neither, one verified write per article
 * with a backup taken first, lenient mirror replacement, and every AFTER re-gated before
 * anything is fetched.
 *
 * Usage (on the server):
 *   node scripts/restore-toothpaste-kids-wording.mjs --slug why-glycerin-free-toothpaste-matters
 *   node scripts/restore-toothpaste-kids-wording.mjs --apply
 */
import { isDirectRun } from '../lib/is-direct-run.js';
import { runPlan } from './remediate-toothpaste-safety-claims.mjs';

const BLOG_ID = 48998449187;

export const ARTICLES = {
  'why-glycerin-free-toothpaste-matters': { blogId: BLOG_ID, articleId: 562341380266 },
  'best-natural-toothpaste-for-families-2025': { blogId: BLOG_ID, articleId: 562335973546 },
  'best-fluoride-free-toothpaste-2025': { blogId: BLOG_ID, articleId: 562334367914 },
  '7-ingredients-to-avoid-in-natural-toothpaste': { blogId: BLOG_ID, articleId: 562341347498 },
  'best-sls-free-toothpaste-for-kids-safe-natural': { blogId: BLOG_ID, articleId: 564154826922 },
  'discover-the-power-of-coconut-whitening-toothpaste': { blogId: BLOG_ID, articleId: 561045405866 },
};

/**
 * BEFORE is the wording #881 put live (verified byte-exact against the live bodies on
 * 2026-09-13); AFTER is the wording it replaced, minus any oral drug claim.
 */
export const PLAN = [
  // ── why-glycerin-free-toothpaste-matters
  {
    id: 'restore-glycerin-formula-safe-for-kids',
    reverses: 'glycerin-formula-safe-for-kids',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: "It's gentle on gums and a good fit for sensitive mouths.",
    after: "It's safe for kids, gentle on gums, and works well for people with sensitivity.",
    reason: 'Restores "safe for kids" in the product description.',
  },
  {
    id: 'restore-glycerin-list-safe-for-kids',
    reverses: 'glycerin-list-safe-for-kids',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: '<li>You want fewer synthetic ingredients in your daily routine</li>\n</ul>',
    after: "<li>You want fewer synthetic ingredients in your daily routine</li>\n  <li>You're looking for a clean option that's safe for kids</li>\n</ul>",
    reason: 'Restores the "safe for kids" reason to switch. Anchored on the closing </ul> so the BEFORE is not a substring of the AFTER.',
  },
  {
    id: 'restore-glycerin-faq-kids',
    reverses: 'glycerin-faq-kids',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: "<p>Ask your pediatric dentist which toothpaste suits your child's age, especially since young kids tend to swallow some. Whatever you choose, use a pea-sized amount and supervise brushing.</p>",
    after: "<p>Yes, and it's often the better choice. Kids swallow more toothpaste than adults. A formula with fewer synthetic ingredients — no SLS, no fluoride, no glycerin — is gentler and safer if they happen to swallow some. Real Skin Care's formula is safe for kids. Just use a pea-sized amount, the same as you would with any toothpaste.</p>",
    reason: 'Restores the original "Can kids use glycerin-free toothpaste?" answer verbatim.',
  },

  // ── best-natural-toothpaste-for-families-2025
  {
    id: 'restore-families-product-safe-if-swallowed',
    reverses: 'families-product-safe-if-swallowed',
    handle: 'best-natural-toothpaste-for-families-2025',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'it’s a mild, short-ingredient formula.',
    after: 'it’s mild and safe if swallowed.',
    reason: 'Restores "safe if swallowed". The "supports natural remineralization" half of the original sentence stays removed.',
  },
  {
    id: 'restore-families-faq-toddlers',
    reverses: 'families-faq-toddlers',
    handle: 'best-natural-toothpaste-for-families-2025',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'Ask your pediatric dentist which toothpaste suits your toddler’s age. Whatever you choose, use a tiny smear and supervise brushing.',
    after: 'Yes — especially when fluoride-free and free of SLS. Real Skin Care’s formula is safe if swallowed.',
    reason: 'Restores the original toddler FAQ answer verbatim.',
  },
  {
    id: 'restore-families-description-tag',
    reverses: 'families-description-tag',
    handle: 'best-natural-toothpaste-for-families-2025',
    surface: 'description_tag',
    expectedOccurrences: 1,
    before: 'Discover the best natural toothpaste for families in 2025. Real Skin Care’s All Natural formula offers clean, effective oral care without harsh ingredients.',
    after: 'Discover the best natural toothpaste for families in 2025. Safe for kids and adults, Real Skin Care’s All Natural formula offers clean, effective oral care.',
    reason: 'Restores "Safe for kids and adults" to the SERP snippet. Drops "without harsh ingredients" to stay inside 160 characters.',
  },

  // ── best-fluoride-free-toothpaste-2025
  {
    id: 'restore-fluoride-free-faq-kids',
    reverses: 'fluoride-free-faq-kids',
    handle: 'best-fluoride-free-toothpaste-2025',
    surface: 'body',
    expectedOccurrences: 1,
    before: "If you're considering a fluoride-free, SLS-free formula like Real Skin Care's Coconut Oil Toothpaste for a child, check with your pediatric dentist first.",
    after: "A fluoride-free, SLS-free formula like Real Skin Care's Coconut Oil Toothpaste is safe for children old enough to spit (generally age 3 and up).",
    reason: 'Restores the original kids FAQ sentence verbatim.',
  },

  // ── 7-ingredients-to-avoid-in-natural-toothpaste
  {
    id: 'restore-seven-ingredients-cta-safe-for-kids',
    reverses: 'seven-ingredients-cta-safe-for-kids',
    handle: '7-ingredients-to-avoid-in-natural-toothpaste',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'No foaming agents, and gentle enough for everyday brushing.',
    after: 'Safe for kids, free of foaming agents, and gentle enough for everyday brushing.',
    reason: 'Restores "Safe for kids" in the buy-box copy. The "supportive of enamel and gum health" claim stays removed.',
  },

  // ── best-sls-free-toothpaste-for-kids-safe-natural (FAQ in prose AND inert JSON-LD)
  {
    id: 'restore-sls-kids-faq-coconut-oil-safe',
    reverses: 'sls-kids-faq-coconut-oil-safe',
    handle: 'best-sls-free-toothpaste-for-kids-safe-natural',
    surface: 'body',
    expectedOccurrences: 2,
    before: " is a gentle base ingredient in Real Skin Care's formula. For young children, ask your pediatric dentist which toothpaste suits their age.",
    after: " is a gentle, naturally antibacterial ingredient appropriate for all ages. It is a core ingredient in Real Skin Care's formula and is well-tolerated even by young children.",
    reason: 'Restores the original answer in both the visible FAQ and its JSON-LD copy.',
  },
  {
    id: 'restore-sls-kids-faq-yes-prose',
    reverses: 'sls-kids-faq-yes-prose',
    handle: 'best-sls-free-toothpaste-for-kids-safe-natural',
    surface: 'body',
    expectedOccurrences: 1,
    before: '<p>Organic coconut oil is a gentle',
    after: '<p>Yes. Organic coconut oil is a gentle',
    reason: 'Restores the leading "Yes." on the visible answer.',
  },
  {
    id: 'restore-sls-kids-faq-yes-jsonld',
    reverses: 'sls-kids-faq-yes-jsonld',
    handle: 'best-sls-free-toothpaste-for-kids-safe-natural',
    surface: 'body',
    expectedOccurrences: 1,
    before: '"text": "<a href="https://www.realskincare.com/blogs/news/organic-coconut-oil-types-uses-benefits-for-skin"',
    after: '"text": "Yes. <a href="https://www.realskincare.com/blogs/news/organic-coconut-oil-types-uses-benefits-for-skin"',
    reason: 'Restores the leading "Yes." in the JSON-LD copy.',
  },

  // ── discover-the-power-of-coconut-whitening-toothpaste (FAQ in prose AND JSON-LD, worded differently)
  {
    id: 'restore-whitening-faq-question-prose',
    reverses: 'whitening-faq-question-prose',
    handle: 'discover-the-power-of-coconut-whitening-toothpaste',
    surface: 'body',
    expectedOccurrences: 1,
    before: '<h3>Can kids use it?</h3>',
    after: '<h3>Is it safe for kids?</h3>',
    reason: 'Restores the original FAQ question.',
  },
  {
    id: 'restore-whitening-faq-answer-prose',
    reverses: 'whitening-faq-answer-prose',
    handle: 'discover-the-power-of-coconut-whitening-toothpaste',
    surface: 'body',
    expectedOccurrences: 1,
    before: '<p>Ask your pediatric dentist first, especially for young children. If you do use it, supervise brushing, use a pea-size amount, and remind kids to spit and rinse thoroughly.</p>',
    after: '<p>Yes, when used as directed. Supervise brushing and use a pea-size amount. Remind kids to spit and rinse thoroughly.</p>',
    reason: 'Restores the original FAQ answer.',
  },
  {
    id: 'restore-whitening-faq-question-jsonld',
    reverses: 'whitening-faq-question-jsonld',
    handle: 'discover-the-power-of-coconut-whitening-toothpaste',
    surface: 'body',
    expectedOccurrences: 1,
    before: '"name":"Can kids use it?"',
    after: '"name":"Is it safe for kids?"',
    reason: 'JSON-LD copy of the question.',
  },
  {
    id: 'restore-whitening-faq-answer-jsonld',
    reverses: 'whitening-faq-answer-jsonld',
    handle: 'discover-the-power-of-coconut-whitening-toothpaste',
    surface: 'body',
    expectedOccurrences: 1,
    before: '"text":"Ask your pediatric dentist first, especially for young children. If you do use it, supervise brushing, use a pea-size amount, and remind children to spit and rinse thoroughly."',
    after: '"text":"Yes, when used as directed. Supervise brushing, use a pea-size amount, and remind children to spit and rinse thoroughly."',
    reason: 'JSON-LD copy of the answer, which is worded differently from the prose.',
  },
];

export function main(opts = {}) {
  return runPlan({
    plan: PLAN,
    articles: ARTICLES,
    reportDir: 'toothpaste-kids-wording-restore',
    backupTag: 'toothpaste-kids-restore',
    ...opts,
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
