#!/usr/bin/env node
/**
 * DAILY_THEME_CLAIMS_GATE — 12:45 UTC, DETECT ONLY.
 *
 * `lib/supply-duration.js` guards BUNDLE copy. Nothing guarded a theme template,
 * and on 2026-09-05 an audit of all 8 landing pages found FOUR overstated supply
 * claims live (cream and the sensitive-skin set at 2.80x, lotion 1.87x,
 * toothpaste 1.24x), two pages claiming a duration for products with no measured
 * rate, and `coconut-soap` pointing at a templateSuffix whose asset was not on
 * the theme — a 200 that silently served the default product template. All of it
 * had been live for months because nobody runs an audit nobody scheduled.
 *
 * IT CAN NEVER WRITE. There is no --apply branch, no theme mutation, and
 * `--apply` / `--fix` are refused with exit 64. `scripts/update-theme-asset.mjs`
 * exists and can create assets now, so this file is one careless edit away from a
 * nightly self-healing theme push — which would rewrite live customer-facing copy
 * unattended, on a surface where the correct fix is a judgement about what the
 * product actually does. A test counts the child processes to pin that it spawns
 * nothing.
 *
 * Reported through ONE deferred notify(); the wrapper always exits 0 so cron has
 * nothing to say the 5 AM digest does not. The single exception is refusing a
 * write flag, which is a usage error rather than a finding.
 *
 *   exit 0  clean                          success
 *   exit 1  a claim overstates / is incoherent / has no evidence   error
 *   exit 2  a product's template is MISSING from the theme         error
 *   exit 3  a template could not be read                           error
 *
 * Nothing here is routine. Unlike DAILY_POST_META_GATE — where the box being
 * ahead of git is the normal state and is reported quietly — every finding on
 * this surface is a live page telling a customer something untrue.
 */
import { getMainThemeId, getThemeAssetRaw, listThemeAssets, shopifyGraphQL } from '../lib/shopify.js';
import { parseDurationClaim, auditClaim, findMissingTemplates, summarize, branchForHandle, stripLiquidComments } from '../lib/theme-claim-audit.js';
import { bindingDuration } from '../lib/supply-duration.js';
import { notify } from '../lib/notify.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const strings = (n, o = []) => {
  if (typeof n === 'string') o.push(n);
  else if (Array.isArray(n)) n.forEach((x) => strings(x, o));
  else if (n && typeof n === 'object') Object.values(n).forEach((x) => strings(x, o));
  return o;
};

export async function audit() {
  const { rates } = JSON.parse(readFileSync(join(ROOT, 'config', 'consumption-rates.json'), 'utf8'));
  const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));

  // A BUNDLE has no rates entry and never should — its duration is bindingDuration
  // over its components, the minimum, because a box lasts as long as the first thing
  // in it runs out. Looking a bundle up in `rates` reports "unevidenced" for a
  // product whose evidence is simply computed somewhere else.
  const rateFor = (handle) => {
    if (rates[handle]?.daysPerUnit != null) return rates[handle].daysPerUnit;
    const b = bundles.find((x) => x.handle === handle);
    if (!b) return null;
    try { return bindingDuration(b.variants[0].components).days ?? null; } catch { return null; }
  };
  const themeId = await getMainThemeId();
  const assetKeys = (await listThemeAssets(themeId)).map((a) => a.key);

  const q = await shopifyGraphQL(
    '{ products(first:100){ nodes { handle status templateSuffix variants(first:1){ nodes { price } } } } }',
  );
  const products = q.products.nodes;
  const missing = findMissingTemplates(products, assetKeys);

  const bySuffix = {};
  for (const p of products) if (p.templateSuffix) (bySuffix[p.templateSuffix] ??= []).push(p);

  const claims = [];
  const unreadable = [];
  for (const key of assetKeys.filter((k) => /^templates\/product\.landing/.test(k))) {
    let tpl;
    try { tpl = JSON.parse((await getThemeAssetRaw(themeId, key)).value); }
    catch (err) { unreadable.push({ key, error: err.message }); continue; }

    const suffix = key.replace('templates/product.', '').replace('.json', '');
    // One template can serve several products; judge the claim against EACH, because
    // landing-page-liquid-soap served both an 8oz bottle and a 32oz refill off one
    // hardcoded line describing the 8oz.
    for (const p of bySuffix[suffix] ?? []) {
      const price = Number(p.variants.nodes[0]?.price) || null;
      for (const raw of strings(tpl)) {
        // Resolve per-product Liquid branches first, or one product's copy is
        // reported as another product's defect.
        const s = branchForHandle(stripLiquidComments(raw), p.handle);
        const claim = parseDurationClaim(s);
        if (!claim) continue;
        const r = auditClaim({ claim, rateDays: rateFor(p.handle), price });
        if (r.verdict !== 'ok' && r.verdict !== 'no-claim') {
          claims.push({ ...r, key, handle: p.handle, text: claim.text.slice(0, 140) });
        }
      }
    }
  }
  return summarize({ missing, claims, unreadable });
}

function render(s) {
  const lines = [];
  if (s.missing.length) {
    lines.push(`${s.missing.length} product(s) point at a template the theme does not have.`);
    lines.push('Shopify serves the DEFAULT product template and still returns 200, so the page looks fine and is not.');
    for (const m of s.missing) lines.push(`  · ${m.handle} → ${m.expected}`);
    lines.push('');
  }
  if (s.bad.length) {
    lines.push(`${s.bad.length} supply claim(s) not supported by config/consumption-rates.json:`);
    for (const c of s.bad) lines.push(`  · [${c.verdict}] ${c.handle}: ${c.detail}\n      "${c.text}"`);
    lines.push('');
  }
  if (s.unreadable.length) {
    lines.push(`${s.unreadable.length} template(s) could not be read — unchecked, which is worse than known-bad:`);
    for (const u of s.unreadable) lines.push(`  · ${u.key}: ${u.error}`);
    lines.push('');
  }
  if (!lines.length) lines.push('Every landing-page supply claim is supported, and every templateSuffix resolves.');
  lines.push('Fix with scripts/update-theme-asset.mjs put <key> <file> --apply. This gate never writes.');
  return lines.join('\n');
}

async function main() {
  if (process.argv.slice(2).some((a) => ['--apply', '--fix', '--write'].includes(a))) {
    console.error('check-theme-claims-drift is DETECT ONLY. It has no write mode; fixing a claim is a judgement about the product.');
    process.exit(64);
  }
  let s;
  try {
    s = await audit();
  } catch (err) {
    await notify({ agent: 'theme-claims-gate', status: 'error',
      subject: 'Theme claims gate could not run',
      body: `The gate itself failed, so nothing was checked:\n${err.message}` });
    console.error(err);
    return;
  }
  const body = render(s);
  console.log(body);
  await notify({
    agent: 'theme-claims-gate',
    status: s.code === 0 ? 'success' : 'error',
    subject: s.code === 0
      ? 'Theme claims: all supply claims supported'
      : `Theme claims: ${s.missing.length} missing template(s), ${s.bad.length} unsupported claim(s)`,
    body,
  });
}

if (isDirectRun(import.meta.url)) await main();
