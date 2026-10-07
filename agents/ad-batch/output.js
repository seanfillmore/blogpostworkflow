// agents/ad-batch/output.js
//
// Where a batch lands: <outRoot>/<date> <product>/<NN headline>/ with the images,
// _rejected/ (kept, with the reason, so Sean can overrule a check), a contact sheet
// and scenes.md. Rotation history lives beside the batches, outside any git worktree.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';

export const DEFAULT_OUT_ROOT = join(homedir(), 'Desktop', 'Ad Batches');

export function slug(s, max = 60) {
  return String(s || '')
    .replace(/[‘’]/g, "'")
    .replace(/[^A-Za-z0-9' &+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

export function shortTitle(title) {
  return slug(String(title || '').split(/[|—–]/)[0], 40);
}

export function batchDirName({ date, product }) {
  return `${date} ${shortTitle(product.title)}${product.variant ? ' - ' + product.variant : ''}`;
}

export function conceptDirName(i, concept) {
  return `${String(i + 1).padStart(2, '0')} ${slug(concept.headline, 50)}`;
}

export function imageName(i, scene) {
  return `${String(i + 1).padStart(2, '0')}-${scene.id}.png`;
}

export function loadUsage(outRoot) {
  try { return JSON.parse(readFileSync(join(outRoot, '.scene-usage.json'), 'utf8')); } catch { return {}; }
}

export function saveUsage(outRoot, usage) {
  try {
    mkdirSync(outRoot, { recursive: true });
    writeFileSync(join(outRoot, '.scene-usage.json'), JSON.stringify(usage, null, 2));
  } catch { /* rotation history is a nicety; never fail a paid run over it */ }
}

export function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Grid of the accepted images, 4 across, each captioned with its scene. */
export async function writeContactSheet(dir, items, { cols = 4, w = 360 } = {}) {
  if (!items.length) return null;
  const h = Math.round(w * 1.25);
  const cap = 34;
  const rows = Math.ceil(items.length / cols);
  const tiles = await Promise.all(items.map(async (it, i) => {
    const img = await sharp(it.path).resize(w, h, { fit: 'cover' }).toBuffer();
    const label = Buffer.from(`<svg width="${w}" height="${cap}"><rect width="100%" height="100%" fill="#fff"/><text x="6" y="22" font-family="Helvetica, Arial" font-size="15" fill="#222">${esc(it.caption).slice(0, 48)}</text></svg>`);
    const col = i % cols; const row = Math.floor(i / cols);
    return [
      { input: img, left: col * w, top: row * (h + cap) },
      { input: label, left: col * w, top: row * (h + cap) + h },
    ];
  }));
  const out = join(dir, '_contact sheet.jpg');
  await sharp({ create: { width: cols * w, height: rows * (h + cap), channels: 3, background: '#ffffff' } })
    .composite(tiles.flat()).jpeg({ quality: 85 }).toFile(out);
  return out;
}

export function scenesMarkdown({ concept, results }) {
  const lines = [`# ${concept.headline}`];
  if (concept.subhead) lines.push(`_${concept.subhead}_`);
  lines.push('', '| # | scene | source | family | result | notes |', '|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    const res = r.ok ? `✅ ${r.model}` : `❌ ${r.reasons.join('; ')}`;
    lines.push(`| ${i + 1} | ${r.scene.scene.replace(/\|/g, '/')} | ${r.scene.source} | ${r.scene.family} | ${res.replace(/\|/g, '/')} | ${(r.notes || []).join('; ').replace(/\|/g, '/')} |`);
  });
  return lines.join('\n') + '\n';
}
