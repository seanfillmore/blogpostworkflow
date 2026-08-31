#!/usr/bin/env node
/**
 * The 90-Day Coconut Reset lander — copy plan. DRY BY DEFAULT.
 *
 *   node scripts/build-coconut-reset-lander.mjs            # show the diff
 *   node scripts/build-coconut-reset-lander.mjs --apply    # write it
 *
 * ── WHY A PLAN AND NOT AN EDIT ──────────────────────────────────────────────
 * This lander's copy does NOT live in the theme. It lives in a `bundle_lander`
 * METAOBJECT (gid 220166586538) that `sections/hero-landing-section.liquid`
 * reads via `product.metafields.bundle.lander.value`. The template's own block
 * settings are a stale fallback — theirs still says "1 Body Cream" while the
 * metaobject says 3, which is why the live hero renders correctly and the file
 * on disk looks wrong.
 *
 * That matters for the workflow: a metaobject edit is DATA, not theme code, so
 * `shopify theme dev` cannot preview it — it renders against live store data and
 * would show the change to customers the moment it is written. There is no
 * unpublished copy of a metaobject. So this follows the pattern the repo already
 * uses for live copy changes (scripts/remediate-*.js): a hand-reviewed fixed
 * plan, dry by default, every AFTER re-gated, the whole object backed up before
 * any write, and a drift guard that SKIPS rather than overwrites when live
 * matches neither BEFORE nor AFTER.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * The live page states the box contents three times. Twice it says "3 Body
 * Creams". The third is the tab literally named "What's Inside", and it says
 * "1 Body Cream (4oz)".
 *
 * A customer who opens the tab that answers "what do I get" is told they get one
 * third of the cream they actually get — understating the box by two 4oz creams,
 * $56 of list value against a $121 price. It contradicts the same page twice
 * over. This is a correctness fix before it is a marketing one, and it is the
 * highest-value change on the page.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
export const METAOBJECT_ID = 'gid://shopify/Metaobject/220166586538';

/**
 * Every change, with the reason it is being made.
 *
 * `kind` is asserted by a test so the two classes cannot blur:
 *   'correctness' — the page states something untrue about the product.
 *   'positioning' — a judgement from the competitor teardown + the spec.
 */
export const PLAN = Object.freeze([
  {
    id: 'tabs-whats-inside-cream-count',
    kind: 'correctness',
    field: 'tabs',
    // A JSON field: the edit is a literal substring swap inside the serialized
    // value, so the other three tabs cannot be disturbed by a re-serialization.
    before: '3 full-size Body Lotions (8oz) and 1 Body Cream (4oz)',
    after: '3 full-size Body Lotions (8oz) and 3 Body Creams (4oz)',
    reason:
      'The box contains 3 creams (bundle.components qty [3,3]; value_stack row "3 Body Lotions + 3 Body Creams" '
      + '= 3x$30 + 3x$28 = $174 = the compare-at). The tab that answers "what do I get" said 1, understating the '
      + 'box by two creams and $56 of list value, and contradicting the hero and buy box on the same page.',
  },
  {
    id: 'subheading-count-and-lead',
    kind: 'positioning',
    field: 'subheading',
    before:
      'The complete routine in one box — three daily lotions and an overnight cream — for skin that finally '
      + 'stays soft. Ninety days. Never run out.',
    after:
      'Three lotions and three creams — eight ingredients between them, and a completely fragrance-free option. '
      + 'Ninety days of the same two things. Never run out.',
    reason:
      'Two jobs. (1) "an overnight cream" is the same understatement as the tab, softer: singular where the box '
      + 'holds three. (2) The spec leads on sensitive-skin SIMPLICITY rather than scent — a deliberate divergence '
      + 'from the strongest competitor pattern, because that pattern is validated for scent-products and half this '
      + 'SKU is Pure Unscented. The ingredient count is the numeric spec the teardown found in 3 of 4 brands, and '
      + 'it is verified: the Ingredients tab lists 6 for the lotion plus beeswax and palm stearic for the cream, '
      + 'and the stats block already publishes "8 ingredients across both formulas".',
  },
]);

/** Template-file fallbacks that still carry the old count. */
export const TEMPLATE_FIXES = Object.freeze([
  {
    id: 'hero-bullet-1-fallback',
    file: 'theme/templates/product.bundle-landing.json',
    before: '3 full-size Body Lotions + 1 Body Cream — a complete 90-day routine',
    after: '3 full-size Body Lotions + 3 Body Creams — a complete 90-day routine',
    reason:
      'Inert while the metaobject resolves, because the section prefers it. But it is the value that renders if '
      + 'the metaobject is ever cleared or fails to load, so leaving it is leaving the defect armed.',
  },
]);

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = -1;
  while ((i = haystack.indexOf(needle, i + 1)) !== -1) n += 1;
  return n;
}

/**
 * Decide what to do with one entry against the live value.
 * @returns {'apply'|'already-applied'|'skip-drift'}
 */
export function classifyEntry(liveValue, entry) {
  if (occurrences(liveValue, entry.before) > 0) return 'apply';
  if (occurrences(liveValue, entry.after) > 0) return 'already-applied';
  return 'skip-drift';
}

/** Every AFTER must clear the health gate before it can be written. */
export function gatePlan(plan = PLAN) {
  const failures = [];
  for (const e of plan) {
    const r = checkSeoCopyFields({ [`${e.id} (${e.field})`]: e.after });
    if (!r.ok) failures.push({ id: e.id, problems: r.claims ?? r.problems ?? r });
  }
  return { ok: failures.length === 0, failures };
}

async function main(argv) {
  const APPLY = argv.includes('--apply');

  const gate = gatePlan();
  if (!gate.ok) {
    console.error('REFUSED: an AFTER trips the health-claim gate.');
    for (const f of gate.failures) console.error(`  ${f.id}: ${JSON.stringify(f.problems).slice(0, 300)}`);
    return 1;
  }
  console.log(`health gate: all ${PLAN.length} rewrites clear\n`);

  const { shopifyGraphQL } = await import('../lib/shopify.js');
  const res = await shopifyGraphQL(
    `{ metaobject(id:"${METAOBJECT_ID}"){ handle fields { key value type } } }`,
  );
  const fields = Object.fromEntries(res.metaobject.fields.map((f) => [f.key, f]));

  if (APPLY) {
    const dir = join(ROOT, 'data', 'reports', 'coconut-reset-lander', 'backups');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `metaobject-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(path, `${JSON.stringify(res.metaobject, null, 2)}\n`);
    console.log(`backed up the whole metaobject -> ${path}\n`);
  }

  const writes = [];
  for (const e of PLAN) {
    const live = fields[e.field]?.value;
    if (live === undefined) { console.log(`  MISSING FIELD  ${e.id} (${e.field})`); continue; }
    const verdict = classifyEntry(live, e);
    console.log(`  ${verdict.toUpperCase().padEnd(16)} ${e.id}`);
    if (verdict === 'skip-drift') {
      console.log('      live matches neither BEFORE nor AFTER — refusing to overwrite an edit nobody here made');
      continue;
    }
    if (verdict === 'already-applied') continue;
    console.log(`      - ${e.before.slice(0, 110)}`);
    console.log(`      + ${e.after.slice(0, 110)}`);
    writes.push({ key: e.field, value: live.split(e.before).join(e.after) });
  }

  console.log('\n--- template fallbacks ---');
  for (const t of TEMPLATE_FIXES) {
    const p = join(ROOT, t.file);
    let src;
    try { src = readFileSync(p, 'utf8'); } catch { console.log(`  MISSING  ${t.file}`); continue; }
    const verdict = classifyEntry(src, t);
    console.log(`  ${verdict.toUpperCase().padEnd(16)} ${t.id}`);
    if (verdict === 'apply' && APPLY) {
      writeFileSync(p, src.split(t.before).join(t.after));
      console.log('      written (local file only — upload is a separate, reviewed step)');
    }
  }

  if (!APPLY) {
    console.log(`\n${writes.length} metaobject field(s) would change. Re-run with --apply.`);
    console.log('NOTE: a metaobject edit is LIVE immediately — there is no unpublished copy to preview.');
    return 0;
  }
  if (!writes.length) { console.log('\nnothing to write.'); return 0; }

  const m = await shopifyGraphQL(
    `mutation($id:ID!, $fields:[MetaobjectFieldInput!]!){
       metaobjectUpdate(id:$id, metaobject:{fields:$fields}){ userErrors { field message } } }`,
    { id: METAOBJECT_ID, fields: writes },
  );
  if (m.metaobjectUpdate.userErrors.length) {
    console.error('FAILED:', m.metaobjectUpdate.userErrors);
    return 1;
  }
  console.log(`\nwrote ${writes.length} field(s). Verify the rendered page before calling this done.`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
