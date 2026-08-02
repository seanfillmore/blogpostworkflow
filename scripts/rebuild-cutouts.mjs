#!/usr/bin/env node
/**
 * Rebuild every cutout listed in data/brand/cutouts/recipes.json.
 *
 *   node scripts/rebuild-cutouts.mjs [name-fragment]
 *
 * Each cutout is a deterministic function of a source photograph plus a handful
 * of measured numbers. Keeping those numbers in a manifest rather than in a shell
 * history is the whole point: the first eight cutouts in this library needed three
 * rebuilds, and each time the numbers had to be re-derived from scratch because
 * nothing recorded them.
 *
 * Re-run this after replacing a source photograph, and diff the output. A cutout
 * that changes size is telling you the new photograph stages the product
 * differently, which is exactly the thing that silently breaks a composited frame.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { cutouts } = JSON.parse(readFileSync(join(ROOT, 'data', 'brand', 'cutouts', 'recipes.json'), 'utf8'));

const filter = process.argv[2];
const todo = filter ? cutouts.filter((c) => c.out.includes(filter)) : cutouts;
if (!todo.length) { console.error(`no cutout matches "${filter}"`); process.exit(1); }

let failed = 0;
for (const c of todo) {
  const args = [join(ROOT, 'scripts', 'cut-component.mjs'), join(ROOT, c.source), join(ROOT, 'data', 'brand', 'cutouts', c.out), '--seed', c.seed, '--fuzz', String(c.fuzz)];
  for (const k of ['band', 'x', 'taper', 'top', 'bottom']) if (c[k] !== undefined) args.push(`--${k}`, String(c[k]));
  console.log(`\n── ${c.out}  (${c.product} / ${c.variant})`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`  ✗ FAILED`); }
}
console.log(`\n${todo.length - failed}/${todo.length} cutouts rebuilt${failed ? `, ${failed} FAILED` : ''}.`);
process.exit(failed ? 1 : 0);
