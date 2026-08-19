#!/usr/bin/env node
/**
 * Read or write a single asset on the live (main) theme, with a backup on write.
 *
 *   node scripts/update-theme-asset.mjs get <asset/key.js> [outfile]
 *   node scripts/update-theme-asset.mjs put <asset/key.js> <infile> [--apply]
 *
 * `put` always writes the current live copy to theme/backup/<key> first, so a bad
 * edit to a shared file can be restored exactly. Dawn's product-info.js and
 * global.js are loaded on every product page — an edit there is a storefront-wide
 * change, not a per-product one, and it needs a way back.
 *
 * Without --apply, `put` prints a unified diff and writes nothing.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const [mode, key, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
if (!mode || !key) { console.error('usage: update-theme-asset.mjs get|put <asset/key> [file] [--apply]'); process.exit(2); }

const token = await getAccessToken();
const rest = async (path, init) => {
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/${path}`, {
    ...init,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};

const { themes } = await rest('themes.json');
const theme = themes.find((t) => t.role === 'main');
console.log(`theme: ${theme.name} (${theme.id})`);

const current = (await rest(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).asset?.value;
if (current === undefined) throw new Error(`asset not found: ${key}`);

if (mode === 'get') {
  const out = file ?? join(ROOT, 'theme', 'backup', key);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, current);
  console.log(`${key} → ${out} (${current.length} bytes)`);
  process.exit(0);
}

if (mode !== 'put' || !file) { console.error('put needs an input file'); process.exit(2); }
const next = readFileSync(file, 'utf8');

if (next === current) { console.log('identical — nothing to write.'); process.exit(0); }

// Show what changes, so a shared-file edit is never blind. Common prefix and
// suffix are trimmed and only the differing span is printed — enough to eyeball
// a targeted patch, and it does not pretend to be a real diff algorithm.
const a = current.split('\n'), b = next.split('\n');
let head = 0;
while (head < a.length && head < b.length && a[head] === b[head]) head++;
let tail = 0;
while (tail < a.length - head && tail < b.length - head
       && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

console.log(`\n${key}: ${a.length} → ${b.length} lines`);
console.log(`changed span: line ${head + 1}, ${a.length - head - tail} removed / ${b.length - head - tail} added\n`);
for (const line of a.slice(head, a.length - tail)) console.log(`  - ${line}`);
for (const line of b.slice(head, b.length - tail)) console.log(`  + ${line}`);

if (!APPLY) { console.log('\ndry run — pass --apply to write'); process.exit(0); }

// Back up the live copy, but NEVER clobber an existing backup. The first backup
// is the pristine vendor file and is the only thing worth restoring; overwriting
// it on every write means the second write replaces the original with your own
// previous edit, and the way back is gone. Later writes get a timestamped copy.
const pristine = join(ROOT, 'theme', 'backup', key);
mkdirSync(dirname(pristine), { recursive: true });
if (!existsSync(pristine)) {
  writeFileSync(pristine, current);
  console.log(`\nbacked up pristine live copy → ${pristine.replace(ROOT + '/', '')}`);
} else {
  const stamp = `${pristine}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(stamp, current);
  console.log(`\npristine backup already exists; snapshotted current → ${stamp.replace(ROOT + '/', '')}`);
}
const backup = pristine;

await rest(`themes/${theme.id}/assets.json`, {
  method: 'PUT',
  body: JSON.stringify({ asset: { key, value: next } }),
});

// Read back until it matches. An asset PUT is not immediately consistent — the
// first GET after a successful write can still return the previous content, and
// a single-shot comparison reports a failure for a write that actually landed.
let after;
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  after = (await rest(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).asset?.value;
  if (after === next) break;
}
if (after !== next) {
  throw new Error(
    `write-back verification failed after 12s — live copy does not match what was sent. `
    + `Restore from ${backup.replace(ROOT + '/', '')} if the storefront is broken.`);
}
console.log(`wrote ${key} and verified it read back byte-identical.`);
