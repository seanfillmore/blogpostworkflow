#!/usr/bin/env node
/**
 * Add finished static ads to the Instagram statics queue (config/ig-statics.json,
 * posted one a day by agents/ig-statics).
 *
 *   node scripts/ig-statics-add.mjs --manifest <file.json>           # dry run
 *   node scripts/ig-statics-add.mjs --manifest <file.json> --apply   # upload + append
 *
 * The manifest is { "batch": "<name>", "product": "<handle>", "items": [
 *   { "id": "<unique id>", "file": "<local png/jpg>", "caption": "<caption>" } ] }
 * in the order they should post.
 *
 * Each image is converted to JPEG (Instagram accepts nothing else) with macOS
 * `sips`, uploaded to Shopify Files (additive: nothing is replaced or deleted),
 * and appended to the queue with its public CDN URL. Every caption is checked by
 * lib/ig-statics.js first and ONE failure aborts the run before any upload. An
 * id already in the queue is skipped, so a re-run after a partial failure is safe.
 * Run it locally (it needs the image files), then commit the queue.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captionProblems } from '../lib/ig-statics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_PATH = join(ROOT, 'config', 'ig-statics.json');

const args = process.argv.slice(2);
const manifestPath = args[args.indexOf('--manifest') + 1];
const apply = args.includes('--apply');
if (!args.includes('--manifest') || !manifestPath) { console.error('Usage: --manifest <file.json> [--apply]'); process.exit(64); }

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const queue = existsSync(QUEUE_PATH) ? JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) : { items: [] };
const have = new Set(queue.items.map((i) => i.id));

const bad = [];
for (const it of manifest.items) {
  if (!existsSync(it.file)) bad.push(`${it.id}: no file at ${it.file}`);
  for (const p of captionProblems(it.caption)) bad.push(`${it.id}: ${p}`);
}
if (bad.length) { console.error(`Refusing, nothing uploaded:\n  ${bad.join('\n  ')}`); process.exit(1); }

const todo = manifest.items.filter((it) => !have.has(it.id));
console.log(`${todo.length} to add, ${manifest.items.length - todo.length} already queued.`);
if (!apply) { for (const it of todo) console.log(`  would add ${it.id} <- ${basename(it.file)}`); process.exit(0); }

const { uploadFileToShopify } = await import('../lib/shopify.js');
const work = mkdtempSync(join(tmpdir(), 'ig-statics-'));
for (const it of todo) {
  let jpg = it.file;
  if (!/\.jpe?g$/i.test(extname(it.file))) {
    jpg = join(work, `${it.id}.jpg`);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', it.file, '--out', jpg], { stdio: 'ignore' });
  }
  const up = await uploadFileToShopify(jpg, { mimeType: 'image/jpeg', alt: `${manifest.batch}: ${it.id}` });
  queue.items.push({ id: it.id, batch: manifest.batch, product: manifest.product, image_url: up.url, shopify_file_id: up.id, caption: it.caption });
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
  console.log(`  added ${it.id} -> ${up.url}`);
}
