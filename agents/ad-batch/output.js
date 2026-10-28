// agents/ad-batch/output.js
//
// Where a batch lands: <outRoot>/<message>/<date> <product>/<NN headline>/ with the
// images, _rejected/ (kept, with the reason, so Sean can overrule a check), a contact
// sheet and scenes.md. Rotation history lives at <outRoot>, outside any git worktree.
//
// The default outRoot is the "01 Static Ads" folder of the RSC creatives library in
// Google Drive (Sean, 2026-10-26: every creative lives there, by type then message).
// A batch stays ONE folder (its run.json and meta-copy.md are read by the Social
// ingest and --copy-only), filed under one message folder. On a machine without that
// Drive folder it falls back to ~/Desktop/Ad Batches, flat, as before; --out <dir>
// is always flat.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';

export const CREATIVES_STATIC_ROOT = join(homedir(), 'Library', 'CloudStorage',
  'GoogleDrive-sfillmore15@gmail.com', 'My Drive', 'Real Skin Care', 'Creatives', '01 Static Ads');
export const DESKTOP_OUT_ROOT = join(homedir(), 'Desktop', 'Ad Batches');

/** The library when it is on this machine, else the old Desktop folder. */
export function defaultOutRoot(exists = existsSync) {
  if (process.env.AD_BATCH_OUT) return process.env.AD_BATCH_OUT;
  return exists(CREATIVES_STATIC_ROOT) ? CREATIVES_STATIC_ROOT : DESKTOP_OUT_ROOT;
}
export const DEFAULT_OUT_ROOT = defaultOutRoot();

/** The message folders in the creatives library, in rule order (first match wins). */
export const MESSAGE_RULES = [
  ['Halloween - Scariest Thing in Your House', /^scariest\b|halloween/i],
  ["Grandma's Recipe", /grandma/i],
  ['Sensitive Skin', /sensitive skin|reacts to everything|gambling on lotion/i],
  ['Toothpaste - SLS-Free & Gentle', /toothpaste|\bsls\b|fluoride|foam|brush/i],
  ['Short Ingredient List', /\bingredients?\b|read the (whole )?label|zero junk|nothing else|switching/i],
  ['Clean Swap (90-Day Reset)', /clean swap|90-day/i],
  ['Dry Skin Pain Points', /\bdry\b|tight|flaky|cracked|thirsty|dusty|ashy|itch|lotion (twice|habit|every)|reapply/i],
  ['Soft, Hydrated Skin', /\bsoft\b|hydrat|moistur/i],
];
// Folders a batch reaches only by naming them in `message`: no headline rule points at
// them. The seasonal body cream sets (2026-10-27) say "nothing scary" or "no tricks",
// not "halloween", so only an explicit message can file them.
export const MESSAGES = [...MESSAGE_RULES.map(([name]) => name), 'Product & Scent Spotlight',
  'Baby-Soft Skin (Baby Drama)', "This One's For You", 'Creator UGC Edits',
  'Halloween - Body Cream', 'Fall - Body Cream', 'Holiday - Body Cream'];
export const UNSORTED_MESSAGE = '_New (to sort)';

/**
 * Which message folder a batch files under. An explicit batch `message` wins when
 * it names a known folder; otherwise the first headline the rules recognise decides
 * (the product title is consulted last, so a toothpaste batch with an unmatched
 * headline still lands with toothpaste). Unknown -> UNSORTED_MESSAGE, never a guess.
 */
export function messageFolder({ message, headlines = [], productTitle = '' } = {}) {
  if (message) {
    const hit = MESSAGES.find((m) => m.toLowerCase() === String(message).trim().toLowerCase());
    if (hit) return hit;
  }
  for (const text of [...headlines, productTitle]) {
    for (const [name, re] of MESSAGE_RULES) if (re.test(String(text || ''))) return name;
  }
  return UNSORTED_MESSAGE;
}

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

/**
 * The run.json to write for a batch folder that may already hold one. Two batches
 * of one product on one day share a folder (batchDirName is date + product), and
 * the second used to OVERWRITE the first's run.json, so its concepts vanished from
 * the record the Social ingest reads (found 2026-10-24: a 5-image parody batch and
 * two toothpaste batches could not be queued). Earlier concepts are kept unless this
 * run re-rendered the same concept folder; a prior file that cannot be read is
 * replaced, as before.
 */
export function mergeRunRecord(prior, record) {
  if (!prior || !Array.isArray(prior.concepts)) return record;
  const dirs = new Set(record.concepts.map(c => c.dir));
  const earlier = prior.concepts.filter(c => !dirs.has(c.dir));
  if (!earlier.length) return record;
  return { ...record, concepts: [...earlier, ...record.concepts] };
}

