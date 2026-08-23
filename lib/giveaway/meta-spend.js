// lib/giveaway/meta-spend.js
/**
 * Actual spend on the giveaway campaign, straight from Meta.
 *
 * Deliberately NOT "daily budget x days elapsed". A budget is what you asked
 * for; spend is what happened. They diverge whenever delivery is capped, the
 * campaign is paused for a day, or the learning phase underspends — and a gate
 * that fires on an estimate will eventually fire on a day nothing was spent.
 *
 * Reads only. Never throws: the daily giveaway report must survive Meta being
 * unreachable, so every failure resolves to null and the caller says so.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_VERSION = 'v21.0';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * process.env first, then .env — the precedence this repo already uses for
 * CREATIVES_BUDGET_BYTES, and for the same reason: the paths that run unattended
 * do not source .env, while a hand-run script deliberately keeps .env out of
 * process.env. Reading only one of them means the token is missing in exactly
 * one of those two worlds, and the failure is silent.
 */
export function resolveAccessToken(env = process.env) {
  if (env.FACEBOOK_ACCESS_TOKEN) return env.FACEBOOK_ACCESS_TOKEN;
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      if (t.slice(0, i).trim() === 'FACEBOOK_ACCESS_TOKEN') return t.slice(i + 1).trim();
    }
  } catch { /* no .env is a valid state */ }
  return null;
}

/**
 * The ad account's own reporting timezone, which is the clock Meta buckets a
 * "day" of insights by — NOT the server's clock, and not necessarily the store's.
 *
 * Verified live 2026-08-23: act_946015593265647 reports `timezone_name:
 * "America/Los_Angeles"`. That happens to match the Pacific the giveaway config
 * runs on, so the two agree today — but they are independent settings and a
 * future account could differ. spendWindow asserts nothing; it simply names the
 * assumption here so a mismatch is findable rather than silently off by a day.
 */
export const AD_ACCOUNT_TIME_ZONE = 'America/Los_Angeles';

/** YYYY-MM-DD for an instant, in a named zone. en-CA is ISO-ordered by definition. */
function ymdInZone(at, timeZone) {
  return new Date(at).toLocaleDateString('en-CA', { timeZone });
}

/**
 * The window "campaign to date" actually means, including today.
 *
 * WHY THIS EXISTS. `date_preset: 'maximum'` is the lifetime preset and it ENDS
 * YESTERDAY — it never includes the current day. So every spend figure the daily
 * report showed lagged 24 hours, and on 2026-08-22 that meant $78.84 / 301 leads
 * where the true campaign-to-date was $110.33 / 471. The gap is largest exactly
 * when it matters most: early in a campaign, when one day is a big share of
 * everything spent so far.
 *
 * `since` is the Entry Period open rather than the campaign's creation date. The
 * campaign was created 2026-08-12 but sat paused with zero delivery until
 * 2026-08-19, so no spend is excluded — and "spend during the Entry Period" is
 * the quantity the spend gate and cost-per-entry are actually about, since the
 * entrants they divide by can only have entered inside that window.
 */
export function spendWindow({ entryOpensAt, now = Date.now(), timeZone = AD_ACCOUNT_TIME_ZONE } = {}) {
  const since = String(entryOpensAt ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return null;
  return { since, until: ymdInZone(now, timeZone) };
}

/**
 * @param {object}  o
 * @param {string}  o.campaignId
 * @param {string}  o.accessToken
 * @param {string} [o.since] YYYY-MM-DD; defaults to campaign lifetime EXCLUDING today
 * @param {string} [o.until] YYYY-MM-DD
 * @returns {Promise<{spend: number, impressions: number, leads: number|null,
 *                    costPerLead: number|null, error: string|null}|null>}
 */
export async function fetchCampaignSpend({ campaignId, accessToken, since = null, until = null } = {}) {
  if (!campaignId || !accessToken) return null;

  const params = new URLSearchParams({
    fields: 'spend,impressions,actions,cost_per_action_type',
    access_token: accessToken,
  });
  // Without a range Meta defaults to the last day, which is not what "campaign
  // to date" means. `maximum` is the lifetime preset, and it ends YESTERDAY —
  // callers who need today in the total must pass an explicit range. See
  // spendWindow, which builds the one this campaign wants.
  if (since && until) params.set('time_range', JSON.stringify({ since, until }));
  else params.set('date_preset', 'maximum');

  try {
    const res = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${campaignId}/insights?${params}`,
    );
    const body = await res.json();
    if (body.error) return { spend: 0, impressions: 0, leads: null, costPerLead: null, error: body.error.message };

    const row = body.data?.[0];
    // No row is not an error: a campaign that has never delivered has no insights.
    if (!row) return { spend: 0, impressions: 0, leads: null, costPerLead: null, error: null };

    const spend = Number.parseFloat(row.spend ?? 0) || 0;
    const impressions = Number.parseInt(row.impressions ?? 0, 10) || 0;

    // Meta reports leads under several action types depending on where the
    // conversion is defined. Take the first that is present rather than assuming.
    const findAction = (list) => {
      for (const key of ['offsite_conversion.fb_pixel_lead', 'lead', 'onsite_conversion.lead_grouped']) {
        const hit = (list ?? []).find((a) => a.action_type === key);
        if (hit) return Number.parseFloat(hit.value ?? 0) || 0;
      }
      return null;
    };
    const leads = findAction(row.actions);
    const costPerLead = findAction(row.cost_per_action_type);

    return { spend: Math.round(spend * 100) / 100, impressions, leads, costPerLead, error: null };
  } catch (e) {
    return { spend: 0, impressions: 0, leads: null, costPerLead: null, error: e.message };
  }
}

/**
 * The spend gate.
 *
 * Compares what an entry COSTS against what an entry is WORTH. Both halves have
 * to be real or the answer is "not yet", never a number:
 *
 *  - cost uses OUR entrant count, not Meta's reported leads. Meta counts the
 *    Lead event; we count rows on the list. Ours is the one the prize and the
 *    nurture actually run on, and it cannot be inflated by a duplicate event.
 *  - value comes from the NEW-customer segment. Reacquiring an existing customer
 *    is not acquisition, and including them would raise the ceiling on the
 *    strength of revenue the ad did not cause.
 *
 * Returns `{ verdict, line, costPerEntry, basis }` where verdict is 'ok' | 'over' | 'unknown'.
 *
 * THE PROVISIONAL TARGET. Measured value is the real answer, and it is the one used the
 * moment it exists. But it cannot exist early: no entrant is 30 days old on day 2, so for
 * the first month the gate could only ever say "not measurable yet — do not judge the
 * campaign on cost alone". That is correct and useless. A campaign spending $30/day for
 * four weeks against no yardstick at all is how $840 goes out with nobody able to say
 * whether it went well.
 *
 * So: when measured value is unavailable, fall back to a provisional ceiling from
 * config/giveaway.json and say IN THE LINE that it is provisional and where it came from.
 * The verdict is real either way — an operator can act on it — but the basis is never
 * disguised, because a guessed denominator presented as a measurement is worse than no
 * denominator. Measured value always wins when present; the provisional number never
 * overrides data, it only covers the window before there is any.
 */
export function evaluateSpendGate({ spend, entrants, entryValue: value, provisionalTarget = null }) {
  if (!Number.isFinite(spend) || spend <= 0) {
    return { verdict: 'unknown', basis: 'none', costPerEntry: null, line: 'Spend gate: no spend recorded yet.' };
  }
  if (!entrants) {
    return { verdict: 'unknown', basis: 'none', costPerEntry: null, line: `Spend gate: $${spend.toFixed(2)} spent and zero entrants — check the entry path before raising budget.` };
  }

  const costPerEntry = Math.round((spend / entrants) * 100) / 100;

  // windowMatured, NOT `matured` — see entryValue's fallback. A $0 "measured" value from
  // entrants who are hours old is the absence of data, not a finding, and treating it as
  // one makes the gate fire 'over' against a ceiling of $0 forever.
  if (value?.value == null || value?.windowMatured !== true) {
    if (!Number.isFinite(provisionalTarget) || provisionalTarget <= 0) {
      return {
        verdict: 'unknown',
        basis: 'none',
        costPerEntry,
        line: `Spend gate: $${costPerEntry}/entry ($${spend.toFixed(2)} over ${entrants}). `
          + `Worth is not measurable yet (${value?.basis ?? 'no data'}) — do not judge the campaign on cost alone.`,
      };
    }
    const over = costPerEntry > provisionalTarget;
    return {
      verdict: over ? 'over' : 'ok',
      basis: 'provisional',
      costPerEntry,
      line: (over
        ? `GATE (provisional): $${costPerEntry}/entry exceeds the $${provisionalTarget} target. `
        : `Spend gate OK (provisional): $${costPerEntry}/entry against a $${provisionalTarget} target. `)
        + `This target is an ASSUMPTION, not a measurement — no entrant has matured yet `
        + `(${value?.basis ?? 'no data'}). It is replaced automatically by measured new-entrant value `
        + `once one 30-day window closes. Set in config/giveaway.json.`,
    };
  }

  const over = costPerEntry > value.value;
  return {
    verdict: over ? 'over' : 'ok',
    basis: 'measured',
    costPerEntry,
    line: over
      ? `GATE: $${costPerEntry}/entry exceeds the $${value.value} a NEW entrant is worth `
        + `(${value.basis}, ${value.matured} matured). Fix creative or targeting before raising budget.`
      : `Spend gate OK: $${costPerEntry}/entry against $${value.value} of value per new entrant `
        + `(${value.basis}, ${value.matured} matured).`,
  };
}
