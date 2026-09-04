#!/usr/bin/env node
/**
 * Which theme templates does anything actually render? Read-only.
 *
 * A template is reachable one of three ways, and all three have to be checked or
 * the answer is wrong in the dangerous direction:
 *
 *   1. A RESOURCE points at it via `template_suffix` — products, pages,
 *      collections, blogs and articles each carry their own, and each is a
 *      separate API call. A resource of ANY status counts, not just published
 *      ones: a draft product is one publish away from rendering its template.
 *   2. It is a CORE template Shopify routes to by name. `templates/index.json`
 *      is the homepage; `templates/cart.json`, `404`, `search`, `password`,
 *      `list-collections`, `gift_card` and every `customers/*` are routed by the
 *      platform with no resource pointing at them. Deleting one of those breaks
 *      the storefront and NOTHING in the resource data would have warned you.
 *   3. It is a BASE template — bare `product.json`, `page.json`, `collection.json`,
 *      `article.json`, `blog.json` — used by every resource whose suffix is null.
 *   4. Theme CODE renders it by name through the `?view=` parameter, with no
 *      resource pointing at it at all. This one is easy to miss and it is not
 *      hypothetical: on 2026-09-04 the resource scan called `product.card.liquid`
 *      and `product.modal.json` unused, while `assets/color-swatches.js` fetches
 *      `?view=card` and `assets/quick-view.js` fetches `?view=modal`. Deleting
 *      either would have broken a live storefront feature with nothing in the
 *      resource data to warn you. So every section/snippet/layout/asset is scanned
 *      for `view=` renders and those names are treated as used.
 *
 * So "no product uses it" is only a deletion argument for a SUFFIXED template
 * whose type is also checked against the right resource list. The classifier
 * refuses to call a core or base template unused, whatever the resource data says.
 *
 * `robots.txt.liquid` and `llms.txt.liquid` are core-adjacent: Shopify routes both
 * by name and this repo publishes llms.txt deliberately, so both are protected.
 *
 * PRUNING. `--prune` lists what would be deleted; `--prune --apply` deletes it.
 * The prune set is exactly the rows this same run classified `UNUSED` — there is no
 * second list to drift out of step with the classifier, which is the whole reason
 * the two live in one file. Every asset's full text is written to
 * data/reports/theme-template-audit/<stamp>/ BEFORE the delete; a theme asset is
 * plain text restorable with `updateThemeAsset`, unlike a product image where
 * DELETE destroys the CDN file. `--prune` without `--apply` never writes.
 *
 * Usage: node scripts/audit-theme-templates.mjs [--json] [--prune [--apply]]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getMainThemeId,
  listThemeAssets,
  getThemeAssetRaw,
  getProducts,
  getPages,
  getCustomCollections,
  getSmartCollections,
  getBlogs,
  getArticles,
  deleteThemeAsset,
} from '../lib/shopify.js';

const AS_JSON = process.argv.includes('--json');
const PRUNE = process.argv.includes('--prune');
const APPLY = process.argv.includes('--apply');

/** Routed by Shopify by name, or published by this repo. Never "unused". */
export const CORE_TEMPLATES = new Set([
  'index', 'cart', '404', 'search', 'password', 'list-collections',
  'gift_card', 'robots.txt', 'llms.txt', 'collection.all',
]);

/** The default for every resource whose template_suffix is null. */
export const BASE_TYPES = new Set(['product', 'page', 'collection', 'article', 'blog']);

/** `templates/product.landing-page-lotion.json` → { type, suffix, base } */
export function parseTemplateKey(key) {
  const name = key.replace(/^templates\//, '').replace(/\.(json|liquid)$/, '');
  if (name.startsWith('customers/')) return { name, type: 'customers', suffix: null, core: true };
  if (CORE_TEMPLATES.has(name)) return { name, type: name, suffix: null, core: true };
  const dot = name.indexOf('.');
  if (dot === -1) return { name, type: name, suffix: null, core: BASE_TYPES.has(name) };
  return { name, type: name.slice(0, dot), suffix: name.slice(dot + 1), core: false };
}

async function main() {
  const themeId = await getMainThemeId();
  const assets = await listThemeAssets(themeId);
  const keys = assets.map((a) => a.key).filter((k) => k.startsWith('templates/'));

  // Every resource type that can carry a template_suffix, of ANY status.
  const products = await getProducts({ limit: 250 });
  const pages = await getPages({ limit: 250 });
  const collections = [
    ...(await getCustomCollections({ limit: 250 })),
    ...(await getSmartCollections({ limit: 250 })),
  ];
  const blogs = await getBlogs();
  const articles = [];
  for (const b of blogs) articles.push(...(await getArticles(b.id, { limit: 250 })));

  // (4) Templates rendered by theme CODE via ?view=<name>. Scanned live rather than
  // hardcoded, so a new quick-view or swatch feature protects its own template.
  const codeKeys = assets.map((a) => a.key).filter((k) => /^(sections|snippets|layout|blocks|assets)\/.*\.(liquid|js)$/.test(k));
  const viewRe = /[?&]view=([a-z0-9_-]+)|view:\s*'([a-z0-9_-]+)'|view:\s*"([a-z0-9_-]+)"/gi;
  const viewRendered = new Map(); // suffix -> [asset keys]
  for (const k of codeKeys) {
    let v;
    try { v = (await getThemeAssetRaw(themeId, k))?.value || ''; } catch { continue; }
    for (const m of v.matchAll(viewRe)) {
      const name = m[1] || m[2] || m[3];
      if (!viewRendered.has(name)) viewRendered.set(name, []);
      viewRendered.get(name).push(k);
    }
  }

  const used = new Map(); // "type.suffix" -> [labels]
  const note = (type, suffix, label) => {
    const k = suffix ? `${type}.${suffix}` : type;
    if (!used.has(k)) used.set(k, []);
    used.get(k).push(label);
  };
  for (const p of products) note('product', p.template_suffix, `${p.handle} [${p.status}]`);
  for (const p of pages) note('page', p.template_suffix, p.handle);
  for (const c of collections) note('collection', c.template_suffix, c.handle);
  for (const b of blogs) note('blog', b.template_suffix, b.handle);
  for (const a of articles) note('article', a.template_suffix, a.handle);

  const rows = [];
  for (const key of keys) {
    const { name, type, suffix, core } = parseTemplateKey(key);
    const users = used.get(suffix ? `${type}.${suffix}` : type) || [];
    const viewers = (suffix && viewRendered.get(suffix)) || [];
    let verdict;
    if (core) verdict = 'core';
    else if (!suffix && BASE_TYPES.has(type)) verdict = users.length ? 'base (in use)' : 'base (no resource, still routed)';
    else if (users.length) verdict = 'in use';
    else if (viewers.length) verdict = 'rendered by ?view=';
    else verdict = 'UNUSED';
    const asset = verdict === 'UNUSED' ? await getThemeAssetRaw(themeId, key) : null;
    rows.push({ key, name, type, suffix, verdict, users, viewers, bytes: asset?.value?.length ?? null });
  }

  const result = {
    generated_at: new Date().toISOString(),
    theme_id: themeId,
    counts: {
      templates: keys.length,
      products: products.length,
      pages: pages.length,
      collections: collections.length,
      blogs: blogs.length,
      articles: articles.length,
      unused: rows.filter((r) => r.verdict === 'UNUSED').length,
    },
    rows,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
    if (PRUNE) await prune(themeId, rows);
    return;
  }

  const c = result.counts;
  console.log(`\nTheme ${themeId} — ${c.templates} templates against ${c.products} products, ${c.pages} pages, ${c.collections} collections, ${c.blogs} blogs, ${c.articles} articles\n`);
  for (const group of ['UNUSED', 'rendered by ?view=', 'in use', 'base (in use)', 'base (no resource, still routed)', 'core']) {
    const g = rows.filter((r) => r.verdict === group);
    if (!g.length) continue;
    console.log(`${group} (${g.length})`);
    for (const r of g) {
      const tail = r.verdict === 'UNUSED'
        ? `  ${r.bytes ?? '?'}b`
        : r.viewers.length && !r.users.length ? `  ← ${r.viewers.join(', ')}`
        : r.users.length ? `  ← ${r.users.slice(0, 3).join(', ')}${r.users.length > 3 ? ` +${r.users.length - 3}` : ''}` : '';
      console.log(`  ${r.key}${tail}`);
    }
    console.log('');
  }

  if (PRUNE) await prune(themeId, rows);
}

/** Delete exactly the rows this run classified UNUSED, after backing each one up. */
async function prune(themeId, rows) {
  const doomed = rows.filter((r) => r.verdict === 'UNUSED');
  if (!doomed.length) {
    console.log('Nothing to prune.');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('data', 'reports', 'theme-template-audit', stamp);
  mkdirSync(dir, { recursive: true });

  const done = [];
  for (const r of doomed) {
    const asset = await getThemeAssetRaw(themeId, r.key);
    if (!asset || typeof asset.value !== 'string') {
      console.log(`  ${r.key}: already absent.`);
      done.push({ key: r.key, outcome: 'already-absent' });
      continue;
    }
    const backup = join(dir, r.key.replace(/\//g, '__'));
    writeFileSync(backup, asset.value);
    if (!APPLY) {
      console.log(`  ${r.key}: would delete (${asset.value.length}b, backed up)`);
      done.push({ key: r.key, outcome: 'would-delete', backup });
      continue;
    }
    await deleteThemeAsset(themeId, r.key);
    console.log(`  ${r.key}: DELETED (${asset.value.length}b, backup ${backup})`);
    done.push({ key: r.key, outcome: 'deleted', backup });
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ at: new Date().toISOString(), themeId, applied: APPLY, pruned: done }, null, 2));
  console.log(`\nBackups + run record: ${dir}/`);
  if (!APPLY) console.log('DRY RUN — pass --apply to delete.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
