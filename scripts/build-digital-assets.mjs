#!/usr/bin/env node
/**
 * Render the bundle digital assets (Routine & Tracker, Field Guide) to branded PDFs.
 *
 *   node scripts/build-digital-assets.mjs [slug|--all] [--refresh-images] [--upload]
 *
 * Why this exists rather than a hand-made PDF: the previous guides were Chrome
 * print-to-PDF one-offs with no source in the repo — unversioned binaries on a CDN
 * asserting ingredients, timings and prices. Four separate live claims were found
 * false on 2026-07-27 because a value lived in one place and drifted from its
 * source. A PDF nobody can regenerate is the ideal vector for the fifth.
 *
 * So: content lives in the repo as markdown, every factual claim that CAN be
 * derived IS derived (ingredients from config/ingredients.json), and the output is
 * a build artifact rather than a document someone edits.
 *
 * Layout:
 *   assets/digital/<slug>/manifest.json   title, subtitle, theme, cover image
 *   assets/digital/<slug>/content.md      the prose — written by the content agents
 *   assets/digital/image-map.json         resolved Shopify CDN URLs (committed, so a
 *                                         build needs no API credentials)
 *   data/digital-assets/<slug>.pdf        output
 *
 * Content directives (see renderBlock) keep these from becoming walls of text:
 *   :::image product=coconut-lotion index=0 caption="..." size=full|half|inset
 *   :::callout title="..."            … :::
 *   :::ingredients product=lotion     renders the real list from config
 *   :::tracker weeks=12               generates the fillable grid
 *   :::pagebreak
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'digital');
const OUT = join(ROOT, 'data', 'digital-assets');
const IMAGE_MAP = join(SRC, 'image-map.json');

const BRAND = {
  // Resolved from the theme's `logo` setting. Pinned rather than fetched so a build
  // is reproducible and needs no credentials.
  logo: 'https://cdn.shopify.com/s/files/1/0270/1911/6579/files/Logo_3c129581-8a9a-426f-9f94-8b5d96a43e16.png',
  ink: '#1f2a24',
  muted: '#6b7770',
  accent: '#4a8b3c',
  rule: '#dfe5e0',
  wash: '#f5f8f5',
  site: 'realskincare.com',
};

/* ── content helpers ──────────────────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Inline markdown: **bold**, *italic*, `code`. Deliberately small. */
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+?)\*/g, '$1<em>$2</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

/** Parse `key=value key="value with spaces"` into an object. */
function parseAttrs(s) {
  const out = {};
  for (const m of String(s).matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/** The real ingredient list, so a formulation change cannot leave the guide lying. */
function renderIngredients(attrs, ingredients) {
  const key = attrs.product;
  const raw = ingredients[key];
  if (!raw) throw new Error(`:::ingredients unknown product "${key}" — valid: ${Object.keys(ingredients).join(', ')}`);
  const list = Array.isArray(raw) ? raw : raw.ingredients || raw.list || Object.values(raw).find(Array.isArray) || [];
  if (!list.length) throw new Error(`:::ingredients "${key}" resolved to an empty list`);
  const items = list.map((i) => `<li>${inline(i)}</li>`).join('');
  return `<div class="ing"><p class="ing__h">${inline(attrs.title || 'Every ingredient, in order')}</p><ol class="ing__list">${items}</ol>
    <p class="ing__n">${list.length} ingredient${list.length === 1 ? '' : 's'}. Generated from the product record — if the formula changes, this page changes.</p></div>`;
}

/** The fillable grid. This is the artefact people print; it is generated, not drawn. */
function renderTracker(attrs) {
  const weeks = Number(attrs.weeks || 12);
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const rows = Array.from({ length: weeks }, (_, w) => {
    const cells = days.map(() => '<td class="tk__box"></td>').join('');
    return `<tr><th class="tk__wk">Week ${w + 1}</th>${cells}<td class="tk__scale"></td><td class="tk__note"></td></tr>`;
  }).join('');
  return `<table class="tk"><thead><tr><th></th>${days.map((d) => `<th class="tk__d">${d}</th>`).join('')}
    <th class="tk__h">Skin 1–5</th><th class="tk__h">Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderImage(attrs, images) {
  const key = `${attrs.product}:${attrs.index || 0}`;
  const url = images[key];
  if (!url) throw new Error(`:::image has no resolved URL for "${key}" — run with --refresh-images`);
  const cap = attrs.caption ? `<figcaption>${inline(attrs.caption)}</figcaption>` : '';
  return `<figure class="fig fig--${attrs.size || 'full'}"><img src="${url}" alt="${esc(attrs.alt || attrs.caption || '')}">${cap}</figure>`;
}

/** Markdown subset → HTML. Blocks are separated by blank lines. */
function renderBlock(block, ctx) {
  const t = block.trim();
  if (!t) return '';

  const d = t.match(/^:::(\w+)\s*(.*?)$/s);
  if (d) {
    const [, name, rest] = d;
    const body = rest.includes('\n') ? rest.slice(rest.indexOf('\n') + 1).replace(/:::\s*$/, '').trim() : '';
    const attrs = parseAttrs(rest.split('\n')[0]);
    if (name === 'pagebreak') return '<div class="pb"></div>';
    if (name === 'image') return renderImage(attrs, ctx.images);
    if (name === 'ingredients') return renderIngredients(attrs, ctx.ingredients);
    if (name === 'tracker') return renderTracker(attrs);
    if (name === 'callout') {
      const h = attrs.title ? `<p class="co__h">${inline(attrs.title)}</p>` : '';
      const inner = body.split(/\n{2,}/).map((p) => `<p>${inline(p.replace(/\n/g, ' '))}</p>`).join('');
      return `<aside class="co">${h}${inner}</aside>`;
    }
    throw new Error(`unknown directive :::${name}`);
  }

  if (/^#{1,4} /.test(t)) {
    const lvl = t.match(/^#+/)[0].length;
    return `<h${lvl}>${inline(t.replace(/^#+\s*/, ''))}</h${lvl}>`;
  }
  if (/^\s*\|/.test(t)) {
    const rows = t.split('\n').filter((l) => l.trim() && !/^\s*\|[\s|:-]+\|\s*$/.test(l));
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('');
    const body = rows.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
    return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }
  if (/^[-*] /.test(t)) {
    return `<ul>${t.split('\n').map((l) => `<li>${inline(l.replace(/^[-*]\s*/, ''))}</li>`).join('')}</ul>`;
  }
  if (/^\d+\. /.test(t)) {
    return `<ol>${t.split('\n').map((l) => `<li>${inline(l.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>`;
  }
  return `<p>${inline(t.replace(/\n/g, ' '))}</p>`;
}

/** Split on blank lines, but keep ::: fenced blocks whole. */
function splitBlocks(md) {
  const out = [];
  let buf = [];
  let fence = null;
  for (const line of md.split('\n')) {
    const open = line.match(/^:::(\w+)/);
    if (open && !fence && !/:::\s*$/.test(line.slice(3)) && ['callout'].includes(open[1])) {
      if (buf.join('\n').trim()) out.push(buf.join('\n'));
      buf = [line];
      fence = open[1];
      continue;
    }
    if (fence) {
      buf.push(line);
      if (/^:::\s*$/.test(line)) { out.push(buf.join('\n')); buf = []; fence = null; }
      continue;
    }
    if (!line.trim()) { if (buf.join('\n').trim()) out.push(buf.join('\n')); buf = []; continue; }
    buf.push(line);
  }
  if (buf.join('\n').trim()) out.push(buf.join('\n'));
  return out;
}

/* ── page shell ───────────────────────────────────────────────────────────── */

function css() {
  return `
  @page { size: Letter; margin: 20mm 16mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia,'Iowan Old Style',serif; color:${BRAND.ink}; font-size:10.5pt; line-height:1.55; margin:0; }
  h1,h2,h3,h4,.co__h,.ing__h,.eyebrow,figcaption,.tk th { font-family:'Helvetica Neue',Arial,sans-serif; }
  h1 { font-size:30pt; line-height:1.1; margin:0 0 10px; letter-spacing:-.5px; }
  h2 { font-size:15pt; margin:26px 0 8px; padding-bottom:5px; border-bottom:2px solid ${BRAND.accent}; break-after:avoid; }
  h3 { font-size:11.5pt; margin:18px 0 5px; color:${BRAND.accent}; break-after:avoid; }
  p { margin:0 0 9px; } li { margin:0 0 4px; }
  .eyebrow { font-size:7.5pt; letter-spacing:2px; text-transform:uppercase; color:${BRAND.muted}; margin:0 0 8px; }
  .pb { break-after:page; }

  /* cover */
  .cover { display:flex; flex-direction:column; justify-content:center; min-height:232mm; break-after:page; text-align:center; }
  .cover img.logo { width:150px; margin:0 auto 30px; }
  .cover .sub { font-size:12.5pt; color:${BRAND.muted}; max-width:118mm; margin:14px auto 0; line-height:1.5; }
  .cover .rule { width:54px; height:3px; background:${BRAND.accent}; margin:22px auto; }
  .cover .incl { margin-top:34px; font-size:8.5pt; letter-spacing:1.2px; text-transform:uppercase; color:${BRAND.muted}; }

  /* figures — the reason this isn't a wall of words */
  .fig { margin:14px 0; break-inside:avoid; }
  .fig img { width:100%; border-radius:6px; display:block; }
  .fig--half { width:52%; float:right; margin:4px 0 12px 16px; }
  .fig--inset { width:34%; float:left; margin:4px 16px 10px 0; }
  figcaption { font-size:8pt; color:${BRAND.muted}; margin-top:5px; line-height:1.4; }

  .co { background:${BRAND.wash}; border-left:3px solid ${BRAND.accent}; padding:11px 14px; margin:14px 0; break-inside:avoid; font-size:10pt; }
  .co__h { font-weight:700; font-size:9.5pt; margin:0 0 4px; }
  .co p:last-child { margin-bottom:0; }

  .tbl { width:100%; border-collapse:collapse; margin:12px 0; font-size:9.5pt; break-inside:avoid; }
  .tbl th { background:${BRAND.ink}; color:#fff; text-align:left; padding:7px 9px; font-size:8.5pt; }
  .tbl td { padding:7px 9px; border-bottom:1px solid ${BRAND.rule}; vertical-align:top; }

  .ing { background:${BRAND.wash}; padding:12px 15px; border-radius:6px; margin:14px 0; break-inside:avoid; }
  .ing__h { font-weight:700; font-size:9.5pt; margin:0 0 6px; }
  .ing__list { margin:0; padding-left:18px; font-size:9.5pt; column-count:2; column-gap:20px; }
  .ing__n { font-size:7.5pt; color:${BRAND.muted}; margin:8px 0 0; }

  /* the tracker grid */
  .tk { width:100%; border-collapse:collapse; margin:12px 0; break-inside:avoid; }
  .tk th { font-size:7.5pt; text-transform:uppercase; letter-spacing:.5px; color:${BRAND.muted}; padding:0 0 5px; font-weight:600; }
  .tk__wk { text-align:left; font-size:8.5pt; color:${BRAND.ink}; width:56px; }
  .tk__box { border:1px solid ${BRAND.rule}; width:26px; height:23px; }
  .tk__scale { border:1px solid ${BRAND.rule}; width:52px; }
  .tk__note { border:1px solid ${BRAND.rule}; }
  .tk tbody th { padding-right:8px; }`;
}

function shell({ manifest, bodyHtml }) {
  const cover = `<section class="cover">
    <img class="logo" src="${BRAND.logo}" alt="Real Skin Care">
    <p class="eyebrow">${esc(manifest.eyebrow || 'Real Skin Care')}</p>
    <h1>${inline(manifest.title)}</h1>
    <div class="rule"></div>
    <p class="sub">${inline(manifest.subtitle || '')}</p>
    ${manifest.included ? `<p class="incl">${esc(manifest.included)}</p>` : ''}
  </section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css()}</style></head>
    <body>${cover}${bodyHtml}</body></html>`;
}

/* ── image resolution ─────────────────────────────────────────────────────── */

async function refreshImageMap() {
  const { getProducts } = await import('../lib/shopify.js');
  const products = await getProducts({ limit: 250 });
  const map = {};
  for (const p of products) {
    (p.images || []).forEach((img, i) => { map[`${p.handle}:${i}`] = String(img.src).split('?')[0]; });
  }
  writeFileSync(IMAGE_MAP, JSON.stringify(map, null, 2) + '\n');
  console.log(`image map refreshed — ${Object.keys(map).length} images across ${products.length} products`);
  return map;
}

/* ── build ────────────────────────────────────────────────────────────────── */

async function build(slug, images, ingredients, browser) {
  const dir = join(SRC, slug);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const md = readFileSync(join(dir, 'content.md'), 'utf8');

  const bodyHtml = splitBlocks(md).map((b) => renderBlock(b, { images, ingredients })).join('\n');
  const html = shell({ manifest, bodyHtml });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  mkdirSync(OUT, { recursive: true });
  const out = join(OUT, `${slug}.pdf`);
  await page.pdf({
    path: out,
    format: 'Letter',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;font:8pt 'Helvetica Neue',Arial;color:#6b7770;padding:0 16mm;display:flex;justify-content:space-between;">
      <span>${esc(manifest.title)}</span><span>${BRAND.site} &nbsp;·&nbsp; <span class="pageNumber"></span></span></div>`,
    margin: { top: '20mm', bottom: '18mm', left: '16mm', right: '16mm' },
  });
  await page.close();

  const words = md.replace(/:::\w+[^\n]*/g, ' ').split(/\s+/).filter(Boolean).length;
  return { out, words };
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh-images');
  const targets = args.filter((a) => !a.startsWith('--'));

  const ingredients = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));
  let images = {};
  if (refresh || !existsSync(IMAGE_MAP)) images = await refreshImageMap();
  else images = JSON.parse(readFileSync(IMAGE_MAP, 'utf8'));

  const slugs = targets.length && targets[0] !== '--all'
    ? targets
    : readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (!slugs.length) throw new Error(`no assets found under ${SRC}`);

  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    for (const slug of slugs) {
      const { out, words } = await build(slug, images, ingredients, browser);
      const { execSync } = await import('node:child_process');
      let pages = '?';
      try { pages = execSync(`pdfinfo "${out}"`, { encoding: 'utf8' }).match(/Pages:\s*(\d+)/)?.[1] ?? '?'; } catch {}
      console.log(`✓ ${slug} — ${pages} pages, ~${words} words → ${out.replace(ROOT + '/', '')}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
