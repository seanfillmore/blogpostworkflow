#!/usr/bin/env node
/**
 * Restore the toothpaste buy-box links that `scripts/fix-redirect-links.mjs`
 * repointed from the PRODUCT to a BLOG POST on 2026-09-20/21.
 *
 * What happened: Shopify's redirect table held a redirect whose source was a
 * live product URL for the coconut oil toothpaste, targeting
 * /blogs/news/can-you-use-coconut-oil-as-toothpaste. A redirect on a path a live
 * resource occupies never fires (Shopify serves the resource), but the script
 * treated every redirect source as dead and rewrote the links. Measured
 * 2026-10-03: 41 live articles, ~100 "Add to Cart" / "Shop" buttons sending
 * buyers to a blog post instead of the product.
 *
 * How it restores, and why it cannot over-reach: fix-redirect-links backed up
 * every live body (data/reports/redirect-links/backups/<stamp>/<handle>.live.html)
 * and every mirror (data/posts/<slug>/backups/content-redirect-links-<stamp>.html)
 * BEFORE writing. An anchor is restored only when BOTH hold:
 *   - its href now resolves to the blog post, and
 *   - in the earliest backup taken on/after 2026-09-20, every anchor with the same
 *     identity (attributes other than href, plus link text) pointed at a product.
 * Links that legitimately pointed at the blog post before are untouched, and an
 * ambiguous identity is left alone.
 * The restored href is the canonical product URL, keeping the link's host style.
 *
 * Dry by default; --apply writes live and the mirror; --handle <h> limits to one
 * article. Run on the SERVER.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const HANDLE = (() => { const i = process.argv.indexOf('--handle'); return i === -1 ? null : process.argv[i + 1]; })();
const BACKUPS = join(ROOT, 'data/reports/redirect-links/backups');
const SINCE = '2026-09-20';
export const WRONG = '/blogs/news/can-you-use-coconut-oil-as-toothpaste';
export const PRODUCT = '/products/coconut-oil-toothpaste';

export function hrefPath(href) {
  try {
    const u = new URL(href, 'https://www.realskincare.com');
    if (!/(^|\.)realskincare\.com$/i.test(u.hostname)) return null;
    return u.pathname.replace(/\/+$/, '').toLowerCase();
  } catch { return null; }
}

const isWrong = (href) => hrefPath(href) === WRONG;
const wasProduct = (href) => {
  const p = hrefPath(href);
  return p === PRODUCT || /^\/collections\/[^/]+\/products\/coconut-oil-toothpaste$/.test(p || '');
};
const productHrefLike = (wrongHref) =>
  /^https?:\/\//i.test(wrongHref) ? `${new URL(wrongHref).origin}${PRODUCT}` : PRODUCT;

const FULL_ANCHOR = /<a\b([^>]*?)\shref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;

/** An anchor's identity without its href: other attributes plus visible text. */
export function anchorKey(attrsBefore, attrsAfter, inner) {
  const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const attrs = `${attrsBefore} ${attrsAfter}`.replace(/\s+/g, ' ').trim();
  return `${attrs}|${text}`;
}

/** A purchase call can never correctly lead to an article, whatever the backup says. */
export function isBuyButton(inner) {
  return /^(add to cart|shop\b|buy\b)/i.test(inner.replace(/<[^>]+>/g, ' ').trim());
}

/**
 * Pure. Restore anchors in `current` that the backup proves were product links.
 * Matching is by anchor identity (attributes other than href + link text), not
 * position, because internal-linker has added links to these pages since the
 * rewrite. A key is restorable only when, in the backup, EVERY anchor with that
 * key pointed at the product, so an identity that also pointed at the blog post
 * before is never changed.
 * @returns {{html:string, restored:number}}
 */
export function restoreFromBackup(current, backup) {
  const verdict = new Map(); // key -> 'product' | 'other'
  for (const m of backup.matchAll(FULL_ANCHOR)) {
    const key = anchorKey(m[1], m[3], m[4]);
    const v = wasProduct(m[2]) ? 'product' : 'other';
    verdict.set(key, verdict.has(key) && verdict.get(key) !== v ? 'other' : v);
  }
  let restored = 0;
  const html = current.replace(FULL_ANCHOR, (match, a1, href, a2, inner) => {
    if (!isWrong(href)) return match;
    if (verdict.get(anchorKey(a1, a2, inner)) !== 'product' && !isBuyButton(inner)) return match;
    restored++;
    return match.replace(`href="${href}"`, `href="${productHrefLike(href)}"`);
  });
  return { html, restored };
}

/** Earliest backup on/after SINCE for this handle, from a list of stamp dirs. */
function earliestLiveBackup(handle) {
  for (const stamp of readdirSync(BACKUPS).filter((s) => s >= SINCE).sort()) {
    const f = join(BACKUPS, stamp, `${handle}.live.html`);
    if (existsSync(f)) return { stamp, html: readFileSync(f, 'utf8') };
  }
  return null;
}

function earliestMirrorBackup(slug) {
  const dir = join(ROOT, 'data/posts', slug, 'backups');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => n.startsWith('content-redirect-links-') && n.slice(23) >= SINCE).sort()[0];
  return f ? readFileSync(join(dir, f), 'utf8') : null;
}

async function main() {
  const { getBlogs, getArticles, updateArticle } = await import('../lib/shopify.js');
  const { listAllSlugs, getPostMeta, getContentPath } = await import('../lib/posts.js');
  const byArticleId = new Map();
  for (const s of listAllSlugs()) {
    const m = getPostMeta(s);
    if (m?.shopify_article_id) byArticleId.set(String(m.shopify_article_id), s);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(ROOT, 'data/reports/product-link-restore', stamp);
  const summary = { live_fixed: 0, links: 0, skipped: [], mirrors_fixed: 0, mirror_skipped: [] };

  for (const blog of await getBlogs()) {
    for (const a of await getArticles(blog.id, { limit: 250 })) {
      if (HANDLE && a.handle !== HANDLE) continue;
      if (!a.published_at || !(a.body_html || '').includes('can-you-use-coconut-oil-as-toothpaste')) continue;
      const b = earliestLiveBackup(a.handle);
      if (!b) { summary.skipped.push(`${a.handle}: no backup`); continue; }
      const r = restoreFromBackup(a.body_html, b.html);
      if (!r.html) { summary.skipped.push(`${a.handle}: ${r.reason}`); continue; }
      if (!r.restored) continue;
      console.log(`${a.handle}: restore ${r.restored} link(s) (ref ${b.stamp})`);
      summary.live_fixed++; summary.links += r.restored;

      const slug = byArticleId.get(String(a.id));
      const mirrorPath = slug ? getContentPath(slug) : null;
      let mirrorOut = null;
      if (mirrorPath && existsSync(mirrorPath)) {
        const mb = earliestMirrorBackup(slug);
        const mr = mb ? restoreFromBackup(readFileSync(mirrorPath, 'utf8'), mb) : { html: null, reason: 'no mirror backup' };
        if (mr.html && mr.restored) mirrorOut = mr.html;
        else if (!mr.html) summary.mirror_skipped.push(`${slug}: ${mr.reason}`);
      }

      if (APPLY) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${a.handle}.before.html`), a.body_html);
        await updateArticle(blog.id, a.id, { body_html: r.html });
        if (mirrorOut) {
          writeFileSync(join(outDir, `${slug}.mirror.before.html`), readFileSync(mirrorPath, 'utf8'));
          writeFileSync(mirrorPath, mirrorOut);
          summary.mirrors_fixed++;
        }
      }
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (APPLY) writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  else console.log('\nDry run. Pass --apply to write.');
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e); process.exitCode = 1; });
