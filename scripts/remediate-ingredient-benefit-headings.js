#!/usr/bin/env node
/**
 * Tone down the six ingredient-benefit HEADINGS that are live on realskincare.com.
 *
 *   node scripts/remediate-ingredient-benefit-headings.js            # DRY RUN (default)
 *   node scripts/remediate-ingredient-benefit-headings.js --apply    # write Shopify + local mirrors
 *   node scripts/remediate-ingredient-benefit-headings.js --only <id>
 *
 * ── Why this is a SIBLING of scripts/remediate-live-health-claims.js ────────────
 *
 * That script (PR #634, 2026-08-23) cleaned the excerpts, one `description_tag`
 * and two product-CTA `<h2>`s. It deliberately LEFT this set as borderline: each
 * one describes an INGREDIENT rather than the product, and none sits in a CTA.
 * The operator overruled that on 2026-08-23 — "tone them down" — so they get
 * their own plan rather than being appended to a plan whose header records the
 * opposite decision. The mechanics (`occurrences`, `replaceAll`, `classifyBody`)
 * are IMPORTED from that script, never re-declared: a second copy of the drift
 * guard is a second copy that drifts, the same rule that makes
 * `lib/seo-copy-health-gate.js` import its patterns instead of restating them.
 *
 * ── Why "it's about an ingredient" is a weaker defence than it sounds ───────────
 *
 * FDA reads intended use from the whole page. Every one of these five articles
 * carries a buy box for an RSC product a few hundred pixels below the heading —
 * coconut body lotion, coconut oil lip balm, the Tea Tree Bar Soap variant of
 * `/products/coconut-soap`, the foaming hand soap. A `<h3>` reading "Fights
 * Fungal Infections" on a page selling soap is an intended-use claim whatever the
 * grammatical subject of the sentence is. `4. Fights Fungal Infections` names
 * three diseases outright and is the strongest case in the set.
 *
 * ── Why some entries change the section BODY and most do not ───────────────────
 *
 * Softening a heading while the paragraph under it still makes the claim achieves
 * nothing, so every section body was read before a heading was touched. Three
 * outcomes, recorded per entry in `bodyVerdict`:
 *
 *   - body is already cosmetic → HEADING ONLY. The coconut-oil overnight section
 *     talks about cracked heels and rough elbows; the vanilla section is doubly
 *     hedged ("traditional use and emerging research suggest … may support").
 *     Only the heading's own word was the problem.
 *   - body IS the claim → HEADING + BODY, replaced together as one block. Both
 *     tea-tree "11 benefits" entries: "may promote faster recovery of minor cuts
 *     and abrasions", and "effective against athlete's foot, ringworm, and yeast
 *     infections". A heading-only edit there would have been cosmetic in the
 *     wrong sense.
 *   - body is cited third-party research, with ONE product-subject sentence →
 *     the heading and that one sentence change, the research stays. The
 *     `tea-tree-oil-soap` section reports Satchell et al. 2002 accurately; that
 *     is editorial about the oil and rewriting it would make the page LESS
 *     accurate (the same reasoning that spared the stretch-mark posts). What did
 *     not survive is "Using a tea tree oil antifungal SOAP … may help manage
 *     these conditions", where a product is the subject of the verb.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────────
 *
 * The scan around these six turned up neighbours that were left alone on purpose,
 * so nobody re-litigates them from the raw grep:
 *
 *   - `tea-tree-oil-soap-…`'s sibling `<h3>Antibacterial Properties</h3>` and
 *     `<h3>Acne and Blemish-Prone Skin</h3>`, both under an "Evidence-Backed
 *     Benefits" `<h2>` and both citing named journals. They are the editorial
 *     majority case CLAUDE.md warns against rewriting, and neither was on the
 *     operator's list. Flagged in the report, not changed.
 *   - the same article's `11-benefits` neighbours 2, 6, 7 and 10 ("eczema,
 *     rosacea, and contact dermatitis", "prevent scratching from leading to
 *     infection", "Antiseptic for Minor Cuts", a mouth rinse). That post has a
 *     wider problem than six headings and needs its own editorial pass through
 *     `scripts/remediate-live-post.js`.
 *   - `coconut-oil-for-skin-…`'s `<h2>Can Coconut Oil Help With Eczema?</h2>`,
 *     which is a hedged Q&A ending "always check with your doctor". That is the
 *     debunking frame, and softening it would make the page less useful.
 *
 * ── Local mirrors ──────────────────────────────────────────────────────────────
 *
 * `agents/publisher` republishes from `data/posts/<slug>/content.html`, so a live
 * fix that is not mirrored is a fix a republish undoes — the trap PR #634 found
 * with `summary_html`. Four mirror entries, and one of them is NOT a copy of the
 * live string: `why-choose-coconut-skin-care-products/content.html` is an older
 * draft carrying `<h3>5. Naturally Antibacterial</h3>` (live says `4. Naturally
 * Antibacterial and Antifungal`). It is toned down on its own terms rather than
 * skipped, because it is the file a republish would push. Two of the five slugs
 * have no mirror at all: `tea-tree-oil-soap-benefits-uses-what-to-look-for` has
 * no `data/posts/` directory, and `coconut-oil-for-skin-…`'s local file is a
 * different, older article with no overnight section in it.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────────
 *
 * - Dry by default. `--apply` is the only thing that writes, to Shopify OR to disk.
 * - Idempotent: an entry whose target already contains AFTER and not BEFORE is skipped.
 * - Never blind-overwrites: BEFORE must occur exactly `expectedOccurrences` times or
 *   the entry is SKIPPED as drift and reported. Literal matching, never regex.
 * - Every AFTER is re-gated through `checkSeoCopy` at run time, in the slot the entry
 *   declares. One failure aborts the whole run before anything is read or written.
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

const BLOG_ID = 48998449187; // "news", the only blog carrying these articles

const ARTICLE = (slug, articleId) => ({ kind: 'article', slug, blogId: BLOG_ID, articleId, field: 'body_html' });
const FILE = (path) => ({ kind: 'file', path });

/**
 * @typedef {object} PlanEntry
 * @property {string} id                     stable key, also the `--only` argument
 * @property {{kind:'article'|'file'}} target where the write lands
 * @property {'title'|'meta'} gateSlot        which checkSeoCopy slot AFTER is gated in —
 *                                            'title' for a bare heading, 'meta' for prose
 * @property {string} before                  exact literal substring, machine-extracted
 * @property {string} after
 * @property {number} expectedOccurrences
 * @property {string[]} mustContain           tokens that must survive BEFORE → AFTER, in order
 * @property {string} why                     why this is a claim and not editorial
 * @property {string} bodyVerdict             what reading the section body decided
 */

/** @type {PlanEntry[]} */
export const PLAN = [
  // ── 1. why-choose-coconut-skin-care-products ────────────────────────────────
  {
    id: 'coconut-why-antibacterial-antifungal',
    target: ARTICLE('why-choose-coconut-skin-care-products', 559604236458),
    gateSlot: 'title',
    before: '<h3>4. Naturally Antibacterial and Antifungal</h3>',
    after: '<h3>4. Naturally Odor-Fighting</h3>',
    expectedOccurrences: 1,
    mustContain: ['4. Naturally'],
    why:
      '"Antifungal" is an OTC drug category, not a cosmetic attribute, and the heading asserts the '
      + 'property flatly rather than reporting it. The post is a "why choose these products" piece with '
      + 'a Coconut Body Lotion buy box two sections below, so the page as a whole reads as the product '
      + 'speaking. Deodorancy — what the section actually evidences — is an ordinary cosmetic claim.',
    bodyVerdict:
      'HEADING ONLY. The paragraph is already about odor ("reduced odor-causing bacteria", "targets the '
      + 'bacteria responsible for body odor") and hedges the rest ("may help minimize minor breakouts"). '
      + 'Its one lab-study sentence is about monolaurin as a compound, not about what the product does '
      + 'for the reader, and with the heading no longer asserting the property it reads as ingredient '
      + 'science. Nothing in it needed changing.',
  },

  // ── 2. 11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life ────
  {
    id: 'tea-tree-11-wound-healing',
    target: ARTICLE('11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life', 559520252074),
    gateSlot: 'meta',
    before:
      '<h3>3. Supports Wound Healing</h3>\n'
      + '<p>By reducing inflammation and preventing bacterial growth, tea tree oil may promote faster '
      + 'recovery of minor cuts and abrasions. It also helps minimize the risk of scarring by supporting '
      + 'healthy skin regeneration.</p>',
    after:
      '<h3>3. Supports Smooth-Looking Skin</h3>\n'
      + '<p>By calming the look of redness and supporting a balanced skin surface, tea tree oil is a '
      + 'common choice for people who want skin to look smooth and even. It is a cosmetic ingredient, '
      + 'not a first-aid product.</p>',
    expectedOccurrences: 1,
    mustContain: ['3.', 'tea tree oil'],
    why:
      'A wound-care claim on a page whose mid-article CTA sells the Tea Tree Bar Soap variant of '
      + '/products/coconut-soap. "Wound" is a disease term and "healing" is a therapeutic verb with the '
      + 'oil as its subject; the appearance claim underneath it (smooth, even-looking skin) is the part '
      + 'a cosmetic may keep.',
    bodyVerdict:
      'HEADING + BODY. The paragraph carries the claim on its own — "may promote faster recovery of '
      + 'minor cuts and abrasions", "minimize the risk of scarring". Softening only the heading would '
      + 'have left the sentence that matters, so both are replaced as one block. The section necessarily '
      + 'narrows: a therapeutic benefit has no honest cosmetic equivalent, and the explicit "not a '
      + 'first-aid product" line is there so the narrowing is visible to a reader rather than implied.',
  },
  {
    id: 'tea-tree-11-fungal-infections',
    target: ARTICLE('11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life', 559520252074),
    gateSlot: 'meta',
    before:
      '<h3>4. Fights Fungal Infections</h3>\n'
      + '<p>Tea tree oil is a natural antifungal, effective against athlete’s foot, ringworm, and '
      + 'yeast infections. It works by disrupting the fungal cell membranes, stopping their growth and '
      + 'spread.</p>',
    after:
      '<h3>4. Keeps Feet and Skin Feeling Fresh</h3>\n'
      + '<p>Tea tree oil’s terpinen-4-ol is the reason it turns up in foot soaks, gym-bag sprays and '
      + 'everyday washes. Used properly diluted, it helps skin feel clean and fresh. For a persistent '
      + 'skin concern, see a healthcare provider.</p>',
    expectedOccurrences: 1,
    mustContain: ['4.', 'Tea tree oil'],
    why:
      'The strongest case in the set. The heading names a disease category and the paragraph names three '
      + 'specific ones (athlete’s foot, ringworm, yeast infections) with an unhedged efficacy claim '
      + '("effective against"). On a page selling soap that is textbook unapproved-drug intended use, and '
      + 'no rewording of the heading alone rescues it.',
    bodyVerdict:
      'HEADING + BODY. Nothing in the paragraph survives — "is a natural antifungal", "effective against", '
      + 'and the mechanism sentence exists only to support the efficacy claim. Replaced with the cosmetic '
      + 'reason the ingredient is actually in a soap bar (freshness) plus a see-a-provider pointer, which '
      + 'is what the section should have said to a reader with a real problem.',
  },

  // ── 3. tea-tree-oil-soap-benefits-uses-what-to-look-for ─────────────────────
  {
    id: 'tea-tree-soap-antifungal-heading',
    target: ARTICLE('tea-tree-oil-soap-benefits-uses-what-to-look-for', 563577487530),
    gateSlot: 'title',
    before: '<h3>Antifungal Support</h3>',
    after: '<h3>Studied for Everyday Foot Care</h3>',
    expectedOccurrences: 1,
    mustContain: [],
    why:
      'Sits under "The Evidence-Backed Benefits of Tea Tree Oil Soap" — the `<h2>` names the SOAP, so the '
      + '`<h3>` beneath it reads as a property of the product, and "antifungal" is a drug category. The '
      + 'heading is also the scannable element: it is what a reader skimming, and what a SERP snippet, '
      + 'picks up. mustContain is deliberately empty — nothing in "Antifungal Support" is a claim a '
      + 'cosmetic may keep, so nothing carries over; the section subject (foot care) does.',
    bodyVerdict:
      'HEADING + ONE SENTENCE. The paragraph is cited third-party research (Satchell et al., 2002, '
      + 'Australasian Journal of Dermatology) reported accurately about the OIL, which is the editorial '
      + 'majority case CLAUDE.md says not to rewrite — removing it would make the page less accurate. '
      + 'Only the final sentence took a PRODUCT as the subject of the verb, and that is the one that '
      + 'changes (see tea-tree-soap-antifungal-clause). The research sentences keep the words "antifungal '
      + 'activity" and "ringworm" on purpose: a documented finding about an ingredient is not an '
      + 'intended-use claim about this catalogue.',
  },
  {
    id: 'tea-tree-soap-antifungal-clause',
    target: ARTICLE('tea-tree-oil-soap-benefits-uses-what-to-look-for', 563577487530),
    gateSlot: 'meta',
    before:
      'Using a tea tree oil antifungal soap on affected areas as part of daily hygiene may help manage '
      + 'these conditions — though persistent or spreading infections should always be evaluated by '
      + 'a healthcare provider.',
    after:
      'Tea tree oil soap is a cosmetic cleanser rather than a medicine, so use it as part of a daily '
      + 'hygiene routine — and see a healthcare provider about any persistent or spreading skin '
      + 'concern.',
    expectedOccurrences: 1,
    mustContain: ['tea tree oil', 'daily hygiene', 'healthcare provider'],
    why:
      'The one sentence in an otherwise-editorial section where a PRODUCT is the subject: "Using a tea '
      + 'tree oil antifungal soap … may help manage these conditions". That is the line the two tiers of '
      + 'the gate draw — "the product does X" is a claim, "here is information about X" is not. The '
      + 'see-a-provider advice it already carried is kept and promoted, not dropped.',
    bodyVerdict:
      'Paired with tea-tree-soap-antifungal-heading. Two entries rather than one block so the research '
      + 'sentences between them are visibly untouched in the run record.',
  },

  // ── 4. coconut-oil-for-skin-ultimate-guide-… ────────────────────────────────
  {
    id: 'coconut-guide-overnight-spot-treatment',
    target: ARTICLE('coconut-oil-for-skin-ultimate-guide-to-benefits-and-potential-downsides', 562063114410),
    gateSlot: 'title',
    before: '<h3>As an Overnight Spot Treatment</h3>',
    after: '<h3>As an Overnight Layer for Rough Spots</h3>',
    expectedOccurrences: 1,
    mustContain: ['As an Overnight'],
    why:
      'The mildest of the six and the only one where a single word is the whole problem. "Spot treatment" '
      + 'is ordinary industry vocabulary, but "treatment" is a therapeutic noun and this is a how-to '
      + 'section on a page selling body lotion. "Layer" is the word the paragraph itself already uses '
      + '("apply a generous layer at night"), so the heading now matches its own instructions.',
    bodyVerdict:
      'HEADING ONLY. The paragraph is entirely cosmetic — cracked heels, rough elbows, socks, "visible '
      + 'within a week". No disease, no therapeutic verb, nothing to soften. Rewriting it would have been '
      + 'the over-correction the brief warns about.',
  },

  // ── 5. incorporating-vanilla-skin-care-into-your-beauty-regimen ─────────────
  {
    id: 'vanilla-supports-skin-healing',
    target: ARTICLE('incorporating-vanilla-skin-care-into-your-beauty-regimen', 559636119722),
    gateSlot: 'title',
    before: '<h3>3. Supports Skin Healing</h3>',
    after: '<h3>3. Supports Skin Resilience</h3>',
    expectedOccurrences: 1,
    mustContain: ['3. Supports Skin'],
    why:
      '"Healing" is a therapeutic verb and the heading states it flatly, while the paragraph beneath it '
      + 'is careful. A heading a reader scans should not promise more than the sentence under it does. '
      + '"Resilience" is the register the corpus already uses for the same idea ("Supports Healthy Skin '
      + 'Barrier" on the tea-tree post), so it reads as house style rather than a hedge.',
    bodyVerdict:
      'HEADING ONLY. The paragraph is doubly hedged and attributes the effect to the ingredient, not the '
      + 'product: "Traditional use and emerging research suggest vanilla’s antioxidant and '
      + 'antibacterial activity MAY SUPPORT the skin’s natural repair processes." That is '
      + 'information about an ingredient, and it is what the new heading now promises — no more.',
  },

  // ── Local mirrors — data/posts/<slug>/content.html ──────────────────────────
  {
    id: 'mirror-tea-tree-11-wound-healing',
    target: FILE('data/posts/11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life/content.html'),
    gateSlot: 'meta',
    before:
      '<h3>3. Supports Wound Healing</h3>\n'
      + '<p>By reducing inflammation and preventing bacterial growth, tea tree oil may promote faster '
      + 'recovery of minor cuts and abrasions. It also helps minimize the risk of scarring by supporting '
      + 'healthy skin regeneration.</p>',
    after:
      '<h3>3. Supports Smooth-Looking Skin</h3>\n'
      + '<p>By calming the look of redness and supporting a balanced skin surface, tea tree oil is a '
      + 'common choice for people who want skin to look smooth and even. It is a cosmetic ingredient, '
      + 'not a first-aid product.</p>',
    expectedOccurrences: 1,
    mustContain: ['3.', 'tea tree oil'],
    why: 'Byte-identical mirror of tea-tree-11-wound-healing, so a republish cannot push the claim back.',
    bodyVerdict: 'Mirror of a HEADING + BODY entry — see tea-tree-11-wound-healing.',
  },
  {
    id: 'mirror-tea-tree-11-fungal-infections',
    target: FILE('data/posts/11-benefits-of-incorporating-tea-tree-oil-into-your-everyday-life/content.html'),
    gateSlot: 'meta',
    before:
      '<h3>4. Fights Fungal Infections</h3>\n'
      + '<p>Tea tree oil is a natural antifungal, effective against athlete’s foot, ringworm, and '
      + 'yeast infections. It works by disrupting the fungal cell membranes, stopping their growth and '
      + 'spread.</p>',
    after:
      '<h3>4. Keeps Feet and Skin Feeling Fresh</h3>\n'
      + '<p>Tea tree oil’s terpinen-4-ol is the reason it turns up in foot soaks, gym-bag sprays and '
      + 'everyday washes. Used properly diluted, it helps skin feel clean and fresh. For a persistent '
      + 'skin concern, see a healthcare provider.</p>',
    expectedOccurrences: 1,
    mustContain: ['4.', 'Tea tree oil'],
    why: 'Byte-identical mirror of tea-tree-11-fungal-infections, so a republish cannot push the claim back.',
    bodyVerdict: 'Mirror of a HEADING + BODY entry — see tea-tree-11-fungal-infections.',
  },
  {
    id: 'mirror-vanilla-supports-skin-healing',
    target: FILE('data/posts/incorporating-vanilla-skin-care-into-your-beauty-regimen/content.html'),
    gateSlot: 'title',
    before: '<h3>3. Supports Skin Healing</h3>',
    after: '<h3>3. Supports Skin Resilience</h3>',
    expectedOccurrences: 1,
    mustContain: ['3. Supports Skin'],
    why: 'Byte-identical mirror of vanilla-supports-skin-healing, so a republish cannot push the claim back.',
    bodyVerdict: 'Mirror of a HEADING ONLY entry — see vanilla-supports-skin-healing.',
  },
  {
    id: 'mirror-coconut-why-antibacterial-stale-draft',
    target: FILE('data/posts/why-choose-coconut-skin-care-products/content.html'),
    gateSlot: 'meta',
    before:
      '<h3>5. Naturally Antibacterial</h3>\n'
      + '<p>Thanks to lauric acid, coconut oil also offers mild antibacterial and antifungal benefits, '
      + 'which may help minimize breakouts and soothe minor skin irritations when used gently and '
      + 'correctly.</p>',
    after:
      '<h3>5. Naturally Odor-Fighting</h3>\n'
      + '<p>Thanks to lauric acid, coconut oil helps keep odor-causing bacteria in check, which may help '
      + 'minimize breakouts and soothe minor skin irritations when used gently and correctly.</p>',
    expectedOccurrences: 1,
    mustContain: ['5. Naturally', 'lauric acid'],
    why:
      'NOT a copy of the live string. This local file is an older draft of the article: it numbers the '
      + 'section 5 and words it differently ("mild antibacterial and antifungal benefits"). It is still '
      + 'the file `agents/publisher` would republish from, so it is toned down on its own terms rather '
      + 'than skipped. "Antifungal" is the blocking word here.',
    bodyVerdict:
      'HEADING + BODY, because in this older wording the claim IS the paragraph ("offers mild '
      + 'antibacterial and antifungal benefits"). The hedged tail about breakouts and minor irritations '
      + 'is kept verbatim.',
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
const REPORT_DIR = join(ROOT, 'data/reports/health-claim-remediation/headings');

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
      row.backup = join('data/reports/health-claim-remediation/headings/backups', stamp, backupName(e));

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
        // Drop the cache so a second entry on the same article re-reads the
        // value this write just produced, instead of replacing into a stale copy.
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
    backup_dir: join('data/reports/health-claim-remediation/headings/backups', stamp),
    planned: plan.length,
    written: results.filter((r) => r.written).length,
    already_applied: results.filter((r) => r.action === 'already-applied').length,
    drifted: results.filter((r) => r.action === 'drift').length,
    missing: results.filter((r) => r.action === 'missing').length,
    errors: results.filter((r) => r.action === 'error').length,
    results,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));

  console.log(
    `\n${record.mode}: ${record.written} written, ${record.already_applied} already applied, `
    + `${record.drifted} drifted, ${record.missing} missing, ${record.errors} errors.`,
  );
  console.log(`Run record: data/reports/health-claim-remediation/headings/${stamp}.json`);
  if (!apply) console.log('Dry run — nothing was written. Re-run with --apply.');
  if (record.drifted || record.errors || record.missing) process.exitCode = 1;
}

// Guarded: importing this module must not run it (reference_agents_run_on_import).
if (isDirectRun(import.meta.url)) {
  await main(process.argv.slice(2));
}
