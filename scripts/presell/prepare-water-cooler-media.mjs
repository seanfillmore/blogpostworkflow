#!/usr/bin/env node
// scripts/presell/prepare-water-cooler-media.mjs
//
// Builds the media for the water cooler pre-sell page from
// data/presell/water-cooler/content.json. Three source kinds:
//
//   source: 'local'    a file committed under data/presell/water-cooler/source/
//                      (stills and silent clips cut from the Baby Drama water
//                      cooler ad, captions already burned in). Videos must already
//                      be <=1.5 MB, H.264, no audio; a poster is taken from 0.5s.
//   source: 'shopify'  already in Shopify Files: referenced by url, size probed.
//   reuseFrom: <page>  an entry already uploaded for another pre-sell page
//                      (data/presell/<page>/media.json), copied as is.
//
// Dry by default. --apply uploads (additive, nothing deleted) and writes
// data/presell/water-cooler/media.json. A key whose source signature (file
// sha256, or url) is unchanged is not uploaded again; --force re-uploads.
//
// Usage: node scripts/presell/prepare-water-cooler-media.mjs [--apply] [--force]
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = 'water-cooler';
const DIR = join(ROOT, 'data', 'presell', PAGE);
const CONTENT = join(DIR, 'content.json');
const MEDIA = join(DIR, 'media.json');
const WORK = join(tmpdir(), `presell-${PAGE}-media`);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const MAX_VIDEO_BYTES = 1.5 * 1024 * 1024;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

function dimensions(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = out.split(',').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`cannot read the size of ${file}`);
  return { width, height };
}

function hasAudio(file) {
  return execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
    '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim() !== '';
}

async function probeUrl(key, url) {
  const dest = join(WORK, `${key}-cdn.jpg`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dimensions(dest);
}

async function main() {
  const content = JSON.parse(readFileSync(CONTENT, 'utf8'));
  const existing = existsSync(MEDIA) ? JSON.parse(readFileSync(MEDIA, 'utf8')) : {};
  mkdirSync(WORK, { recursive: true });
  const plan = [];

  const entries = [
    ...Object.entries(content.videos).map(([k, v]) => [k, v, 'video']),
    ...Object.entries(content.images).map(([k, v]) => [k, v, 'image']),
  ];
  for (const [key, e, kind] of entries) {
    if (e.reuseFrom) {
      const other = JSON.parse(readFileSync(join(ROOT, 'data', 'presell', e.reuseFrom, 'media.json'), 'utf8'));
      if (!other[key]) throw new Error(`${e.reuseFrom}/media.json has no ${key} to reuse`);
      plan.push({ key, reuse: { ...other[key], reusedFrom: e.reuseFrom } });
      continue;
    }
    if (e.source === 'shopify') {
      const known = existing[key];
      const dims = Number.isInteger(known?.width) && known.signature === e.url
        ? { width: known.width, height: known.height } : await probeUrl(key, e.url);
      plan.push({ key, shopify: { url: e.url, kind: 'image', ...dims, signature: e.url } });
      continue;
    }
    if (e.source !== 'local') throw new Error(`${key}: unknown source ${e.source}`);
    const file = join(ROOT, e.path);
    const sig = sha(file);
    if (!FORCE && existing[key]?.signature === sig) { plan.push({ key, skip: true }); continue; }
    if (kind === 'video') {
      const bytes = statSync(file).size;
      if (bytes > MAX_VIDEO_BYTES) throw new Error(`${e.path} is ${bytes} B, over ${MAX_VIDEO_BYTES}`);
      if (hasAudio(file)) throw new Error(`${e.path} has an audio track; the page plays clips silent`);
      const poster = join(WORK, `presell-${PAGE}-${key}-poster.jpg`);
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', file, '-frames:v', '1', '-q:v', '4', poster]);
      plan.push({ key, kind, file, poster, bytes, sig, alt: e.alt });
    } else {
      plan.push({ key, kind, file, bytes: statSync(file).size, sig, alt: e.alt, ...dimensions(file) });
    }
  }

  for (const p of plan) {
    if (p.reuse) console.log(`  ${p.key.padEnd(18)} reused from ${p.reuse.reusedFrom}`);
    else if (p.shopify) console.log(`  ${p.key.padEnd(18)} existing Shopify file ${p.shopify.width}x${p.shopify.height}`);
    else if (p.skip) console.log(`  ${p.key.padEnd(18)} unchanged, skipped`);
    else console.log(`  ${p.key.padEnd(18)} ${p.kind} ${(p.bytes / 1024).toFixed(0)} KB${p.width ? ` ${p.width}x${p.height}` : ''}`);
  }
  if (!APPLY) { console.log('DRY RUN: nothing uploaded. Re-run with --apply.'); return; }

  const { uploadFileToShopify } = await import('../../lib/shopify.js');
  const media = { ...existing };
  const save = () => writeFileSync(MEDIA, JSON.stringify(media, null, 2) + '\n');
  for (const p of plan) {
    if (p.skip) continue;
    if (p.reuse) { media[p.key] = p.reuse; save(); continue; }
    if (p.shopify) { media[p.key] = p.shopify; save(); continue; }
    if (p.kind === 'video') {
      const v = await uploadFileToShopify(p.file, { mimeType: 'video/mp4', alt: p.alt });
      const poster = await uploadFileToShopify(p.poster, { mimeType: 'image/jpeg', alt: p.alt });
      media[p.key] = { url: v.url, poster: poster.url, kind: 'video', fileId: v.id, posterFileId: poster.id, bytes: p.bytes, signature: p.sig };
    } else {
      const f = await uploadFileToShopify(p.file, { mimeType: 'image/jpeg', alt: p.alt });
      media[p.key] = { url: f.url, kind: 'image', fileId: f.id, bytes: p.bytes, width: p.width, height: p.height, signature: p.sig };
    }
    save();
    console.log(`  uploaded ${p.key} -> ${media[p.key].url}`);
  }
  console.log(`wrote ${MEDIA}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
