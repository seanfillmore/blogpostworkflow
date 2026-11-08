#!/usr/bin/env node
/**
 * Shopping-only title overrides for items whose feed title is wrong, without touching
 * Shopify or the page's SEO title.
 *
 *   node scripts/sync-shopping-title-overrides.mjs            # dry run
 *   node scripts/sync-shopping-title-overrides.mjs --apply    # write + link
 *   node scripts/sync-shopping-title-overrides.mjs --unlink --apply   # undo (titles revert)
 *
 * Why (Sean, 2026-11-08, option a): the Shopify Google app builds a single's title from
 * the product's SEO title (`global.title_tag` "Fresh Mint Coconut Oil Toothpaste – Real
 * Skin Care") plus the variant, so the All Natural and Cinnamon Spice toothpastes showed
 * in Shopping as "Fresh Mint …". The SEO title is also the organic page title of a page
 * earning orders, so it is left alone and the fix lives in Merchant Center only.
 *
 * The PATCH mask is `primaryProductDataSource.defaultRule`: the longer
 * `...defaultRule.takeFromDataSources` returns 200 and changes nothing (2026-11-08).
 *
 * How: a SUPPLEMENTAL data source holds { offerId, title } for each override, and is
 * linked AHEAD of the Shopify app's own data in that primary source's default rule, so
 * its title wins and every other attribute still comes from Shopify. Unlinking restores
 * the default rule to the Shopify app alone.
 *
 * Config: config/shopping-title-overrides.json. Titles are gated (commercial health-claim
 * gate, no dashes, at most 150 characters) before anything is sent.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://merchantapi.googleapis.com';
export const CONFIG_PATH = join(ROOT, 'config/shopping-title-overrides.json');

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every problem with the configured overrides; empty means they may be sent. */
export function overrideProblems(config) {
  const out = [];
  const seen = new Set();
  for (const o of config.overrides || []) {
    if (!/^[A-Za-z0-9_]+$/.test(o.offerId || '')) out.push(`bad offerId ${o.offerId}`);
    if (seen.has(o.offerId)) out.push(`duplicate offerId ${o.offerId}`);
    seen.add(o.offerId);
    const t = String(o.title || '');
    if (!t || t.length > 150) out.push(`${o.offerId}: title length ${t.length}`);
    if (/[–—]/.test(t)) out.push(`${o.offerId}: dash in "${t}"`);
    if (/whiten|antiperspirant/i.test(t)) out.push(`${o.offerId}: forbidden term in "${t}"`);
    if (!checkSeoCopyFields({ title: t }).ok) out.push(`${o.offerId}: claim gate on "${t}"`);
  }
  return out;
}

/** The default rule's source list with the supplemental linked first (highest priority), or removed. */
export function linkedRule(takeFrom, supplementalName, { unlink = false } = {}) {
  const rest = (takeFrom || []).filter((s) => s.supplementalDataSourceName !== supplementalName);
  if (unlink) return rest.length ? rest : [{ self: true }];
  return [{ supplementalDataSourceName: supplementalName }, ...(rest.length ? rest : [{ self: true }])];
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const apply = process.argv.includes('--apply');
  const unlink = process.argv.includes('--unlink');
  const config = loadConfig();
  const problems = overrideProblems(config);
  if (problems.length) { console.error('Refused:\n  ' + problems.join('\n  ')); process.exit(1); }

  const { getAccessToken } = await import('../lib/google-ads.js');
  const token = await getAccessToken();
  const account = `accounts/${config.merchantId}`;
  const primaryName = `${account}/dataSources/${config.primaryDataSourceId}`;
  const primary = await api(token, 'GET', `datasources/v1/${primaryName}`);
  const sources = (await api(token, 'GET', `datasources/v1/${account}/dataSources?pageSize=250`)).dataSources || [];
  let supp = sources.find((s) => s.displayName === config.supplementalName);

  console.log(`primary: ${primary.displayName} (${config.primaryDataSourceId}), rule now ${JSON.stringify(primary.primaryProductDataSource.defaultRule.takeFromDataSources)}`);
  console.log(`supplemental: ${supp ? supp.name : '(will create) ' + config.supplementalName}`);
  if (!unlink) for (const o of config.overrides) console.log(`  ${o.offerId} -> "${o.title}"`);
  if (!apply) { console.log('\nDry run. Re-run with --apply.'); return; }

  if (unlink) {
    if (!supp) { console.log('nothing linked'); return; }
    const rule = linkedRule(primary.primaryProductDataSource.defaultRule.takeFromDataSources, supp.name, { unlink: true });
    await api(token, 'PATCH', `datasources/v1/${primaryName}?updateMask=primaryProductDataSource.defaultRule`, { primaryProductDataSource: { defaultRule: { takeFromDataSources: rule } } });
    console.log('unlinked; the Shopify app titles return on the next Merchant Center processing pass');
    return;
  }

  if (!supp) {
    supp = await api(token, 'POST', `datasources/v1/${account}/dataSources`, {
      displayName: config.supplementalName,
      // An API-fed supplemental source carries no feed label or language of its own:
      // each product input states them (Merchant API refuses them here, HTTP 400).
      supplementalProductDataSource: {},
    });
    console.log(`created ${supp.name}`);
  }
  for (const o of config.overrides) {
    await api(token, 'POST', `products/v1/${account}/productInputs:insert?dataSource=${encodeURIComponent(supp.name)}`, {
      offerId: o.offerId, contentLanguage: config.contentLanguage, feedLabel: config.feedLabel,
      productAttributes: { title: o.title },
    });
    console.log(`  wrote ${o.offerId}`);
  }
  const rule = linkedRule(primary.primaryProductDataSource.defaultRule.takeFromDataSources, supp.name);
  await api(token, 'PATCH', `datasources/v1/${primaryName}?updateMask=primaryProductDataSource.defaultRule`, { primaryProductDataSource: { defaultRule: { takeFromDataSources: rule } } });
  const after = await api(token, 'GET', `datasources/v1/${primaryName}`);
  console.log(`rule now ${JSON.stringify(after.primaryProductDataSource.defaultRule.takeFromDataSources)}`);
  console.log('Merchant Center applies the override on its next processing pass (usually minutes, up to a few hours).');
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
