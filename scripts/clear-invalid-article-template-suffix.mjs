#!/usr/bin/env node
/**
 * Clear an article's `template_suffix` when it names a template the LIVE theme does not have.
 *
 * WHY. On 2026-09-12, 37 articles carried `template_suffix: "article"` and 1 carried
 * `"Default blog post"`. The live theme (Be Yours 9.2.0) has exactly one article template,
 * `templates/article.json`, so Shopify silently renders the default for all 38 — the same
 * "plausible fallback instead of a loud failure" family as `coconut-soap` pointing at a
 * product template that was not on the theme. Nothing in this repo writes an article
 * suffix; the values are historical. Clearing them changes NOTHING visible today and stops
 * a future theme file named `article.article.json` from silently restyling 38 posts.
 * Operator-approved (Sean, 2026-09-12).
 *
 * RULE. A suffix is kept when it is empty, or when `templates/article.<suffix>.json` or
 * `.liquid` exists on the live theme. Everything else is cleared to null.
 *
 * SAFETY.
 *   · Dry by default. `--apply` writes. `--handle <h>` restricts to one article, so the
 *     first live write can be a single post checked end to end before the rest.
 *   · Aborts before any write when the live theme lists no base article template: an empty
 *     or failed asset listing would otherwise judge every suffix invalid, valid ones included.
 *   · Every article is re-read immediately before its write and skipped unless its suffix is
 *     still the value that was judged — nothing is computed from a stale read.
 *   · The before-values are written to disk BEFORE the first write, so a crash mid-run still
 *     leaves the restore data. Restore one: `updateArticle(blog_id, id, { template_suffix: before })`.
 *   · Each write is read back until the suffix is empty.
 *
 * Usage:
 *   node scripts/clear-invalid-article-template-suffix.mjs                    # dry run
 *   node scripts/clear-invalid-article-template-suffix.mjs --handle <h> --apply
 *   node scripts/clear-invalid-article-template-suffix.mjs --apply
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectRun } from '../lib/is-direct-run.js';

const OUT_DIR = join('data', 'reports', 'article-template-suffix');
const PAGE = 250;

const flag = (argv, name) => argv.includes(name);
const argValue = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};

/** Does the theme hold `templates/<type>[.<suffix>].json|liquid`? */
export function templateExists(type, suffix, assetKeys) {
  const name = suffix ? `${type}.${suffix}` : type;
  const keys = assetKeys instanceof Set ? assetKeys : new Set(assetKeys);
  return keys.has(`templates/${name}.json`) || keys.has(`templates/${name}.liquid`);
}

/** Pure decision for one article against the live theme's asset keys. */
export function decideArticle(article, assetKeys) {
  const suffix = article.template_suffix;
  if (suffix === null || suffix === undefined || suffix === '') {
    return { action: 'keep', why: 'no suffix — renders the default article template' };
  }
  if (templateExists('article', suffix, assetKeys)) {
    return { action: 'keep', why: `templates/article.${suffix} exists on the live theme` };
  }
  return { action: 'clear', why: `templates/article.${suffix} is not on the live theme — Shopify falls back to the default` };
}

async function listAllArticles(shopify, blogId) {
  const all = [];
  let sinceId = 0;
  for (;;) {
    const page = await shopify.getArticles(blogId, { limit: PAGE, since_id: sinceId });
    all.push(...page);
    if (page.length < PAGE) return all;
    sinceId = page.at(-1).id;
  }
}

async function readBackUntil(read, predicate, { sleep, attempts = 5, delayMs = 1500 }) {
  for (let i = 0; i < attempts; i++) {
    const v = await read();
    if (predicate(v)) return { verified: true, value: v };
    await sleep(delayMs);
  }
  return { verified: false };
}

/** `outDir` is injectable so tests never write into the real report directory. */
export async function main({ api, argv = process.argv, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), outDir = OUT_DIR } = {}) {
  const apply = flag(argv, '--apply');
  const onlyHandle = argValue(argv, '--handle');
  const shopify = api ?? await import('../lib/shopify.js');

  const themeId = await shopify.getMainThemeId();
  const assetKeys = new Set((await shopify.listThemeAssets(themeId)).map((a) => a.key));
  if (!templateExists('article', null, assetKeys)) {
    throw new Error(`ABORT — live theme ${themeId} lists no templates/article.json|liquid (${assetKeys.size} assets). Refusing to judge suffixes against an asset list that is empty or wrong.`);
  }

  const rows = [];
  for (const blog of await shopify.getBlogs()) {
    for (const article of await listAllArticles(shopify, blog.id)) {
      if (onlyHandle && article.handle !== onlyHandle) continue;
      const d = decideArticle(article, assetKeys);
      rows.push({
        blog_id: blog.id, id: article.id, handle: article.handle,
        published: Boolean(article.published_at), before: article.template_suffix ?? null, ...d,
      });
    }
  }
  if (onlyHandle && rows.length === 0) throw new Error(`No article with handle "${onlyHandle}".`);

  const toClear = rows.filter((r) => r.action === 'clear');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`Live theme ${themeId}: ${rows.length} article(s) checked, ${toClear.length} to clear.`);
  for (const r of toClear) console.log(`  CLEAR ${r.published ? 'pub  ' : 'draft'} ${JSON.stringify(r.before).padEnd(20)} ${r.handle}`);

  mkdirSync(outDir, { recursive: true });
  if (apply && toClear.length) {
    const backupPath = join(outDir, `before-${stamp}.json`);
    writeFileSync(backupPath, JSON.stringify(toClear.map(({ blog_id, id, handle, before }) => ({ blog_id, id, handle, before })), null, 2));
    console.log(`Before-values written: ${backupPath}`);
  }

  for (const r of toClear) {
    r.written = false;
    if (!apply) continue;
    const live = await shopify.getArticle(r.blog_id, r.id);
    if ((live?.template_suffix ?? null) !== r.before) {
      r.skipped = `live suffix is now ${JSON.stringify(live?.template_suffix ?? null)}, not ${JSON.stringify(r.before)}`;
      console.log(`  SKIP ${r.handle}: ${r.skipped}`);
      continue;
    }
    await shopify.updateArticle(r.blog_id, r.id, { template_suffix: null });
    const rb = await readBackUntil(() => shopify.getArticle(r.blog_id, r.id),
      (a) => (a?.template_suffix ?? '') === '', { sleep });
    r.written = true;
    r.verified = rb.verified;
    console.log(`  ✓ ${r.handle}${rb.verified ? '' : ' — READ-BACK STILL SHOWS A SUFFIX, re-check'}`);
  }

  const record = { generated_at: new Date().toISOString(), applied: apply, theme_id: themeId, checked: rows.length, cleared: toClear };
  const recordPath = join(outDir, `run-${stamp}.json`);
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`\nRun record: ${recordPath}${apply ? '' : '\nDRY RUN — pass --apply to write.'}`);
  return record;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
