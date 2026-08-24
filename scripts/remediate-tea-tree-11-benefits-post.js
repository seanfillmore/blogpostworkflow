#!/usr/bin/env node
/**
 * The full editorial health-claim pass on ONE live post:
 * `11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life`.
 *
 *   node scripts/remediate-tea-tree-11-benefits-post.js            # DRY RUN (default)
 *   node scripts/remediate-tea-tree-11-benefits-post.js --apply    # write Shopify + local mirror
 *   node scripts/remediate-tea-tree-11-benefits-post.js --only <id>
 *
 * ── Why this is a SIBLING of scripts/remediate-ingredient-benefit-headings.js ───
 *
 * That script (PR #645) fixed two `<h3>`s on this article — `3. Supports Wound
 * Healing` and `4. Fights Fungal Infections`, bodies included — and its own header
 * records the rest as out of scope: "the `11-benefits` neighbours 2/6/7/10 … that
 * post has a wider problem than six headings and needs its own editorial pass."
 * This is that pass. It is a separate plan rather than an append, for the same
 * reason #645 did not append to #634's: a plan's header is the record of a
 * decision, and adding entries to one whose header says "not here" erases it.
 *
 * The mechanics (`occurrences`, `replaceAll`, `classifyBody`) are IMPORTED, never
 * re-declared — a second copy of the drift guard is a second copy that drifts.
 *
 * ── The line, inherited from PR #645 verbatim ──────────────────────────────────
 *
 *   "the product does X"       → rewrite. A therapeutic verb taking the product,
 *                                or the oil sold as the product, as its subject.
 *   "here is information about X" → keep. Editorial / ingredient / historical.
 *   cited research             → keep VERBATIM, disease words included. Rewriting
 *                                a citation makes the page less accurate, not safer.
 *   no honest cosmetic equivalent → the section NARROWS, and the narrowing is
 *                                stated outright rather than implied.
 *
 * Every one of the 27 blocks in the live body was judged, not just the four the
 * brief named. `lib/seo-copy-health-gate.js` was run over each block first, so the
 * candidate list is measured rather than remembered; the human decision then put
 * each candidate in or out. `KEPT` below records the ones left alone, with the
 * reason, so nobody re-litigates them from a raw grep — and a test asserts each
 * KEPT excerpt is still present and is not touched by any PLAN entry.
 *
 * ── The one entry the gate did NOT flag: section 10, the mouth rinse ───────────
 *
 * `10. Freshens Breath (with caution)` trips only the ADVISORY tier (`toxic`), so
 * a gate-driven pass would leave it. It is rewritten anyway, and `s10-mouth-rinse`
 * is the only entry carrying `nonClaimRationale` — a field a test REQUIRES exactly
 * when BEFORE is clean at the blocking tier, so an unflagged edit can never be
 * smuggled in as an afterthought.
 *
 * The risk there is a different one and the gate is not built to see it: the
 * section is an ORAL-USE INSTRUCTION for a page whose buy box sells a bar soap. It
 * tells a reader to put an essential oil in their mouth, gives no dilution ratio,
 * no concentration and no method, and warns in the same breath that swallowing it
 * is toxic. RSC sells no mouth rinse, so the section cannot convert; it is pure
 * liability on a page that exists to sell soap.
 *
 * SOFTENING IT WAS NOT AN OPTION, and that is the whole judgement. "Can freshen
 * breath when used carefully" keeps the invitation, which IS the hazard — the
 * honest answer is that the section should not be on this page at all. It is not
 * deleted, because item 10 of a list of 11 cannot be removed without renumbering
 * item 11 and rewriting the article title, the `<h2>`, the opening promise ("11
 * ways"), the meta description and the local meta.json — a large, SEO-expensive
 * diff to remove one paragraph. So slot 10 is REFILLED with a different, honest,
 * cosmetic benefit (post-shave feel) and the useful half of the old paragraph —
 * never swallow it — is kept and strengthened into an external-use-only line.
 * Checked before deciding: the page states "never ingest" twice more (the safety
 * list and FAQ Q5), so no safety information leaves the page with the section.
 *
 * ── The FAQ entries are DELIBERATELY worded to hit two places at once ──────────
 *
 * Q1's question, Q1's answer and Q3's answer each appear TWICE in `body_html` —
 * once as visible prose and once inside the JSON-LD `FAQPage` block at the foot of
 * the article, which is the surface Google may render as a rich result. Those
 * three entries declare `expectedOccurrences: 2` and replace both, so the schema
 * and the visible copy cannot drift apart. That mirrored-into-JSON-LD shape is the
 * one PR #634 called its highest-severity find.
 *
 * ── The local mirror had ALREADY diverged from live, in three places ───────────
 *
 * `data/posts/<slug>/content.html` is the same article (not, as with two of PR
 * #645's five slugs, a different older draft) but it is NOT byte-identical to live:
 *
 *   1. sections 3 and 4 still carry the PRE-#645 claims. #645's commit landed the
 *      plan; its `--apply` run wrote Shopify and its two mirror entries were never
 *      committed. A republish from this file would push
 *      "Fights Fungal Infections" back onto the live page.
 *   2. live gained an internal link on "antibacterial power" in the top CTA
 *      (agents/internal-linker) that the mirror does not have.
 *   3. live LOST the link on "Toxic Chemicals in Soap to Keep an Eye On" in the
 *      related-posts list; the mirror still has it.
 *
 * None of the three overlaps anything in this plan, so this script neither fixes
 * nor worsens them, and it does not silently "resync" a file it was not asked to
 * resync. (1) is closed by re-running the #645 script, which is idempotent and
 * will report its two live entries as `already-applied`:
 *
 *   node scripts/remediate-ingredient-benefit-headings.js --apply
 *
 * (2) and (3) are link state owned by internal-linker / link-repair and are not a
 * claims question.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────────
 *
 * - Dry by default. `--apply` is the only thing that writes, to Shopify OR to disk.
 * - Idempotent: an entry whose target already contains AFTER and not BEFORE is skipped.
 * - Never blind-overwrites: BEFORE must occur exactly `expectedOccurrences` times or
 *   the entry is SKIPPED as drift and reported. Literal matching, never regex.
 * - Every AFTER is re-gated through `checkSeoCopy` at run time, in the slot the entry
 *   declares. `checkSeoCopy` takes an OBJECT and returns ok:true for a bare string,
 *   so the slot is always named. One failure aborts the run before anything is read.
 * - The current value of every target is backed up to disk BEFORE its write.
 * - A run record naming every before/after pair is written on dry runs too.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSeoCopy } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import {
  occurrences,
  replaceAll,
  classifyBody,
} from './remediate-live-health-claims.js';

const BLOG_ID = 48998449187; // "news"
const ARTICLE_ID = 559520252074;
const SLUG = '11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life';
const MIRROR = `data/posts/${SLUG}/content.html`;

const ARTICLE = () => ({ kind: 'article', slug: SLUG, blogId: BLOG_ID, articleId: ARTICLE_ID, field: 'body_html' });
const FILE = () => ({ kind: 'file', path: MIRROR });

/**
 * @typedef {object} PlanEntry
 * @property {string} id                     stable key, also the `--only` argument
 * @property {{kind:'article'|'file'}} target where the write lands
 * @property {'title'|'meta'} gateSlot        which checkSeoCopy slot AFTER is gated in
 * @property {string} before                  exact literal substring, machine-extracted from live
 * @property {string} after
 * @property {number} expectedOccurrences     2 for the three FAQ strings — prose + JSON-LD
 * @property {string[]} mustContain           tokens that must survive BEFORE → AFTER, in order
 * @property {string} why                     why this is a claim and not editorial
 * @property {string} bodyVerdict             what reading the section decided
 * @property {string} [nonClaimRationale]     REQUIRED iff BEFORE trips no blocking-tier claim
 */

/** The eleven live rewrites, in document order. */
const LIVE = [
  // ── opening / answer-first paragraph ────────────────────────────────────────
  {
    id: 'intro-kills-bacteria',
    gateSlot: 'meta',
    before:
      '<p>Tea tree oil kills bacteria and fungi that cause acne, dandruff, and body odor. This natural '
      + 'oil from Australian tea tree leaves has been used for skin problems for thousands of years, and '
      + 'modern science backs up what people have known all along. Keep reading to discover 11 ways you '
      + 'can use it safely in your daily routine.</p>',
    after:
      '<p>Tea tree oil is a cosmetic ingredient known for leaving skin feeling clean, fresh and less '
      + 'oily. This natural oil from Australian tea tree leaves has been part of skin care routines for '
      + 'thousands of years, and modern formulators still reach for it. Keep reading to discover 11 ways '
      + 'you can use it safely in your daily routine.</p>',
    expectedOccurrences: 1,
    mustContain: ['Tea tree oil', 'Australian tea tree leaves', '11 ways you can use it safely in your daily routine'],
    why:
      'The FIRST sentence of the article and the one an answer-engine quotes, sitting four lines above '
      + 'the above-the-fold buy box for the Tea Tree Bar Soap variant of /products/coconut-soap. "Kills '
      + 'bacteria and fungi that cause acne" is an unhedged antimicrobial efficacy claim naming a disease, '
      + 'and the CTA immediately under it sells the reader the same oil as "antibacterial power" — so the '
      + 'page itself makes the product the beneficiary of the sentence. "Used for skin problems" carries '
      + 'the same freight in vaguer words.',
    bodyVerdict:
      'HEADING + BODY is not the shape here — there is no heading, the paragraph IS the claim. Replaced '
      + 'whole, keeping the answer-first structure and every ranking token it carried ("tea tree oil", '
      + 'the Australian provenance, "11 ways … daily routine"). What it now promises is a feel and '
      + 'appearance claim, which is what a cosmetic may say.',
  },

  // ── 1 ───────────────────────────────────────────────────────────────────────
  {
    id: 's1-helps-fight-acne',
    gateSlot: 'meta',
    before:
      '<h3>1. Helps Fight Acne</h3>\n'
      + '<p>Its antibacterial action targets acne-causing bacteria (*Cutibacterium acnes*), reducing '
      + 'breakouts without the dryness and peeling common with chemical treatments like benzoyl peroxide. '
      + 'Regular use can help maintain clearer skin over time.</p>',
    after:
      '<h3>1. Helps Skin Look Clearer</h3>\n'
      + '<p>Its antibacterial action is why tea tree oil turns up in so many cleansers made for oily, '
      + 'blemish-prone skin. Used in a well-diluted wash, it helps skin look clearer and feel less '
      + 'congested, without the tight, flaky feeling harsher products can leave behind.</p>',
    expectedOccurrences: 1,
    mustContain: ['1.', 'antibacterial', 'clearer'],
    why:
      'Not on the brief\'s reported list and the strongest remaining claim after section 7. "Helps Fight '
      + 'Acne" is grammatically identical to "Fights Fungal Infections", which PR #645 rewrote on this '
      + 'same page — a therapeutic verb plus a disease name — so leaving it would make the two edits '
      + 'inconsistent on one article. The body compounds it by positioning the ingredient against '
      + 'benzoyl peroxide, an OTC DRUG: "as good as the drug, without the side effects" is the classic '
      + 'shape of an unapproved-drug claim.',
    bodyVerdict:
      'HEADING + BODY. Softening only the heading would have left "targets acne-causing bacteria … '
      + 'reducing breakouts" and the drug comparison, which are the claim. The cosmetic core survives '
      + 'intact — the same ingredient, the same product category, the same promise of skin that LOOKS '
      + 'clearer — so this narrows the register rather than the topic. "Blemish-prone" is the permitted '
      + 'vocabulary for the audience the section is written for.',
  },

  // ── 2 ───────────────────────────────────────────────────────────────────────
  {
    id: 's2-disease-list',
    gateSlot: 'meta',
    before:
      'This makes tea tree oil helpful for conditions like eczema, rosacea, and contact dermatitis when '
      + 'used in a diluted formulation.',
    after:
      'That is why tea tree oil is a common choice in products made for skin that reddens or reacts '
      + 'easily, always in a properly diluted formulation.',
    expectedOccurrences: 1,
    mustContain: ['tea tree oil', 'diluted formulation'],
    why:
      'Three named skin diseases in one sentence, with the oil asserted as "helpful for" them. Reported '
      + 'by the brief and confirmed live. RSC sells no eczema, rosacea or dermatitis product and may not '
      + 'target one; the audience the sentence is really describing — skin that reddens and reacts — is '
      + 'describable without naming a disease.',
    bodyVerdict:
      'HEADING ONLY in reverse: the BODY sentence changes and the HEADING is deliberately kept. '
      + '"2. Reduces Skin Inflammation" is clean at both tiers, "anti-inflammatory" is standard cosmetic '
      + 'ingredient vocabulary this corpus uses in the kept sections 6 and 11, and expanding the '
      + 'vocabulary to cover it would be a fleet-wide change CLAUDE.md says to measure first. The '
      + 'section\'s opening sentence ("Anti-inflammatory compounds calm redness and swelling") is also '
      + 'untouched — it is an appearance claim, which is what a cosmetic may make.',
  },

  // ── 6 ───────────────────────────────────────────────────────────────────────
  {
    id: 's6-scratching-infection',
    gateSlot: 'meta',
    before:
      '<p>Tea tree oil’s anti-inflammatory and antimicrobial properties help reduce itching caused by '
      + 'insect bites, rashes, or dry skin conditions. It also helps prevent scratching from leading to '
      + 'infection.</p>',
    after:
      '<p>Tea tree oil’s anti-inflammatory and antimicrobial properties are why it appears in products '
      + 'for dry, itchy-feeling skin. Well diluted, it helps skin feel calm and comfortable rather than '
      + 'tight and scratchy.</p>',
    expectedOccurrences: 1,
    mustContain: ['Tea tree oil’s anti-inflammatory and antimicrobial properties', 'itch'],
    why:
      'Reported by the brief and confirmed live. "Helps prevent scratching from leading to infection" is '
      + 'a prevention claim naming a disease outcome — the exact pair the blocking tier exists for.',
    bodyVerdict:
      'HEADING ONLY kept, BODY replaced in full — and the FIRST sentence was rewritten too, deliberately, '
      + 'even though it is clean at both tiers. The two sentences are one first-aid claim: relief of '
      + 'insect-bite and rash itch, then prevention of the infection that follows scratching. Dropping '
      + 'only the second leaves bite-relief framing with its qualifier removed, which is worse than '
      + 'either half. "6. Soothes Itchy Skin" stays — soothing the feel of skin is a cosmetic claim, and '
      + 'it is now exactly what the paragraph delivers.',
  },

  // ── 7 ───────────────────────────────────────────────────────────────────────
  {
    id: 's7-antiseptic-minor-cuts',
    gateSlot: 'meta',
    before:
      '<h3>7. Antiseptic for Minor Cuts</h3>\n'
      + '<p>Applying a properly diluted solution can help prevent infection in small wounds and scrapes '
      + 'while supporting faster healing.</p>',
    after:
      '<h3>7. An Everyday Clean for Hands and Body</h3>\n'
      + '<p>A properly diluted tea tree wash leaves hands and skin feeling clean and fresh — that is the '
      + 'cosmetic job this ingredient does. It is not a first-aid product; for cuts and scrapes use one, '
      + 'and see your healthcare provider about anything that does not settle.</p>',
    expectedOccurrences: 1,
    mustContain: ['7.', 'diluted'],
    why:
      'The brief called this as strong as the two PR #645 already fixed, and that is right — it is '
      + 'stronger. "Antiseptic" is not an adjective here, it is an FDA OTC drug category, and the '
      + 'sentence under it stacks a prevention claim ("help prevent infection"), a disease term '
      + '("wounds") and a therapeutic verb ("faster healing") into 22 words, on a page with a buy box. '
      + 'A cosmetic soap may not be an antiseptic for cuts under any wording.',
    bodyVerdict:
      'HEADING + BODY, and the section NARROWS — there is no honest cosmetic equivalent of first-aid '
      + 'antisepsis, so nothing of the old claim carries over. Per the brief, the narrowing is stated '
      + 'outright rather than implied: the new paragraph says in plain words that this is not a first-aid '
      + 'product and points the reader with a real cut at a real one. Slot 7 is refilled with what a '
      + 'diluted tea tree wash genuinely does — everyday cleansing of hands and body, distinct from '
      + 'section 4 (feet and freshness) and section 3 (smooth-looking skin), and the closest thing on '
      + 'this page to the product the CTA actually sells.',
  },

  // ── 10 ──────────────────────────────────────────────────────────────────────
  {
    id: 's10-mouth-rinse',
    gateSlot: 'meta',
    before:
      '<h3>10. Freshens Breath (with caution)</h3>\n'
      + '<p>When diluted properly in a mouth rinse, tea tree oil can help reduce oral bacteria. However, '
      + 'it should never be swallowed, as ingestion can be toxic.</p>',
    after:
      '<h3>10. A Calmer Feel After Shaving</h3>\n'
      + '<p>A tea tree wash or a well-diluted oil is a long-standing favorite for post-shave skin, where '
      + 'the goal is simply skin that feels calm and fresh rather than hot and tight. Keep it away from '
      + 'your eyes and mouth — tea tree oil is for external use only and is toxic if swallowed.</p>',
    expectedOccurrences: 1,
    mustContain: ['10.', 'tea tree oil', 'swallowed'],
    why:
      'Not a health-claim edit — see nonClaimRationale. The heading and paragraph are replaced because '
      + 'the section instructs oral use of an essential oil, not because of anything the gate matched.',
    nonClaimRationale:
      'The gate flags only ADVISORY `toxic` here, and it is right to: this is not a cosmetic-versus-drug '
      + 'claim, it is an UNSAFE-USE INSTRUCTION, which the gate is not built to see. The page tells a '
      + 'reader to put an essential oil in their mouth, gives no ratio, concentration or method, and '
      + 'warns in the same sentence that swallowing it is toxic. There is no RSC mouth rinse, so the '
      + 'section can never convert; on a page whose buy box sells a bar soap it is liability with no '
      + 'revenue behind it. Softening it was NOT an option — "use it carefully in a rinse" keeps the '
      + 'invitation, which is the hazard itself — so the honest answer is that the section does not '
      + 'belong on this page. It is refilled rather than deleted only because removing item 10 of 11 '
      + 'forces a renumber of item 11 plus the article title, the `<h2>`, the "11 ways" opening promise, '
      + 'the meta description and the local meta.json: an expensive diff on a live indexed page to '
      + 'remove one paragraph. Verified before deciding that the page keeps its "never ingest" warning '
      + 'twice over (the safety list and FAQ Q5), so no safety information leaves with the section — and '
      + 'the AFTER carries an external-use-only line of its own, retaining the word "toxic" so this edit '
      + 'cannot be mistaken for the advisory-tier over-correction the gate forbids.',
    bodyVerdict:
      'HEADING + BODY, replaced not softened. Slot 10 is refilled with post-shave feel — a real, '
      + 'ordinary use of tea tree oil, distinct from every other section on the page, and a pure '
      + 'feel claim.',
  },

  // ── myths ───────────────────────────────────────────────────────────────────
  {
    id: 'myth-works-instantly',
    gateSlot: 'meta',
    before:
      'While tea tree oil can quickly calm redness, full benefits — especially for acne or fungal '
      + 'infections — may take days to weeks of consistent use.',
    after:
      'While tea tree oil can quickly calm the look of redness, full benefits — especially on '
      + 'blemish-prone or rough-feeling skin — may take days to weeks of consistent use.',
    expectedOccurrences: 1,
    mustContain: ['tea tree oil', 'redness', 'days to weeks of consistent use'],
    why:
      'The myth-busting FRAME is kept — CLAUDE.md is explicit that a debunking section stays — but the '
      + 'sentence inside it asserts that full benefits for "fungal infections" do arrive with consistent '
      + 'use, hedged only on timing. That is the claim PR #645 rewrote section 4 to remove, re-entering '
      + 'the same page 60 lines later. A claim does not become editorial by sitting under a myth heading.',
    bodyVerdict:
      'HEADING ONLY kept ("It’s only for acne" is handled separately; "It works instantly" is untouched), '
      + 'one sentence replaced. The debunking answer — that results take days to weeks — is preserved '
      + 'word for word; only the two conditions it promised results for are replaced with the skin the '
      + 'page may honestly address.',
  },
  {
    id: 'myth-only-for-acne',
    gateSlot: 'meta',
    before:
      '<h3>"It’s only for acne"</h3>\n'
      + '<p>Tea tree oil’s antibacterial, antifungal, and anti-inflammatory effects make it useful for a '
      + 'wide range of skin and household needs.</p>',
    after:
      '<h3>"It’s only for blemishes"</h3>\n'
      + '<p>Tea tree oil’s antibacterial and anti-inflammatory properties make it useful for a wide range '
      + 'of skin and household needs.</p>',
    expectedOccurrences: 1,
    mustContain: ['It’s only for', 'Tea tree oil’s antibacterial', 'wide range of skin and household needs'],
    why:
      '"Antifungal" is the blocking word PR #645 named as decisive on the sibling coconut entry, and it '
      + 'is asserted flatly here as a property of the oil the page sells. "Antibacterial" is deliberately '
      + 'KEPT: it is not in the gate\'s vocabulary, the article\'s own CTA uses it, and it links to a live '
      + 'ranking post titled "Unscented Antibacterial Soap" — removing it would be a vocabulary change '
      + 'with a blast radius nobody has measured.',
    bodyVerdict:
      'HEADING + BODY. The heading is a myth the copywriter authored, not a quotation from a source, so '
      + 'restating it as "blemishes" costs nothing and keeps the page consistent with section 1, which no '
      + 'longer names the disease either. Everything the section is FOR — that tea tree oil is more than '
      + 'a single-purpose ingredient — survives unchanged.',
  },

  // ── FAQ (prose + JSON-LD, two occurrences each) ─────────────────────────────
  {
    id: 'faq-q1-question',
    gateSlot: 'title',
    before: 'Can tea tree oil help with acne?',
    after: 'Is tea tree oil good for blemish-prone skin?',
    expectedOccurrences: 2,
    mustContain: ['tea tree oil'],
    why:
      'A question a brand asks and answers about its own product is marketing copy, not neutral '
      + 'reference. It occurs twice: as visible prose and inside the JSON-LD FAQPage block, which is the '
      + 'copy Google may render as a rich result — the mirrored-into-schema shape PR #634 called its '
      + 'highest-severity find. Replacing both in one entry is what stops the two drifting apart.',
    bodyVerdict:
      'Paired with faq-q1-answer. Two entries rather than one block so the `<strong>`/`<br>` prose '
      + 'wrapper and the JSON-LD wrapper are each left untouched around the replaced text.',
  },
  {
    id: 'faq-q1-answer',
    gateSlot: 'meta',
    before:
      'Yes, studies show tea tree oil reduces acne-causing bacteria and calms inflammation without the '
      + 'dryness of harsher treatments.',
    after:
      'Yes. It is one of the most common ingredients in cleansers made for oily, blemish-prone skin, '
      + 'because it helps skin look clearer and feel fresh without the tight, flaky feeling harsher '
      + 'products can leave.',
    expectedOccurrences: 2,
    mustContain: ['Yes', 'harsher'],
    why:
      'Three problems in one sentence: an unsourced substantiation claim ("studies show"), a disease '
      + 'name, and a comparison to "treatments". This is the answer PR #634\'s scan would have flagged if '
      + 'its BODY bucket had covered article prose; it did not, which is why it is here. Like the '
      + 'question, it occurs twice — prose and JSON-LD.',
    bodyVerdict:
      'Paired with faq-q1-question. The affirmative answer survives ("Yes") and so does the contrast '
      + 'with harsher products, which is the useful part; what goes is the citation nobody can produce '
      + 'and the disease it was cited for.',
  },
  {
    id: 'faq-q3-spot-treatment',
    gateSlot: 'meta',
    before:
      'Use a diluted formula as a spot treatment, in cleansers, or in gentle bar soaps like our Tea Tree '
      + 'Bar Soap.',
    after:
      'Use a diluted formula as a targeted application, in cleansers, or in gentle bar soaps like our '
      + 'Tea Tree Bar Soap.',
    expectedOccurrences: 2,
    mustContain: ['Use a diluted formula', 'in cleansers, or in gentle bar soaps like our Tea Tree Bar Soap.'],
    why:
      'The smallest edit in the plan and the same call PR #645 made on '
      + '`As an Overnight Spot Treatment`: "spot treatment" is ordinary industry vocabulary, but '
      + '"treatment" is a therapeutic noun and this sentence names the product being sold in the same '
      + 'breath. One word changes; every ranking token survives. Occurs twice — prose and JSON-LD.',
    bodyVerdict:
      'Mirror of the PR #645 precedent rather than a fresh judgement — HEADING ONLY has no analogue for '
      + 'an FAQ answer, so this is the sentence-level equivalent: one noun, nothing else.',
  },
].map((e) => ({ ...e, target: ARTICLE() }));

/**
 * The local mirror. Byte-identical strings — verified against the committed file
 * by the test suite, not promised here — because a republish from
 * `data/posts/<slug>/content.html` would otherwise push every claim back.
 */
const MIRRORS = LIVE.map((e) => ({
  ...e,
  id: `mirror-${e.id}`,
  target: FILE(),
  why: `Byte-identical mirror of ${e.id}, so a republish cannot push the claim back.`,
  bodyVerdict: `Mirror of ${e.id} — see that entry for the verdict.`,
  ...(e.nonClaimRationale ? { nonClaimRationale: `Mirror of ${e.id}. ${e.nonClaimRationale}` } : {}),
}));

/** @type {PlanEntry[]} */
export const PLAN = [...LIVE, ...MIRRORS];

/**
 * Every section examined and DELIBERATELY LEFT ALONE, with the reason.
 *
 * The brief asked for a verdict on every section, and a plan can only show the
 * ones that changed. Without this list "we judged it and kept it" and "we never
 * looked" are indistinguishable six weeks later — which is exactly the ambiguity
 * PR #645's header prose was written to close, promoted here to data so a test can
 * check it. Each `excerpt` is a literal from the live article; the suite asserts it
 * is still present in the committed mirror and that no PLAN entry overlaps it, so
 * a later pass cannot quietly rewrite something recorded as a considered keep.
 *
 * @type {Array<{id:string, excerpt:string, verdict:string}>}
 */
export const KEPT = [
  {
    id: 'top-cta-antibacterial-power',
    excerpt: 'blends organic oils with tea tree’s natural',
    verdict:
      'KEEP. Product-as-subject, and it survived PR #634\'s CTA sweep. "Antibacterial" is not in the '
      + 'gate\'s vocabulary at either tier, the site runs a live ranking post called "Unscented '
      + 'Antibacterial Soap: What to Look For & Why", and live copy now links this very phrase to it. '
      + 'Blocking it is a vocabulary expansion with an unmeasured blast radius — the same mistake the '
      + 'toxicity tier exists to prevent.',
  },
  {
    id: 'history-healing-vapors',
    excerpt: 'Indigenous Bundjalung people crushed its leaves to inhale the healing vapors',
    verdict:
      'KEEP, despite two blocking-tier "healing" hits. The subject is a historical practice, not a '
      + 'product: what Bundjalung people did with crushed leaves, and why 1920s Australian chemists '
      + 'commercialised the oil. No efficacy is asserted to the reader and nothing on sale is the subject '
      + 'of any verb. This is the same reasoning that kept PR #645\'s Satchell 2002 citation verbatim — '
      + 'rewriting an accurate historical statement makes the page less accurate, not safer.',
  },
  {
    id: 'how-it-works-mechanism',
    excerpt: 'terpinen-4-ol is its star player',
    verdict:
      'KEEP. Clean at both tiers. Ingredient mechanism reported about a compound, naming no condition; '
      + 'the outcomes it claims ("soothing irritation, redness, and swelling") are appearance and feel, '
      + 'which is precisely what a cosmetic may say.',
  },
  {
    id: 's2-heading-inflammation',
    excerpt: '<h3>2. Reduces Skin Inflammation</h3>',
    verdict:
      'KEEP while the section BODY is rewritten (see s2-disease-list). Clean at both tiers, and '
      + '"anti-inflammatory" is standard cosmetic-ingredient vocabulary used in the kept sections 6 and '
      + '11 and in the kept mechanism paragraph. Promoting it to blocking is a fleet-wide vocabulary '
      + 'change CLAUDE.md requires be measured first, and doing it inside a single-post pass would be '
      + 'the over-correction the brief warns against.',
  },
  {
    id: 's5-deodorizer',
    excerpt: '<h3>5. Natural Deodorizer</h3>',
    verdict:
      'KEEP. Clean at both tiers, and deodorancy is an ordinary cosmetic claim — the same call PR #645 '
      + 'made when it rewrote a coconut heading INTO "Naturally Odor-Fighting".',
  },
  {
    id: 's6-heading-itchy',
    excerpt: '<h3>6. Soothes Itchy Skin</h3>',
    verdict:
      'KEEP while the body is rewritten (see s6-scratching-infection). "Soothes" acts on how skin feels, '
      + 'not on a condition, and after the body rewrite the heading is an accurate label for what the '
      + 'section now says.',
  },
  {
    id: 's8-scalp-health',
    excerpt: '<h3>8. Improves Scalp Health</h3>',
    verdict:
      'KEEP. Clean at both tiers — "dandruff" is not in the gate\'s vocabulary — and this is the purest '
      + '"information about an ingredient" case on the page: RSC sells no hair or scalp product, so there '
      + 'is nothing for an intended-use reading to attach to. CLAUDE.md already records `hair` as a '
      + 'cluster this catalogue does not serve.',
  },
  {
    id: 's9-household-cleaner',
    excerpt: '<h3>9. Natural Household Cleaner</h3>',
    verdict:
      'KEEP. Clean at both tiers. "Surface disinfectant" is an EPA question about neat essential oil, not '
      + 'an FDA intended-use claim about a cosmetic, and RSC sells no household cleaner for the sentence '
      + 'to be about.',
  },
  {
    id: 's11-skin-barrier',
    excerpt: '<h3>11. Supports Healthy Skin Barrier</h3>',
    verdict:
      'KEEP. Clean at both tiers, and CLAUDE.md cites this exact heading as the house register the '
      + 'vanilla rewrite ("Supports Skin Resilience") was written to match. Rewriting the model would be '
      + 'incoherent.',
  },
  {
    id: 'mid-cta-acne-prone',
    excerpt: 'perfect for acne-prone and sensitive skin alike',
    verdict:
      'KEEP, despite a blocking-tier "acne" hit, and this is the one place on the page the word stays. '
      + 'The product is the subject but the claim is SUITABILITY FOR A SKIN TYPE, not treatment of a '
      + 'condition — the standard cosmetic formulation, and the case CLAUDE.md names outright when it '
      + 'lists "Oily or Acne-Prone Skin" among the headings that stay. Every other "acne" on the page is '
      + 'an efficacy claim and every one of those is rewritten.',
  },
  {
    id: 'myth-undiluted-safety',
    excerpt: 'Undiluted tea tree oil can cause irritation, redness, and even allergic reactions.',
    verdict:
      'KEEP. Clean at both tiers, and it is a safety warning against the product\'s own misuse — the '
      + 'debunking frame CLAUDE.md protects. Softening a warning is the one direction this pass must '
      + 'never move.',
  },
  {
    id: 'safety-never-ingest',
    excerpt: 'Avoid contact with eyes and never ingest.',
    verdict:
      'KEEP, and load-bearing for s10-mouth-rinse: it is one of the two places the "never ingest" '
      + 'warning survives the removal of the mouth-rinse section, which is what made refilling slot 10 '
      + 'safe rather than a quiet loss of a safety line.',
  },
  {
    id: 'faq-q5-side-effects',
    excerpt: 'Undiluted use can cause irritation or allergic reactions. Never ingest tea tree oil.',
    verdict:
      'KEEP. The second surviving "never ingest" warning, and it appears twice (prose + JSON-LD), so the '
      + 'rich result carries it too.',
  },
  {
    id: 'related-toxic-chemicals-link',
    excerpt: 'Toxic Chemicals in Soap to Keep an Eye On',
    verdict:
      'KEEP. Advisory-tier `toxic` only, and it is the title of another live RSC article — the exact '
      + 'category the gate deliberately never blocks, because a page ranking on "toxic chemicals in soap" '
      + 'cannot be retitled without the word.',
  },
];

// --- pure helpers (exported for the tests) ------------------------------------

/**
 * Re-gate every AFTER in the slot its entry declares.
 *
 * `checkSeoCopy` takes an OBJECT and returns `ok: true` for a bare string, so the
 * slot is named explicitly on every call — a silent free pass here would defeat
 * the whole point of gating a remediation that exists because of a bad write.
 */
export function gatePlan(plan) {
  const failures = [];
  for (const e of plan) {
    const res = checkSeoCopy({ [e.gateSlot]: e.after });
    if (!res.ok) {
      failures.push({ id: e.id, matches: res.blocking.map((b) => b.match) });
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Human label for logs and the run record. */
export function targetLabel(target) {
  return target.kind === 'article'
    ? `${target.slug} [${target.field} #${target.articleId}]`
    : target.path;
}

/** Filesystem-safe basename for a backup file. */
export function backupName(entry) {
  return `${entry.id}.txt`.replace(/[^a-z0-9.@_-]/gi, '_');
}

// --- runner -------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_DIR = join(ROOT, 'data/reports/health-claim-remediation/tea-tree-11-benefits');

async function main(argv) {
  const apply = argv.includes('--apply');
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;

  const plan = only ? PLAN.filter((e) => e.id === only) : PLAN;
  if (!plan.length) {
    console.error(only ? `No plan entry with id "${only}".` : 'Plan is empty.');
    process.exitCode = 1;
    return;
  }

  const gate = gatePlan(plan);
  if (!gate.ok) {
    console.error('ABORT — a planned rewrite does not pass checkSeoCopy:');
    for (const f of gate.failures) console.error(`  ${f.id}: ${f.matches.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Gate: ${plan.length}/${plan.length} planned rewrites pass checkSeoCopy.\n`);

  const needsShopify = plan.some((e) => e.target.kind === 'article');
  // Imported lazily so a `--help`-shaped mistake, and the tests, never need creds.
  const shopify = needsShopify ? await import('../lib/shopify.js') : null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(REPORT_DIR, 'backups', stamp);
  mkdirSync(backupDir, { recursive: true });

  const results = [];
  const articleCache = new Map();
  const getCached = async (blogId, articleId) => {
    const key = `${blogId}/${articleId}`;
    if (!articleCache.has(key)) articleCache.set(key, await shopify.getArticle(blogId, articleId));
    return articleCache.get(key);
  };

  for (const e of plan) {
    const row = {
      id: e.id,
      target: targetLabel(e.target),
      kind: e.target.kind,
      why: e.why,
      body_verdict: e.bodyVerdict,
      ...(e.nonClaimRationale ? { non_claim_rationale: e.nonClaimRationale } : {}),
    };
    try {
      let current;
      let filePath;

      if (e.target.kind === 'article') {
        const art = await getCached(e.target.blogId, e.target.articleId);
        current = String(art[e.target.field] ?? '');
      } else {
        filePath = join(ROOT, e.target.path);
        if (!existsSync(filePath)) {
          row.action = 'missing';
          console.log(`! ${e.id} — ${e.target.path} does not exist; skipped.`);
          results.push(row);
          continue;
        }
        current = readFileSync(filePath, 'utf8');
      }

      // Backup BEFORE anything is decided, so a drifted value is captured too.
      writeFileSync(join(backupDir, backupName(e)), current);
      row.backup = join(
        'data/reports/health-claim-remediation/tea-tree-11-benefits/backups', stamp, backupName(e),
      );

      const verdict = classifyBody(current, e);
      row.action = verdict.action;
      row.occurrences = verdict.found;

      if (verdict.action === 'already-applied') {
        console.log(`= ${e.id} already remediated — skipping.`);
        results.push(row);
        continue;
      }
      if (verdict.action === 'drift') {
        row.expected_occurrences = e.expectedOccurrences;
        console.log(
          `! ${e.id} DRIFTED — found ${verdict.found} occurrence(s) of BEFORE, expected `
          + `${e.expectedOccurrences}. Nothing written.`,
        );
        console.log(`    target:   ${targetLabel(e.target)}`);
        console.log(`    expected: ${JSON.stringify(e.before.slice(0, 140))}`);
        results.push(row);
        continue;
      }

      const next = replaceAll(current, e.before, e.after);
      row.before = e.before;
      row.after = e.after;

      console.log(`${apply ? '→' : '·'} ${e.id}  (${targetLabel(e.target)})`);
      console.log(`    BEFORE: ${JSON.stringify(e.before)}`);
      console.log(`    AFTER:  ${JSON.stringify(e.after)}`);

      if (!apply) {
        row.written = false;
        results.push(row);
        continue;
      }

      if (e.target.kind === 'article') {
        await shopify.updateArticle(e.target.blogId, e.target.articleId, { [e.target.field]: next });
        // Drop the cache so the next entry on the same article re-reads the value
        // this write just produced, instead of replacing into a stale copy. Every
        // live entry here targets the SAME article, so this is not optional.
        articleCache.delete(`${e.target.blogId}/${e.target.articleId}`);
      } else {
        writeFileSync(filePath, next);
      }
      row.written = true;
      console.log('    written.');
    } catch (err) {
      row.action = 'error';
      row.error = err.message;
      console.error(`✗ ${e.id} — ${err.message}`);
    }
    results.push(row);
  }

  const record = {
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    post: SLUG,
    article_id: ARTICLE_ID,
    backup_dir: join('data/reports/health-claim-remediation/tea-tree-11-benefits/backups', stamp),
    planned: plan.length,
    written: results.filter((r) => r.written).length,
    already_applied: results.filter((r) => r.action === 'already-applied').length,
    drifted: results.filter((r) => r.action === 'drift').length,
    missing: results.filter((r) => r.action === 'missing').length,
    errors: results.filter((r) => r.action === 'error').length,
    results,
    kept: KEPT,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));

  console.log(
    `\n${record.mode}: ${record.written} written, ${record.already_applied} already applied, `
    + `${record.drifted} drifted, ${record.missing} missing, ${record.errors} errors.`,
  );
  console.log(`${KEPT.length} section(s) examined and deliberately left alone — see \`kept\` in the run record.`);
  console.log(`Run record: data/reports/health-claim-remediation/tea-tree-11-benefits/${stamp}.json`);
  if (!apply) console.log('Dry run — nothing was written. Re-run with --apply.');
  if (record.drifted || record.errors || record.missing) process.exitCode = 1;
}

// Guarded: importing this module must not run it (reference_agents_run_on_import).
if (isDirectRun(import.meta.url)) {
  await main(process.argv.slice(2));
}
