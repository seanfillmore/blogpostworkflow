#!/usr/bin/env node
// scripts/presell/prepare-cream-media.mjs
//
// Builds the media for the Coconut Moisturizer pre-sell page from
// data/presell/coconut-cream/content.json:
//
//   videos  Trybe submission -> trimmed clip (H.264, <=720px wide, no audio
//           track, ~15s, target <=1.5 MB) + a poster jpg from the clip's start.
//   images  Trybe submission -> optional crop (cuts off a baked-in ad headline)
//           -> jpg <=1080px wide. A `source: 'shopify'` image is already in
//           Shopify and is referenced by its URL, never re-uploaded.
//
// Dry by default: downloads and processes into a work directory and reports
// sizes, touching nothing in Shopify. --apply uploads each file to Shopify Files
// (additive; nothing is ever deleted) and writes
// data/presell/coconut-cream/media.json as { [key]: { url, poster?, kind } }.
// A key already in media.json with the same source signature is NOT uploaded
// again (pass --force to re-upload), so a re-run cannot pile up duplicates;
// instead its current url is re-read from Shopify. Videos record the ORIGINAL
// uploaded mp4, not one of Shopify's (larger) transcoded renditions.
//
// Usage:
//   node scripts/presell/prepare-cream-media.mjs [--apply] [--force] [--work <dir>]
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { listSubmissions } from '../../lib/trybe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'data', 'presell', 'coconut-cream');
const CONTENT = join(DIR, 'content.json');
const MEDIA = join(DIR, 'media.json');
const FFMPEG = process.env.FFMPEG || (existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');

const MAX_VIDEO_BYTES = 1.5 * 1024 * 1024;
const VIDEO_WIDTH = 720;
const IMAGE_WIDTH = 1080;
// Constant rate factors tried in order until the clip fits MAX_VIDEO_BYTES.
const CRF_LADDER = [26, 28, 30, 32, 34, 36];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const WORK = args.includes('--work') ? args[args.indexOf('--work') + 1] : join(tmpdir(), 'presell-cream-media');

function readEnv() {
  const env = {};
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function ff(argv) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return dest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url.slice(0, 80)}... -> HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/** Trim, scale, strip audio; walk the CRF ladder until the file fits. */
function encodeClip(src, out, { start, end }) {
  const dur = end - start;
  for (const crf of CRF_LADDER) {
    ff(['-ss', String(start), '-t', String(dur), '-i', src,
      '-an', '-vf', `scale='min(${VIDEO_WIDTH},iw)':-2,fps=30,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-crf', String(crf),
      '-maxrate', '900k', '-bufsize', '1800k', '-movflags', '+faststart', out]);
    const bytes = statSync(out).size;
    if (bytes <= MAX_VIDEO_BYTES) return { bytes, crf };
  }
  throw new Error(`${out} still over ${MAX_VIDEO_BYTES} bytes at crf ${CRF_LADDER.at(-1)}`);
}

function posterFrom(src, out, start) {
  ff(['-ss', String(start + 0.5), '-i', src, '-frames:v', '1',
    '-vf', `scale='min(${VIDEO_WIDTH},iw)':-2`, '-q:v', '4', out]);
  return statSync(out).size;
}

function prepareImage(src, out, crop) {
  const filters = [];
  if (crop) filters.push(`crop=iw:${crop.h}:0:${crop.y}`);
  filters.push(`scale='min(${IMAGE_WIDTH},iw)':-2`);
  ff(['-i', src, '-frames:v', '1', '-vf', filters.join(','), '-q:v', '3', out]);
  return statSync(out).size;
}

/** What a media.json entry was built from; a changed signature re-uploads. */
function signature(entry) {
  return JSON.stringify({ id: entry.submissionId || entry.url, trim: entry.trim || null, crop: entry.crop || null });
}

async function main() {
  const content = JSON.parse(readFileSync(CONTENT, 'utf8'));
  const existing = existsSync(MEDIA) ? JSON.parse(readFileSync(MEDIA, 'utf8')) : {};
  mkdirSync(WORK, { recursive: true });

  const env = readEnv();
  const apiKey = process.env.TRYBE_API_KEY || env.TRYBE_API_KEY;
  // Asset urls are signed and expire, so they are always fetched fresh.
  const subs = await listSubmissions({ apiKey, status: 'approved' });
  const byId = new Map(subs.map((s) => [s.id, s]));
  const asset = (id) => {
    const s = byId.get(id);
    if (!s?.asset?.url) throw new Error(`no approved Trybe submission with an asset: ${id}`);
    return s.asset.url;
  };

  const plan = [];
  for (const [key, v] of Object.entries(content.videos)) {
    const sig = signature(v);
    if (!FORCE && existing[key]?.signature === sig) { plan.push({ key, kind: 'video', skip: true }); continue; }
    const ext = asset(v.submissionId).split('?')[0].split('.').pop();
    const src = await download(asset(v.submissionId), join(WORK, `${key}-src.${ext}`));
    const clip = join(WORK, `presell-cream-${key}.mp4`);
    const poster = join(WORK, `presell-cream-${key}-poster.jpg`);
    const { bytes, crf } = encodeClip(src, clip, v.trim);
    const posterBytes = posterFrom(src, poster, v.trim.start);
    plan.push({ key, kind: 'video', sig, clip, poster, bytes, crf, posterBytes, alt: v.alt });
  }
  for (const [key, img] of Object.entries(content.images)) {
    if (img.source === 'shopify') { plan.push({ key, kind: 'image', url: img.url, sig: signature(img) }); continue; }
    const sig = signature(img);
    if (!FORCE && existing[key]?.signature === sig) { plan.push({ key, kind: 'image', skip: true }); continue; }
    const src = await download(asset(img.submissionId), join(WORK, `${key}-src.img`));
    const out = join(WORK, `presell-cream-${key}.jpg`);
    const bytes = prepareImage(src, out, img.crop);
    plan.push({ key, kind: 'image', sig, file: out, bytes, alt: img.alt });
  }

  for (const p of plan) {
    if (p.skip) console.log(`  ${p.key.padEnd(14)} already in media.json (unchanged source), skipped`);
    else if (p.url) console.log(`  ${p.key.padEnd(14)} existing Shopify file, referenced by url`);
    else if (p.kind === 'video') console.log(`  ${p.key.padEnd(14)} video ${(p.bytes / 1024).toFixed(0)} KB (crf ${p.crf}), poster ${(p.posterBytes / 1024).toFixed(0)} KB`);
    else console.log(`  ${p.key.padEnd(14)} image ${(p.bytes / 1024).toFixed(0)} KB`);
  }
  console.log(`  work dir: ${WORK}`);
  if (!APPLY) { console.log('DRY RUN: nothing uploaded. Re-run with --apply.'); return; }

  // Imported only on --apply: lib/shopify.js reads credentials at import time.
  const { uploadFileToShopify, getFileUrl } = await import('../../lib/shopify.js');
  const media = { ...existing };
  const save = () => writeFileSync(MEDIA, JSON.stringify(media, null, 2) + '\n');
  for (const p of plan) {
    if (p.skip) {
      // Already uploaded: re-read its current url (read-only) so media.json
      // always holds what Shopify serves now, without uploading a duplicate.
      const e = media[p.key];
      for (const [field, id] of [['url', e.fileId], ['poster', e.posterFileId]]) {
        if (!id) continue;
        const url = await getFileUrl(id);
        if (url && url !== e[field]) { console.log(`  ${p.key}.${field} refreshed -> ${url}`); e[field] = url; }
      }
      save();
      continue;
    }
    if (p.url) { media[p.key] = { url: p.url, kind: 'image', signature: p.sig }; save(); continue; }
    if (p.kind === 'video') {
      const v = await uploadFileToShopify(p.clip, { mimeType: 'video/mp4', alt: p.alt });
      const poster = await uploadFileToShopify(p.poster, { mimeType: 'image/jpeg', alt: p.alt });
      media[p.key] = { url: v.url, poster: poster.url, kind: 'video', fileId: v.id, posterFileId: poster.id, bytes: p.bytes, signature: p.sig };
    } else {
      const f = await uploadFileToShopify(p.file, { mimeType: 'image/jpeg', alt: p.alt });
      media[p.key] = { url: f.url, kind: 'image', fileId: f.id, bytes: p.bytes, signature: p.sig };
    }
    save(); // after every upload, so a crash mid-run never forgets a file already in Shopify
    console.log(`  uploaded ${p.key} -> ${media[p.key].url}`);
  }
  console.log(`wrote ${MEDIA}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
