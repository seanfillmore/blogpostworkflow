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
 * USAGE
 *   node scripts/pull-theme.mjs                          # refresh the mirror
 *   node scripts/pull-theme.mjs --key templates/product.bundle-landing.json
 *   node scripts/pull-theme.mjs --all
 *   node scripts/pull-theme.mjs --theme 147480051882     # a specific theme
 */

import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { getThemes, getMainThemeId, getThemeAsset, listThemeAssets } from '../lib/shopify.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME_DIR = join(ROOT, 'theme');

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
  // `theme/rum/` is authored here and has no Shopify counterpart — it is source
  // for an asset that is built and uploaded under a different key.
  return out.filter((k) => !k.startsWith('rum/'));
}

export function parseArgs(argv) {
  const args = { keys: [], all: false, theme: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--key') args.keys.push(argv[++i]);
    else if (a === '--theme') args.theme = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
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

  let written = 0, skipped = 0, missing = 0;
  const binary = [];
  for (const key of keys.sort()) {
    let asset;
    try { asset = await getThemeAsset(id, key); } catch { missing += 1; console.log(`  MISSING  ${key}`); continue; }
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

  console.log(`\n${written} written, ${skipped} binary skipped, ${missing} not on this theme.`);
  console.log('Provenance recorded in theme/.theme-source.json');
  console.log('\nThis script NEVER uploads. To ship a change: review the diff, then upload to an');
  console.log('UNPUBLISHED theme and verify the rendered page before anything reaches customers.');
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
