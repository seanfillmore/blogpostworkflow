// scripts/giveaway/build-pages.mjs
/**
 * Push giveaway theme assets and create/update the Shopify pages.
 *
 *   node scripts/giveaway/build-pages.mjs
 *
 * Idempotent: existing pages are updated by handle rather than duplicated.
 * Verifies each page returns 200 afterwards -- success logs lie, the live page
 * is the evidence.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMainThemeId, updateThemeAsset, getPages, createPage, updatePage } from '../../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const abs = (...p) => join(ROOT, ...p);

// Source path -> theme asset key. Sources that do not exist yet are SKIPPED
// with a log line rather than throwing, so this script runs green while the
// giveaway pages are still being built out across tasks. A silent skip would be
// worse than a throw, so each one is announced.
const ASSETS = [
  [abs('theme', 'sections', 'giveaway-entry.liquid'), 'sections/giveaway-entry.liquid'],
  [abs('theme', 'sections', 'giveaway-entered.liquid'), 'sections/giveaway-entered.liquid'],
  [abs('theme', 'assets', 'giveaway.js'), 'assets/giveaway.js'],
  [abs('theme', 'assets', 'giveaway.css'), 'assets/giveaway.css'],
  [abs('theme', 'templates', 'page.giveaway.json'), 'templates/page.giveaway.json'],
  [abs('theme', 'templates', 'page.giveaway-entered.json'), 'templates/page.giveaway-entered.json'],
];

const PAGES = [
  { handle: 'free-soap-giveaway', title: 'Win 36 Free Bars of Unscented Soap', template_suffix: 'giveaway', body_html: '', requires: abs('theme', 'sections', 'giveaway-entry.liquid') },
  { handle: 'giveaway-entered', title: "You're entered", template_suffix: 'giveaway-entered', body_html: '', requires: abs('theme', 'sections', 'giveaway-entered.liquid') },
  { handle: 'giveaway-official-rules', title: 'Giveaway Official Rules', template_suffix: null, bodyFrom: abs('data', 'giveaway', 'official-rules.html'), requires: abs('data', 'giveaway', 'official-rules.html') },
];

const themeId = await getMainThemeId();
console.log(`Theme ${themeId}`);
for (const [source, key] of ASSETS) {
  if (!existsSync(source)) { console.log(`  SKIP ${key} — not built yet`); continue; }
  await updateThemeAsset(themeId, key, readFileSync(source, 'utf8'));
  console.log(`  pushed ${key}`);
}

const existing = await getPages();
const live = [];
for (const { requires, bodyFrom, ...page } of PAGES) {
  if (!existsSync(requires)) { console.log(`  SKIP /pages/${page.handle} — not built yet`); continue; }
  if (bodyFrom) page.body_html = readFileSync(bodyFrom, 'utf8');
  const hit = existing.find((p) => p.handle === page.handle);
  const saved = hit ? await updatePage(hit.id, page) : await createPage(page);
  console.log(`  ${hit ? 'updated' : 'created'} /pages/${saved.handle} (${saved.id})`);
  live.push(page.handle);
}

// Success logs lie; the live page is the evidence.
for (const handle of live) {
  const url = `https://www.realskincare.com/pages/${handle}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  console.log(`  ${res.status} ${url}`);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
}
console.log(`Verified ${live.length} page(s) live.`);
