#!/usr/bin/env node
/**
 * Bundle economics — single source of truth for offer profitability.
 *
 * Regenerates docs/bundle-economics.md from measured data:
 *   - COGS and weights come from the SKU table below (pulled from Shopify's
 *     inventoryItem.unitCost and variant weights on 2026-07-25)
 *   - freight comes from lib/shipping-costs.js, which reads Shopify's
 *     shipping_labels ShopifyQL dataset (232 real labels)
 *
 * Usage:
 *   node scripts/bundle-economics.mjs            # live package costs, print
 *   node scripts/bundle-economics.mjs --write    # + write docs/bundle-economics.md
 *   node scripts/bundle-economics.mjs --offline  # use the 365d fallback averages
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  estimateShipping, contribution, FALLBACK_PACKAGE_COSTS, FALLBACK_AVERAGE,
} from '../lib/shipping-costs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

/** Target CAC. CFA rule: 30-day gross profit >= CAC to break even, >= 2x to scale. */
export const CAC = 25;

/** price, cogs (measured), ounces (measured). */
export const SKUS = {
  lotion:     { label: 'Body Lotion 8oz',        price: 30, cogs: 4.92, oz: 10 },
  cream:      { label: 'Coconut Moisturizer 4oz', price: 28, cogs: 5.18, oz: 5 },
  refill:     { label: 'Foam Soap Refill 32oz',  price: 26, cogs: 8.79, oz: 44.8, oversize: true },
  lipbalm:    { label: 'Lip Balm 4-pack',        price: 15, cogs: 5.00, oz: 0.4 },
  deo:        { label: 'Deodorant',              price: 15, cogs: 3.84, oz: 2.5 },
  toothpaste: { label: 'Toothpaste',             price: 13, cogs: 3.35, oz: 4 },
  pump:       { label: 'Foaming Soap Pump 8oz',  price: 13, cogs: 4.26, oz: 10 },
  barsoap:    { label: 'Bar Soap 3.4oz',         price: 11, cogs: 2.99, oz: 4 },
};

/**
 * status: live | draft | proposed | rejected | retired
 * Prices for proposed bundles are the recommended starting point, not fixed.
 * `retired` rows are kept deliberately — the row is the record of why the bundle
 * was removed, and deleting it invites someone to re-propose it next quarter.
 */
export const BUNDLES = [
  { name: '90-Day Clean Swap', status: 'live', price: 159,
    items: { deo: 3, toothpaste: 3, barsoap: 3, lotion: 3 },
    story: 'Replace the four things you put on your body every day, for a quarter.' },
  { name: 'Head-to-Toe', status: 'live', price: 105,
    items: { lotion: 1, cream: 1, deo: 1, toothpaste: 1, barsoap: 1, pump: 1, lipbalm: 1 },
    story: 'One of everything. Discovery and gifting.' },
  { name: '90-Day Coconut Reset', status: 'live', price: 99,
    items: { lotion: 3, cream: 1 },
    story: 'Live on the lean lander, two scents, digital bonuses delivered by Klaviyo.' },
  { name: 'Pump 4-pack + Lotion', status: 'proposed', price: 72,
    items: { pump: 4, lotion: 1 },
    story: 'The pump push, anchored by a high-margin lotion so it clears CAC.' },
  { name: 'Gift Box', status: 'proposed', price: 62, packaging: 1.00,
    items: { lotion: 1, lipbalm: 1, barsoap: 1, deo: 1 },
    story: 'Gifting escapes price comparison entirely. Q4. Ships in the custom box ($1/unit).' },
  { name: 'The Clean Swap', status: 'proposed', price: 59,
    items: { deo: 1, toothpaste: 1, barsoap: 1, lotion: 1 },
    story: 'Entry version of the 90-day. Turns three weak singles into margin.' },
  { name: 'Pump 3-pack + Lotion', status: 'proposed', price: 59,
    items: { pump: 3, lotion: 1 }, story: 'Smaller pump entry.' },
  { name: 'Sensitive Skin Set', status: 'live', price: 46.80,
    items: { lotion: 1, cream: 1 },
    story: 'Current hero. Clears the $45 free-shipping threshold on its own.' },
  { name: 'Pump 4-pack', status: 'proposed', price: 44,
    items: { pump: 4 },
    story: 'One per scent, one per sink. Sits on the CAC line at full MSRP; any discount sinks it. Reorder/AOV, not paid acquisition.' },
  { name: 'Bar Soap 4-Pack', status: 'live', price: 39,
    items: { barsoap: 4 },
    story: 'Subscription vehicle, every 4 months. Replaces the single-bar sub, which still loses money per shipment. Does not clear the $45 free-shipping threshold — never lead its copy with shipping.' },
  { name: 'Two-Step Dry Skin Starter Set', status: 'retired', price: 39.99,
    items: { lotion: 1, cream: 1 },
    story: 'Deleted 2026-07-26. Same contents as the hero at a deeper discount; it only split traffic and reviews.' },
  { name: 'Pump + Refill', status: 'rejected', price: 34,
    items: { pump: 1, refill: 1 }, story: 'Loses money: the refill forces a $21.31 box.' },
  { name: 'Foam Soap Bundle', status: 'retired', price: 20.02,
    items: { pump: 2, refill: 1 },
    story: 'Deleted 2026-07-26 without ever being published — lost ~$19/order.' },
  { name: 'Single lotion (reference)', status: 'live', price: 30,
    items: { lotion: 1 }, story: 'Reference point, not an offer. Anchor for the $99 bundle.' },
];

// ── computation ──────────────────────────────────────────────────────────────

export function evaluate(bundle, packageCosts) {
  const entries = Object.entries(bundle.items);
  const msrp  = entries.reduce((s, [k, q]) => s + SKUS[k].price * q, 0);
  const cogs  = entries.reduce((s, [k, q]) => s + SKUS[k].cogs * q, 0);
  const oz    = entries.reduce((s, [k, q]) => s + SKUS[k].oz * q, 0);
  const units = entries.reduce((s, [, q]) => s + q, 0);
  const oversize = entries.some(([k]) => SKUS[k].oversize);
  const pounds = oz / 16;
  const shipping = estimateShipping({ units, pounds, hasOversizeItem: oversize }, packageCosts);
  const packaging = bundle.packaging ?? 0;
  const contrib = contribution({ price: bundle.price, cogs, shipping, packaging });
  return {
    ...bundle, msrp, cogs: round(cogs), pounds: round(pounds), units, shipping, packaging, contrib,
    discountPct: msrp > 0 ? Math.round((1 - bundle.price / msrp) * 100) : 0,
    verdict: contrib >= CAC * 2 ? 'scale' : contrib >= CAC ? 'breakeven' : contrib > 0 ? 'thin' : 'loss',
  };
}

const round = n => Math.round(n * 100) / 100;
const money = n => `$${n.toFixed(2)}`;

const VERDICT_LABEL = {
  scale: `✅ scale (≥2× CAC)`, breakeven: `🟡 breakeven (≥1× CAC)`,
  thin: `🟠 thin (<1× CAC)`, loss: `❌ loses money`,
};

export function buildMarkdown(rows, { packageCosts, average, live }) {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  let md = `# Bundle economics — Real Skin Care\n\n`;
  md += `Generated ${d} by \`scripts/bundle-economics.mjs\`. Freight is **measured**, `;
  md += live ? `pulled live from Shopify's \`shipping_labels\` dataset.\n\n` : `from the 365-day fallback averages.\n\n`;
  md += `> Regenerate with \`node scripts/bundle-economics.mjs --write\`. Do not hand-edit the tables.\n\n`;

  md += `## How to read this\n\n`;
  md += `CAC target is **$${CAC}**. Under the CFA rule, 30-day gross profit ≥ CAC breaks even; ≥ 2× CAC (**$${CAC * 2}**) is the threshold for scaling paid spend. Contribution = price − COGS − freight − payment fees (2.9% + $0.30).\n\n`;

  md += `## Bundles\n\n`;
  md += `| Bundle | Status | MSRP | Price | Disc | COGS | lb | Units | Freight | **Contribution** | Verdict |\n`;
  md += `|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|\n`;
  for (const r of rows) {
    md += `| ${r.name} | ${r.status} | ${money(r.msrp)} | ${money(r.price)} | ${r.discountPct}% | ${money(r.cogs)} | ${r.pounds.toFixed(2)} | ${r.units} | ${money(r.shipping)} | **${money(r.contrib)}** | ${VERDICT_LABEL[r.verdict]} |\n`;
  }

  md += `\n## Why each one exists\n\n`;
  for (const r of rows) md += `- **${r.name}** (${r.status}, ${money(r.contrib)}) — ${r.story}\n`;

  md += `\n## SKU table (measured)\n\n`;
  md += `| SKU | Price | COGS | Margin | Weight |\n|---|--:|--:|--:|--:|\n`;
  for (const s of Object.values(SKUS)) {
    md += `| ${s.label} | ${money(s.price)} | ${money(s.cogs)} | ${Math.round((1 - s.cogs / s.price) * 100)}% | ${s.oz} oz |\n`;
  }

  md += `\n## Freight model\n\n`;
  md += `Cost is driven by **package**, not weight — real labels are flat $6.50–8.50 from 0.4 lb to 3.1 lb. Weighted average across all labels: **${money(average ?? FALLBACK_AVERAGE)}**.\n\n`;
  md += `| Package | Measured avg |\n|---|--:|\n`;
  for (const [k, v] of Object.entries(packageCosts).sort((a, b) => a[1] - b[1])) md += `| ${k} | ${money(v)} |\n`;
  md += `\nSelection rules live in \`estimateShipping()\` (\`lib/shipping-costs.js\`): oversize item → 14x10x4; ≤2 units and <1 lb → bubble envelope; ≤8 units and <3.5 lb → 10x5x5; otherwise a larger box.\n`;
  return md;
}

async function main() {
  const args = process.argv.slice(2);
  let packageCosts = FALLBACK_PACKAGE_COSTS, average = FALLBACK_AVERAGE, live = false;
  if (!args.includes('--offline')) {
    try {
      const { fetchPackageCosts } = await import('../lib/shipping-costs.js');
      const r = await fetchPackageCosts();
      if (Object.keys(r.costs).length) { packageCosts = r.costs; average = r.average; live = true; }
    } catch (e) {
      console.error(`(live freight unavailable, using fallback: ${e.message})`);
    }
  }
  const rows = BUNDLES.map(b => evaluate(b, packageCosts)).sort((a, b) => b.contrib - a.contrib);
  const md = buildMarkdown(rows, { packageCosts, average, live });
  if (args.includes('--write')) {
    const out = join(ROOT, 'docs', 'bundle-economics.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    console.error(`wrote ${out}`);
  }
  console.log(md);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
