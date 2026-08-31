#!/usr/bin/env node
/**
 * Pull theme assets DOWN from Shopify into `theme/`. Never uploads anything.
 *
 * WHY
 * ───
 * Sean, 2026-08-30: "We need to pull down the theme and work offline until the
 * changes are approved then upload once verified. We should not be making
 * changes to the live theme and testing them in production."
 *
 * The repo had four scripts that PUSH to a theme and none that pull, so the only
 * way to read the live markup was an ad-hoc API call, and the only way to try a
 * change was to make it on the live theme. `theme/` is a partial mirror of
 * whatever somebody happened to author or fetch, with no record of which theme
 * or which day it came from — so "is this file current?" had no answer.
 *
 * WHAT IT WRITES
 * ──────────────
 * Only files under `theme/`, plus `theme/.theme-source.json` recording the theme
 * id, name, role and the moment of the pull. That provenance is the point: a
 * mirror nobody can date is one nobody can trust, which is the same failure that
 * made the per-post `content.html` mirrors dangerous.
 *
 * DEFAULT SCOPE IS "REFRESH WHAT WE ALREADY MIRROR"
 * ─────────────────────────────────────────────────
 * `theme/` holds 23 of the theme's several hundred files. Pulling everything
 * would bury the authored ones in vendor markup nobody reviews, so the default
 * re-pulls exactly the keys already present and `--key` adds new ones
 * deliberately. `--all` exists but announces the count first.
 *
 * BINARY ASSETS ARE SKIPPED, NOT SILENTLY TRUNCATED
 * ─────────────────────────────────────────────────
 * The Assets API returns text in `value` and everything else base64 in
 * `attachment`. Writing an `attachment` as text would corrupt it, so those are
 * counted and named instead of written.
 *
 * IT WILL NOT OVERWRITE AN UNCOMMITTED LOCAL EDIT
 * ────────────────────────────────────────────────
 * Added after this tool destroyed real work on 2026-08-31: two lander edits were
 * made locally, previewed, and then silently reverted from live by a later
 * unrelated `pull-theme` run. A file with uncommitted changes is now HELD and
 * named; `--force` discards them deliberately. Committed files are recoverable
 * from git, which is why the line is drawn at uncommitted.
 *
 * USAGE
 *   node scripts/pull-theme.mjs                          # refresh the mirror
 *   node scripts/pull-theme.mjs --force                  # discard local edits
 *   node scripts/pull-theme.mjs --key templates/product.bundle-landing.json
 *   node scripts/pull-theme.mjs --all
 *   node scripts/pull-theme.mjs --theme 147480051882     # a specific theme
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { getThemes, getMainThemeId, getThemeAssetRaw, listThemeAssets } from '../lib/shopify.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME_DIR = join(ROOT, 'theme');

/**
 * Directories under `theme/` that are AUTHORING SOURCE, not Shopify assets.
 * Re-pulling one either 404s or overwrites hand-written source with a build.
 *
 * `blocks/` is the subtle one, and it was briefly mistaken for four pieces of
 * merged work that never shipped. The live theme has 480 assets and ZERO under
 * `blocks/`, and none of those four filenames exist anywhere on it — which looks
 * exactly like a compliance fix and an SEO fix silently never uploaded.
 *
 * They ship a different way. Each is inlined into a `"type": "custom_liquid"`
 * block in a template's JSON, whose block ID happens to match the filename —
 * `quantity-ladder` is a custom_liquid block inside
 * product.landing-page-bar-soap.json, `ladder-tier-noindex` one inside
 * product.json. The features are live; the `.liquid` file is the readable copy
 * of what got pasted in. So these are kept, and the puller must not report them
 * as MISSING, which reads like an outage.
 */
const LOCAL_ONLY = ['rum/', 'blocks/'];

/** Every file currently mirrored, as Shopify asset keys. */
export function mirroredKeys(dir = THEME_DIR) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.filter((k) => !LOCAL_ONLY.some((p) => k.startsWith(p)));
}

export function parseArgs(argv) {
  const args = { keys: [], all: false, theme: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--key') args.keys.push(argv[++i]);
    else if (a === '--theme') args.theme = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Asset keys whose local file has UNCOMMITTED changes.
 *
 * This exists because the tool destroyed real work on 2026-08-31. Two edits to
 * the lander template — a section removal and a CSS change — were made locally,
 * uploaded to a preview theme, and then silently overwritten from live when
 * `pull-theme` was run again for an unrelated reason. Nothing warned; the file
 * simply went back to what production held, and the loss was found only because
 * a later assertion failed.
 *
 * A puller that clobbers local edits is the same shape as the content-mirror
 * bug this repo already documents: a routine unattended write over work nobody
 * knew was there. Committed files are recoverable from git, so the line is
 * drawn at UNCOMMITTED.
 *
 * @returns {Set<string>} keys to refuse, empty when git cannot answer
 */
export function locallyModifiedKeys(root, spawn = spawnSync) {
  const r = spawn('git', ['status', '--porcelain', '--', 'theme'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return new Set();
  const out = new Set();
  for (const line of r.stdout.split('\n')) {
    // porcelain v1: XY <path>, and a rename prints "old -> new"
    const m = line.match(/^..\s+(?:.*->\s*)?(.+)$/);
    if (!m) continue;
    const p = m[1].trim().replace(/^"|"$/g, '');
    if (p.startsWith('theme/')) out.add(p.slice('theme/'.length));
  }
  return out;
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  if (args.help) {
    console.log('Usage: node scripts/pull-theme.mjs [--key <asset>]... [--all] [--theme <id>]');
    return 0;
  }

  const themes = await getThemes();
  const id = args.theme ? Number(args.theme) : await getMainThemeId();
  const meta = themes.find((t) => String(t.id) === String(id));
  if (!meta) { console.error(`theme ${id} not found on this store`); return 1; }
  console.log(`Pulling from theme ${meta.id} — "${meta.name}" (role: ${meta.role})\n`);

  let keys;
  if (args.all) {
    const all = await listThemeAssets(id);
    keys = all.map((a) => a.key);
    console.log(`--all: ${keys.length} assets. This will add files nobody has reviewed.\n`);
  } else {
    keys = [...new Set([...mirroredKeys(), ...args.keys])];
  }
  if (!keys.length) { console.error('nothing to pull'); return 1; }

  const dirty = args.force ? new Set() : locallyModifiedKeys(ROOT);
  if (dirty.size) {
    console.log(`${dirty.size} file(s) have UNCOMMITTED local changes and will NOT be overwritten.`);
    console.log('Commit them, or pass --force to discard them.\n');
  }

  let written = 0, skipped = 0, missing = 0, held = 0;
  const binary = [];
  for (const key of keys.sort()) {
    if (dirty.has(key)) { held += 1; console.log(`  HELD     ${key} (uncommitted local changes)`); continue; }
    let asset;
    try { asset = await getThemeAssetRaw(id, key); } catch { missing += 1; console.log(`  MISSING  ${key}`); continue; }
    // getThemeAssetRaw hands back the whole record, so `attachment` is reachable
    // and a BINARY asset is distinguishable from an ABSENT one. Through
    // getThemeAsset both were null and every binary reported as MISSING.
    const value = typeof asset === 'string' ? asset : asset?.value;
    if (value === undefined || value === null) {
      if (asset?.attachment) { binary.push(key); skipped += 1; console.log(`  BINARY   ${key} (skipped — would corrupt as text)`); }
      else { missing += 1; console.log(`  MISSING  ${key}`); }
      continue;
    }
    const dest = join(THEME_DIR, key);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, value);
    written += 1;
    console.log(`  pulled   ${key}  (${value.length} bytes)`);
  }

  writeFileSync(join(THEME_DIR, '.theme-source.json'), `${JSON.stringify({
    themeId: meta.id, themeName: meta.name, role: meta.role,
    pulledAt: new Date().toISOString(), keys: keys.length, written, binarySkipped: binary,
  }, null, 2)}\n`);

  console.log(`\n${written} written, ${held} held (local edits), ${skipped} binary skipped, ${missing} not on this theme.`);
  console.log('Provenance recorded in theme/.theme-source.json');
  console.log('\nThis script NEVER uploads. To ship a change: review the diff, then upload to an');
  console.log('UNPUBLISHED theme and verify the rendered page before anything reaches customers.');
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
