#!/usr/bin/env node
/**
 * One-time switch of the announcement bar's soap line when the standing offer changes
 * (Sean, 2026-11-07: "Keep any order"; the bar recommendation was one switch, no revert).
 *
 *   node scripts/soap-announcement-switch.mjs            # dry run: prints the change
 *   node scripts/soap-announcement-switch.mjs --apply    # writes the live header group
 *
 * Until 2026-11-27T08:00Z the live discount is "2 free Pure Unscented bars on $60+" and the
 * bar says so. From then on it is "3 free Pure Unscented bars with any order", with no end
 * date (scripts/unscented-bar-push.mjs). The theme's announcement bar cannot change by date
 * on its own, so cron runs this once (DATED_SOAP_ANNOUNCEMENT in scripts/setup-cron.sh).
 *
 * It REFUSES before the switch instant (the bar would promise an offer that is not live
 * yet) and does nothing after 2026-12-31, which is what makes the cron line's missing year
 * harmless: it fires again in 2027 and exits. Idempotent: a second run changes nothing.
 * Touches one block (`unscented-bars-60`) and nothing else; the whole file is re-serialized
 * with Shopify's own escaping and the round trip is proven on the unchanged file first.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SWITCH_AT = Date.parse('2026-11-27T08:00:00Z');
export const LAST_DAY = Date.parse('2026-12-31T23:59:59Z');
export const BLOCK = 'unscented-bars-60';
export const TEXT = '3 free Pure Unscented soap bars with any order';
export const TEXT_MOBILE = '3 free soap bars with any order';

export const serialize = (head, obj) => head + JSON.stringify(obj, null, 2).replace(/\//g, '\\/') + '\n';

/** Pure: decide and apply. Returns { action, out? }. */
export function plan(raw, now) {
  if (now < SWITCH_AT) return { action: 'refuse-early' };
  if (now > LAST_DAY) return { action: 'expired' };
  const m = raw.match(/^\/\*[\s\S]*?\*\/\s*/);
  const head = m ? m[0] : '';
  const obj = JSON.parse(raw.slice(head.length));
  if (serialize(head, obj) !== raw) return { action: 'refuse-roundtrip' };
  const b = obj.sections?.['announcement-bar']?.blocks?.[BLOCK];
  if (!b) return { action: 'refuse-missing-block' };
  if (b.settings.text === TEXT && b.settings.text_on_mobile === TEXT_MOBILE) return { action: 'already-done' };
  b.settings.text = TEXT;
  b.settings.text_on_mobile = TEXT_MOBILE;
  return { action: 'switch', out: serialize(head, obj) };
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const { getAccessToken } = await import('../lib/shopify.js');
  const { API_VERSION } = await import('../lib/shopify-api-version.js');
  const { notify } = await import('../lib/notify.js');
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const H = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };
  const B = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}`;
  const theme = (await (await fetch(`${B}/themes.json`, { headers: H })).json()).themes.find((t) => t.role === 'main');
  const key = 'sections/header-group.json';
  const get = async () => (await (await fetch(`${B}/themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: H })).json()).asset.value;

  const p = plan(await get(), Date.now());
  console.log(`announcement switch: ${p.action}`);
  if (p.action !== 'switch') {
    if (p.action.startsWith('refuse') && p.action !== 'refuse-early') {
      await notify({ subject: `Soap announcement switch refused: ${p.action}`, body: 'The announcement bar was not changed. Check sections/header-group.json by hand.', status: 'error', category: 'storefront' });
    }
    return;
  }
  if (!APPLY) { console.log('dry run: would set the soap line to the any-order offer'); return; }
  const r = await fetch(`${B}/themes/${theme.id}/assets.json`, { method: 'PUT', headers: H, body: JSON.stringify({ asset: { key, value: p.out } }) });
  if (!r.ok) throw new Error(`PUT ${key} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  let ok = false;
  for (let i = 0; i < 6 && !ok; i += 1) { ok = plan(await get(), Date.now()).action === 'already-done'; if (!ok) await new Promise((res) => setTimeout(res, 1500)); }
  console.log(ok ? 'switched and verified' : 'WRITE DID NOT VERIFY');
  await notify({
    subject: ok ? 'Announcement bar now says: 3 free soap bars with any order' : 'Soap announcement switch did not verify',
    body: ok ? `Live announcement bar soap line set to "${TEXT}".` : 'The PUT succeeded but the read-back differs. Check the announcement bar by hand.',
    status: ok ? 'success' : 'error', category: 'storefront',
  });
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
