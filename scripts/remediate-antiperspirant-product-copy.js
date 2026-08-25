#!/usr/bin/env node
/**
 * Remove the three places where live copy describes RSC's DEODORANT as an
 * ANTIPERSPIRANT — and nowhere else.
 *
 *   node scripts/remediate-antiperspirant-product-copy.js            # DRY RUN (default)
 *   node scripts/remediate-antiperspirant-product-copy.js --apply    # write Shopify + mirrors
 *   node scripts/remediate-antiperspirant-product-copy.js --only <id>
 *
 * ── The rule, verbatim from the operator (2026-08-24) ────────────────────────────
 *
 *   "We should never use the term antiperspirant to describe our product because it
 *    is not accurate."
 *
 * An antiperspirant is an FDA-regulated OTC drug (21 CFR Part 350) that reduces
 * sweating with an aluminum-salt active ingredient. RSC sells an aluminum-free
 * coconut-oil deodorant, a cosmetic that addresses odor. The word is wrong factually
 * AND as a regulatory claim — a cosmetic described with a drug category name is the
 * same intended-use failure PRs #634/#645/#648 cleaned up, except that here the
 * category name IS the claim rather than smuggling one in through a verb.
 *
 * ── WHAT THIS SCRIPT DELIBERATELY DOES NOT TOUCH ────────────────────────────────
 *
 * RANKING FOR THE QUERY IS FINE. DESCRIBING THE PRODUCT WITH THE WORD IS NOT.
 *
 * A read-only audit of the live corpus on 2026-08-24 (204 articles, 19 products,
 * 89 collections, 42 pages) found the word **539 times in rendered prose across 58
 * pages** — 687 counting href and title attributes. Essentially all of it is
 * legitimate CATEGORY reference: the FDA monograph, aluminum chemistry, deodorant-vs-
 * antiperspirant comparisons, the two-to-four-week transition, "when was antiperspirant
 * invented". Those pages rank for that query, and five article titles plus five URL
 * handles are built on it. Removing the word wholesale would destroy the ranking and
 * the reader's reason to be there — the exact failure PR #633 exists to prevent.
 *
 * SLUGS AND HANDLES ARE NOT RENAMED, deliberately. Five live handles carry the word
 * (`natural-antiperspirant-what-works-why-it-matters`,
 * `travel-size-antiperspirant-what-to-know-before-you-pack`,
 * `aluminum-free-antiperspirant-what-it-is-does-it-work` and its `-2` sibling,
 * `natural-deodorant-vs-antiperspirant-which-is-right-for-you`). A handle is a URL, not
 * a description of the product: changing one breaks a ranking page and costs a redirect
 * for no accuracy gain, since nothing about a URL claims what the product is.
 *
 * ── THE THREE ENTRIES, AND WHY EACH IS A PRODUCT DESCRIPTION ────────────────────
 *
 * Each entry records `caughtBy` — WHICH enforcement arm stops that shape being written
 * again. It is a statement about the code, and a test pins it against the code rather
 * than trusting the label: `arm-a` must actually trip `findProductCategoryMisnomers`,
 * and `judgement` must actually not.
 *
 * 1-2. THE TWO BUY-BOX LINES — `caughtBy: 'arm-a+arm-b'`, defence in depth.
 *      `agents/featured-product-injector` builds its featured-
 *      product headline as `Our pick for ${target_keyword}: ${product}` — a sentence
 *      whose subject is unambiguously our product. Two live articles therefore carried
 *      `Our pick for travel size antiperspirant: Best Coconut Oil Deodorant …` and
 *      `Our pick for aluminum free antiperspirant what it is does it work: …` INSIDE
 *      the conversion path, directly above an Add-to-Cart button. Same shape as the
 *      2026-08-22 CTA-heading find: highest severity, and invisible to a title/meta
 *      scan. These are the only two occurrences in the entire live corpus where the
 *      word names an RSC product.
 *
 *      The generator was fixed in the same change (`buildCtaCopy` now runs the keyword
 *      through `sanitizeProductCategoryTerm`), which is what makes this remediation
 *      stick — without it the next injector run rewrites both lines back.
 *
 *      ARM A CATCHES THESE TOO, since 2026-08-24, and the two arms are deliberately
 *      redundant here. Grammatically `Our` heads `pick` and `for` opens a new phrase, so
 *      no tightening of possessive attachment reaches the line — and simply allowing
 *      `for` into the gap re-acquires the "our deep-dive on aluminum-free antiperspirant"
 *      false positive, which is a live sentence about an article we wrote. The narrow way
 *      in is to name the RECOMMENDATION idioms ("our pick for", "our top choice for"),
 *      which take a product as their object by construction where "our deep-dive on"
 *      takes a document. Arm B still sanitizes the line so the generator cannot emit it;
 *      Arm A now also blocks it if any OTHER caller ever builds that shape.
 *
 * 3.   THE BUYING-GUIDE HEADING — `caughtBy: 'judgement'`, the borderline one.
 *      `<h2>What to Look For in a Natural Antiperspirant (Buying Guide)</h2>` on
 *      `natural-antiperspirant-what-works-why-it-matters`. It names no RSC product, so
 *      NEITHER arm flags it and a future regeneration would not be blocked from writing
 *      it again — that asymmetry is recorded honestly in the plan rather than papered
 *      over by widening a rule until it produced the answer somebody wanted.
 *
 *      It is here anyway because a BUYING GUIDE is product-recommendation copy: it
 *      tells the reader what to buy on a page whose buy box sells our deodorant. Two
 *      further facts settle it. The section's own first sentence already reads
 *      "Shopping for natural deodorant is easier when you know what actually matters on
 *      the label" — heading and body contradict each other. And the article's own
 *      thesis, four paragraphs above, is that "a product cannot legally be called an
 *      antiperspirant in the U.S. without containing an FDA-approved aluminum active
 *      ingredient. Full stop." The heading tells a reader to shop for a thing the page
 *      has just proved does not exist.
 *
 *      Ranking is not at risk: 20 of this post's 21 occurrences of the phrase survive,
 *      including the article title, the H1, the intro, the sibling H2 ("Natural
 *      Antiperspirant vs. Natural Deodorant") and the FAQ.
 *
 * ── WHAT WAS EXAMINED AND KEPT (so nobody re-litigates it from a raw grep) ───────
 *
 *   - 38 headings carrying the word across 27 articles. All but entry 3 are explicitly
 *     comparative or historical ("Deodorant vs. Antiperspirant", "When Was
 *     Antiperspirant Invented? (1903 and Beyond)", "How to Switch from Conventional
 *     Antiperspirant to Natural Deodorant"). Every one is category reference.
 *   - 5 article titles and 6 `summary_html` excerpts. All name the topic, not a product.
 *   - 6 collection body paragraphs (all on DRAFT collections), every one of which
 *     CONTRASTS conventional antiperspirants with what RSC sells ("Unlike traditional
 *     antiperspirants, which block sweat glands, our formula works with your body").
 *     That is the accurate distinction, stated correctly — the opposite of the defect.
 *   - 22 JSON-LD blocks. All mirror kept headings and FAQ entries.
 *   - 0 occurrences in any product title, product body, product tag, variant title,
 *     collection title or page. The catalogue itself was already clean.
 *
 * ── LOCAL MIRRORS ───────────────────────────────────────────────────────────────
 *
 * `agents/publisher` republishes `data/posts/<slug>/content.html` over `body_html`, so
 * a live fix that is not mirrored is a fix a republish undoes — the `summary_html` trap
 * PR #634 found. Each article entry therefore has a paired mirror entry, and a test
 * pins that pairing so a future entry cannot be added without one.
 *
 * NOTE THE SLUG MISMATCH, which is the `resolvePostSlug` trap: a Shopify handle is not
 * the local slug. Live `aluminum-free-antiperspirant-what-it-is-does-it-work-2` is
 * mirrored at `data/posts/aluminum-free-antiperspirant-what-it-is-does-it-work/`, and
 * live `travel-size-antiperspirant-what-to-know-before-you-pack` at
 * `data/posts/travel-size-antiperspirant/`. Verified against each mirror's own
 * `meta.json.shopify_article_id`, not by prefix-matching the handle.
 *
 * All three mirrors are SERVER-ONLY — they exist under `/root/seo-claude/data/posts/`
 * and are untracked, so a fresh checkout reports them `missing`. That is expected and
 * is NOT a failure exit: a mirror that does not exist cannot undo anything. It is still
 * printed and counted, because "absent" and "already fixed" must not look alike.
 * Verified read-only on the server 2026-08-24: all three exist there and each carries
 * its BEFORE exactly once, byte-identical to live.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopy } from '../lib/seo-copy-health-gate.js';
import { findProductCategoryMisnomers } from '../lib/product-category-terms.js';
// Mechanics are IMPORTED, never re-declared — a second copy of the drift guard is a
// second copy that drifts. Same rule as scripts/remediate-ingredient-benefit-headings.js.
import { occurrences, replaceAll, classifyBody } from './remediate-live-health-claims.js';

const NEWS_BLOG_ID = 48998449187;

const ARTICLE = (slug, articleId) => ({ kind: 'article', slug, articleId, blogId: NEWS_BLOG_ID, field: 'body_html' });
const MIRROR = (slug) => ({ kind: 'file', slug, path: `data/posts/${slug}/content.html` });

// The em dash is written as an explicit — escape rather than pasted. A trailing
// U+00A0 transcribed as a plain space is what the sibling script's drift guard caught
// on its first run; a literal that LOOKS right and is not is the failure mode here.
const EM = '—';
const CTA_PRODUCT = `Best Coconut Oil Deodorant ${EM} All Natural Formula | 2oz`;

const CTA_TRAVEL_BEFORE = `Our pick for travel size antiperspirant: ${CTA_PRODUCT}`;
const CTA_TRAVEL_AFTER = `Our pick for travel size deodorant: ${CTA_PRODUCT}`;
const CTA_ALU_BEFORE = `Our pick for aluminum free antiperspirant what it is does it work: ${CTA_PRODUCT}`;
const CTA_ALU_AFTER = `Our pick for aluminum free deodorant what it is does it work: ${CTA_PRODUCT}`;
const H2_BEFORE = '<h2>What to Look For in a Natural Antiperspirant (Buying Guide)</h2>';
const H2_AFTER = '<h2>What to Look For in a Natural Deodorant (Buying Guide)</h2>';

/**
 * @typedef {object} PlanEntry
 * @property {string} id               stable key, also the `--only` argument
 * @property {object} target           where the write lands
 * @property {'title'|'meta'} gateSlot which checkSeoCopy slot AFTER is gated in
 * @property {string} before           exact literal, machine-extracted from live
 * @property {string} after
 * @property {number} expectedOccurrences
 * @property {string[]} mustContain    tokens that must survive BEFORE -> AFTER, in order
 * @property {'arm-a'|'arm-b'|'arm-a+arm-b'|'judgement'} caughtBy  which enforcement arm
 *                                    stops this shape being written again — see the header
 * @property {string} why
 */

/** @type {PlanEntry[]} */
export const PLAN = [
  {
    id: 'cta-travel-size-antiperspirant',
    target: ARTICLE('travel-size-antiperspirant-what-to-know-before-you-pack', 564256243882),
    gateSlot: 'title',
    before: CTA_TRAVEL_BEFORE,
    after: CTA_TRAVEL_AFTER,
    expectedOccurrences: 1,
    mustContain: ['Our pick for', 'travel size', CTA_PRODUCT],
    caughtBy: 'arm-a+arm-b',
    why:
      'featured-product buy-box headline. "Our pick for <X>: <our product>" makes our '
      + 'deodorant the referent of the category name, directly above an Add-to-Cart button.',
  },
  {
    id: 'mirror-travel-size-antiperspirant',
    target: MIRROR('travel-size-antiperspirant'),
    gateSlot: 'title',
    before: CTA_TRAVEL_BEFORE,
    after: CTA_TRAVEL_AFTER,
    expectedOccurrences: 1,
    mustContain: ['Our pick for', 'travel size', CTA_PRODUCT],
    caughtBy: 'arm-a+arm-b',
    why: 'local mirror of the above — agents/publisher republishes this file over body_html.',
  },
  {
    id: 'cta-aluminum-free-antiperspirant',
    target: ARTICLE('aluminum-free-antiperspirant-what-it-is-does-it-work-2', 563512180906),
    gateSlot: 'title',
    before: CTA_ALU_BEFORE,
    after: CTA_ALU_AFTER,
    expectedOccurrences: 1,
    mustContain: ['Our pick for', 'aluminum free', CTA_PRODUCT],
    caughtBy: 'arm-a+arm-b',
    why:
      'featured-product buy-box headline, same generator, same defect. The raw target '
      + 'keyword makes this headline clumsy as well as wrong; only the wrong part is fixed here.',
  },
  {
    id: 'mirror-aluminum-free-antiperspirant',
    // The local slug is NOT the live handle: this mirror backs the `-2` article.
    target: MIRROR('aluminum-free-antiperspirant-what-it-is-does-it-work'),
    gateSlot: 'title',
    before: CTA_ALU_BEFORE,
    after: CTA_ALU_AFTER,
    expectedOccurrences: 1,
    mustContain: ['Our pick for', 'aluminum free', CTA_PRODUCT],
    caughtBy: 'arm-a+arm-b',
    why: 'local mirror of the above — agents/publisher republishes this file over body_html.',
  },
  {
    id: 'heading-natural-antiperspirant-buying-guide',
    target: ARTICLE('natural-antiperspirant-what-works-why-it-matters', 563582435498),
    gateSlot: 'title',
    before: H2_BEFORE,
    after: H2_AFTER,
    expectedOccurrences: 1,
    mustContain: ['What to Look For in a Natural', '(Buying Guide)'],
    caughtBy: 'judgement',
    why:
      'BORDERLINE, included on judgement rather than on the rule. A buying-guide heading '
      + 'is product-recommendation copy on a page whose buy box sells our deodorant; the '
      + 'section body already says "Shopping for natural deodorant", and the article itself '
      + 'argues four paragraphs earlier that a natural antiperspirant cannot legally exist. '
      + '20 of the post\'s 21 occurrences of the phrase are kept, title and H1 included.',
  },
  {
    id: 'mirror-natural-antiperspirant-buying-guide',
    target: MIRROR('natural-antiperspirant'),
    gateSlot: 'title',
    before: H2_BEFORE,
    after: H2_AFTER,
    expectedOccurrences: 1,
    mustContain: ['What to Look For in a Natural', '(Buying Guide)'],
    caughtBy: 'judgement',
    why: 'local mirror of the above — agents/publisher republishes this file over body_html.',
  },
];

/** Human label for logs and the run record. */
export function targetLabel(target) {
  return target.kind === 'article'
    ? `${target.slug} [${target.field} #${target.articleId}]`
    : target.path;
}

/** Filesystem-safe backup name. */
export function backupName(entry) {
  return `${entry.id}.txt`.replace(/[^a-z0-9.@_-]/gi, '_');
}

/**
 * Re-gate every AFTER at run time. One failure aborts the whole run.
 *
 * TWO gates, because they answer different questions and the second is the one this
 * change exists for: `checkSeoCopy` (health claims + product-category accuracy, in an
 * explicitly NAMED slot, since a bare string returns ok:true) and a direct
 * `findProductCategoryMisnomers` pass that also refuses an AFTER still carrying the
 * literal term anywhere. A rewrite that swapped one misnomer for another would sail
 * through the first check and is caught by the second.
 */
export function gatePlan(plan) {
  const failures = [];
  for (const e of plan) {
    const res = checkSeoCopy({ [e.gateSlot]: e.after });
    if (!res.ok) failures.push({ id: e.id, reason: 'seo-copy', matches: res.blocking.map((b) => b.match) });
    if (/antiperspirant/i.test(e.after)) {
      failures.push({ id: e.id, reason: 'term-survives', matches: ['antiperspirant'] });
    }
    if (findProductCategoryMisnomers(e.after).length) {
      failures.push({ id: e.id, reason: 'misnomer', matches: findProductCategoryMisnomers(e.after).map((m) => m.match) });
    }
    for (const token of e.mustContain) {
      if (!e.after.includes(token)) {
        failures.push({ id: e.id, reason: 'ranking-token-lost', matches: [token] });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

// --- runner -------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_DIR = join(ROOT, 'data/reports/antiperspirant-remediation');

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
    console.error('ABORT — a planned rewrite does not pass the gates:');
    for (const f of gate.failures) console.error(`  ${f.id} (${f.reason}): ${f.matches.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Gate: ${plan.length}/${plan.length} planned rewrites pass checkSeoCopy + product-category accuracy.\n`);

  const needsShopify = plan.some((e) => e.target.kind === 'article');
  // Imported lazily so `--help`-shaped mistakes and the tests never need creds.
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
      caught_by: e.caughtBy,
      why: e.why,
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
          // Expected in a fresh checkout: every mirror here is server-only and
          // untracked. A mirror that does not exist cannot undo the live fix, so this
          // is reported and counted but is NOT an error exit.
          row.action = 'missing';
          console.log(`~ ${e.id} — ${e.target.path} not present in this checkout; nothing to mirror.`);
          results.push(row);
          continue;
        }
        current = readFileSync(filePath, 'utf8');
      }

      // Backup BEFORE anything is decided, so a drifted value is captured too.
      writeFileSync(join(backupDir, backupName(e)), current);
      row.backup = join('data/reports/antiperspirant-remediation/backups', stamp, backupName(e));

      const verdict = classifyBody(current, e);
      row.action = verdict.action;
      row.occurrences = verdict.found;
      row.expected_occurrences = e.expectedOccurrences;

      if (verdict.action === 'already-applied') {
        console.log(`= ${e.id} already remediated — skipping.`);
        results.push(row);
        continue;
      }
      if (verdict.action === 'drift') {
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

      console.log(`${apply ? '→' : '·'} ${e.id}  (${targetLabel(e.target)})${e.caughtBy === 'judgement' ? '  [borderline — operator judgement, not the rule]' : ''}`);
      console.log(`    BEFORE: ${JSON.stringify(e.before)}`);
      console.log(`    AFTER:  ${JSON.stringify(e.after)}`);

      if (!apply) {
        row.written = false;
        results.push(row);
        continue;
      }

      if (e.target.kind === 'article') {
        await shopify.updateArticle(e.target.blogId, e.target.articleId, { [e.target.field]: next });
        // Drop the cache so a second entry on the same article re-reads the value this
        // write just produced instead of replacing into a stale copy.
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
    backup_dir: join('data/reports/antiperspirant-remediation/backups', stamp),
    planned: plan.length,
    written: results.filter((r) => r.written).length,
    already_applied: results.filter((r) => r.action === 'already-applied').length,
    drifted: results.filter((r) => r.action === 'drift').length,
    missing_mirrors: results.filter((r) => r.action === 'missing').length,
    errors: results.filter((r) => r.action === 'error').length,
    results,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));

  console.log(
    `\n${record.mode}: ${record.written} written, ${record.already_applied} already applied, `
    + `${record.drifted} drifted, ${record.missing_mirrors} mirror(s) absent, ${record.errors} errors.`,
  );

  // The one thing that can silently undo this fix, so it is stated loudly rather than
  // left as a count. All three mirrors live on the production box and are untracked, so
  // a local run finds none of them — and `scheduler.js`'s daily link-repair step
  // republishes `content.html` with `--force` for any post already on Shopify. The
  // content-mirror gate will NOT stop it: a one-line difference scores ~0.99 similarity,
  // far above DIVERGENT_WARN_MAX, so the republish reads as an ordinary edit and pushes
  // the old buy-box line straight back over the fix.
  if (record.missing_mirrors) {
    record.mirror_warning =
      `${record.missing_mirrors} local mirror(s) were not present in this checkout. They exist `
      + `on the production server. Run this script THERE (read-write on files only) after the `
      + `deploy, or scheduler.js's daily link-repair republish will restore the old text.`;
    console.log(`\n⚠ ${record.mirror_warning}`);
    for (const r of results.filter((x) => x.action === 'missing')) console.log(`    ${r.target}`);
    writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
    writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));
  }

  console.log(`Run record: data/reports/antiperspirant-remediation/${stamp}.json`);
  if (!apply) console.log('Dry run — nothing was written. Re-run with --apply.');
  // A missing mirror is expected and does NOT fail the run; drift and errors do.
  if (record.drifted || record.errors) process.exitCode = 1;
}

// Guarded: importing this module must not run it (reference_agents_run_on_import).
if (isDirectRun(import.meta.url)) {
  await main(process.argv.slice(2));
}
