#!/usr/bin/env node
/**
 * Plan 6 cutover script.
 *
 * Steps (run in order):
 *   1. Saves a backup of current product state for all 8 SKUs to
 *      data/reports/plan6-cutover/backup-{timestamp}.json
 *   2. For each product:
 *      - Sets template_suffix → landing-page-<cluster>
 *      - Updates body_html from data/performance-queue/<handle>.json (if present)
 *      - Sets global.title_tag metafield from queue item's seoTitle
 *      - Sets global.description_tag metafield from queue item's metaDescription
 *   3. Prints a verification table.
 *
 * Theme publish (draft → live) is done separately via shopify CLI.
 *
 * Usage: node scripts/plan6-cutover.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProducts, updateProduct, upsertMetafield } from '../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const QUEUE = join(ROOT, 'data', 'performance-queue');
const BACKUP_DIR = join(ROOT, 'data', 'reports', 'plan6-cutover');

const DRY_RUN = process.argv.includes('--dry-run');

const PLAN = [
  // [handle, template_suffix, queue_filename]
  ['coconut-oil-toothpaste',     'landing-page-toothpaste',   'coconut-oil-toothpaste.json'],
  ['coconut-oil-deodorant',      'landing-page-deodorant',    'coconut-oil-deodorant.json'],
  ['coconut-lotion',             'landing-page-lotion',       'coconut-lotion.json'],
  ['coconut-moisturizer',        'landing-page-cream',        'coconut-moisturizer.json'],
  ['coconut-soap',               'landing-page-bar-soap',     'coconut-soap.json'],
  ['organic-foaming-hand-soap',  'landing-page-liquid-soap',  'organic-foaming-hand-soap.json'],
  ['foam-soap-refill-32oz',      'landing-page-liquid-soap',  'foam-soap-refill-32oz.json'],
  ['coconut-oil-lip-balm',       'landing-page-lip-balm',     'coconut-oil-lip-balm.json'],
];

function readQueueItem(filename) {
  const path = join(QUEUE, filename);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn(`  ! could not parse queue item ${filename}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(DRY_RUN ? '[DRY RUN]' : '[LIVE]', 'Plan 6 cutover starting');
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  const products = await getProducts();
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = [];

  for (const [handle, suffix, queueFile] of PLAN) {
    const product = products.find((p) => p.handle === handle);
    if (!product) { console.error(`✗ ${handle}: not found in store`); continue; }

    const item = readQueueItem(queueFile);
    const proposed = item?.proposed || {};

    const backup = {
      handle,
      product_id: product.id,
      template_suffix: product.template_suffix || null,
      body_html: product.body_html || '',
    };
    backups.push(backup);

    console.log(`\n→ ${handle} (id ${product.id})`);
    console.log(`  template_suffix: ${product.template_suffix || '(none)'} → ${suffix}`);
    console.log(`  body_html: ${proposed.bodyHtml ? `${proposed.bodyHtml.length} chars (will replace)` : '(no queue item — keeping current)'}`);
    console.log(`  seoTitle:  ${proposed.seoTitle || '(none)'}`);
    console.log(`  meta:      ${proposed.metaDescription ? proposed.metaDescription.slice(0, 80) + '…' : '(none)'}`);

    if (DRY_RUN) continue;

    // Apply changes
    const productFields = { template_suffix: suffix };
    if (proposed.bodyHtml) productFields.body_html = proposed.bodyHtml;
    await updateProduct(product.id, productFields);

    if (proposed.seoTitle) {
      await upsertMetafield('products', product.id, 'global', 'title_tag', proposed.seoTitle);
    }
    if (proposed.metaDescription) {
      await upsertMetafield('products', product.id, 'global', 'description_tag', proposed.metaDescription);
    }

    console.log(`  ✓ updated`);
  }

  if (!DRY_RUN) {
    const backupPath = join(BACKUP_DIR, `backup-${now}.json`);
    writeFileSync(backupPath, JSON.stringify(backups, null, 2));
    console.log(`\nBackup saved: ${backupPath}`);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
