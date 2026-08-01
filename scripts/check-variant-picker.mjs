#!/usr/bin/env node
/**
 * Verify that picking an option on a PDP actually changes what the buy button submits.
 *
 *   node scripts/check-variant-picker.mjs [--handle <handle>] [--json]
 *
 * Why this exists: on 2026-08-01 eight of seventeen multi-variant products were
 * adding the WRONG variant to cart. The picker updated, the price stayed plausible
 * (all scents of a product are the same price), and nothing looked broken — the
 * only visible symptom was the value of the hidden cart input. A buyer selecting
 * Rose Petal was charged for, and shipped, Pure Unscented.
 *
 * Nothing in the fleet would have caught that, because every other check asks
 * whether the page renders. This one asks whether it sells the right thing.
 *
 * See docs/known-issues/wrong-variant-added-to-cart.md.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { getAccessToken } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const argv = process.argv.slice(2);
const only = argv.includes('--handle') ? argv[argv.indexOf('--handle') + 1] : null;
const asJson = argv.includes('--json');

const token = await getAccessToken();
const data = await (await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `{ products(first: 100, query: "status:active") { edges { node {
    handle templateSuffix onlineStoreUrl variants(first: 40) { edges { node { id title } } } } } } }` }),
}).then((r) => r.json())).data;

const products = data.products.edges.map((e) => e.node)
  .filter((p) => p.variants.edges.length > 1 && p.onlineStoreUrl)
  .filter((p) => !only || p.handle === only);

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const results = [];

for (const product of products) {
  const variants = product.variants.edges.map((e) => ({ id: e.node.id.split('/').pop(), title: e.node.title }));
  // Pick a non-default option — the default is already selected, so it proves nothing.
  const target = variants[2] ?? variants[1];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  let jsError = '';
  page.on('pageerror', (e) => {
    if (/dataset|handleOptionValueChange/.test(e.message + (e.stack ?? ''))) jsError = 'handleOptionValueChange';
  });

  try {
    await page.goto(product.onlineStoreUrl, { waitUntil: 'networkidle2', timeout: 45_000 });
    const picker = await page.evaluate((title) => {
      const sel = [...document.querySelectorAll('select')]
        .find((s) => s.offsetHeight > 0 && [...s.options].some((o) => o.textContent.trim().startsWith(title)));
      if (!sel) return null;
      if (!sel.id) sel.id = 'variant-picker-probe';
      return { id: sel.id, value: [...sel.options].find((o) => o.textContent.trim().startsWith(title)).value };
    }, target.title);

    if (!picker) {
      results.push({ handle: product.handle, template: product.templateSuffix ?? 'default', status: 'NO_PICKER' });
    } else {
      await page.select(`#${picker.id}`, picker.value);
      await new Promise((r) => setTimeout(r, 2600));
      const submitted = await page.evaluate(
        () => document.querySelector('form[action*="/cart/add"] [name="id"]')?.value);
      results.push({
        handle: product.handle, template: product.templateSuffix ?? 'default',
        picked: `${target.title} (${target.id})`, submitted,
        status: submitted === target.id ? 'OK' : 'WRONG_VARIANT', jsError,
      });
    }
  } catch (e) {
    results.push({ handle: product.handle, template: product.templateSuffix ?? 'default', status: `ERROR: ${e.message.slice(0, 60)}` });
  }
  await page.close();
}
await browser.close();

if (asJson) { console.log(JSON.stringify(results, null, 2)); }
else {
  console.log('handle'.padEnd(30) + 'template'.padEnd(26) + 'result');
  for (const r of results) {
    console.log(r.handle.padEnd(30) + r.template.padEnd(26) + r.status + (r.jsError ? `  [${r.jsError}]` : ''));
  }
}

const broken = results.filter((r) => r.status === 'WRONG_VARIANT');
console.log(`\n${broken.length} of ${results.length} submit the wrong variant.`);
if (broken.length) {
  console.log('See docs/known-issues/wrong-variant-added-to-cart.md');
  process.exit(1);
}
