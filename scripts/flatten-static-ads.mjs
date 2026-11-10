#!/usr/bin/env node
/**
 * Flatten the "01 Static Ads" creatives library into the layout ad-batch now writes
 * (Sean, 2026-11-10: "one theme folder ... and inside that 4:5 and 9:16 with all of the
 * images open in each to scroll through"):
 *
 *   <theme>/4x5/<batch> - <headline>.png     feed ads, flat
 *   <theme>/9x16/<batch> - <headline>.png    Stories/Reels versions
 *   <theme>/Other sizes/...                  anything else (1:1, wide frames)
 *   <theme>/Ad copy - <batch>.md             each batch's meta-copy.md, copied up
 *   <theme>/_records/<batch>/                everything else, moved intact
 *
 * The size folder is decided by each image's REAL pixel ratio, not by the folder it sat
 * in: the legacy batches mix phone frames and wide frames in one folder. Rejected
 * renders (_rejected/), contact sheets and comparison boards are records, not ads, and
 * stay in _records. run.json paths are rewritten to where each file went, so
 * `--copy-only` keeps working. Nothing is deleted.
 *
 *   node scripts/flatten-static-ads.mjs [--root <dir>]          # dry run: print the plan
 *   node scripts/flatten-static-ads.mjs [--root <dir>] --apply  # move
 */
import { existsSync, readdirSync, statSync, mkdirSync, renameSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, basename, extname, sep } from 'node:path';
import sharp from 'sharp';
import { isDirectRun } from '../lib/is-direct-run.js';
import { CREATIVES_STATIC_ROOT, FEED_DIR, VERTICAL_DIR, RECORDS_DIR, OTHER_SIZES_DIR, adCopyName } from '../agents/ad-batch/output.js';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const LAYOUT_DIRS = new Set([FEED_DIR, VERTICAL_DIR, RECORDS_DIR, OTHER_SIZES_DIR]);

/** Size folder for a width/height. Tolerant, because generators round to multiples of 16. */
export function sizeDir(width, height) {
  const r = width / height;
  if (Math.abs(r - 0.8) < 0.03) return FEED_DIR;
  if (Math.abs(r - 0.5625) < 0.03) return VERTICAL_DIR;
  return OTHER_SIZES_DIR;
}

/** True for a path that is a record, not an ad: anything under or named with a leading "_". */
export function isRecordPath(rel) {
  return rel.split(sep).some(part => part.startsWith('_'));
}

/**
 * The flat name for an image found at <batch>/<rel>. The headline folder is kept; a
 * generated "01-custom-01.png" style file name is dropped when it is the only ad of its
 * size in that folder, and a "9x16" segment is dropped because the size folder says it.
 */
export function flatName(batch, rel, { soleOfSize }) {
  const parts = rel.split(sep).filter(p => p !== VERTICAL_DIR);
  const file = parts.pop();
  const stem = basename(file, extname(file));
  const keepFile = !soleOfSize || parts.length === 0;
  return [batch, ...parts, ...(keepFile ? [stem] : [])].join(' - ') + extname(file).toLowerCase();
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function unique(path, taken) {
  if (!taken.has(path) && !existsSync(path)) { taken.add(path); return path; }
  const ext = extname(path);
  for (let n = 2; ; n++) {
    const p = `${path.slice(0, -ext.length)} (${n})${ext}`;
    if (!taken.has(p) && !existsSync(p)) { taken.add(p); return p; }
  }
}

export async function planTheme(themeDir) {
  const moves = []; // { from, to }
  const records = []; // { from, to } whole batch folders
  const copies = []; // { from, to } ad copy
  const taken = new Set();
  for (const name of readdirSync(themeDir).sort()) {
    if (name.startsWith('.') || LAYOUT_DIRS.has(name)) continue;
    const p = join(themeDir, name);
    const st = statSync(p);
    if (!st.isDirectory()) {
      if (IMAGE_RE.test(name) && !name.startsWith('_')) {
        const m = await sharp(p).metadata();
        moves.push({ from: p, to: unique(join(themeDir, sizeDir(m.width, m.height), name), taken) });
      }
      continue;
    }
    // A batch folder: lift its ads out, then move what is left into _records.
    const images = [];
    for (const f of walk(p)) {
      const rel = relative(p, f);
      if (!IMAGE_RE.test(f) || isRecordPath(rel)) continue;
      const m = await sharp(f).metadata();
      images.push({ f, rel, size: sizeDir(m.width, m.height), folder: rel.split(sep).filter(x => x !== VERTICAL_DIR).slice(0, -1).join(sep) });
    }
    for (const im of images) {
      const soleOfSize = images.filter(o => o.folder === im.folder && o.size === im.size).length === 1;
      moves.push({ from: im.f, to: unique(join(themeDir, im.size, flatName(name, im.rel, { soleOfSize })), taken) });
    }
    if (existsSync(join(p, 'meta-copy.md'))) copies.push({ from: join(p, 'meta-copy.md'), batch: name, to: join(themeDir, adCopyName(name)) });
    records.push({ from: p, to: join(themeDir, RECORDS_DIR, name) });
  }
  return { moves, records, copies };
}

function rewriteRunJson(recordDir, oldDir, moveMap) {
  const runPath = join(recordDir, 'run.json');
  if (!existsSync(runPath)) return false;
  let text = readFileSync(runPath, 'utf8');
  // Image paths first (exact file moves), then any remaining path under the old batch folder.
  const esc = (s) => JSON.stringify(s).slice(1, -1);
  for (const [from, to] of moveMap) if (from.startsWith(oldDir + sep)) text = text.split(esc(from)).join(esc(to));
  text = text.split(esc(oldDir + sep)).join(esc(recordDir + sep));
  text = text.split(`"${esc(oldDir)}"`).join(`"${esc(recordDir)}"`);
  JSON.parse(text);
  writeFileSync(runPath, text);
  return true;
}

export async function flatten(root, { apply = false, log = console.log } = {}) {
  const totals = { themes: 0, images: 0, records: 0, copies: 0 };
  for (const theme of readdirSync(root).sort()) {
    const themeDir = join(root, theme);
    if (theme.startsWith('.') || !statSync(themeDir).isDirectory()) continue;
    const plan = await planTheme(themeDir);
    if (!plan.moves.length && !plan.records.length) continue;
    totals.themes++; totals.images += plan.moves.length; totals.records += plan.records.length; totals.copies += plan.copies.length;
    const by = (d) => plan.moves.filter(m => m.to.startsWith(join(themeDir, d) + sep)).length;
    log(`${theme}: ${plan.moves.length} images (${FEED_DIR} ${by(FEED_DIR)}, ${VERTICAL_DIR} ${by(VERTICAL_DIR)}, other ${by(OTHER_SIZES_DIR)}), ${plan.records.length} batch folders → ${RECORDS_DIR}, ${plan.copies.length} ad copy`);
    if (!apply) { for (const m of plan.moves.slice(0, 3)) log(`    ${relative(themeDir, m.from)}  →  ${relative(themeDir, m.to)}`); continue; }
    const moveMap = new Map();
    for (const m of plan.moves) { mkdirSync(join(m.to, '..'), { recursive: true }); renameSync(m.from, m.to); moveMap.set(m.from, m.to); }
    for (const c of plan.copies) { if (!existsSync(c.to)) copyFileSync(c.from, c.to); }
    for (const r of plan.records) {
      mkdirSync(join(themeDir, RECORDS_DIR), { recursive: true });
      const to = existsSync(r.to) ? `${r.to} (moved ${new Date().toISOString().slice(0, 10)})` : r.to;
      renameSync(r.from, to);
      rewriteRunJson(to, r.from, moveMap);
    }
  }
  log(`\n${apply ? 'Moved' : 'Would move'}: ${totals.images} images in ${totals.themes} theme folders; ${totals.records} batch folders to ${RECORDS_DIR}; ${totals.copies} ad copy files placed.${apply ? '' : ' Dry run, pass --apply.'}`);
  return totals;
}

if (isDirectRun(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i > -1 ? process.argv[i + 1] : CREATIVES_STATIC_ROOT;
  await flatten(root, { apply: process.argv.includes('--apply') });
}
