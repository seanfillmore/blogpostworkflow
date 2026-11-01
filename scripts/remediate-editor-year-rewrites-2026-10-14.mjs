#!/usr/bin/env node
/**
 * Put back two historical dates that agents/editor's stale-year auto-fix
 * rewrote to the current year on LIVE articles.
 *
 * The editor's pre-review pass bumped every "in <year>" and every year in link
 * text without consulting lib/year-accuracy.js's historical guard, so a dated
 * FACT became a fabricated one (fixed in the same change as this script). Found
 * by reading every "Corrected year" line in the server logs and checking each
 * affected post's live body on 2026-10-14. Only two live pages carry a falsified
 * date; every other bump was an edition marker ("the best ... in 2026"), which is
 * the intended behaviour and is left alone.
 *
 * Correct values come from each post's OWN history, not from memory:
 *   - toothpaste-ingredients-to-avoid: content.backup-1781172509700.html reads
 *     "food additive in 2021" (EFSA's E171 opinion, May 2021).
 *   - natural-antiperspirant: the post's own body cites "(Darbre, 2020)", and the
 *     pre-edit Sources entry read "Frontiers in Oncology. 2020."
 *
 * Dry by default; `--apply` writes. RUN ON THE PRODUCTION SERVER: the content.html
 * mirrors are server-only, and agents/publisher republishes from them, so a fix
 * to Shopify alone would be pushed back by the next republish.
 *
 * A factual repair, so lib/post-edit-gate.js kind `repair` (always allowed).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { runPlan } from './remediate-toothpaste-safety-claims.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_ID = 48998449187;

export const ARTICLES = {
  'toothpaste-ingredients-to-avoid-for-a-cleaner-smile': { blogId: BLOG_ID, articleId: 563840843946 },
  'natural-antiperspirant-what-works-why-it-matters': { blogId: BLOG_ID, articleId: 563582435498 },
};

/** Local post directory for each handle (the mirror runPlan cannot find by handle). */
export const MIRRORS = {
  'toothpaste-ingredients-to-avoid-for-a-cleaner-smile': 'toothpaste-ingredients-to-avoid',
  'natural-antiperspirant-what-works-why-it-matters': 'natural-antiperspirant',
};

const e = (id, handle, before, after, reason) => ({ id, handle, surface: 'body', expectedOccurrences: 1, before, after, reason });

export const PLAN = [
  e('efsa-e171-year', 'toothpaste-ingredients-to-avoid-for-a-cleaner-smile',
    'reclassified it as no longer safe as a food additive in 2026, citing',
    'reclassified it as no longer safe as a food additive in 2021, citing',
    'EFSA concluded E171 was no longer safe as a food additive in May 2021; the editor rewrote it to 2026.'),
  e('darbre-citation-year', 'natural-antiperspirant-what-works-why-it-matters',
    'PD. Aluminum and the Human Breast. <em>Frontiers in Oncology</em>. 2026.</a>',
    'PD. Aluminum and the Human Breast. <em>Frontiers in Oncology</em>. 2020.</a>',
    'Sources entry; the same post cites "(Darbre, 2020)" in its body. The editor rewrote the year to 2026.'),
];

export async function main({ shopify, argv = process.argv.slice(2), root = ROOT, log = console.log } = {}) {
  const record = await runPlan({
    plan: PLAN, articles: ARTICLES, reportDir: 'editor-year-rewrites-2026-10-14',
    backupTag: 'editor-year-rewrites', shopify, argv, root, log,
  });
  const apply = argv.includes('--apply');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [handle, slug] of Object.entries(MIRRORS)) {
    const path = join(root, 'data', 'posts', slug, 'content.html');
    if (!existsSync(path)) { log(`  mirror data/posts/${slug}/content.html — absent`); continue; }
    const original = readFileSync(path, 'utf8');
    let text = original;
    for (const entry of PLAN.filter((p) => p.handle === handle)) {
      const n = text.split(entry.before).length - 1;
      log(`  mirror ${slug}: ${entry.id} — ${n ? `BEFORE ×${n}` : text.includes(entry.after) ? 'already applied' : 'absent'}`);
      if (n) text = text.split(entry.before).join(entry.after);
    }
    if (text !== original && apply) {
      mkdirSync(join(root, 'data', 'posts', slug, 'backups'), { recursive: true });
      writeFileSync(join(root, 'data', 'posts', slug, 'backups', `editor-year-rewrites-${stamp}-content.html`), original);
      writeFileSync(path, text);
      log(`  ✓ mirror data/posts/${slug}/content.html written`);
    }
  }
  return record;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
