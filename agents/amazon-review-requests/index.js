/**
 * Amazon review requests — daily, gap-filler.
 *
 * Sends Amazon's standard "Request a Review" email (SP-API Solicitations API) for every
 * shipped order aged 10-31 days that is STILL eligible, i.e. that nothing else has
 * already requested. Covers every order on the seller account (Culina and RSC alike):
 * Amazon allows one request per order and writes the email itself, so there is no copy
 * here to get wrong. Rules and the reason for the day-10 start are in
 * lib/amazon-review-requests.js.
 *
 *   node agents/amazon-review-requests/index.js            # dry run: checks, sends nothing
 *   node agents/amazon-review-requests/index.js --apply    # sends (cron passes this)
 *   node agents/amazon-review-requests/index.js --apply --limit 3
 *
 * State: data/reports/amazon-review-requests/state.json (gitignored). Losing it is
 * harmless: Amazon's eligibility check is re-read before every send, so a re-check can
 * never produce a second request.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';
import { notify } from '../../lib/notify.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import {
  SOLICITATION_ACTION, orderWindow, ordersToCheck, isEligible, pruneState, renderBody,
} from '../../lib/amazon-review-requests.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-review-requests');
const STATE = join(OUT_DIR, 'state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Solicitations API: 1 request/second, burst 5.
const SOLICIT_PACE_MS = 1100;

function loadState() {
  if (!existsSync(STATE)) return {};
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

function saveState(state) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${STATE}.tmp`, STATE);
}

async function listOrders(client, marketplaceId) {
  const { createdAfter, createdBefore } = orderWindow();
  const orders = [];
  let nextToken = null;
  do {
    const params = nextToken
      ? { MarketplaceIds: marketplaceId, NextToken: nextToken }
      : { MarketplaceIds: marketplaceId, CreatedAfter: createdAfter, CreatedBefore: createdBefore, OrderStatuses: 'Shipped', MaxResultsPerPage: 100 };
    const r = await request(client, 'GET', '/orders/v0/orders', params);
    orders.push(...(r?.payload?.Orders ?? []));
    nextToken = r?.payload?.NextToken ?? null;
    if (nextToken) await sleep(1100);
  } while (nextToken);
  return orders;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;

  const client = getClient();
  const marketplaceId = getMarketplaceId();
  const state = pruneState(loadState());
  const orders = await listOrders(client, marketplaceId);
  const todo = ordersToCheck(orders, state);

  let sent = 0, notEligible = 0, checked = 0;
  const errors = [];
  for (const o of todo) {
    if (sent >= limit) break;
    const id = o.AmazonOrderId;
    checked++;
    try {
      const actions = await request(client, 'GET', `/solicitations/v1/orders/${id}`, { marketplaceIds: marketplaceId });
      await sleep(SOLICIT_PACE_MS);
      if (!isEligible(actions)) {
        notEligible++;
        if (apply) state[id] = { result: 'not-eligible', at: new Date().toISOString() };
        continue;
      }
      if (apply) {
        // marketplaceIds is a QUERY parameter on this POST; the body is empty.
        await request(client, 'POST', `/solicitations/v1/orders/${id}/solicitations/${SOLICITATION_ACTION}?marketplaceIds=${marketplaceId}`);
        await sleep(SOLICIT_PACE_MS);
        state[id] = { result: 'sent', at: new Date().toISOString() };
        saveState(state); // after every send, so a crash cannot lose the record
      }
      sent++;
    } catch (e) {
      errors.push(`${id}: ${String(e.message).slice(0, 160)}`);
    }
  }
  if (apply) saveState(state);

  const summary = { checked, sent, notEligible, errors, dryRun: !apply, listed: orders.length };
  const body = renderBody(summary);
  console.log(body);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify({ generated_at: new Date().toISOString(), ...summary }, null, 2));
  await notify({
    subject: `Amazon review requests: ${apply ? '' : 'DRY RUN, '}${sent} ${apply ? 'sent' : 'eligible'}, ${notEligible} already requested`,
    body, status: 'success', category: 'amazon',
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (e) => {
    console.error(e);
    await notify({ subject: 'Amazon review requests failed', body: String(e?.stack ?? e), status: 'error', category: 'amazon' }).catch(() => {});
    process.exit(1);
  });
}
