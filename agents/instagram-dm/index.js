#!/usr/bin/env node
/**
 * Instagram DMs: answers the bio's "DM 'Natural' for $10 off your first order"
 * with a unique single-use code, and lists every other DM waiting on Sean.
 * Policy lives in lib/instagram-dm.js.
 *
 * The codes belong to ONE Shopify code discount (created by --setup-discount):
 * $10 off the order, usage limit 1 PER CODE, once per customer, first order only
 * (customer segment number_of_orders = 0, the same segment WELCOME30 uses), so a
 * code passed to a friend who has ordered before, or used once already, does
 * nothing. Codes are pre-generated into a pool in the state file; the pool is
 * topped up in Shopify when it runs low.
 *
 * Usage:
 *   node agents/instagram-dm/index.js                    # dry run: what would be sent
 *   node agents/instagram-dm/index.js --apply            # send replies (cron, every 10 min)
 *   node agents/instagram-dm/index.js --digest           # DMs waiting on Sean, into the 5 AM digest (cron, daily)
 *   node agents/instagram-dm/index.js --setup-discount [--apply]   # create the discount + first 200 codes (once)
 *
 * State: data/instagram-dm/state.json (gitignored, server-owned): the discount
 * id, the unassigned pool, who got which code, and which messages were handled.
 * An unreadable state file THROWS: reading it as empty would hand everyone a
 * second code. Off switch: config/instagram-dm.json "enabled": false.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { getPageToken, listIgConversations, sendIgMessage } from '../../lib/facebook-page.js';
import { planReplies, awaitingReply, replyText, genCodes, POOL_LOW } from '../../lib/instagram-dm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_PATH = join(ROOT, 'data', 'instagram-dm', 'state.json');
const CONFIG_PATH = join(ROOT, 'config', 'instagram-dm.json');
const NEVER_PURCHASED_SEGMENT = 'gid://shopify/Segment/365228064938'; // number_of_orders = 0 (scripts/flows/align-offers-2026-10-05.mjs)

function loadEnv(root = ROOT) {
  try {
    const env = {};
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env;
  } catch { return {}; }
}

export function readState(path = STATE_PATH) {
  if (!existsSync(path)) return { discount_id: null, pool: [], assigned: {}, handled: {}, sent: [] };
  const s = JSON.parse(readFileSync(path, 'utf8'));
  return { discount_id: s.discount_id || null, pool: s.pool || [], assigned: s.assigned || {}, handled: s.handled || {}, sent: s.sent || [] };
}

export function writeState(state, path = STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, path);
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return { enabled: true };
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

async function shopifyGql(query, variables) {
  const { shopifyGraphQL } = await import('../../lib/shopify.js');
  return shopifyGraphQL(query, variables);
}

/** Add codes to the discount in Shopify, then (only then) to the local pool. */
export async function addCodes(state, n, { gql = shopifyGql, log = console.log } = {}) {
  const taken = new Set([...state.pool, ...Object.values(state.assigned).map((a) => a.code)]);
  const codes = genCodes(n, Math.random, taken);
  for (let i = 0; i < codes.length; i += 100) {
    const chunk = codes.slice(i, i + 100);
    const r = await gql('mutation($id:ID!,$codes:[DiscountRedeemCodeInput!]!){ discountRedeemCodeBulkAdd(discountId:$id,codes:$codes){ bulkCreation{ id } userErrors{ message } } }', { id: state.discount_id, codes: chunk.map((code) => ({ code })) });
    const errs = r?.discountRedeemCodeBulkAdd?.userErrors || [];
    if (errs.length) throw new Error(`discountRedeemCodeBulkAdd: ${errs.map((e) => e.message).join('; ')}`);
    state.pool.push(...chunk);
  }
  log(`  added ${codes.length} codes (pool now ${state.pool.length})`);
}

export async function setupDiscount({ apply, gql = shopifyGql, log = console.log }) {
  const state = readState();
  if (state.discount_id) { log(`Discount already set up: ${state.discount_id} (${state.pool.length} unassigned codes).`); return state; }
  const first = genCodes(1)[0];
  const input = {
    title: 'Instagram DM $10 off first order (unique, single use)',
    code: first,
    startsAt: new Date().toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection: { customerSegments: { add: [NEVER_PURCHASED_SEGMENT] } },
    customerGets: { value: { discountAmount: { amount: '10.00', appliesOnEachItem: false } }, items: { all: true } },
    combinesWith: { shippingDiscounts: true, orderDiscounts: false, productDiscounts: false },
  };
  log(`Would create: ${JSON.stringify(input)}`);
  if (!apply) return state;
  const r = await gql('mutation($b:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$b){ codeDiscountNode{ id } userErrors{ field message } } }', { b: input });
  const errs = r?.discountCodeBasicCreate?.userErrors || [];
  if (errs.length) throw new Error(`discountCodeBasicCreate: ${JSON.stringify(errs)}`);
  state.discount_id = r.discountCodeBasicCreate.codeDiscountNode.id;
  state.pool = [first];
  writeState(state);
  await addCodes(state, 199, { gql, log });
  writeState(state);
  log(`Created ${state.discount_id} with ${state.pool.length} codes.`);
  return state;
}

/**
 * One reply run. Each send is recorded the moment it lands (code moved from the
 * pool to `assigned`, message marked handled), so a crash mid-run cannot hand
 * the same person a second code or the same code to two people.
 */
export async function runOnce({ apply, conversations, state, send, now = Date.now(), log = console.log, save = writeState }) {
  const { sends, stale } = planReplies(conversations, state, { now });
  const done = [];
  for (const s of sends) {
    if (!apply) { done.push({ ...s, outcome: 'would-send' }); continue; }
    try {
      await send({ recipientId: s.recipientId, text: replyText(s.code) });
      if (!s.reused) {
        state.pool = state.pool.filter((c) => c !== s.code);
        state.assigned[s.recipientId] = { code: s.code, at: new Date(now).toISOString(), username: s.username };
      }
      state.handled[s.messageId] = true;
      state.sent.push({ at: new Date(now).toISOString(), username: s.username, code: s.code, reused: s.reused });
      save(state);
      done.push({ ...s, outcome: 'sent' });
    } catch (err) {
      done.push({ ...s, outcome: 'failed', error: err.message });
      log(`  send to @${s.username} failed: ${err.message}`);
    }
  }
  return { done, stale };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (args.includes('--setup-discount')) { await setupDiscount({ apply }); return; }
  const config = readConfig();
  if (config.enabled === false) { console.log('instagram-dm is switched off (config/instagram-dm.json)'); return; }
  const env = loadEnv();
  const userToken = env.META_USER_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN;
  if (!userToken) throw new Error('META_USER_ACCESS_TOKEN is not in .env');
  const pageToken = await getPageToken({ userToken });
  const conversations = await listIgConversations({ limit: 25 }, { token: pageToken });
  const state = readState();

  if (args.includes('--digest')) {
    const waiting = awaitingReply(conversations, state);
    const day = state.sent.filter((s) => Date.now() - Date.parse(s.at) < 86_400_000);
    const lines = [
      `${day.length} "Natural" code(s) sent automatically in the last 24 h; ${state.pool.length} unused codes left.`,
      waiting.length ? `${waiting.length} DM conversation(s) waiting on you (newest first; Instagram allows a reply only within 24 h of their last message):` : 'No DMs waiting on you.',
      ...waiting.map((w) => `  @${w.username}, ${w.ageHours} h ago${w.canReply ? '' : ' (past the 24 h reply window)'}: ${w.preview}`),
    ];
    console.log(lines.join('\n'));
    await notify({ subject: `Instagram DMs: ${waiting.length} waiting on you, ${day.length} code(s) sent`, body: lines.join('\n'), status: 'info', category: 'social' });
    return;
  }

  if (!state.discount_id) throw new Error('no discount set up: run --setup-discount --apply first');
  if (apply && state.pool.length < POOL_LOW) await addCodes(state, 200).then(() => writeState(state));
  const run = await runOnce({
    apply, conversations, state,
    send: ({ recipientId, text }) => sendIgMessage({ recipientId, text }, { token: pageToken }),
  });
  for (const d of run.done) console.log(`${d.outcome}: @${d.username} ${d.code}${d.reused ? ' (same code as before)' : ''}${d.error ? ` (${d.error})` : ''}`);
  for (const s of run.stale) console.log(`not answered: @${s.username} (${s.reason || 'older than 24 h; in the digest'})`);
  if (!run.done.length && !run.stale.length) console.log('No new "Natural" requests.');
  const failed = run.done.filter((d) => d.outcome === 'failed');
  if (apply && failed.length) {
    await notify({ subject: `Instagram DMs: ${failed.length} "Natural" code(s) failed to send`, body: failed.map((f) => `@${f.username}: ${f.error}`).join('\n'), status: 'info', category: 'social' });
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    try { await notify({ subject: 'Instagram DM agent failed', body: String(err?.stack || err), status: 'error', category: 'social' }); } catch { /* console has it */ }
    process.exit(1);
  });
}
