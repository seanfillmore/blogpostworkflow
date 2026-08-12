#!/usr/bin/env node
/**
 * Gate A: everything that must be true before a single ad dollar is spent.
 *
 *   node scripts/giveaway/verify-launch.mjs
 *
 * Exits non-zero on any failure. Success logs lie; this checks the live surfaces
 * (the storefront render, not the Admin API record — see the note above the
 * rules-clause checks below for why that distinction matters on this store).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
const UA = { 'User-Agent': 'Mozilla/5.0' };
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures.push(label); };

// A network failure (DNS not resolving, connection refused, timeout) is a real
// launch blocker, not a script bug -- turn it into a labeled FAIL with the
// underlying reason instead of letting an uncaught rejection crash the run
// before later checks get a chance to report. A crash buries "why" in a stack
// trace; this gate exists to say exactly which check failed and why.
async function safeFetch(url, options) {
  try {
    return { res: await fetch(url, options), error: null };
  } catch (error) {
    return { res: null, error };
  }
}
const fetchFailureReason = (error) => error.cause?.message ?? error.message;

// Shopify's `| json` Liquid filter escapes forward slashes as \/ per the JSON
// spec (`window.RSC_GIVEAWAY_ENDPOINT = "https:\/\/entries.realskincare.com\/api\/giveaway";`).
// Un-escape before running any regex that expects literal slashes, or a
// correctly-rendered page reads as "no endpoint declared."
const unescapeSlashes = (html) => html.replace(/\\\//g, '/');

// 1. All three pages live.
for (const handle of ['free-soap-giveaway', 'giveaway-entered', 'giveaway-official-rules']) {
  const { res, error } = await safeFetch(`https://www.realskincare.com/pages/${handle}`, { headers: UA });
  check(!!res?.ok, `/pages/${handle} returns 200 (got ${res ? res.status : fetchFailureReason(error)})`);
}

// 2. The lander carries the required legal lines.
const landerFetch = await safeFetch('https://www.realskincare.com/pages/free-soap-giveaway', { headers: UA });
if (!landerFetch.res) check(false, `lander is reachable (${fetchFailureReason(landerFetch.error)})`);
const lander = landerFetch.res ? unescapeSlashes(await landerFetch.res.text()) : '';
check(/no purchase necessary/i.test(lander), 'lander states NO PURCHASE NECESSARY');
check(/not sponsored, endorsed/i.test(lander), 'lander carries the Meta release');
check(/official-rules/.test(lander), 'lander links the official rules');

// 3. No offer copy has leaked onto a pre-draw page.
const enteredFetch = await safeFetch('https://www.realskincare.com/pages/giveaway-entered', { headers: UA });
if (!enteredFetch.res) check(false, `entered page is reachable (${fetchFailureReason(enteredFetch.error)})`);
const entered = enteredFetch.res ? await enteredFetch.res.text() : '';
check(!/\$99|\$66|months free|SOAP6MO|SOAP4MO/.test(entered), 'entered page contains NO offer copy');

// 4. Rules contain the clauses that bound our liability.
const rulesFetch = await safeFetch('https://www.realskincare.com/pages/giveaway-official-rules', { headers: UA });
if (!rulesFetch.res) check(false, `official rules page is reachable (${fetchFailureReason(rulesFetch.error)})`);
const rules = rulesFetch.res ? await rulesFetch.res.text() : '';
// These assert what the storefront SERVES, not what the Admin API stored.
// On 2026-08-11 the corrected rules were saved and confirmed byte-identical via
// the Admin API while the storefront kept serving the previous version from
// edge cache — including the double-payout wording it was corrected to remove.
// Saved is not served, and only served matters to an entrant.
for (const [re, label] of [
  [/void in rhode island/i, 'rules: void in Rhode Island'],
  [/purchases do not earn entries/i, 'rules: purchases do not earn entries'],
  [/does not forfeit your entry/i, 'rules: unsubscribing does not forfeit an entry'],
  [/536\.40/, 'rules: ARV $536.40 stated'],
  [/confirmed entrant/i, 'rules: referrer must be a confirmed entrant'],
  [/cash equivalent|terminated/i, 'rules: liability cap on the 3-year obligation'],
  [/no second prize/i, 'rules: self-referral earns NO SECOND PRIZE (double-payout guard)'],
  [/independently void/i, 'rules: self-referral voided for prize eligibility, separately from crediting'],
  [/base entry per email/i, 'rules: one-base-entry carve-out reconciles §4 with the bonus ladder'],
]) check(re.test(rules), label);

// Sponsor address must be the corrected Cheyenne, WY address (data/brand/brand-kit.json
// postal_address). The superseded Blum, TX address was a real live-site defect once
// (Task 9 addendum) — assert both directions so a regression can't slip back in silently.
check(rules.includes('Cheyenne, WY 82001'), 'rules: sponsor address is the corrected Cheyenne, WY address');
check(!rules.includes('Blum'), 'rules: superseded Blum, TX address is NOT present');

// 5. The Meta pixel is present (installed via the sales channel app).
check(/connect\.facebook\.net|fbevents|fbq\(/.test(lander), 'Meta pixel fires on the lander');

// 6. The entry endpoint is reachable and first-party.
const endpointMatch = lander.match(/https:\/\/[a-z0-9.-]+\/api\/giveaway/);
check(!!endpointMatch, 'lander declares an entry endpoint');
if (endpointMatch) {
  const host = new URL(endpointMatch[0]).host;
  check(host.endsWith('realskincare.com'), `endpoint is first-party (${host})`);
  const { res, error } = await safeFetch(`${endpointMatch[0]}/entries?email=bad`, { headers: UA });
  check(!!res && res.status === 400, `endpoint answers without auth (got ${res ? res.status : fetchFailureReason(error)})`);
}

// 7. Config is complete.
check(!!config.listId, 'config.listId is set');
check(!!config.nurtureFlowId, 'config.nurtureFlowId is set');

console.log('');
if (failures.length) { console.error(`${failures.length} failure(s). DO NOT launch.`); process.exit(1); }
console.log('Gate A passed. Manual step remaining: submit a real test entry and confirm the email arrives.');
