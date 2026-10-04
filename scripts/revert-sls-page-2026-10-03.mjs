#!/usr/bin/env node
/**
 * Revert the SERP-facing copy of `toothpaste-without-sls-what-to-know-best-options`
 * (article 563313508522) to the version it held while it ranked ~#5.
 *
 * Why: the page was the biggest on the blog. Between 2026-09-01 and 2026-09-22 it
 * was edited nine times (title three ways, meta twice, body five times). On
 * 2026-09-08 meta-optimizer changed its H1 from the list framing "Top Picks & What
 * to Skip" to the product framing "for Sensitive Mouths", and on 2026-09-13
 * "sls free toothpaste" fell from ~#5 to ~#10 and clicks fell ~90%. On 2026-09-21
 * the Google title and description followed it into the product framing. The
 * list framing is what searchers on that query want and what ranked.
 *
 * Target state is the 2026-09-01..09-07 version, which held ~#5 the whole time:
 *   article.title    "SLS Free Toothpaste: Top Picks & What to Skip"
 *   title_tag        DELETED, so the theme renders article.title (+ " – Real Skin Care"),
 *                    exactly as before the 2026-09-07 --mint wrote a truncated stub
 *   description_tag  the list-intent meta written 2026-09-01
 *   summary_html     same text (the excerpt)
 *
 *   body_html        the 2026-09-01 body, byte for byte (sha256 1f8ec2c2..., backed up by
 *                    regate at 2026-09-01T16:22Z). It undoes two cannibalization merges
 *                    (09-06, 09-13) that rewrote this locked winner. Checked before
 *                    choosing it: its health-gate hits are a strict SUBSET of the live
 *                    body's (category references to fluoride), its 5 product links point
 *                    at the product, and its only redirected links resolve to the product.
 *   mirror           data/posts/toothpaste-without-sls/content.html set to the same body,
 *                    or scheduler.js's daily link-repair republish would push the merged
 *                    body straight back.
 *   shadow dir       data/posts/toothpaste-without-sls-what-to-know-best-options/ is MOVED
 *                    to data/posts/_orphaned/. The resolver created it on 2026-09-13 keyed
 *                    by the article handle; with a meta.json it shadowed the real post dir
 *                    in resolvePostSlug, so every lock check read "unlocked" for a post
 *                    whose state.json says legacy_locked: true.
 *
 * Also concludes the open meta-ab test on this page as `withdrawn`, or
 * meta-ab-checker would later "revert" it to its stored stub title.
 *
 * Dry by default. `--apply` writes. Run on the SERVER (the A/B tracker lives there).
 * The run record under data/reports/sls-page-revert/ holds every before-value.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeoCopyFields, EDITORIAL_SURFACE } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

export const ARTICLE_ID = 563313508522;
export const HANDLE = 'toothpaste-without-sls-what-to-know-best-options';
export const TARGET = {
  title: 'SLS Free Toothpaste: Top Picks & What to Skip',
  description:
    'Looking for SLS free toothpaste? See which clean ingredients actually matter, which to avoid, and which formulas are worth making the switch to.',
};
export const BODY_SHA256 = '1f8ec2c267cc22a9a0acf327338663174d87016f2af954598b3bbfa80f250204';
const BODY_BACKUP = join(ROOT, 'data/posts/toothpaste-without-sls/backups/content-regate-2026-09-01T16-22-32-827Z.html');
const MIRROR = join(ROOT, 'data/posts/toothpaste-without-sls/content.html');
const SHADOW = join(ROOT, 'data/posts', HANDLE);
const ORPHANED = join(ROOT, 'data/posts/_orphaned');
const TRACKER = join(ROOT, 'data/reports/meta-ab/meta-ab-tracker.json');
const REPORT_DIR = join(ROOT, 'data/reports/sls-page-revert');

export function gateTarget() {
  const r = checkSeoCopyFields({ title: TARGET.title, meta: TARGET.description }, { surface: EDITORIAL_SURFACE });
  if (!r.ok) throw new Error(`target copy fails the health gate: ${JSON.stringify(r)}`);
  if (/[—–]/.test(TARGET.title + TARGET.description)) throw new Error('target copy carries a dash');
}

/** Open tracker entries pointing at this page (any keyword). Pure. */
export function openEntriesForPage(tracker) {
  return tracker.filter((e) => e.status !== 'concluded' && String(e.pageUrl || '').includes(`/${HANDLE}`));
}

async function main() {
  gateTarget();
  const { getBlogs, getArticle, updateArticle, getMetafields, deleteMetafield, upsertMetafield } = await import('../lib/shopify.js');
  let blogId = null, article = null;
  for (const b of await getBlogs()) {
    try { article = await getArticle(b.id, ARTICLE_ID); blogId = b.id; break; } catch { /* not this blog */ }
  }
  if (!article || article.handle !== HANDLE) throw new Error(`article ${ARTICLE_ID} not found or handle mismatch`);
  const mfs = await getMetafields('articles', ARTICLE_ID);
  const tt = mfs.find((m) => m.namespace === 'global' && m.key === 'title_tag');
  const dt = mfs.find((m) => m.namespace === 'global' && m.key === 'description_tag');

  if (!existsSync(BODY_BACKUP)) throw new Error(`body backup missing: ${BODY_BACKUP} (run on the server)`);
  const body = readFileSync(BODY_BACKUP, 'utf8');
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== BODY_SHA256) throw new Error(`body backup hash ${sha} != expected ${BODY_SHA256}`);

  const before = {
    title: article.title, summary_html: article.summary_html,
    title_tag: tt?.value ?? null, description_tag: dt?.value ?? null,
    body_sha256: createHash('sha256').update(article.body_html).digest('hex'),
  };
  const tracker = existsSync(TRACKER) ? JSON.parse(readFileSync(TRACKER, 'utf8')) : null;
  const open = tracker ? openEntriesForPage(tracker) : [];

  console.log('BEFORE', JSON.stringify(before, null, 2));
  console.log('AFTER ', JSON.stringify({ title: TARGET.title, summary_html: TARGET.description, title_tag: null, description_tag: TARGET.description }, null, 2));
  console.log(`body: ${before.body_sha256.slice(0, 8)} -> ${BODY_SHA256.slice(0, 8)} (${article.body_html.length} -> ${body.length} bytes)`);
  console.log(existsSync(SHADOW) ? 'shadow dir present, will move to _orphaned/' : 'shadow dir already gone');
  console.log(tracker ? `open A/B entries on this page: ${open.length}` : 'A/B tracker not present here (run on the server)');
  if (!APPLY) { console.log('\nDry run. Pass --apply to write.'); return; }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recordPath = join(REPORT_DIR, `${stamp}.json`);
  writeFileSync(recordPath, JSON.stringify({ article_id: ARTICLE_ID, before, target: TARGET, open_ab: open }, null, 2));
  writeFileSync(join(REPORT_DIR, `${stamp}.live-body.before.html`), article.body_html);
  if (existsSync(MIRROR)) writeFileSync(join(REPORT_DIR, `${stamp}.mirror.before.html`), readFileSync(MIRROR, 'utf8'));

  await updateArticle(blogId, ARTICLE_ID, { title: TARGET.title, summary_html: TARGET.description, body_html: body });
  writeFileSync(MIRROR, body);
  if (tt) await deleteMetafield(tt.id);
  await upsertMetafield('articles', ARTICLE_ID, 'global', 'description_tag', TARGET.description);

  if (tracker && open.length) {
    const today = new Date().toISOString().slice(0, 10);
    for (const e of open) {
      Object.assign(e, {
        status: 'concluded', outcome: 'withdrawn', concludedDate: today, lastCheckedAt: today,
        openReason: 'withdrawn: page reverted to its pre-drop list framing on 2026-10-03 after the 2026-09-13 ranking drop; the test baseline predates the drop and cannot be read',
      });
    }
    const tmp = `${TRACKER}.tmp`;
    writeFileSync(tmp, JSON.stringify(tracker, null, 2));
    renameSync(tmp, TRACKER);
  }

  if (existsSync(SHADOW)) {
    mkdirSync(ORPHANED, { recursive: true });
    const dest = join(ORPHANED, HANDLE);
    if (existsSync(dest)) throw new Error(`${dest} already exists; not overwriting an archive`);
    renameSync(SHADOW, dest);
    writeFileSync(join(ORPHANED, `${HANDLE}.orphan.json`), `${JSON.stringify({
      slug: HANDLE,
      archived_at: new Date().toISOString(),
      archived_by: 'scripts/revert-sls-page-2026-10-03.mjs',
      action: 'archive',
      reason: "second directory for article 563313508522 created by cannibalization-resolver on 2026-09-13 (keyed by article handle); its meta.json shadowed data/posts/toothpaste-without-sls in resolvePostSlug and hid that post's legacy_locked: true",
      resolved_target: 'toothpaste-without-sls',
      restore: `mv data/posts/_orphaned/${HANDLE} data/posts/${HANDLE}`,
    }, null, 2)}\n`);
  }

  // Read back.
  const a2 = await getArticle(blogId, ARTICLE_ID);
  const m2 = await getMetafields('articles', ARTICLE_ID);
  const ok = a2.title === TARGET.title
    && !m2.some((m) => m.namespace === 'global' && m.key === 'title_tag')
    && m2.find((m) => m.namespace === 'global' && m.key === 'description_tag')?.value === TARGET.description
    && createHash('sha256').update(a2.body_html).digest('hex') === BODY_SHA256;
  console.log(ok ? `\nApplied and verified. Record: ${recordPath}` : '\nREAD-BACK MISMATCH, check the article by hand');
  if (!ok) process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
