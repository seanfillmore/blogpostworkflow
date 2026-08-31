#!/usr/bin/env node
/**
 * Rewrite internal links that point at a Shopify REDIRECT SOURCE so they point
 * at the final destination. DRY BY DEFAULT.
 *
 *   node scripts/fix-redirect-links.mjs                  # report only
 *   node scripts/fix-redirect-links.mjs --slug <handle>  # one article
 *   node scripts/fix-redirect-links.mjs --limit 5        # cap the pages touched
 *   node scripts/fix-redirect-links.mjs --apply          # write live + mirror
 *
 * Measured read-only 2026-08-31: 1,222 internal links (29.5% of all internal
 * links) across 174 of 188 live pages resolve through a 301, mostly the retired
 * collections from the 62 → 5 consolidation, sitting in the buy path.
 *
 * A 301 passes essentially full ranking signal, so this is NOT a ranking fix.
 * It removes a redundant round trip on every click into the buy path and stops
 * crawl budget being spent rediscovering the same destination. It is worth
 * doing because the mapping is Shopify's own redirect table — deterministic, no
 * model call — not because rankings are bleeding.
 *
 * ── WHY IT WRITES BOTH LIVE AND THE MIRROR ──────────────────────────────────
 *
 * `data/posts/<slug>/content.html` is the file `agents/publisher` republishes
 * from, and `scheduler.js`'s daily link-repair step republishes it with
 * --force. Fixing live alone would leave the mirror holding the old hrefs, and
 * the next morning's republish would push them straight back — exactly the
 * `mirror_warning` failure `scripts/remediate-antiperspirant-product-copy.js`
 * documents. So both sides are written in the same run, and a post whose mirror
 * is a DIFFERENT ARTICLE is skipped entirely rather than half-fixed.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 *  * Dry by default; --apply is the only thing that writes.
 *  * The live body is backed up to data/reports/redirect-links/backups/<stamp>/
 *    BEFORE any write, and the mirror to the post's own backups/ directory.
 *  * ANCHOR COUNT IS ASSERTED before and after. This rewrite may only ever
 *    change href VALUES; if the count moves, something structural happened and
 *    the page is skipped. lib/html-output-guards.js's validateRevision would
 *    reject a dropped link downstream, and this fails earlier and louder.
 *  * Only live articles. A draft has no reader to save a hop for.
 *  * Every skip is counted and named — a silent skip is how a fix quietly
 *    stops working.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBlogs, getArticles, updateArticle, getRedirects } from '../lib/shopify.js';
import { rewriteRedirectLinks, buildRedirectMap } from '../lib/redirect-links.js';
import { compareBodies } from '../lib/content-mirror.js';
import { getContentPath } from '../lib/posts.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const slugArg = (() => {
  const i = args.indexOf('--slug');
  return i === -1 ? null : args[i + 1];
})();
const limit = (() => {
  const i = args.indexOf('--limit');
  return i === -1 ? Infinity : Math.max(0, parseInt(args[i + 1], 10) || 0);
})();

const countAnchors = (html) => (html.match(/<a\b/gi) || []).length;

/** Find the local mirror for a Shopify handle, if the repo has one. */
function mirrorPathFor(handle) {
  const direct = getContentPath(handle);
  if (existsSync(direct)) return direct;
  // The Shopify handle is not always the local slug (CLAUDE.md documents the
  // tattoo winner). Fall back to a prefix match over data/posts.
  const postsDir = join(ROOT, 'data', 'posts');
  if (!existsSync(postsDir)) return null;
  for (const d of readdirSync(postsDir)) {
    if (d.startsWith('_')) continue;
    if (handle.startsWith(d) || d.startsWith(handle)) {
      const p = join(postsDir, d, 'content.html');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function main() {
  console.log(`\nRedirect-link fixer — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const redirectRows = await getRedirects();
  const map = buildRedirectMap(redirectRows);
  console.log(`  Redirect table: ${map.size} source paths`);

  const blogs = await getBlogs();
  let articles = [];
  for (const b of blogs) {
    articles = articles.concat((await getArticles(b.id)).map((a) => ({ ...a, blogId: b.id })));
  }
  const live = articles.filter((a) => a.published_at && new Date(a.published_at) <= new Date());
  const scope = slugArg ? live.filter((a) => a.handle === slugArg) : live;
  console.log(`  Live articles: ${live.length}${slugArg ? ` (scoped to ${slugArg})` : ''}\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(ROOT, 'data', 'reports', 'redirect-links', 'backups', stamp);

  let touched = 0;
  let totalRewrites = 0;
  const skipReasons = new Map();
  const bump = (r) => skipReasons.set(r, (skipReasons.get(r) || 0) + 1);
  const rows = [];

  for (const art of scope) {
    if (touched >= limit) break;
    const before = art.body_html || '';
    const { html: after, rewrites, skipped } = rewriteRedirectLinks(before, map);
    for (const s of skipped) bump(s.reason);
    if (!rewrites.length) continue;

    if (countAnchors(before) !== countAnchors(after)) {
      bump('anchor-count-changed');
      console.log(`  ⚠ ${art.handle} — anchor count moved; skipped`);
      continue;
    }

    const mirror = mirrorPathFor(art.handle);
    let mirrorHtml = null;
    let mirrorAfter = null;
    if (mirror) {
      mirrorHtml = readFileSync(mirror, 'utf8');
      const cmp = compareBodies(mirrorHtml, before);
      if (cmp.tier === 'different-article') {
        // Writing live while leaving a different-article mirror behind invites
        // the next republish to overwrite the page wholesale. Not this script's
        // problem to solve — scripts/reconcile-content-mirrors.mjs owns it.
        bump('mirror-is-a-different-article');
        console.log(`  ⚠ ${art.handle} — mirror is a DIFFERENT ARTICLE; skipped (reconcile it first)`);
        continue;
      }
      mirrorAfter = rewriteRedirectLinks(mirrorHtml, map).html;
    }

    touched += 1;
    totalRewrites += rewrites.length;
    rows.push({ handle: art.handle, count: rewrites.length, mirror: Boolean(mirror) });
    console.log(`  ${APPLY ? '✎' : '·'} ${art.handle} — ${rewrites.length} link(s)${mirror ? '' : ' (no local mirror)'}`);
    for (const r of rewrites.slice(0, 3)) console.log(`      ${r.from} → ${r.to}${r.hops > 1 ? ` (${r.hops} hops)` : ''}`);
    if (rewrites.length > 3) console.log(`      … and ${rewrites.length - 3} more`);

    if (!APPLY) continue;

    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, `${art.handle}.live.html`), before);
    await updateArticle(art.blogId, art.id, { body_html: after });

    if (mirror && mirrorAfter !== mirrorHtml) {
      const mirrorBackups = join(dirname(mirror), 'backups');
      mkdirSync(mirrorBackups, { recursive: true });
      writeFileSync(join(mirrorBackups, `content-redirect-links-${stamp}.html`), mirrorHtml);
      writeFileSync(mirror, mirrorAfter);
    }
  }

  console.log(`\n  ${APPLY ? 'Rewrote' : 'Would rewrite'} ${totalRewrites} link(s) across ${touched} page(s).`);
  if (skipReasons.size) {
    console.log('  Skipped:');
    for (const [r, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n} × ${r}`);
    }
  }
  if (!APPLY) console.log('\n  Dry run — nothing was written. Re-run with --apply.');
  else console.log(`\n  Live bodies backed up to ${backupDir}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
