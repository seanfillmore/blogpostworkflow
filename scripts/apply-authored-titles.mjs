#!/usr/bin/env node
/**
 * scripts/apply-authored-titles.mjs — write a HAND-AUTHORED `title_tag`.
 * DRY BY DEFAULT; `--apply` writes.
 *
 * ── WHY THIS IS NOT `remediate-long-titles.mjs --mint` ────────────────────────
 *
 * That script only ever SHORTENS, and it only looks at surfaces whose RENDERED
 * title is over the limit. Once a title has been minted it fits, so it leaves
 * the candidate set entirely — including its `OVERRIDES` table, which is only
 * consulted for surfaces already flagged as over. There is therefore no path in
 * that script for "this title fits but reads badly", which is exactly what a
 * mechanical trim leaves behind:
 *
 *     Best Women Body Lotion: Natural Picks     ← grammatical, barely
 *     Best All Natural Toothpaste: Top Picks    ← true of half the blog
 *
 * A trim preserves ranking tokens and nothing else. This path exists for the
 * rewrite a person would actually write, grounded in what the article says.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────────
 *
 *  * Dry by default. `--apply` is the only thing that writes.
 *  * Every proposed value is re-checked at run time through `checkSeoCopy`
 *    (health/regulatory) AND `checkCopyLength` (the rendered-title budget: the
 *    theme appends " – Real Skin Care" unless the title already contains the
 *    shop name), and ONE failure aborts the whole run rather than writing a
 *    partial sweep — the same rule as the other remediation scripts.
 *  * It also asserts each value is STABLE under `shortenToRenderedLimit`, so a
 *    later sweep cannot re-trim an operator's chosen wording.
 *  * DRIFT GUARD: it refuses when the live `title_tag` is neither the expected
 *    `before` nor already the `after`. Something else wrote it, and silently
 *    overwriting that is how a considered edit gets lost.
 *  * The run record holds every BEFORE value, so it is the backup.
 *
 * Usage:
 *   node scripts/apply-authored-titles.mjs            # report
 *   node scripts/apply-authored-titles.mjs --apply    # write
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBlogs, getArticles, getMetafields, upsertMetafield } from '../lib/shopify.js';
import { checkCopyLength, shortenToRenderedLimit, renderTitle, LENGTH_LIMITS } from '../lib/seo-copy-length.js';
import { checkSeoCopy } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'authored-titles');
const APPLY = process.argv.slice(2).includes('--apply');

/**
 * Hand-authored, operator-approved 2026-09-21. `before` is the mechanical trim
 * `remediate-long-titles.mjs --mint` wrote on 2026-09-20; `after` is grounded in
 * what each article actually contains, read off the live page rather than
 * guessed from the slug.
 *
 * Two are left at the mechanical value on purpose and are NOT in this plan:
 * `Coconut Oil Fatty Acids Explained` and `Best Cheap Natural Lip Balms` already
 * say what their articles are about, and rewriting a good title to prove a
 * script works is churn on a live SERP snippet.
 */
export const PLAN = [
  {
    handle: 'best-women-body-lotion-natural-picks-for-soft-skin',
    before: 'Best Women Body Lotion: Natural Picks',
    after: 'Best Body Lotion for Women: Clean Picks',
    why: '"Women Body Lotion" is not English. The article is a numbered roundup of clean picks, so "for Women: Clean Picks" reads as written while keeping every ranking token.',
  },
  {
    handle: 'best-body-lotion-for-aging-skin-top-natural-picks',
    before: 'Best Body Lotion for Aging Skin',
    after: 'Best Natural Body Lotion for Aging Skin',
    why: 'The trim dropped "Natural", which is the article\'s actual angle (its picks are all natural, and it has a full ingredients-to-avoid section). 8 characters of unused budget bought it back.',
  },
  {
    handle: 'best-all-natural-toothpaste-top-picks-for-a-clean-smile',
    before: 'Best All Natural Toothpaste: Top Picks',
    after: 'Best All Natural Toothpaste: SLS-Free Picks',
    why: '"Top Picks" is true of half the blog. SLS-free is the concrete differentiator the article leads on, and it is an ingredient-absence fact rather than a claim about what the toothpaste does.',
  },
];

async function findArticle(handle) {
  for (const b of await getBlogs()) {
    for (const a of await getArticles(b.id, { limit: 250 })) {
      if (a.handle === handle) return { ...a, blogId: b.id };
    }
  }
  return null;
}

async function titleTag(articleId) {
  const mf = await getMetafields('articles', articleId);
  return mf.find((m) => m.namespace === 'global' && m.key === 'title_tag')?.value ?? null;
}

async function main() {
  console.log(`\nAuthored title_tag — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const planned = [];
  const refusals = [];

  for (const entry of PLAN) {
    const health = checkSeoCopy({ title: entry.after });
    if (!health.ok) { refusals.push({ ...entry, reason: 'health gate', detail: health.violations }); continue; }

    const length = checkCopyLength({ title: entry.after }, { title: 'title' });
    if (!length.ok) { refusals.push({ ...entry, reason: 'rendered length', detail: length.overlong }); continue; }

    // A later --mint/--list sweep must not re-trim what a person chose.
    if (shortenToRenderedLimit(entry.after) !== entry.after) {
      refusals.push({ ...entry, reason: 'not stable under the shortener' });
      continue;
    }

    const article = await findArticle(entry.handle);
    if (!article) { refusals.push({ ...entry, reason: 'article not found' }); continue; }

    const live = await titleTag(article.id);
    if (live !== entry.before && live !== entry.after) {
      // Neither the value we expected nor the one we intend: somebody or
      // something else wrote this. Overwriting it silently is the loss.
      refusals.push({ ...entry, reason: 'live title_tag matches neither before nor after', detail: live });
      continue;
    }

    planned.push({ ...entry, id: article.id, live, already: live === entry.after });
  }

  if (refusals.length) {
    console.log('  REFUSED:');
    for (const r of refusals) console.log(`    ✗ ${r.handle} — ${r.reason}${r.detail ? `: ${JSON.stringify(r.detail).slice(0, 200)}` : ''}`);
    console.error('\n  Aborting: every entry must pass before any write.\n');
    process.exitCode = 1;
    return;
  }

  for (const p of planned) {
    const r = renderTitle(p.after);
    console.log(`  ${p.handle}${p.already ? '   [already applied]' : ''}`);
    console.log(`     was : ${JSON.stringify(p.before)}`);
    console.log(`     now : ${JSON.stringify(p.after)}  [${p.after.length} authored, ${[...r].length}/${LENGTH_LIMITS.title.max} rendered]`);
    console.log(`     why : ${p.why}\n`);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = { generated_at: new Date().toISOString(), applied: APPLY, planned, refusals };
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));

  if (!APPLY) { console.log('  Dry run — nothing was written. Re-run with --apply.\n'); return; }

  let written = 0;
  for (const p of planned) {
    if (p.already) { console.log(`  · ${p.handle} already applied`); continue; }
    try {
      await upsertMetafield('articles', p.id, 'global', 'title_tag', p.after);
      written++;
      console.log(`  ✓ ${p.handle}`);
    } catch (e) {
      console.error(`  ✗ ${p.handle}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n  Wrote ${written} title(s).\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
