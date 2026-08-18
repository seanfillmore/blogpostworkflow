#!/usr/bin/env node
/**
 * PDP Builder Agent
 *
 * Generates Shopify product-page content from a curated foundation.
 * Output goes to data/performance-queue/ for human review; nothing
 * publishes from this agent.
 *
 * Modes:
 *   cluster <cluster-name>    Generate cluster template content
 *   product <product-handle>  Generate per-SKU content
 *   bundle  <product-handle>  Generate a multi-product bundle description
 *
 * Usage:
 *   node agents/pdp-builder/index.js cluster toothpaste
 *   node agents/pdp-builder/index.js product coconut-oil-toothpaste
 *   node agents/pdp-builder/index.js bundle clean-swap
 *
 * NOTHING PUBLISHES FROM THIS AGENT. Every mode writes to data/performance-queue/
 * for human review. Bundle mode additionally writes the reviewable copy to the
 * tracked path data/bundles/descriptions/ because the queue directory is
 * gitignored and the text has to travel with the pull request. There is no
 * Shopify write anywhere in this agent and no mode changes a product's status.
 */

import Anthropic from '../../lib/anthropic.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFoundation } from './lib/load-foundation.js';
import { assembleCluster } from './lib/assemble-cluster.js';
import { assembleProduct } from './lib/assemble-product.js';
import { assembleBundle } from './lib/assemble-bundle.js';
import { buildBundleFacts } from './lib/bundle-facts.js';
import { fetchBundleProduct } from './lib/fetch-bundle.js';
import { assertNoHealthClaims } from '../ad-studio/health-claims.js';
import { getProducts } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');
const BUNDLE_COPY_DIR = join(ROOT, 'data', 'bundles', 'descriptions');

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const CLUSTER_BY_HANDLE = {
  'coconut-oil-deodorant':       'deodorant',
  'coconut-oil-toothpaste':      'toothpaste',
  'coconut-lotion':              'lotion',
  'coconut-moisturizer':         'cream',
  'coconut-soap':                'bar_soap',
  'organic-foaming-hand-soap':   'liquid_soap',
  'foam-soap-refill-32oz':       'liquid_soap',
  'coconut-oil-lip-balm':        'lip_balm',
};

function writeQueueItem(item) {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
  const prefix = { 'pdp-cluster': 'cluster-', 'pdp-bundle': 'bundle-' }[item.type] || '';
  const path = join(QUEUE_DIR, `${prefix}${item.slug}.json`);
  writeFileSync(path, JSON.stringify(item, null, 2));
  return path;
}

/**
 * Writes the reviewable copy to a TRACKED path so it survives into the PR —
 * data/performance-queue/ is gitignored, and a reviewer cannot judge writing
 * they cannot see.
 *
 * The health-claim gate is asserted here as well as inside the assembler. It is
 * cheap, it throws rather than returning, and it is the last thing standing
 * between generated text and a file a human might copy into Shopify. Nothing is
 * written for an item that failed validation.
 *
 * @throws if a health claim reached this point (should be impossible)
 */
export function writeBundleCopy(item, { dir = BUNDLE_COPY_DIR } = {}) {
  if (item.status !== 'pending' || !item.proposed) return null;
  assertNoHealthClaims({
    seoTitle: item.proposed.seoTitle,
    metaDescription: item.proposed.metaDescription,
    bodyHtml: item.proposed.bodyHtml,
  });
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, `${item.slug}.html`);
  writeFileSync(htmlPath, `${item.proposed.bodyHtml}\n`);
  writeFileSync(join(dir, `${item.slug}.json`), JSON.stringify({
    handle: item.slug,
    generated_at: item.generated_at,
    foundation_version: item.foundation_version,
    seoTitle: item.proposed.seoTitle,
    metaDescription: item.proposed.metaDescription,
    savings: item.facts.savings,
    variants: item.facts.variants,
    scentCorrections: item.facts.scentCorrections,
  }, null, 2));
  return htmlPath;
}

async function main() {
  const [, , mode, target] = process.argv;
  if (!mode || !target) {
    console.error('Usage: node agents/pdp-builder/index.js <cluster|product|bundle> <name-or-handle>');
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }
  const claudeClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const foundation = loadFoundation();

  let item;
  if (mode === 'cluster') {
    console.log(`\nPDP Builder — cluster mode — ${target}\n`);
    item = await assembleCluster({ foundation, clusterName: target, claudeClient });
  } else if (mode === 'product') {
    console.log(`\nPDP Builder — product mode — ${target}\n`);
    const clusterName = CLUSTER_BY_HANDLE[target];
    if (!clusterName) {
      console.error(`Unknown product handle: ${target}. Add to CLUSTER_BY_HANDLE in agents/pdp-builder/index.js if this is a real SKU.`);
      process.exit(1);
    }
    const products = await getProducts();
    const product = products.find((p) => p.handle === target);
    if (!product) {
      console.error(`Product not found in Shopify: ${target}`);
      process.exit(1);
    }
    item = await assembleProduct({ foundation, clusterName, product, claudeClient });
  } else if (mode === 'bundle') {
    console.log(`\nPDP Builder — bundle mode — ${target}\n`);
    const product = await fetchBundleProduct(target);
    const facts = buildBundleFacts({ product, ingredientsByCluster: foundation.ingredientsByCluster });
    for (const c of facts.scentCorrections) {
      console.log(`  NOTE: Shopify variant title "${c.from}" (${c.handle}) corrected to "${c.to}" from config/ingredients.json`);
    }
    if (!facts.savings.claimable) {
      console.log(`  PRICING PROBLEM: ${target} is not cheaper than the sum of its parts — no savings copy will be written.`);
    }
    for (const v of facts.variants) {
      console.log(`  ${v.title}: $${v.price} vs parts $${v.partsTotal} → saves $${v.savings} (${v.savingsPct}%)`);
    }
    item = await assembleBundle({ foundation, facts, claudeClient });
  } else {
    console.error(`Unknown mode: ${mode}. Use "cluster", "product" or "bundle".`);
    process.exit(1);
  }

  const path = writeQueueItem(item);
  console.log(`  Queue item written: ${path}`);
  if (item.type === 'pdp-bundle') {
    const copyPath = writeBundleCopy(item);
    console.log(copyPath
      ? `  Reviewable copy written: ${copyPath}`
      : `  No copy written — item did not pass validation.`);
  }
  console.log(`  Status: ${item.status}`);
  if (item.validation.errors.length) {
    console.log(`  Errors:`);
    for (const e of item.validation.errors) console.log(`    - ${e}`);
  }
}

// Main guard: importing this module must not run the agent. Without it, a test or
// a tool that imports index.js for `writeBundleCopy` would fire a live run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
