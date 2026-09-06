#!/usr/bin/env node
//
// DAILY DRIFT GATE for the product templates — DETECT ONLY.
//
//   node scripts/check-pdp-template-drift.mjs
//
// WHY THIS EXISTS
//   `scripts/build-product-templates.mjs` is run by whoever happens to be
//   changing a template. Between those runs the CATALOGUE moves underneath it,
//   and twice in one week that silently invalidated a decision the manifest had
//   already recorded correctly:
//
//     · PR #805 gave the hand soap a quantity ladder, which instantly made its
//       `complete-the-routine` card redundant — the card cross-sells the 4-pack
//       the new ladder now sells as a tier. It shipped that way and nobody knew
//       until an operator spotted the same shape on the bar soap.
//     · Recurpay plan 11152263 attached a selling plan to foam-soap-refill-32oz,
//       turning `subscribable: false` on that template into a WITHHELD true
//       claim within 24 hours of it being written.
//
//   Neither is visible in a diff, because in both cases no repo file changed.
//
// IT CAN NEVER FIX ANYTHING
//   `--apply` is refused with exit 64, and the only child process this file
//   spawns is the builder's DRY run (a test counts them). The builder writes to
//   the live theme, so a gate that could pass `--apply` would be one careless
//   edit away from rewriting nine live product templates every morning —
//   including the `insertAfter` and `dropSections` fields, the two that change
//   what a shopper sees.
//
// SEVERITY
//   exit 2 · a stale card or a wrong subscription claim → the case a human needs.
//            A false claim is live copy that is not true; a withheld one is a
//            real benefit the page is not stating.
//   exit 1 · live drifted from the sources, or a manifest entry names a template
//            no product uses. Reported quietly: a theme-editor edit is a
//            legitimate thing for a human to have done, and a daily failure row
//            for it is how a Failures block stops being read.
//
// Always exits 0 so cron has nothing to say the digest does not — the single
// exception is refusing a write flag, which is a usage error, not a finding.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { MANIFEST, templateNick } from './build-product-templates.mjs';
import { staleRedundantCards, subscribableDrift, orphanTemplates, summarize, renderReport, fileForSuffix } from '../lib/pdp-template-drift.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Frozen. There is no argument this gate may pass that writes anything. */
export const BUILDER_ARGS = Object.freeze([]);

/** Read the committed templates — the builder's own output, and what live should match. */
export function readTemplates() {
  const out = {};
  for (const file of Object.keys(MANIFEST)) {
    out[file] = JSON.parse(readFileSync(join(ROOT, 'theme', 'templates', file), 'utf8'));
  }
  return out;
}

/**
 * Which products use each template, and which of them carry a selling plan.
 *
 * A DRAFT product is excluded: it serves nobody, so it can neither justify a
 * subscription claim nor make a template an orphan.
 */
export async function fetchCatalogue() {
  const { getAccessToken } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');
  const token = await getAccessToken();
  const env = Object.fromEntries(
    readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
  const res = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ products(first: 250, query: "status:active") { nodes {
      handle templateSuffix sellingPlanGroups(first: 1) { nodes { id } } } } }` }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify: ${JSON.stringify(json.errors).slice(0, 200)}`);

  const productsByFile = {};
  const plansByHandle = {};
  for (const p of json.data.products.nodes) {
    plansByHandle[p.handle] = p.sellingPlanGroups.nodes.length > 0;
    if (!p.templateSuffix) continue;
    (productsByFile[fileForSuffix(p.templateSuffix)] ||= []).push(p.handle);
  }
  return { productsByFile, plansByHandle };
}

/** The builder's DRY run, parsed for which templates it would change. */
export function builderDryRun(run = () => execFileSync(process.execPath,
  [join(ROOT, 'scripts', 'build-product-templates.mjs'), ...BUILDER_ARGS],
  { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })) {
  let stdout = '';
  try { stdout = run(); } catch (e) { stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  const changes = [];
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(product\.[\w.-]+\.json)$/);
    if (!m) continue;
    const notes = (lines[i + 1] ?? '').trim();
    changes.push({ file: m[1], notes: notes ? notes.split(', ') : ['(unspecified)'] });
  }
  return { changes, stdout };
}

if (isDirectRun(import.meta.url)) {
  if (process.argv.includes('--apply')) {
    console.error('check-pdp-template-drift.mjs never writes. Run scripts/build-product-templates.mjs --apply yourself.');
    process.exit(64);
  }

  let result;
  let fatal = null;
  try {
    const templates = readTemplates();
    const { productsByFile, plansByHandle } = await fetchCatalogue();
    result = summarize({
      stale: staleRedundantCards(templates),
      drift: subscribableDrift(productsByFile, plansByHandle, templates),
      orphans: orphanTemplates(productsByFile),
      builderChanges: builderDryRun().changes,
    });
  } catch (e) {
    fatal = e;
    result = summarize({});
  }

  const body = fatal
    ? `The PDP template drift gate could not run: ${fatal.message}`
    : renderReport(result);
  console.log(body);

  const status = fatal || result.code === 2 ? 'error' : 'success';
  const subject = fatal
    ? 'PDP templates: gate could not run'
    : result.code === 0
      ? 'PDP templates: manifest and catalogue agree'
      : `PDP templates: ${result.stale.length} stale card(s), ${result.drift.length} claim drift, ${result.builderChanges.length} live drift`;

  await notify({ subject, body, status, agent: 'pdp-template-drift' });
  process.exit(0);
}
