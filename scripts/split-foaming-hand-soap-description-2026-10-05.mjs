#!/usr/bin/env node
/**
 * Move the foaming-hand-soap buying guide and FAQ BELOW the product grid
 * (2026-10-05).
 *
 * templates/collection.json renders collection.description in two places:
 * everything before a `<!---Split--->` marker above the product grid, and
 * everything after it below. This collection has no marker, so all ~805 words
 * sit above its two products; every other live collection has at most 131.
 *
 * Inserts ONE marker before the first <h2>, leaving the JSON-LD blocks and the
 * intro paragraph above the grid. No copy changes. Dry by default; --apply backs
 * up the live collection first. Idempotent: a body that already holds a marker
 * is left alone.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const COLLECTION_ID = 153343098915;
export const HANDLE = 'foaming-hand-soap';
export const MARKER = '<!---Split--->';

const words = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

/** Pure: insert the marker before the first <h2>. */
export function splitBody(html) {
  if (html.includes(MARKER)) return { html, state: 'already-applied' };
  // First <h2> OUTSIDE any <script> block: JSON-LD is prose-shaped and can hold markup.
  const masked = html.replace(/<script[\s\S]*?<\/script>/gi, (m) => ' '.repeat(m.length));
  const i = masked.search(/<h2[\s>]/i);
  if (i === -1) throw new Error('no <h2> to split before');
  const out = `${html.slice(0, i)}${MARKER}\n${html.slice(i)}`;
  const [above, below] = out.split(MARKER);
  return { html: out, state: 'apply', above: words(above), below: words(below) };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { getCustomCollections, updateCustomCollection } = await import('../lib/shopify.js');
  const [col] = (await getCustomCollections({ ids: String(COLLECTION_ID) })).filter((c) => c.id === COLLECTION_ID);
  if (!col || col.handle !== HANDLE) throw new Error(`collection ${COLLECTION_ID} not found or handle moved`);
  const r = splitBody(col.body_html);
  console.log(`state: ${r.state}${r.above != null ? ` | words above grid: ${r.above} | below: ${r.below}` : ''}`);
  if (!apply || r.state !== 'apply') { if (!apply) console.log('Dry run. Re-run with --apply to write.'); return; }
  const dir = join(ROOT, 'data/reports/collection-fixes', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${HANDLE}.before-split.json`), JSON.stringify(col, null, 2));
  await updateCustomCollection(COLLECTION_ID, { body_html: r.html });
  console.log(`Written. Backup: ${dir}`);
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
