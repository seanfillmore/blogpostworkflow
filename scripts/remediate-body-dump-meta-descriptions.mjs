#!/usr/bin/env node
/**
 * scripts/remediate-body-dump-meta-descriptions.mjs — give a live article a real
 * meta description when the theme is currently dumping its body copy into the
 * SERP snippet. DRY BY DEFAULT; `--apply` writes.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────────
 *
 * The theme resolves a page's meta description in this order: the
 * `global.description_tag` metafield, then `summary_html`, then a truncation of
 * `body_html`. An article with NEITHER of the first two therefore renders
 * whatever its body happens to open with. On
 * `best-clean-body-lotion-soft-skin-zero-toxins-real-skin-care` that is the
 * product CTA block, so the live SERP snippet reads:
 *
 *   "Clean Hydration, No Compromises Skip parabens, PEGs, PFAS, and synthetic
 *    fragrance. Explore our best non-toxic body lotion collection, or start
 *    with our Organic Coconut Oil Body Lotion — handmade and gentle enough…"
 *
 * That is a CTA read aloud, not a description, on a commercial lotion page —
 * and lotion is 72% of revenue. Found by the Ahrefs crawl of 2026-09-20, which
 * counts 23 URLs with a missing or empty meta description.
 *
 * ── WHY A `description_tag` AND NOT A `summary_html` ─────────────────────────
 *
 * `agents/publisher` writes `summary_html` from the post's own local
 * `meta_description`, so setting it here would be overwritten by the next
 * republish. `description_tag` is the field the theme prefers and nothing in
 * the fleet rewrites it unattended except `agents/meta-optimizer`, which is
 * gated and A/B tracked.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────────
 *
 *  * Dry by default. `--apply` is the only thing that writes.
 *  * It REFUSES to overwrite an existing `description_tag`. This path exists for
 *    pages that have none; a page that has one is somebody's considered copy (or
 *    a live A/B variant) and is not this script's to replace.
 *  * Every proposed value is re-checked at run time through BOTH
 *    `checkSeoCopyFields` (health/regulatory) and `checkCopyLength`, and ONE
 *    failure aborts the whole run rather than writing a partial sweep — the same
 *    rule as `scripts/remediate-long-titles.mjs`, and for the same reason: this
 *    writes a live SERP snippet and has no prompt to regenerate from.
 *  * A run record naming every BEFORE value is written to
 *    data/reports/meta-description-remediation/.
 *
 * Usage:
 *   node scripts/remediate-body-dump-meta-descriptions.mjs            # report
 *   node scripts/remediate-body-dump-meta-descriptions.mjs --apply    # write
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBlogs, getArticles, getMetafields, upsertMetafield } from '../lib/shopify.js';
import { checkCopyLength } from '../lib/seo-copy-length.js';
import { checkSeoCopyFields, EDITORIAL_SURFACE } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'meta-description-remediation');

const APPLY = process.argv.slice(2).includes('--apply');

/**
 * Hand-authored, operator-approved 2026-09-20. Keyed by article handle.
 *
 * The copy keeps the page's ranking tokens ("clean body lotion") and names the
 * concrete ingredient exclusions the article is actually about, so the snippet
 * describes the page rather than selling from it. It deliberately makes no
 * claim about what the lotion does to skin beyond "soft", which is cosmetic.
 */
export const PLAN = [
  {
    handle: 'best-clean-body-lotion-soft-skin-zero-toxins-real-skin-care',
    description:
      'What makes a body lotion "clean"? Compare picks free of parabens, PEGs, '
      + 'PFAS and synthetic fragrance, and see which ingredients to look for.',
    why: 'no description_tag and no summary_html, so the theme was rendering the product CTA block as the SERP snippet',
  },
];

/** Locate a live article by handle across every blog. */
async function findArticle(handle) {
  for (const b of await getBlogs()) {
    for (const a of await getArticles(b.id, { limit: 250 })) {
      if (a.handle === handle) return { ...a, blogId: b.id };
    }
  }
  return null;
}

async function descriptionTag(articleId) {
  const mf = await getMetafields('articles', articleId);
  return mf.find((m) => m.namespace === 'global' && m.key === 'description_tag')?.value ?? null;
}

async function main() {
  console.log(`\nBody-dump meta description remediation — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const planned = [];
  const refusals = [];

  for (const entry of PLAN) {
    // ── gate the proposed value BEFORE touching anything ──────────────────────
    // An article title/description describes an ARTICLE, so it is the editorial
    // surface — the same declaration agents/meta-optimizer makes.
    const health = checkSeoCopyFields(
      { 'meta description': entry.description },
      { surface: EDITORIAL_SURFACE },
    );
    if (!health.ok) {
      refusals.push({ handle: entry.handle, reason: 'health gate', detail: health.violations });
      continue;
    }
    const length = checkCopyLength({ meta: entry.description }, { meta: 'description' });
    if (!length.ok) {
      refusals.push({ handle: entry.handle, reason: 'length gate', detail: length.overlong });
      continue;
    }

    const article = await findArticle(entry.handle);
    if (!article) {
      refusals.push({ handle: entry.handle, reason: 'article not found on any blog' });
      continue;
    }
    if (!article.published_at || new Date(article.published_at) > new Date()) {
      refusals.push({ handle: entry.handle, reason: 'not live — nothing is being shown to a searcher' });
      continue;
    }

    const before = await descriptionTag(article.id);
    if (before !== null && before.trim() !== '') {
      // Not an error we can write through: this page already has authored copy.
      refusals.push({ handle: entry.handle, reason: 'description_tag already set — refusing to overwrite', detail: before });
      continue;
    }

    planned.push({ ...entry, id: article.id, before, rendered: entry.description.length });
  }

  if (refusals.length) {
    console.log('  REFUSED:');
    for (const r of refusals) console.log(`    ✗ ${r.handle} — ${r.reason}${r.detail ? `: ${JSON.stringify(r.detail).slice(0, 180)}` : ''}`);
    console.log('');
    // One failure aborts the whole run — never write a partial sweep.
    console.error('  Aborting: every entry must pass before any write.\n');
    process.exitCode = 1;
    return;
  }

  for (const p of planned) {
    console.log(`  ${p.handle}`);
    console.log(`     before: ${p.before === null ? '(no description_tag — theme fell back to body copy)' : JSON.stringify(p.before)}`);
    console.log(`     after : ${JSON.stringify(p.description)}  [${p.rendered} chars]`);
    console.log(`     why   : ${p.why}\n`);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = { generated_at: new Date().toISOString(), applied: APPLY, planned, refusals };
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));

  if (!APPLY) {
    console.log(`  Dry run — nothing was written. Re-run with --apply.\n`);
    return;
  }

  let written = 0;
  for (const p of planned) {
    try {
      await upsertMetafield('articles', p.id, 'global', 'description_tag', p.description);
      written++;
      console.log(`  ✓ wrote description_tag for ${p.handle}`);
    } catch (e) {
      console.error(`  ✗ ${p.handle}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n  Wrote ${written} meta description(s).\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
