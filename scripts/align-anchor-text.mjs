#!/usr/bin/env node
/**
 * Make every link's words match where it sends people (Sean, 2026-10-22).
 *
 * The 62 → 5 collection consolidation repointed links to single product pages
 * and left their text saying "collection": measured 2026-10-22, 157 links on 64
 * live articles. lib/redirect-links.js now retexts as it repoints, so new ones
 * cannot appear; this sweeps the ones already live. Rules: lib/anchor-destination.js.
 *
 *   node scripts/align-anchor-text.mjs                 # DRY RUN, every published article
 *   node scripts/align-anchor-text.mjs --slug <handle> # one article
 *   node scripts/align-anchor-text.mjs --limit 5
 *   node scripts/align-anchor-text.mjs --apply         # write live + mirror (run ON THE SERVER)
 *
 * Only link TEXT changes. The live body is backed up first; the local mirror
 * gets the same deterministic alignment (never a copy of live), so a mirror
 * that differs from live for other reasons is not resynced by this script.
 * edit-gate kind: repair (link text matching its destination), always allowed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignProductAnchors } from '../lib/anchor-destination.js';
import { listAllSlugs, getPostMeta, getContentPath } from '../lib/posts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const argVal = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const SLUG = argVal('--slug');
const LIMIT = argVal('--limit') ? parseInt(argVal('--limit'), 10) : Infinity;

const anchors = (h) => (h.match(/<a\b/gi) || []).length;
/** Body with every anchor's inner text removed: must be identical before and after. */
const skeleton = (h) => h.replace(/(<a\b[^>]*>)[\s\S]*?(<\/a>)/gi, '$1$2');

function mirrorIndex() {
  const idx = new Map();
  for (const slug of listAllSlugs()) {
    const meta = getPostMeta(slug);
    const p = getContentPath(slug);
    if (meta?.shopify_article_id && existsSync(p)) idx.set(String(meta.shopify_article_id), p);
  }
  return idx;
}

async function main() {
  const { getBlogs, getArticles, updateArticle } = await import('../lib/shopify.js');
  const mirrors = mirrorIndex();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(ROOT, 'data', 'reports', 'anchor-text', stamp);
  let pages = 0; let links = 0;

  for (const blog of await getBlogs()) {
    for (const art of await getArticles(blog.id)) {
      if (pages >= LIMIT) break;
      if (!art.published_at || (SLUG && art.handle !== SLUG)) continue;
      const before = art.body_html || '';
      const { html: after, changes } = alignProductAnchors(before);
      if (!changes.length) continue;
      if (anchors(before) !== anchors(after) || skeleton(before) !== skeleton(after)) {
        console.log(`  ⚠ ${art.handle}: something other than link text would change; skipped`);
        continue;
      }
      pages += 1; links += changes.length;
      console.log(`  ${APPLY ? '✎' : '·'} ${art.handle}: ${changes.length} link(s)`);
      for (const c of changes) console.log(`      "${c.from}" → "${c.to}"`);
      if (!APPLY) continue;

      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, `${art.handle}.live.html`), before);
      await updateArticle(blog.id, art.id, { body_html: after });
      const mirror = mirrors.get(String(art.id));
      if (mirror) {
        const m = readFileSync(mirror, 'utf8');
        const aligned = alignProductAnchors(m).html;
        if (aligned !== m) {
          writeFileSync(join(backupDir, `${art.handle}.mirror.html`), m);
          writeFileSync(mirror, aligned);
        }
      }
    }
  }
  console.log(`\n${APPLY ? 'Retexted' : 'Would retext'} ${links} link(s) on ${pages} page(s).`);
  if (APPLY && pages) console.log(`Backups: ${backupDir}`);
  else if (!APPLY) console.log('Dry run, nothing written. Re-run with --apply ON THE SERVER.');
}

main().catch((e) => { console.error(e); process.exit(1); });
