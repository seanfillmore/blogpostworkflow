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
 * @param {object}  o
 * @param {string}  o.campaignId
 * @param {string}  o.accessToken
 * @param {string} [o.since] YYYY-MM-DD; defaults to campaign lifetime
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
  // to date" means. `maximum` is the lifetime preset.
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
 * Returns `{ verdict, line }` where verdict is 'ok' | 'over' | 'unknown'.
 */
export function evaluateSpendGate({ spend, entrants, entryValue: value }) {
  if (!Number.isFinite(spend) || spend <= 0) {
    return { verdict: 'unknown', line: 'Spend gate: no spend recorded yet.' };
  }
  if (!entrants) {
    return { verdict: 'unknown', line: `Spend gate: $${spend.toFixed(2)} spent and zero entrants — check the entry path before raising budget.` };
  }

  const costPerEntry = Math.round((spend / entrants) * 100) / 100;

  if (value?.value == null || !value.matured) {
    return {
      verdict: 'unknown',
      line: `Spend gate: $${costPerEntry}/entry ($${spend.toFixed(2)} over ${entrants}). `
        + `Worth is not measurable yet (${value?.basis ?? 'no data'}) — do not judge the campaign on cost alone.`,
    };
  }

  const over = costPerEntry > value.value;
  return {
    verdict: over ? 'over' : 'ok',
    line: over
      ? `GATE: $${costPerEntry}/entry exceeds the $${value.value} a NEW entrant is worth `
        + `(${value.basis}, ${value.matured} matured). Fix creative or targeting before raising budget.`
      : `Spend gate OK: $${costPerEntry}/entry against $${value.value} of value per new entrant `
        + `(${value.basis}, ${value.matured} matured).`,
  };
}
