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
import { getListOptInProcess, listProfilesWithConsent } from '../../lib/klaviyo-profiles.js';
import { klaviyoRequest } from '../../lib/klaviyo.js';
import { isTestProfile } from '../../lib/giveaway/test-identity.js';
import { resolveMechanism, CONFIRM_MECHANISMS } from '../../lib/giveaway/reconcile.js';

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
check(!!enteredFetch.res && !/\$99|\$66|months free|SOAP6MO|SOAP4MO/.test(entered), 'entered page contains NO offer copy');

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
check(!!rulesFetch.res && !rules.includes('Blum'), 'rules: superseded Blum, TX address is NOT present');

// 5. The Meta pixel is present, AND it is the pixel we mean to use.
//
// Do NOT grep for connect.facebook.net / fbevents / fbq( — the Facebook &
// Instagram sales channel registers the pixel inside Shopify's sandboxed
// web-pixels runtime, so none of those classic markers appear in page HTML even
// when the pixel is correctly installed and firing. Checking for them produced a
// false FAIL against a working install on 2026-08-11.
//
// What the page actually contains is the web-pixels-manager config, with quotes
// backslash-escaped inside a JS string:
//   {\"pixel_id\":\"1948396628850834\",\"pixel_type\":\"facebook_pixel\",...}
const landerUnescaped = lander.replace(/\\"/g, '"');
check(
  !!landerFetch.res && /"pixel_type"\s*:\s*"facebook_pixel"/.test(landerUnescaped),
  'a Meta pixel is registered in the Shopify web-pixels config',
);
// Assert the ID too: a pixel firing into the wrong dataset is worse than none,
// because it looks like it works.
check(
  !!landerFetch.res && landerUnescaped.includes(`"pixel_id":"${config.metaPixelId}"`),
  `the registered pixel is the expected one (${config.metaPixelId})`,
);

// 6. The entry endpoint is reachable and first-party.
const endpointMatch = lander.match(/https:\/\/[a-z0-9.-]+\/api\/giveaway/);
check(!!endpointMatch, 'lander declares an entry endpoint');
if (endpointMatch) {
  const host = new URL(endpointMatch[0]).host;
  const firstParty = host === 'realskincare.com' || host.endsWith('.realskincare.com');
  check(firstParty, `endpoint is first-party (${host})`);
  const { res, error } = await safeFetch(`${endpointMatch[0]}/entries?email=bad`, { headers: UA });
  check(!!res && res.status === 400, `endpoint answers without auth (got ${res ? res.status : fetchFailureReason(error)})`);
}

// 7. Config is complete.
check(!!config.listId, 'config.listId is set');
check(!!config.nurtureFlowId, 'config.nurtureFlowId is set');

// 8. The list's opt-in process MATCHES the configured confirm mechanism.
//
// This was long documented as unassertable ("the API does not expose this
// field"), which was simply false: GET /api/lists/{id}/ returns
// attributes.opt_in_process. Verified live 2026-08-11 — Y2ukbE is
// `double_opt_in`, and `S6hKFq "Email List"` is `single_opt_in`, so the account
// is NOT uniform and a re-created list can land single without anyone noticing.
// The setting can only be CHANGED in the Klaviyo UI, so asserting the read
// value is the only guard there is.
//
// What is asserted is the PAIR, not the list alone. These are two halves of one
// setting living in two systems, and every way they can disagree is silent in
// production:
//
//   double_opt_in config + single opt-in list -> every entrant is subscribed on
//     submit and the code reads that as confirmation, paying the +2 and every
//     §5 referral rung to people who never clicked anything.
//   flow_link config + double opt-in list -> the branded flow never reaches an
//     unconfirmed profile (Klaviyo will not send marketing email to one), so
//     confirmation stops happening at all and the +2 never pays again.
//
// Neither shows up as an error anywhere; both corrupt the entry ladder. So this
// gate asserts the pair, not just the list.
if (config.listId) {
  const mechanism = resolveMechanism(config);
  const expectedOptIn = mechanism === CONFIRM_MECHANISMS.FLOW_LINK ? 'single_opt_in' : 'double_opt_in';
  let optIn = null;
  let optInError = null;
  try { optIn = await getListOptInProcess(config.listId); }
  catch (error) { optInError = error.message; }
  check(
    optIn === expectedOptIn,
    `Klaviyo list ${config.listId} opt-in process matches confirmMechanism=${mechanism} `
    + `(expected ${expectedOptIn}, got ${optInError ? `error: ${optInError}` : optIn})`,
  );

  // Under flow_link the confirmation email is OURS, so its absence is a launch
  // blocker in exactly the way a missing double-opt-in setting used to be:
  // nothing else in the system sends a confirmation link.
  if (mechanism === CONFIRM_MECHANISMS.FLOW_LINK) {
    check(Boolean(config.confirmFlowId), `confirmFlowId is set (got ${config.confirmFlowId ?? 'null'})`);
    check(Boolean(config.confirmTemplateId), `confirmTemplateId is set (got ${config.confirmTemplateId ?? 'null'})`);

    // The confirmed segment gates every campaign send, and it is built by hand
    // in the Klaviyo UI (this API revision will not return a segment definition,
    // so nothing here can read back what it actually filters on). What CAN be
    // read is its size, which catches both ways a hand-built definition goes
    // wrong: an over-broad one matches the whole list, an under-broad or
    // misspelled one matches nobody. Neither shows up as an error, and both
    // decide who receives email.
    check(Boolean(config.confirmedSegmentId), `confirmedSegmentId is set (got ${config.confirmedSegmentId ?? 'null'})`);
    if (config.confirmedSegmentId) {
      let count = null;
      let countError = null;
      try {
        const res = await klaviyoRequest(
          'GET',
          `/segments/${config.confirmedSegmentId}/?additional-fields%5Bsegment%5D=profile_count`,
        );
        count = res?.data?.attributes?.profile_count ?? null;
      } catch (error) { countError = error.message; }

      const listed = (await listProfilesWithConsent(config.listId)).length;
      check(
        Number.isFinite(count) && count > 0 && count <= listed,
        `confirmed segment ${config.confirmedSegmentId} holds a plausible count `
        + `(got ${countError ? `error: ${countError}` : count}, list holds ${listed}; `
        + 'expected between 1 and the list size — 0 means the definition matches nobody, '
        + 'the full list size means it is not filtering on confirmation at all)',
      );
    }
  }
}

// 9. No test identities may remain in the entrant pool.
//
// The verification harness creates real profiles on the production list. Cleanup
// deletes them, but cleanup can be forgotten — and a forgotten test profile sits
// in the draw pool with a real chance of winning a $536.40 prize. A gate cannot
// be forgotten. This also finally covers the single real test entry the launch
// runbook has always mandated, which nothing previously excluded.
if (config.listId) {
  try {
    const members = await listProfilesWithConsent(config.listId);
    const leftovers = members.filter((p) => isTestProfile(p.properties));
    check(
      leftovers.length === 0,
      `no gv_test profiles remain on the entrant list (found ${leftovers.length}${leftovers.length ? ': ' + leftovers.map((p) => p.email).join(', ') : ''})`,
    );
  } catch (e) {
    check(false, `could not enumerate the entrant list to check for test profiles: ${e.message}`);
  }
}

console.log('');
if (failures.length) { console.error(`${failures.length} failure(s). DO NOT launch.`); process.exit(1); }
console.log('Gate A passed. Manual step remaining: submit a real test entry and confirm the email arrives.');
