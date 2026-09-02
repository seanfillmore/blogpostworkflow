#!/usr/bin/env node
/**
 * Collapse the homepage's two soap product cards into one `Soap` card.
 *
 *   node scripts/merge-homepage-soap-cards.mjs                 # DRY (default)
 *   node scripts/merge-homepage-soap-cards.mjs --out <file>    # write the new JSON
 *
 * WHY
 *   PR #755 replaced `Liquid Soap` + `Bar Soap` in the header with a single
 *   `Soap` link to /collections/soap. The homepage `product-line` multicolumn
 *   section still carried the two cards pointing at the two PDPs, so the
 *   homepage said something different from the header.
 *
 * WHAT IT CHANGES, in `templates/index.json`:
 *   - drops blocks `prod-liquidsoap` and `prod-barsoap`
 *   - adds `prod-soap` AT THE FIRST OF THE TWO POSITIONS, so soap stays
 *     between Deodorant and Lip Balm exactly as it does in the header
 *   - `columns_desktop` 4 → 3
 *
 * WHY THE COLUMN COUNT MOVES. Seven cards at 4 across is 4+3. Six cards at 4
 * across is 4+2, which leaves a two-card orphan row; at 3 across it is an even
 * 3+3. Mobile is 2 across and is clean either way (was 2+2+2+1, now 2+2+2).
 * Merging the cards forces this choice — it is not an unrelated restyle.
 *
 * WHY THE BAR SOAP IMAGE. Both card images were opened and compared. The bar's
 * own label reads "hand & body soap", which is the span of the new collection;
 * the bottle reads specifically as foaming HAND soap. No combined soap card
 * image exists in Files.
 *
 * THIS SCRIPT DOES NOT WRITE TO SHOPIFY. It prints the plan and, with --out,
 * writes the new template. Uploading is `scripts/update-theme-asset.mjs`, which
 * backs up the live copy and diffs before it writes:
 *
 *   node scripts/update-theme-asset.mjs get templates/index.json /tmp/index.json
 *   node scripts/merge-homepage-soap-cards.mjs --out /tmp/index.new.json
 *   node scripts/update-theme-asset.mjs put templates/index.json /tmp/index.new.json
 *   node scripts/update-theme-asset.mjs put templates/index.json /tmp/index.new.json --apply
 *
 * IDEMPOTENT. Re-running on an already-merged template reports nothing to do.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

export const SECTION_ID = 'product-line';
export const DROPPED_BLOCKS = ['prod-liquidsoap', 'prod-barsoap'];
export const NEW_BLOCK_ID = 'prod-soap';
export const COLUMNS_DESKTOP = 3;

export const SOAP_CARD = {
  type: 'column',
  settings: {
    image: 'shopify://shop_images/card-barsoap.webp',
    title: 'Soap',
    title_size: 'medium',
    text: '<p>Bar, liquid, and 32oz refill. No synthetic detergents or fragrance.</p>'
      + '<p><a href="/collections/soap"><strong>Shop →</strong></a></p>',
    button_label: '',
  },
};

/**
 * Serialize the way Shopify's theme editor does — 2-space indent with forward
 * slashes escaped as `\/`. Plain `JSON.stringify` round-trips this file into a
 * 350-line diff that rewrites the WHOLE homepage template to change two cards,
 * which buries the real edit and makes any serializer mistake a silent homepage
 * rewrite. With this, the diff is only the cards. `/` appears solely inside
 * string values (structural JSON has none), so escaping globally is safe.
 */
export function serializeTemplate(template) {
  return `${JSON.stringify(template, null, 2).replace(/\//g, '\\/')}\n`;
}

/**
 * Pure transform over a parsed `templates/index.json`. Returns the new template
 * and what changed; never mutates its argument.
 */
export function mergeSoapCards(template) {
  const next = JSON.parse(JSON.stringify(template));
  const section = next.sections?.[SECTION_ID];
  if (!section) throw new Error(`section "${SECTION_ID}" not found in template — refusing to guess.`);

  const order = section.block_order || [];
  const present = DROPPED_BLOCKS.filter((id) => order.includes(id));
  const already = order.includes(NEW_BLOCK_ID);
  const columnsChanged = section.settings?.columns_desktop !== COLUMNS_DESKTOP;

  if (!present.length && already && !columnsChanged) {
    return { template: next, changed: false, dropped: [], order };
  }

  // Insert at the FIRST dropped position so soap keeps its place in the row.
  // Appending would move it behind Lip Balm and contradict the header.
  const insertAt = present.length ? order.indexOf(present[0]) : order.length;
  const kept = order.filter((id) => !DROPPED_BLOCKS.includes(id) && id !== NEW_BLOCK_ID);
  const head = order.slice(0, insertAt).filter((id) => kept.includes(id));
  const tail = kept.slice(head.length);
  section.block_order = [...head, NEW_BLOCK_ID, ...tail];

  for (const id of DROPPED_BLOCKS) delete section.blocks[id];
  section.blocks[NEW_BLOCK_ID] = JSON.parse(JSON.stringify(SOAP_CARD));
  section.settings.columns_desktop = COLUMNS_DESKTOP;

  return { template: next, changed: true, dropped: present, order: section.block_order };
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx === -1 ? null : process.argv[outIdx + 1];
  const inIdx = process.argv.indexOf('--in');
  const input = inIdx === -1 ? null : process.argv[inIdx + 1];
  if (!input) {
    console.error('usage: merge-homepage-soap-cards.mjs --in <live index.json> [--out <file>]');
    console.error('       fetch the live copy first: node scripts/update-theme-asset.mjs get templates/index.json <file>');
    process.exit(2);
  }

  // The card is commercial copy on the storefront's most-viewed page.
  const gate = checkSeoCopyFields({ 'card title': SOAP_CARD.settings.title, 'card text': SOAP_CARD.settings.text });
  if (!gate.ok) {
    throw new Error(`card copy failed the health-claim gate: ${gate.blocking.map((v) => `${v.field}: ${v.category} "${v.match}"`).join('; ')}`);
  }
  console.log('  ✓ card copy passes the SEO-copy health gate');

  const template = JSON.parse(readFileSync(input, 'utf8'));
  const before = template.sections?.[SECTION_ID];
  console.log(`  before: ${before.block_order.length} cards, columns_desktop=${before.settings.columns_desktop}`);
  console.log(`          ${before.block_order.map((id) => before.blocks[id].settings.title).join(' · ')}`);

  const result = mergeSoapCards(template);
  if (!result.changed) { console.log('\nNothing to do — already merged.'); return; }

  const after = result.template.sections[SECTION_ID];
  console.log(`\n  after:  ${after.block_order.length} cards, columns_desktop=${after.settings.columns_desktop}`);
  console.log(`          ${after.block_order.map((id) => after.blocks[id].settings.title).join(' · ')}`);
  console.log(`\n  dropped: ${result.dropped.join(', ')}`);

  if (!out) { console.log('\nNothing written. Re-run with --out <file> to produce the new template.'); return; }
  writeFileSync(out, serializeTemplate(result.template));
  console.log(`\n  wrote ${out}`);
  console.log('  upload with: node scripts/update-theme-asset.mjs put templates/index.json ' + out + ' [--apply]');
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
