/**
 * Recurpay Admin API client — subscription plans for Real Skin Care.
 *
 * Everything below was verified live against the API on 2026-07-26, including the
 * failure modes. Read the CONSTRAINTS section before writing anything; this API
 * has a destructive edge that has already damaged production once.
 *
 * ── ENDPOINT ────────────────────────────────────────────────────────────────
 *   Base:    https://{subdomain}.recurpay.com/admin/api/2024-07
 *   Subdomain is the Shopify store handle minus ".myshopify.com"
 *            realskincare-com.myshopify.com -> realskincare-com
 *   Auth:    header  X-Recurpay-Access-Token: <RECURPAY_ACCESS_TOKEN>
 *            NOT `Authorization: Bearer` — that returns 404 with an empty message,
 *            which reads like a wrong path rather than a wrong credential.
 *   Docs:    https://docs.recurpay.com/reference/plans
 *
 *   RECURPAY_CLIENT_KEY / RECURPAY_CLIENT_SECRET exist in .env but are not used
 *   by the Admin API. Only the access token is.
 *
 * ── CONSTRAINTS (verified, not inferred) ────────────────────────────────────
 *
 * 1. `selling_plans` MUST CONTAIN EXACTLY ONE ITEM, on both POST and PUT.
 *    Sending two returns 422:
 *      {"errors":{"plan":{"selling_plans":["The selling_plans must contain exactly one item."]}}}
 *    Confirmed by creating throwaway plan 11151694, attempting a 2-item PUT, and
 *    deleting it.
 *
 * 2. THEREFORE SELLING PLANS AT POSITION 2+ CANNOT BE REACHED BY THIS API.
 *    A plan holding several cadences (e.g. 11150632 = 4wk/8wk/12wk) can only ever
 *    have its position-1 plan written. Editing positions 2+ requires the Recurpay
 *    admin UI. This is a hard limit, not a missing parameter.
 *
 * 3. PUT REPLACES POSITION 1 REGARDLESS OF WHAT YOU INTENDED.
 *    The single selling plan you send becomes position 1, taking your delivery and
 *    billing policy with it. In a prior session a 12-week payload sent to plan
 *    11150632 rewrote that plan's *4-week* position-1 plan to deliver every 12
 *    weeks. `updatePlan()` below refuses this by default — see the guard.
 *
 * 4. Shopify's own API CANNOT edit these groups. `sellingPlanGroupUpdate` on a
 *    Recurpay-owned group returns userError "Selling plan group does not exist."
 *    even though the group is plainly readable per-product. Do not spend time on
 *    that route; it is closed.
 *
 * 5. FIELD IS SPELLED `pricing_polices` — the typo is Recurpay's, in both request
 *    and response. `pricing_policies` is silently ignored.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 *   plan {
 *     id, selling_plan_group_id ("gid://shopify/SellingPlanGroup/…"), name,
 *     description, status, created_at, updated_at,
 *     selling_plans: [{
 *       id, selling_plan_id ("gid://shopify/SellingPlan/…"), name, description,
 *       position,
 *       delivery_policy: { frequency, interval, pre_anchor_behavior, cutoff, … },
 *       billing_policy:  { frequency, interval },
 *       pricing_polices: [{ discount: { type: "percentage", value: 15 } }]
 *     }]
 *   }
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv();
const TOKEN = env.RECURPAY_ACCESS_TOKEN;
const SUBDOMAIN = (env.SHOPIFY_STORE || '').replace(/\.myshopify\.com.*$/, '');
const API_VERSION = '2024-07';

if (!TOKEN) throw new Error('Missing RECURPAY_ACCESS_TOKEN in .env');
if (!SUBDOMAIN) throw new Error('Missing SHOPIFY_STORE in .env (needed to derive the Recurpay subdomain)');

const BASE = `https://${SUBDOMAIN}.recurpay.com/admin/api/${API_VERSION}`;

async function request(method, path, body = null) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'X-Recurpay-Access-Token': TOKEN,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data?.errors ? JSON.stringify(data.errors) : (data?.message || text.slice(0, 300));
    throw new Error(`Recurpay ${method} ${path} — HTTP ${res.status}: ${detail}`);
    }
  return data;
}

/** All plans, with their selling plans. */
export async function listPlans() {
  const d = await request('GET', '/plans');
  return d.data.plans;
}

/** One plan by Recurpay plan id. */
export async function getPlan(planId) {
  const d = await request('GET', `/plans/${planId}`);
  return d.data.plan ?? d.data.plans?.[0];
}

/**
 * Create a plan. Exactly one selling plan — the API rejects more (constraint 1).
 * To offer several cadences on one plan you must add positions 2+ in the UI.
 */
export async function createPlan(plan) {
  assertSingleSellingPlan(plan);
  const d = await request('POST', '/plans', { plan });
  return d.data.plan ?? d.data.plans?.[0];
}

/**
 * Update a plan.
 *
 * DESTRUCTIVE BY DESIGN — the selling plan you send becomes position 1, taking its
 * delivery and billing policy with it. If the target plan has more than one selling
 * plan, positions 2+ are unreachable and position 1 is about to be overwritten by
 * whatever you send, which is how a 4-week plan previously became a 12-week plan.
 *
 * So this refuses to touch a multi-selling-plan plan unless you pass
 * { force: true } having decided that is genuinely what you want.
 */
export async function updatePlan(planId, plan, { force = false } = {}) {
  assertSingleSellingPlan(plan);

  const existing = await getPlan(planId);
  const count = existing?.selling_plans?.length ?? 0;

  if (count > 1 && !force) {
    const positions = existing.selling_plans
      .map(sp => `pos ${sp.position}: "${sp.name}" (${sp.delivery_policy?.frequency}${sp.delivery_policy?.interval}, ${sp.pricing_polices?.[0]?.discount?.value}%)`)
      .join('\n    ');
    throw new Error(
      `Refusing to update plan ${planId}: it has ${count} selling plans and this API can only write position 1.\n` +
      `  Writing would overwrite position 1 and is how the 4-week plan previously became 12-week.\n` +
      `  Current:\n    ${positions}\n` +
      `  Edit positions 2+ in the Recurpay admin UI, or pass { force: true } if overwriting position 1 is intended.`
    );
  }

  const d = await request('PUT', `/plans/${planId}`, { plan });
  return d.data.plan ?? d.data.plans?.[0];
}

/** Delete a plan. Returns the API's confirmation message. */
export async function deletePlan(planId) {
  return request('DELETE', `/plans/${planId}`);
}

/**
 * Flatten every selling plan across every plan into one list — the view you
 * almost always want when auditing discounts and cadences.
 */
export async function listSellingPlans() {
  const plans = await listPlans();
  return plans.flatMap(p =>
    (p.selling_plans || []).map(sp => ({
      planId: p.id,
      planName: p.name,
      sellingPlanGroupId: p.selling_plan_group_id,
      id: sp.id,
      shopifySellingPlanId: sp.selling_plan_id,
      name: sp.name,
      position: sp.position,
      cadence: `${sp.delivery_policy?.frequency} ${sp.delivery_policy?.interval}`,
      discountPercent: sp.pricing_polices?.[0]?.discount?.value ?? null,
      // Position 1 is the only one this API can write. Anything else is UI-only.
      apiWritable: sp.position === 1,
    }))
  );
}

function assertSingleSellingPlan(plan) {
  const n = plan?.selling_plans?.length;
  if (n !== 1) {
    throw new Error(
      `Recurpay requires exactly one selling plan per request, got ${n ?? 0}. ` +
      `Multi-cadence plans must be assembled in the Recurpay admin UI (see CONSTRAINTS in lib/recurpay.js).`
    );
  }
}

export { BASE, API_VERSION, SUBDOMAIN };
