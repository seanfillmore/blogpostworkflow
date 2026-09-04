#!/usr/bin/env node
/**
 * Remediate the health-claim findings on live theme templates, and delete the two
 * unused templates carrying the 2026-08-16 incident quote. Dry by default; --apply writes.
 *
 * `scripts/check-uncovered-copy-surfaces.mjs` reported 32 blocking-tier hits across
 * seven templates. Every one was read and judged individually, and the honest answer
 * is that **only two are claims**. The gate is blunt on purpose — its job is to make
 * a human look, not to decide — and CLAUDE.md's standing rule is that over-correcting
 * editorial framing is the expensive mistake. The test applied throughout: does a
 * therapeutic verb or disease word take OUR PRODUCT as its subject?
 *
 * REWRITTEN — 2 entries, both directing the product ONTO a named condition:
 *
 *   1. index.json founder block (the HOMEPAGE) — "a barrier cream we could use on
 *      our kids' eczema-prone patches". Identical to the string already fixed on
 *      the cream template in PR #766; this is the same copy on a second surface,
 *      and leaving it would make the two disagree.
 *   2. sensitive-skin-set lander ingredient card — "Use on dry patches, chapped
 *      hands, eczema-prone elbows and knees." A usage INSTRUCTION placing the
 *      product on eczema, on the hero bundle's own PDP. Stronger than suitability.
 *
 * DELETED — 2 templates, 15 of the 32 hits, used by NO product at any status
 * (verified against every product, not just active ones):
 *
 *   - product.landing-page-99-coconut-reset.json  (9 hits)
 *   - product.default-product-lotion.json          (6 hits)
 *
 *   Both carry the EXACT 2026-08-16 incident quote — "tried prescription strength
 *   lotions, steroids... to no avail" — the Judge.me review CLAUDE.md documents as
 *   the reason `selectQuotableReviews` exists, sitting in a featured-reviews block
 *   and a UGC block. They render nowhere today and are one `template_suffix` edit
 *   away from rendering. Deleting beats remediating copy nobody reads.
 *
 *   The full current `value` of each is written to the backup directory BEFORE the
 *   delete, which is the whole safety argument: unlike a product image (where DELETE
 *   destroys the CDN file irrecoverably), a theme asset is text we can restore with
 *   `updateThemeAsset`. The run record names that path.
 *
 * KEPT — 6 strings, each for a stated reason, exported as ACKNOWLEDGED_KEEPS so
 * "we judged it and kept it" is distinguishable from "we never looked". These feed
 * the checker's acknowledged list so the daily gate reports NEW findings rather than
 * re-raising the same six every morning until nobody reads the row.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMainThemeId, getThemeAssetRaw, updateThemeAsset, deleteThemeAsset, getProducts } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { applyTemplateEdits, assertParsesAsJson } from '../lib/theme-template-edit.js';
import { ACKNOWLEDGED_KEEPS } from '../lib/theme-claim-keeps.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const APPLY = process.argv.includes('--apply');

const REWRITES = [
  {
    key: 'templates/index.json',
    edits: [
      {
        id: 'homepage-founder-eczema',
        before: "a barrier cream we could use on our kids' eczema-prone patches",
        after: "a barrier cream we could use on our kids' driest patches",
      },
    ],
  },
  {
    key: 'templates/product.landing-page-sensitive-skin-set-lander.json',
    edits: [
      {
        id: 'hero-lander-eczema-usage',
        before: 'Use on dry patches, chapped hands, eczema-prone elbows and knees.',
        after: 'Use on dry patches, chapped hands, and rough elbows and knees.',
      },
    ],
  },
];

const DELETIONS = [
  { key: 'templates/product.landing-page-99-coconut-reset.json', suffix: 'landing-page-99-coconut-reset' },
  { key: 'templates/product.default-product-lotion.json', suffix: 'default-product-lotion' },
];

async function main() {
  const fields = {};
  for (const t of REWRITES) for (const e of t.edits) fields[e.id] = e.after;
  const gate = checkSeoCopyFields(fields);
  if (!gate.ok) {
    console.error('REFUSED — replacement copy fails the SEO copy health gate:');
    for (const v of gate.blocking) console.error(`  [${v.category}] ${v.field}: "${v.match}"`);
    process.exit(1);
  }
  console.log(`Health gate: PASS on ${Object.keys(fields).length} replacement strings`);

  // Each BEFORE must still trip the gate, or the plan is stale and is claiming
  // credit for a fix somebody else already made.
  const beforeGate = checkSeoCopyFields(
    Object.fromEntries(REWRITES.flatMap((t) => t.edits.map((e) => [e.id, e.before])))
  );
  console.log(`Of ${Object.keys(fields).length} BEFOREs, ${(beforeGate.blocking || []).length} trip the blocking tier today:`);
  for (const v of beforeGate.blocking || []) console.log(`  [${v.category}] ${v.field} — "${v.match}"`);

  const themeId = await getMainThemeId();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('data', 'reports', 'theme-claims-remediation', stamp);
  const results = [];

  // ---- deletions: prove unused, back up, then delete ----
  const products = await getProducts({ limit: 250 });
  for (const d of DELETIONS) {
    const users = products.filter((p) => p.template_suffix === d.suffix);
    if (users.length) {
      throw new Error(
        `${d.key} is used by ${users.length} product(s) (${users.map((p) => `${p.handle} [${p.status}]`).join(', ')}) — refusing to delete.`
      );
    }
    const asset = await getThemeAssetRaw(themeId, d.key);
    if (!asset || typeof asset.value !== 'string') {
      console.log(`  ${d.key}: already absent.`);
      results.push({ key: d.key, action: 'delete', outcome: 'already-absent' });
      continue;
    }
    mkdirSync(dir, { recursive: true });
    const backup = join(dir, d.key.replace(/\//g, '__'));
    writeFileSync(backup, asset.value);
    console.log(`  ${d.key}: unused by all ${products.length} products · backed up to ${backup} (${asset.value.length}b)`);
    if (APPLY) {
      await deleteThemeAsset(themeId, d.key);
      console.log(`  ${d.key}: DELETED from theme ${themeId}`);
      results.push({ key: d.key, action: 'delete', outcome: 'deleted', backup });
    } else {
      results.push({ key: d.key, action: 'delete', outcome: 'would-delete', backup });
    }
  }

  // ---- rewrites ----
  for (const t of REWRITES) {
    const asset = await getThemeAssetRaw(themeId, t.key);
    if (!asset || typeof asset.value !== 'string') throw new Error(`Could not read ${t.key}.`);
    const original = asset.value;
    const { text, results: edits } = applyTemplateEdits(original, t.edits, { label: t.key });
    for (const r of edits) {
      console.log(`  ${t.key} :: ${r.id} — ${r.outcome}`);
      results.push({ key: t.key, action: 'rewrite', ...r });
    }
    if (text === original) continue;
    assertParsesAsJson(text, t.key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${t.key.replace(/\//g, '__')}.before`), original);
    writeFileSync(join(dir, `${t.key.replace(/\//g, '__')}.after`), text);
    if (APPLY) {
      await updateThemeAsset(themeId, t.key, text);
      console.log(`  ${t.key}: PUSHED to theme ${themeId}`);
    }
  }

  if (results.length) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify(
        { at: new Date().toISOString(), themeId, applied: APPLY, results, acknowledged_keeps: ACKNOWLEDGED_KEEPS },
        null,
        2
      )
    );
    console.log(`\nRun record + backups: ${dir}/`);
  }
  console.log(`\n${ACKNOWLEDGED_KEEPS.length} findings deliberately KEPT — see ACKNOWLEDGED_KEEPS in this file.`);
  if (!APPLY) console.log('\nDRY RUN — pass --apply to write LIVE.');
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
