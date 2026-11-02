// agents/ad-batch/master-sheet.js
//
// One PDF at the top of "01 Static Ads" showing every creative in the library with
// the folder it lives in, so Sean can scan the whole library without clicking in and
// out of message / batch / headline folders (Sean, 2026-11-02: "too cumbersome").
//
// Sections follow the message folders; inside each, batches are newest first (batch
// folders start with their date). Every thumbnail is captioned with its file name and
// its path below the message folder. _rejected/ and anything starting with "_" (the
// per-headline contact sheets, this PDF itself) are skipped; a message folder that
// itself starts with "_" (`_New (to sort)`) is kept, because unsorted work is exactly
// what needs to be seen.
//
// Regenerated at the end of every ad-batch run into the library, and by hand with
//   node agents/ad-batch/master-sheet.js [--root <dir>]

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { CREATIVES_STATIC_ROOT } from './output.js';

export const MASTER_SHEET_NAME = '_All Creatives.pdf';
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/**
 * Every creative under root, grouped by message folder.
 * @returns {{message:string, items:{path:string, file:string, folder:string}[]}[]}
 */
export function collectCreatives(root, { list = readdirSync, isDir = (p) => statSync(p).isDirectory() } = {}) {
  const groups = [];
  // Alphabetical, with `_New (to sort)` and other underscore folders last.
  const order = (a, b) => (a.startsWith('_') - b.startsWith('_')) || a.localeCompare(b);
  for (const message of list(root).sort(order)) {
    const mdir = join(root, message);
    if (message.startsWith('.') || !isDir(mdir)) continue;
    const items = [];
    const walk = (dir) => {
      for (const name of list(dir)) {
        if (name.startsWith('_') || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (isDir(p)) walk(p);
        else if (IMAGE_RE.test(name)) {
          const folder = relative(mdir, dir).split(sep).join(' / ');
          items.push({ path: p, file: name, folder });
        }
      }
    };
    walk(mdir);
    if (!items.length) continue;
    // Newest batch first (batch folders lead with YYYY-MM-DD), then headline and file order.
    items.sort((a, b) => b.folder.split(' / ')[0].localeCompare(a.folder.split(' / ')[0])
      || a.folder.localeCompare(b.folder) || a.file.localeCompare(b.file));
    groups.push({ message, items });
  }
  return groups;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The printable page. `thumbs` maps an item's path to a data: URI. */
export function buildSheetHtml(groups, thumbs, { generatedAt = new Date() } = {}) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const date = generatedAt.toISOString().slice(0, 10);
  const toc = groups.map((g) => `<li>${esc(g.message)} <span>${g.items.length}</span></li>`).join('');
  const sections = groups.map((g) => {
    let last = null;
    const cells = g.items.map((it) => {
      const head = it.folder !== last ? `<div class="folder">${esc(it.folder || '(top level)')}</div>` : '';
      last = it.folder;
      return `${head}<figure><img src="${thumbs.get(it.path) || ''}"><figcaption><b>${esc(it.file)}</b><br>${esc(it.folder || g.message)}</figcaption></figure>`;
    }).join('');
    return `<section><h2>${esc(g.message)} <span>${g.items.length}</span></h2><div class="grid">${cells}</div></section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:Helvetica,Arial,sans-serif;color:#222;margin:0}
  h1{font-size:22px;margin:0 0 4px} .meta{color:#666;font-size:11px;margin-bottom:10px}
  ul.toc{columns:2;font-size:12px;padding-left:18px} ul.toc span,h2 span{color:#888;font-weight:normal}
  section{break-before:page} section:first-of-type{break-before:auto;margin-top:14px} h2{font-size:18px;border-bottom:2px solid #222;padding-bottom:4px;margin:0 0 8px}
  .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
  .folder{grid-column:1/-1;font-size:11px;font-weight:bold;background:#f1f1f1;padding:4px 6px;margin-top:6px;break-after:avoid}
  figure{margin:0;break-inside:avoid} img{width:100%;aspect-ratio:4/5;object-fit:contain;background:#fff;display:block;border:1px solid #ddd}
  figcaption{font-size:7.5px;line-height:1.25;color:#444;margin-top:2px;word-break:break-word}
  </style></head><body>
  <h1>01 Static Ads: all creatives</h1>
  <div class="meta">${total} creatives in ${groups.length} message folders · generated ${date} · each caption is the file and its folder under the message folder</div>
  <ul class="toc">${toc}</ul>${sections}</body></html>`;
}

async function thumbnail(path) {
  const buf = await sharp(path).resize(300, 375, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 70 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** Writes <root>/_All Creatives.pdf. Returns { path, count } or null when the root is absent or empty. */
export async function writeMasterSheet(root = CREATIVES_STATIC_ROOT, { log = () => {} } = {}) {
  if (!existsSync(root)) return null;
  const groups = collectCreatives(root);
  const all = groups.flatMap((g) => g.items);
  if (!all.length) return null;
  const thumbs = new Map();
  for (const it of all) {
    try { thumbs.set(it.path, await thumbnail(it.path)); }
    catch (err) { log(`  ⚠ could not read ${it.path}: ${err.message}`); }
  }
  const html = buildSheetHtml(groups, thumbs);
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const out = join(root, MASTER_SHEET_NAME);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: out, format: 'Letter', printBackground: true, margin: { top: '0.4in', bottom: '0.4in', left: '0.35in', right: '0.35in' } });
  } finally {
    await browser.close();
  }
  return { path: out, count: all.length };
}

if (isDirectRun(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i > -1 ? process.argv[i + 1] : CREATIVES_STATIC_ROOT;
  const r = await writeMasterSheet(root, { log: console.log });
  console.log(r ? `Master sheet: ${r.count} creatives → ${r.path}` : `No creatives found under ${root}`);
}
