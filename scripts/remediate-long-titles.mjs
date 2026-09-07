#!/usr/bin/env node
/**
 * scripts/remediate-long-titles.mjs — shorten live titles that TRUNCATE in Google.
 *
 * DRY BY DEFAULT. `--apply` writes. Every live value is backed up before it is
 * overwritten, and the run record names every decision including the ones it
 * declined to make.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────────
 *
 * `layout/theme.liquid` appends " – Real Skin Care" (17 chars) to any title that
 * does not already contain the shop name. Measured on 67 sitemap-sampled live
 * pages on 2026-09-06, **75% of pages and 92% of ARTICLES render a title over
 * 60 characters**, and **50 of the 50 overages are caused only by that suffix** —
 * every authored title fits, every rendered one does not. PR #828 stops the
 * fleet generating more; this repairs what is already published.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────────
 *
 * It only ever SHORTENS, through the shared, tested `shortenToRenderedLimit`.
 * It does not rewrite for quality, does not call an LLM, and does not touch a
 * meta description, a body, or anything but `title_tag`. A trimmed title is
 * strictly better than a truncated one — Google was already cutting these, the
 * only question was whether WE chose the cut point or the SERP did — but it is
 * not as good as a human rewrite, so `--list` exists to hand the worst cases to
 * a person instead.
 *
 * **It refuses to write a title it would not accept**: every proposed value is
 * re-checked with `checkCopyLength` AND `checkSeoCopy` at run time, and one
 * failure aborts the whole run rather than writing a partial sweep. The health
 * check matters because we are writing a live SERP snippet and this path has no
 * prompt to regenerate from — the same reason `lib/queue-apply.js` refuses
 * rather than dismisses.
 *
 * **Articles carrying no `title_tag` are SKIPPED, not created.** 178 of 215
 * articles have none, so their rendered title comes from `article.title` — the
 * headline a reader sees on the page and in the blog listing, not just a SERP
 * string. Minting a `title_tag` for them is a different, larger decision
 * (it decouples two things that are currently one) and is left to a human.
 * That is why this sweep is smaller than the 92% figure implies, and saying so
 * is the point.
 *
 * Usage:
 *   node scripts/remediate-long-titles.mjs                 # dry run, all surfaces
 *   node scripts/remediate-long-titles.mjs --list          # just show what is over
 *   node scripts/remediate-long-titles.mjs --apply         # write
 *   node scripts/remediate-long-titles.mjs --limit 10 --apply
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getBlogs, getArticles, getProducts, getCustomCollections, getSmartCollections,
  getPages, getMetafields, upsertMetafield,
} from '../lib/shopify.js';
import {
  renderTitle, shortenToRenderedLimit, checkCopyLength, LENGTH_LIMITS,
} from '../lib/seo-copy-length.js';
import { checkSeoCopy } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'long-title-remediation');
const MAX = LENGTH_LIMITS.title.max;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIST_ONLY = argv.includes('--list');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i === -1 ? Infinity : Number(argv[i + 1]) || Infinity;
})();

const len = (s) => [...String(s ?? '')].length;

async function seoTitleTag(resource, id) {
  try {
    const mf = await getMetafields(resource, id);
    return mf.find((m) => m.namespace === 'global' && m.key === 'title_tag')?.value ?? null;
  } catch { return null; }
}

/** Every live surface, with the field the storefront actually renders as page_title. */
async function collectCandidates() {
  const out = [];

  const blogs = await getBlogs();
  for (const b of blogs) {
    for (const a of await getArticles(b.id, { limit: 250 })) {
      out.push({ kind: 'article', resource: 'articles', id: a.id, handle: a.handle, fallback: a.title });
    }
  }
  for (const p of await getProducts({ limit: 250 })) {
    out.push({ kind: 'product', resource: 'products', id: p.id, handle: p.handle, fallback: p.title });
  }
  for (const c of [...await getCustomCollections({ limit: 250 }), ...await getSmartCollections({ limit: 250 })]) {
    out.push({ kind: 'collection', resource: 'collections', id: c.id, handle: c.handle, fallback: c.title });
  }
  for (const pg of await getPages({ limit: 250 })) {
    out.push({ kind: 'page', resource: 'pages', id: pg.id, handle: pg.handle, fallback: pg.title });
  }

  for (const c of out) {
    c.titleTag = await seoTitleTag(c.resource, c.id);
    // page_title is the title_tag when set, else the resource's own title.
    c.pageTitle = c.titleTag ?? c.fallback ?? '';
    c.rendered = renderTitle(c.pageTitle);
    c.renderedLen = len(c.rendered);
  }
  return out;
}

async function main() {
  console.log(`\n  Long-title remediation — ${APPLY ? 'APPLY' : 'DRY RUN'}  (limit ${MAX} rendered chars)\n`);

  const all = await collectCandidates();
  const over = all.filter((c) => c.renderedLen > MAX);

  console.log(`  surfaces scanned : ${all.length}`);
  console.log(`  over ${MAX} rendered : ${over.length}\n`);

  const writable = over.filter((c) => c.titleTag != null);
  const skipped = over.filter((c) => c.titleTag == null);

  // Plan first, verify second, write third — nothing is written until every
  // proposed value has passed both gates.
  // A title_tag carrying markup or a URL is CORRUPT, not merely long — one live
  // article's reads `Can You Use <a href=https://www.realskincare.com/blogs/ne`.
  // Trimming that produces shorter garbage, so it is refused and named. Only a
  // rewrite fixes it.
  const CORRUPT = /[<>]|https?:\/\//;
  const corrupt = writable.filter((c) => CORRUPT.test(c.titleTag));
  const trimmable = writable.filter((c) => !CORRUPT.test(c.titleTag));

  const plan = [];
  for (const c of trimmable) {
    const proposed = shortenToRenderedLimit(c.titleTag);
    if (!proposed || proposed === c.titleTag) continue;

    const lenCheck = checkCopyLength({ title: proposed }, { title: 'title' });
    const health = checkSeoCopy({ title: proposed });
    if (!lenCheck.ok) {
      console.error(`  ABORT — proposed title still over the limit for ${c.handle}: "${proposed}"`);
      process.exitCode = 1; return;
    }
    if (!health.ok) {
      console.error(`  ABORT — proposed title trips the health gate for ${c.handle}: ${JSON.stringify(health.blocking)}`);
      process.exitCode = 1; return;
    }
    plan.push({ ...c, proposed, proposedRendered: renderTitle(proposed) });
  }

  console.log(`  REWRITABLE (have a title_tag) : ${plan.length}`);
  console.log(`  CORRUPT (markup/URL in title_tag — refused, needs a rewrite) : ${corrupt.length}`);
  console.log(`  SKIPPED (no title_tag — would have to CREATE one) : ${skipped.length}\n`);

  for (const c of plan.slice(0, LIST_ONLY ? plan.length : 40)) {
    console.log(`  ${String(c.renderedLen).padStart(3)} → ${String(len(c.proposedRendered)).padStart(3)}  [${c.kind}] ${c.handle}`);
    console.log(`        was: ${c.rendered}`);
    console.log(`        now: ${c.proposedRendered}`);
  }

  if (corrupt.length) {
    console.log(`\n  REFUSED — the title_tag itself is corrupt (markup or a URL). Trimming`);
    console.log(`  would only make it shorter garbage. These need a rewrite:`);
    for (const c of corrupt) console.log(`    [${c.kind}] ${c.handle}\n        ${c.titleTag}`);
  }

  if (skipped.length) {
    console.log(`\n  Skipped — these render from the resource's own title, so shortening them`);
    console.log(`  would mean MINTING a title_tag, which changes what a reader sees. Hand these`);
    console.log(`  to a person or run the meta-optimizer on them:`);
    for (const c of skipped.slice(0, 15)) {
      console.log(`    ${String(c.renderedLen).padStart(3)}  [${c.kind}] ${c.handle}`);
    }
    if (skipped.length > 15) console.log(`    … and ${skipped.length - 15} more`);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = {
    generated_at: new Date().toISOString(),
    applied: APPLY && !LIST_ONLY,
    max_rendered: MAX,
    scanned: all.length,
    over: over.length,
    rewritable: plan.length,
    refused_corrupt: corrupt.map((c) => ({ kind: c.kind, handle: c.handle, title_tag: c.titleTag })),
    skipped_no_title_tag: skipped.map((c) => ({ kind: c.kind, handle: c.handle, rendered: c.rendered, renderedLen: c.renderedLen })),
    changes: plan.map((c) => ({
      kind: c.kind, handle: c.handle, resource: c.resource, id: c.id,
      before: c.titleTag, after: c.proposed,
      before_rendered: c.rendered, after_rendered: c.proposedRendered,
      before_len: c.renderedLen, after_len: len(c.proposedRendered),
    })),
  };
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(record, null, 2));
  console.log(`\n  Run record (includes every BEFORE value, so this is the backup): data/reports/long-title-remediation/${stamp}.json`);

  if (LIST_ONLY) { console.log('\n  --list: nothing written.\n'); return; }
  if (!APPLY) { console.log(`\n  DRY RUN — re-run with --apply to write ${plan.length} title(s).\n`); return; }

  let written = 0;
  for (const c of plan.slice(0, LIMIT)) {
    try {
      await upsertMetafield(c.resource, c.id, 'global', 'title_tag', c.proposed);
      written++;
      console.log(`  ✓ ${c.handle}`);
    } catch (e) {
      console.error(`  ✗ ${c.handle}: ${e.message}`);
    }
  }
  console.log(`\n  Wrote ${written} title(s).\n`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

export { collectCandidates };
