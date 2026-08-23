#!/usr/bin/env node
/**
 * Tone down the health claims that are LIVE on realskincare.com right now.
 *
 *   node scripts/remediate-live-health-claims.js            # DRY RUN (default)
 *   node scripts/remediate-live-health-claims.js --apply    # write to Shopify
 *   node scripts/remediate-live-health-claims.js --only <slug>
 *
 * ── What this is ────────────────────────────────────────────────────────────────
 *
 * A hand-reviewed, fixed PLAN — not a find-and-replace. `lib/seo-copy-health-gate.js`
 * flagged the candidates; a human decision put each one in or out. The scan that
 * produced it (2026-08-23, 1,385 live strings across 203 articles, 19 products,
 * 89 collections, 42 pages, plus 94 local data/posts/*\/meta.json) found 18
 * blocking-tier strings outside article bodies. Only SIX of those are live claims
 * about this catalogue's products. The rest were rejected on review, and the
 * reasons are recorded here so nobody re-litigates them from the raw scan:
 *
 *   - `best-soap-for-tattoos` / `best-soap-for-new-tattoo` collections — both 301
 *     to /products/coconut-soap. Their SEO descriptions are never rendered. The
 *     brief listed "the tattoo collection body" as a live claim; it is not live.
 *   - `best-soap-for-tattoos-what-to-use-for-safe-healing-1` (title "Safe Healing",
 *     summary "fast, clean healing") — 301 to the `-2` article. Not live.
 *   - `vaseline-for-chapped-lips-does-it-actually-work` — 404, and the copy asks
 *     whether a COMPETITOR product heals. A question about somebody else's product
 *     is not an intended-use claim about ours. Would stay even if republished.
 *   - `cut-and-scrape` product ("Natural Wound Care", "Heal every cut and scrape")
 *     — DRAFT, 404. Genuinely unshippable copy, but nothing is live. It must be
 *     rewritten BEFORE that product is ever published; it is not rewritten here
 *     because this script only touches live copy.
 *   - "effectively treats stretch marks", also on the brief's list, does not exist
 *     in live copy or anywhere in this repo. The stretch-mark posts that do rank
 *     hedge explicitly ("not clinically proven to remove or prevent", "not a
 *     miracle cure") — that is the debunking frame, and rewriting it would make
 *     the page LESS accurate.
 *   - All 15 advisory-tier toxicity hits. Deliberately untouched; see the gate's
 *     own header for why a page ranking on "toxic chemicals in soap" cannot be
 *     retitled without the word.
 *
 * ── Two buckets ─────────────────────────────────────────────────────────────────
 *
 * FIELD (summary_html, description_tag): the whole field is replaced. Low risk —
 * one value, verified against live before the write.
 *
 * BODY (body_html): NOT a prose rewrite. Both body entries are a single product-CTA
 * <h2> sitting directly above a buy button, and the exact same string mirrored into
 * a JSON-LD FAQ block. A self-contained heading is replaced literally, with the
 * occurrence count asserted first. Anything embedded in article PROSE is out of
 * scope here and belongs in `scripts/remediate-live-post.js`, which pulls live →
 * gates → repairs → pushes; see the report accompanying this change for that list.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────────
 *
 * - Dry by default. `--apply` is the only thing that writes.
 * - Idempotent: an entry whose live value already equals AFTER is skipped.
 * - Never blind-overwrites: if live matches neither BEFORE nor AFTER, the copy has
 *   drifted since the plan was written, and the entry is SKIPPED and reported.
 * - Every AFTER is re-gated through checkSeoCopy at run time, before any write.
 *   One failure aborts the whole run — a gate that only runs in CI is not a gate.
 * - The live value of every field is backed up to disk BEFORE its write.
 * - A run record naming every before/after pair is written on dry runs too.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSeoCopy } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const BLOG_ID = 48998449187; // "news", the only blog carrying these articles

/**
 * @typedef {object} PlanEntry
 * @property {string} slug            article handle
 * @property {number} blogId
 * @property {number} articleId
 * @property {'summary_html'|'body_html'|'description_tag'|'title'} field
 * @property {string} before          exact live value (field) or exact substring (body)
 * @property {string} after
 * @property {string[]} mustContain   ranking tokens the rewrite must keep, in order
 * @property {string} why             why this is a claim and not editorial
 * @property {number} [expectedOccurrences] body_html only
 */

/** @type {PlanEntry[]} */
export const PLAN = [
  // ── FIELD ────────────────────────────────────────────────────────────────────
  {
    slug: 'best-soap-for-tattoos-what-to-use-for-safe-healing-2',
    blogId: BLOG_ID,
    articleId: 563512344746,
    field: 'summary_html',
    before:
      'The best soap for tattoos skips harsh chemicals and supports real healing. See which natural ingredients protect new ink—and what to avoid entirely.',
    after:
      'The best soap for tattoos skips harsh chemicals and fragrance. See which natural ingredients protect new ink—and what to avoid entirely.',
    mustContain: ['The best soap for tattoos', 'natural ingredients', 'new ink'],
    why:
      'The subject is "the best soap for tattoos" — this catalogue\'s product — and "supports real healing" '
      + 'is the exact 2026-08-22 incident string. The title and description_tag on this page were already '
      + 'fixed by hand; the excerpt was missed and still renders at the top of the live article and on the '
      + 'blog listing. Replacement clause is the operator\'s own wording from the description_tag they wrote.',
  },
  {
    slug: 'best-fragrance-free-body-lotion-2025',
    blogId: BLOG_ID,
    articleId: 562333909162,
    field: 'summary_html',
    before:
      "The best fragrance free body lotion shouldn't just smell like nothing—it should actually heal. See what clean, sensitive-skin ingredients can do.",
    after:
      "The best fragrance free body lotion shouldn't just smell like nothing—it should actually soothe dry skin. See what clean, sensitive-skin ingredients can do.",
    mustContain: ['The best fragrance free body lotion', 'sensitive-skin ingredients'],
    why:
      'A lotion that "should actually heal" is a therapeutic claim with the product as subject. "Soothe" is '
      + 'ordinary cosmetic performance language and is on health-claims.js\'s explicitly-allowed list.',
  },
  {
    slug: 'how-to-choose-the-right-body-cream',
    blogId: BLOG_ID,
    articleId: 559784296618,
    field: 'summary_html',
    before:
      'Body cream keeps skin soft and hydrated while treating and preventing dry, cracked skin. It works best for normal skin and dry to very dry skin during the drier winter because it creates a barrier that delivers ultra-hydration.',
    after:
      'Body cream keeps skin soft and hydrated, easing the look and feel of dry, cracked skin. It works best for normal skin and dry to very dry skin during the drier winter because it creates a barrier that delivers ultra-hydration.',
    mustContain: ['Body cream', 'dry, cracked skin', 'ultra-hydration'],
    why:
      '"Treating and preventing" are therapeutic verbs taking the product as their subject — intended-use '
      + 'language. "Easing the look and feel of" says the same useful thing about appearance instead.',
  },
  {
    slug: 'how-to-choose-the-right-body-cream',
    blogId: BLOG_ID,
    articleId: 559784296618,
    field: 'description_tag',
    before:
      'In this article, we will guide you on how to choose the right body cream moisturizer to prevent your body from drying.',
    after:
      'In this article, we will guide you on how to choose the right body cream moisturizer to keep your skin from feeling dry.',
    mustContain: ['right body cream moisturizer'],
    why:
      'This one RENDERS as the live SERP meta description (verified by fetching the page). "Prevent" is a '
      + 'therapeutic verb; "keep your skin from feeling dry" is the same promise about feel, not prevention.',
  },
  {
    slug: 'why-should-you-use-moisturizers-everday',
    blogId: BLOG_ID,
    articleId: 559549874346,
    field: 'summary_html',
    before:
      '<p><span style="font-weight: 400;">Moisturizers are more than skincare products; they may also be used medically. It also helps several skin disorders, including eczema and psoriasis.</span></p>',
    after:
      '<p><span style="font-weight: 400;">Moisturizers are more than a finishing step in a routine. Daily use helps skin hold on to moisture, so dry, tight, flaky skin looks and feels softer.</span></p>',
    mustContain: ['Moisturizers'],
    why:
      'The worst of the set: "used medically" plus two named diseases (eczema, psoriasis) on the brand\'s own '
      + 'moisturizer content is textbook unapproved-drug intended use. Nothing survives rewording, so the '
      + 'sentence is replaced with the honest version of the same "more than you think" thrust.',
  },
  {
    slug: 'incorporating-vanilla-skin-care-into-your-beauty-regimen',
    blogId: BLOG_ID,
    articleId: 559636119722,
    field: 'summary_html',
    before:
      '<meta charset="utf-8">\n<p><span>Vanilla is well-known for its role as an integral component of many desserts, but it also has medicinal properties that can help with skin problems. In addition, vanilla extract is excellent when used in a regular skincare regimen. But what is vanilla, what are the different kinds of vanilla, and how can we use it in our skincare routines?</span></p>\n<p><span>But do you know that vanilla has more benefits than just a pleasant smell for your skin? Incorporating this all-natural product into your regular skincare routine will help slow the age-related effects on your skin and protect your skin from environmental damage.\u00A0</span></p>',
    after:
      '<meta charset="utf-8">\n<p><span>Vanilla is well-known for its role as an integral component of many desserts, but it also has skin-friendly properties that suit an everyday routine. In addition, vanilla extract is excellent when used in a regular skincare regimen. But what is vanilla, what are the different kinds of vanilla, and how can we use it in our skincare routines?</span></p>\n<p><span>But do you know that vanilla has more benefits than just a pleasant smell for your skin? Incorporating this all-natural product into your regular skincare routine will help slow the age-related effects on your skin and protect your skin from environmental damage.\u00A0</span></p>',
    mustContain: ['Vanilla', 'vanilla extract', 'skincare routines'],
    why:
      '"Medicinal properties that can help with skin problems" is a drug-category claim about an ingredient '
      + 'this brand sells. One clause changes; the rest of the excerpt is untouched.',
  },

  // ── BODY (self-contained product-CTA headings only) ──────────────────────────
  {
    slug: 'soothing-lip-balm-best-natural-picks-for-dry-lips',
    blogId: BLOG_ID,
    articleId: 563829407914,
    field: 'body_html',
    before: 'Clean, Nourishing Lip Care That Actually Heals',
    after: 'Clean, Nourishing Lip Care That Actually Softens',
    expectedOccurrences: 1,
    mustContain: ['Clean, Nourishing Lip Care'],
    why:
      'An <h2> inside the product CTA block, directly above "Real Skin Care\'s Coconut Oil Lip Balm" and an '
      + 'Add to Cart button. The subject is unambiguously the product and it sits in the conversion path — '
      + 'the same shape as the 2026-08-22 incident. Highest-severity find of this scan.',
  },
  {
    slug: 'best-moisturizer-for-dry-hands-natural-options-that-work',
    blogId: BLOG_ID,
    articleId: 563825574058,
    field: 'body_html',
    before: 'Ready to Actually Heal Your Dry Hands?',
    after: 'Ready to Actually Soften Your Dry Hands?',
    expectedOccurrences: 2,
    mustContain: ['Dry Hands'],
    why:
      'The same string twice: the visible product-CTA <h2> above a buy button, and a mirrored JSON-LD FAQPage '
      + 'question whose answer promotes the moisturizer. Both are marketing material; replacing the literal '
      + 'string fixes them together and keeps the schema in sync with the page.',
  },
];

// --- pure helpers (exported for the tests) ------------------------------------

/** Which checkSeoCopy slot a planned field is gated in. */
export function gateSlotFor(field) {
  return field === 'title' ? 'title' : 'meta';
}

/** Count literal (non-regex) occurrences of `needle` in `hay`. */
export function occurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = String(hay).indexOf(needle, i);
    if (at < 0) return n;
    n++;
    i = at + needle.length;
  }
}

/**
 * Literal replace-all. Deliberately NOT `String.replace` with a regex or a
 * replacement string — a `.` in a heading would become a wildcard and a `$&` in
 * the replacement would expand.
 */
export function replaceAll(hay, needle, replacement) {
  if (!needle) return String(hay);
  return String(hay).split(needle).join(replacement);
}

/**
 * What to do with one entry given the value currently live.
 * Never returns 'apply' unless the live value is EXACTLY what the plan was
 * written against.
 */
export function classify(live, entry) {
  const s = typeof live === 'string' ? live : '';
  if (s === entry.after) return { action: 'already-applied' };
  if (s === entry.before) return { action: 'apply' };
  return { action: 'drift', live: s };
}

/** As above, for a body_html entry, where BEFORE is a substring. */
export function classifyBody(liveHtml, entry) {
  const s = typeof liveHtml === 'string' ? liveHtml : '';
  const found = occurrences(s, entry.before);
  if (found === entry.expectedOccurrences) return { action: 'apply', found };
  if (found === 0 && occurrences(s, entry.after) > 0) return { action: 'already-applied', found };
  return { action: 'drift', found };
}

/** Re-gate every AFTER. `ok:false` aborts the run. */
export function gatePlan(plan) {
  const failures = [];
  for (const e of plan) {
    const res = checkSeoCopy({ [gateSlotFor(e.field)]: e.after });
    if (!res.ok) {
      failures.push({
        slug: e.slug,
        field: e.field,
        matches: res.blocking.map((b) => b.match),
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

// --- runner -------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_DIR = join(ROOT, 'data/reports/health-claim-remediation');

async function main(argv) {
  const apply = argv.includes('--apply');
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;

  const plan = only ? PLAN.filter((e) => e.slug === only) : PLAN;
  if (!plan.length) {
    console.error(only ? `No plan entry for slug "${only}".` : 'Plan is empty.');
    process.exitCode = 1;
    return;
  }

  const gate = gatePlan(plan);
  if (!gate.ok) {
    console.error('ABORT — a planned rewrite does not pass checkSeoCopy:');
    for (const f of gate.failures) console.error(`  ${f.slug}/${f.field}: ${f.matches.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Gate: ${plan.length}/${plan.length} planned rewrites pass checkSeoCopy.\n`);

  // Imported lazily so `--help`-shaped mistakes and the tests never need creds.
  const { getArticle, updateArticle, getMetafields, upsertMetafield } =
    await import('../lib/shopify.js');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(REPORT_DIR, 'backups', stamp);
  mkdirSync(backupDir, { recursive: true });

  const results = [];
  const articleCache = new Map();
  const getCached = async (blogId, articleId) => {
    const key = `${blogId}/${articleId}`;
    if (!articleCache.has(key)) articleCache.set(key, await getArticle(blogId, articleId));
    return articleCache.get(key);
  };

  for (const e of plan) {
    const row = { slug: e.slug, field: e.field, articleId: e.articleId, why: e.why };
    try {
      let liveValue;
      let metafieldType;

      if (e.field === 'description_tag') {
        const mfs = await getMetafields('articles', e.articleId);
        const mf = mfs.find((m) => m.namespace === 'global' && m.key === 'description_tag');
        liveValue = mf ? String(mf.value) : '';
        metafieldType = mf?.type || 'single_line_text_field';
      } else {
        const art = await getCached(e.blogId, e.articleId);
        liveValue = String(art[e.field] ?? '');
      }

      // Backup BEFORE anything is decided, so a drifted value is captured too.
      const safe = `${e.slug}.${e.field}`.replace(/[^a-z0-9.@_-]/gi, '_');
      writeFileSync(join(backupDir, `${safe}.txt`), liveValue);
      row.backup = join('data/reports/health-claim-remediation/backups', stamp, `${safe}.txt`);

      const verdict = e.field === 'body_html' ? classifyBody(liveValue, e) : classify(liveValue, e);
      row.action = verdict.action;

      if (verdict.action === 'already-applied') {
        console.log(`= ${e.slug} [${e.field}] already remediated — skipping.`);
        results.push(row);
        continue;
      }
      if (verdict.action === 'drift') {
        row.liveValue = liveValue.slice(0, 400);
        console.log(
          `! ${e.slug} [${e.field}] LIVE VALUE DRIFTED from the plan — skipped, nothing written.`,
        );
        console.log(`    expected: ${JSON.stringify(e.before.slice(0, 120))}`);
        console.log(`    live:     ${JSON.stringify(liveValue.slice(0, 120))}`);
        results.push(row);
        continue;
      }

      const nextValue =
        e.field === 'body_html' ? replaceAll(liveValue, e.before, e.after) : e.after;

      row.before = e.field === 'body_html' ? e.before : liveValue;
      row.after = e.field === 'body_html' ? e.after : e.after;
      row.occurrences = verdict.found;

      console.log(`${apply ? '→' : '·'} ${e.slug} [${e.field}]`);
      console.log(`    BEFORE: ${JSON.stringify(e.before)}`);
      console.log(`    AFTER:  ${JSON.stringify(e.after)}`);

      if (!apply) {
        row.written = false;
        results.push(row);
        continue;
      }

      if (e.field === 'description_tag') {
        await upsertMetafield(
          'articles', e.articleId, 'global', 'description_tag', e.after, metafieldType,
        );
      } else {
        await updateArticle(e.blogId, e.articleId, { [e.field]: nextValue });
        articleCache.delete(`${e.blogId}/${e.articleId}`);
      }
      row.written = true;
      console.log('    written.');
    } catch (err) {
      row.action = 'error';
      row.error = err.message;
      console.error(`✗ ${e.slug} [${e.field}] — ${err.message}`);
    }
    results.push(row);
  }

  const record = {
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    backup_dir: join('data/reports/health-claim-remediation/backups', stamp),
    planned: plan.length,
    written: results.filter((r) => r.written).length,
    already_applied: results.filter((r) => r.action === 'already-applied').length,
    drifted: results.filter((r) => r.action === 'drift').length,
    errors: results.filter((r) => r.action === 'error').length,
    results,
  };
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));

  console.log(
    `\n${record.mode}: ${record.written} written, ${record.already_applied} already applied, `
    + `${record.drifted} drifted, ${record.errors} errors.`,
  );
  console.log(`Run record: data/reports/health-claim-remediation/${stamp}.json`);
  if (!apply) console.log('Dry run — nothing was written. Re-run with --apply.');
  if (record.drifted || record.errors) process.exitCode = 1;
}

// Guarded: importing this module must not run it. `isDirectRun` is the fleet's one
// tested predicate — four hand-rolled spellings had already accumulated, and a guard
// that wrongly says "imported" is a silent no-op that still exits 0.
if (isDirectRun(import.meta.url)) {
  await main(process.argv.slice(2));
}
