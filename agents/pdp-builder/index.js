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
 *
 * Usage:
 *   node agents/pdp-builder/index.js cluster toothpaste
 *   node agents/pdp-builder/index.js product coconut-oil-toothpaste
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFoundation } from './lib/load-foundation.js';
import { assembleCluster } from './lib/assemble-cluster.js';
import { assembleProduct } from './lib/assemble-product.js';
import { getProducts } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');

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
  const fileName = item.type === 'pdp-cluster'
    ? `cluster-${item.slug}.json`
    : `${item.slug}.json`;
  const path = join(QUEUE_DIR, fileName);
  writeFileSync(path, JSON.stringify(item, null, 2));
  return path;
}

async function main() {
  const [, , mode, target] = process.argv;
  if (!mode || !target) {
    console.error('Usage: node agents/pdp-builder/index.js <cluster|product> <name-or-handle>');
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
  } else {
    console.error(`Unknown mode: ${mode}. Use "cluster" or "product".`);
    process.exit(1);
  }

  const path = writeQueueItem(item);
  console.log(`  Queue item written: ${path}`);
  console.log(`  Status: ${item.status}`);
  if (item.validation.errors.length) {
    console.log(`  Errors:`);
    for (const e of item.validation.errors) console.log(`    - ${e}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
