#!/usr/bin/env node
/**
 * Swap a PDP's stock buy box for its quantity ladder.
 *
 *   node scripts/convert-pdp-to-ladder.mjs <base-handle>           # dry
 *   node scripts/convert-pdp-to-ladder.mjs <base-handle> --apply   # writes live
 *
 * The ladder (tiers, default, template) comes from config/bundles.json
 * `ladders[]`; the block is built by build-quantity-ladder.mjs, which refuses a
 * draft tier or incoherent pricing, so a page can only be converted to a ladder
 * that can actually sell. The template edit is the pure, tested convert() from
 * the liquid-soap conversion: ladder inserted BEFORE the old buy box is removed,
 * guarantee moved directly under the ladder, and a throw rather than a page with
 * no way to buy. Live template read fresh; backup + read-back by
 * update-theme-asset.mjs put; the repo mirror is rewritten from what was sent.
 *
 * Generalises the per-page one-offs (liquid soap 2026-09-05, cream 2026-10-05).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { serialize } from './build-product-templates.mjs';
import { convert } from './convert-liquid-soap-to-ladder-2026-09-05.mjs';
import { loadRoster } from '../lib/bundle-roster.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pure: the ladder entry for a base handle, or a thrown reason. */
export function ladderFor(roster, base) {
  const ladder = (roster.ladders ?? []).find((l) => l.base === base);
  if (!ladder) throw new Error(`no ladder configured for "${base}" in config/bundles.json`);
  if (!ladder.template) throw new Error(`ladder "${base}" names no template`);
  return ladder;
}

if (isDirectRun(import.meta.url)) {
  const APPLY = process.argv.includes('--apply');
  const base = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!base) { console.error('usage: convert-pdp-to-ladder.mjs <base-handle> [--apply]'); process.exit(2); }

  const ladder = ladderFor(loadRoster(), base);
  const key = `templates/${ladder.template}`;
  const work = join(ROOT, 'data', 'ladder-convert');
  mkdirSync(work, { recursive: true });
  const tmp = join(work, `${base}.live.json`);
  const out = join(work, `${base}.next.json`);

  // Builds data/ladder-<base>.liquid, or exits non-zero on a draft tier /
  // incoherent price — in which case nothing below runs.
  execFileSync('node', [join(ROOT, 'scripts', 'build-quantity-ladder.mjs'), base], { stdio: 'inherit' });
  const ladderLiquid = readFileSync(join(ROOT, 'data', `ladder-${base}.liquid`), 'utf8');

  execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'get', key, tmp], { stdio: 'inherit' });
  const live = readFileSync(tmp, 'utf8');
  if (serialize(JSON.parse(live)) !== live) throw new Error(`${key}: round-trip mismatch — refusing`);

  const parsed = JSON.parse(live);
  const notes = convert(parsed, ladderLiquid);
  console.log(`${key}:\n  ${notes.join('\n  ')}`);
  console.log(`  block_order: ${parsed.sections.main.block_order.join(' ')}`);
  const next = serialize(parsed);
  if (next === live) { console.log('  already converted'); process.exit(0); }
  writeFileSync(out, next);

  execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'put', key, out, ...(APPLY ? ['--apply'] : [])], { stdio: 'inherit' });
  if (APPLY) writeFileSync(join(ROOT, 'theme', key), next);
  else console.log('\nDry run. Re-run with --apply to write.');
}
