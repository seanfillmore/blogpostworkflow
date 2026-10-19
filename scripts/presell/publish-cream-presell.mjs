#!/usr/bin/env node
/**
 * Ship the Coconut Moisturizer pre-sell page: four theme files and one Shopify page.
 *
 *   node scripts/presell/publish-cream-presell.mjs --theme <preview id> [--apply]
 *   node scripts/presell/publish-cream-presell.mjs --live [--apply]
 *   node scripts/presell/publish-cream-presell.mjs --page [--publish] [--apply]
 *
 * Dry by default: without --apply it reports what each step would do and writes
 * nothing. Flags combine (`--live --page --publish --apply` is the go-live run).
 *
 * THEME FILES are read from git HEAD (`git show HEAD:theme/<key>`), never from the
 * working tree, so what ships is exactly what was reviewed, `\/` escaping intact.
 * Each write is GUARDED: the target theme's current copy must be either
 *   - the expected "before": the version merged to main (LIVE_BASE_REF,
 *     `git show origin/main:theme/<key>`), which is what PR #1087 put live, or
 *   - already the new content (a re-run is a no-op).
 *   - an earlier version of the file committed on this branch (a previous run of
 *     this script shipped it; a fix is being redeployed).
 * Anything else means somebody changed the live file since this was built, and
 * the run refuses BEFORE writing anything. After each write the asset is read
 * back (polled, read-backs lag) and compared byte for byte; `theme push --only`
 * has reported success while uploading nothing, so a write is never trusted.
 *
 * `--live` resolves the published theme with resolveLiveThemeId at run time.
 * `--theme <id>` refuses the live id: preview writes cannot land on production.
 *
 * THE PAGE: handle `coconut-body-cream`, template_suffix `presell-cream`. Found
 * by handle if it exists (idempotent). Created UNPUBLISHED unless --publish.
 * Metafield seo.hidden = 1 (number_integer) is always set, which makes Shopify
 * emit noindex and drop the page from the sitemap.
 *
 * A run record (every guard verdict, write and read-back) lands in
 * data/reports/presell/ — not committed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../../lib/is-direct-run.js';
import { resolveLiveThemeId, UNRESOLVED_LIVE_THEME_REASON } from '../../lib/shopify-live-theme.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PAGE = {
  handle: 'coconut-body-cream',
  title: 'Coconut Body Cream',
  template_suffix: 'presell-cream',
};

/**
 * The page is live (PR #1087), so each file's expected "before" is the version on
 * main. The product template (product.landing-page-cream.json) shipped with that
 * PR and is deliberately NOT in this list: this script never writes it again.
 */
export const LIVE_BASE_REF = 'origin/main';

export const FILES = [
  { key: 'sections/presell-listicle.liquid', before: LIVE_BASE_REF },
  { key: 'assets/presell.css', before: LIVE_BASE_REF },
  { key: 'assets/presell-buy.js', before: LIVE_BASE_REF },
  { key: 'templates/page.presell-cream.json', before: LIVE_BASE_REF },
];

function gitShow(ref, key) {
  return execFileSync('git', ['show', `${ref}:theme/${key}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 });
}

/**
 * Earlier versions of a file committed on THIS branch (origin/main..HEAD). A
 * theme already carrying one of them was written by an earlier run of this
 * script, so a fix can be redeployed over it.
 */
function branchVersions(key) {
  const shas = execFileSync('git', ['log', '--format=%H', 'origin/main..HEAD', '--', `theme/${key}`], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const out = [];
  for (const sha of shas) { try { out.push(gitShow(sha, key)); } catch { /* absent at that commit */ } }
  return out;
}

/**
 * Pure guard. `current` is undefined when the asset is absent on the theme.
 * `prior` lists earlier branch versions this script may have shipped.
 * @returns {'write'|'already'|'refuse'}
 */
export function guardVerdict({ current, before, target, prior = [] }) {
  if (current === target) return 'already';
  if (before === null ? current === undefined : current === before) return 'write';
  if (current !== undefined && prior.includes(current)) return 'write';
  return 'refuse';
}

async function readAsset(shopify, themeId, key) {
  try {
    const v = await shopify.getThemeAsset(themeId, key);
    return v ?? undefined;
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return undefined;
    throw err;
  }
}

async function readBack(shopify, themeId, key, target, { tries = 12, waitMs = 5000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await readAsset(shopify, themeId, key);
    if (v === target) return { ok: true, tries: i + 1, bytes: v.length };
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return { ok: false, tries };
}

async function shipTheme(shopify, themeId, apply, record) {
  const plan = [];
  for (const f of FILES) {
    const target = gitShow('HEAD', f.key);
    const before = f.before === null ? null : gitShow(f.before, f.key);
    const current = await readAsset(shopify, themeId, f.key);
    const verdict = guardVerdict({ current, before, target, prior: branchVersions(f.key) });
    plan.push({ ...f, target, verdict, currentBytes: current?.length ?? null });
    console.log(`  ${f.key}: ${verdict} (live ${current === undefined ? 'absent' : `${current.length} B`}, new ${target.length} B)`);
  }
  record.theme = { themeId, files: plan.map(({ target, ...rest }) => ({ ...rest, targetBytes: target.length })) };
  const refused = plan.filter((p) => p.verdict === 'refuse');
  if (refused.length) {
    throw new Error(`guard refused ${refused.map((r) => r.key).join(', ')}: the theme copy is neither the expected before nor the new content. Nothing written.`);
  }
  if (!apply) return;
  for (const p of plan) {
    if (p.verdict === 'already') continue;
    await shopify.updateThemeAsset(themeId, p.key, p.target);
    const rb = await readBack(shopify, themeId, p.key, p.target);
    record.theme.files.find((f) => f.key === p.key).readBack = rb;
    console.log(`  wrote ${p.key} → read-back ${rb.ok ? `OK (${rb.bytes} B, try ${rb.tries})` : 'MISMATCH'}`);
    if (!rb.ok) throw new Error(`read-back mismatch on ${p.key}`);
  }
}

async function shipPage(shopify, { publish, apply }, record) {
  const found = (await shopify.getPages({ handle: PAGE.handle })).find((p) => p.handle === PAGE.handle);
  console.log(`  page ${PAGE.handle}: ${found ? `exists (id ${found.id}, ${found.published_at ? 'published' : 'unpublished'})` : 'absent → create'}`);
  record.page = { before: found ? { id: found.id, published_at: found.published_at, template_suffix: found.template_suffix } : null };
  if (!apply) return;
  let page = found;
  if (!page) {
    page = await shopify.createPage({ ...PAGE, body_html: '', published: Boolean(publish) });
  } else {
    const fields = {};
    if (page.template_suffix !== PAGE.template_suffix) fields.template_suffix = PAGE.template_suffix;
    if (page.title !== PAGE.title) fields.title = PAGE.title;
    if (publish && !page.published_at) fields.published = true;
    if (Object.keys(fields).length) page = await shopify.updatePage(page.id, fields);
  }
  const mf = await shopify.upsertMetafield('pages', page.id, 'seo', 'hidden', 1, 'number_integer');
  const after = await shopify.getPage(page.id);
  const mfs = await shopify.getMetafields('pages', page.id);
  const hidden = mfs.find((m) => m.namespace === 'seo' && m.key === 'hidden');
  record.page.after = { id: after.id, handle: after.handle, published_at: after.published_at, template_suffix: after.template_suffix, seo_hidden: hidden?.value ?? null, metafield_id: mf?.id };
  console.log(`  page ${after.id}: ${after.published_at ? 'published' : 'unpublished'}, template ${after.template_suffix}, seo.hidden=${hidden?.value}`);
  if (String(hidden?.value) !== '1') throw new Error('seo.hidden did not read back as 1');
}

export async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const live = argv.includes('--live');
  const page = argv.includes('--page');
  const publish = argv.includes('--publish');
  const themeArg = argv.includes('--theme') ? argv[argv.indexOf('--theme') + 1] : null;
  if (!live && !themeArg && !page) {
    console.error('usage: publish-cream-presell.mjs (--theme <id> | --live) [--page [--publish]] [--apply]');
    return 2;
  }
  if (live && themeArg) { console.error('--live and --theme are exclusive'); return 2; }

  const shopify = await import('../../lib/shopify.js');
  const record = { at: new Date().toISOString(), apply, argv, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() };
  console.log(apply ? 'APPLY' : 'DRY RUN (pass --apply to write)');
  let code = 0;
  try {
    if (live || themeArg) {
      const liveId = await resolveLiveThemeId();
      if (!liveId) throw new Error(UNRESOLVED_LIVE_THEME_REASON);
      if (themeArg && String(themeArg) === liveId) throw new Error(`--theme ${themeArg} is the LIVE theme; use --live`);
      const themeId = live ? liveId : String(themeArg);
      console.log(`theme ${themeId}${live ? ' (LIVE)' : ' (preview)'}`);
      await shipTheme(shopify, themeId, apply, record);
    }
    if (page) await shipPage(shopify, { publish, apply }, record);
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    record.error = err.message;
    code = 1;
  }
  const dir = join(ROOT, 'data', 'reports', 'presell');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `publish-${record.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`run record → ${out}`);
  return code;
}

if (isDirectRun(import.meta.url)) {
  main().then((c) => process.exit(c));
}
