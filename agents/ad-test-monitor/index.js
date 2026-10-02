#!/usr/bin/env node
/**
 * Ad Test Monitor — checks each paid ad test in config/ad-tests.json against its
 * stop rules once a day and reports in the 5 AM digest. It REPORTS ONLY: it
 * never pauses, edits or creates anything in Meta. Stopping a test is Sean's
 * call; this makes sure he hears about it the morning a rule is hit.
 *
 * Per campaign it reads Meta's lifetime spend, impressions, link clicks and
 * pixel purchases since the test started, counts Shopify orders whose landing
 * URL carries the test's tag (the ground truth; see lib/ad-test-rules.js for
 * why the stop rules use the larger of the two purchase counts), and adds
 * Trybe's own attributed sales when the test runs through Trybe.
 *
 * A stop rule hit for the first time is ALSO emailed immediately, once; every
 * day's status lands in the digest as an ordinary row.
 *
 * Usage:
 *   node agents/ad-test-monitor/index.js           # print the report
 *   node agents/ad-test-monitor/index.js --notify  # also send it (cron does this)
 *
 * Cron: DAILY_AD_TEST_MONITOR, 12:10 UTC (scripts/setup-cron.sh).
 * Requires META_USER_ACCESS_TOKEN (and TRYBE_API_KEY for Trybe tests) in .env.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { listCreatorPerformance } from '../../lib/trybe.js';
import { evaluateRules, metaPurchaseCount, taggedOrders, renderTestLines } from '../../lib/ad-test-rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'ad-tests.json');
const STATE_PATH = join(ROOT, 'data', 'ad-test-monitor', 'state.json');
const GRAPH = 'https://graph.facebook.com/v21.0';
/** Keep reporting this many days past a test's end date, then go quiet. */
const REPORT_DAYS_AFTER_END = 3;

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

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

async function graph(path, token, params = {}, fetchImpl = fetch) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetchImpl(url);
  const json = JSON.parse(await res.text());
  if (json.error) throw new Error(`meta: ${path}: ${json.error.message}`);
  return json;
}

/** Days until the Meta token expires, or null when it cannot be read or never expires. */
async function tokenDaysLeft(env, now, fetchImpl) {
  if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET) return null;
  try {
    const d = await graph('debug_token', `${env.FACEBOOK_APP_ID}|${env.FACEBOOK_APP_SECRET}`, { input_token: env.META_USER_ACCESS_TOKEN }, fetchImpl);
    const exp = d.data?.data_access_expires_at || d.data?.expires_at;
    return exp ? Math.floor((exp * 1000 - now) / 86_400_000) : null;
  } catch { return null; }
}

/**
 * One test's report. Every source is injectable for tests.
 */
export async function checkTest(test, {
  token, now = Date.now(), fetchImpl = fetch,
  loadOrders = async (from, to) => (await import('../../lib/shopify.js')).getAllOrders(from, to),
  loadTrybe = null,
}) {
  const until = ymd(Math.min(now, Date.parse(test.endDate) + 86_400_000));
  const { orders = [] } = await loadOrders(`${test.startDate}T00:00:00Z`, new Date(now).toISOString());
  const shopifyOrders = taggedOrders(orders, test.landingTag);

  const rows = [];
  for (const c of test.campaigns) {
    const camp = await graph(c.id, token, { fields: 'effective_status' }, fetchImpl);
    // Trybe names each ad "..._trybe=<video id>" and tags its link the same way,
    // so an order's landing URL names the exact ad, and therefore the campaign.
    const ads = await graph(`${c.id}/ads`, token, { fields: 'name', limit: '100' }, fetchImpl);
    const ids = (ads.data || []).map((x) => (String(x.name).match(/trybe=([a-z0-9]+)/i) || [])[1]).filter(Boolean);
    const mine = shopifyOrders.filter((o) => ids.some((id) => String(o.landing_site || '').includes(`${test.landingTag}${id}`)));
    const ins = await graph(`${c.id}/insights`, token, {
      time_range: { since: test.startDate, until }, fields: 'spend,impressions,inline_link_clicks,actions',
    }, fetchImpl);
    const r = ins.data?.[0] || {};
    const shopifyPurchases = ids.length ? mine.length : (test.campaigns.length === 1 ? shopifyOrders.length : 0);
    const m = {
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      linkClicks: Number(r.inline_link_clicks) || 0,
      metaPurchases: metaPurchaseCount(r.actions),
      shopifyPurchases,
    };
    rows.push({ ...m, id: c.id, label: c.label, status: camp.effective_status, eval: evaluateRules(m, test.rules) });
  }

  let trybe = null;
  // Trybe reports complete UTC days ending yesterday, so day 1 has nothing yet.
  if (loadTrybe && ymd(now - 86_400_000) >= test.startDate) {
    try {
      const perf = await loadTrybe(test.startDate, ymd(now - 86_400_000));
      trybe = perf.reduce((t, p) => ({ gmvCents: t.gmvCents + (Number(p.performance?.trybe_gmv_cents) || 0), conversions: t.conversions + (Number(p.performance?.trybe_conversions) || 0) }), { gmvCents: 0, conversions: 0 });
    } catch { trybe = null; }
  }
  return { rows, shopifyOrders, trybe };
}

async function main() {
  const send = process.argv.includes('--notify');
  const env = loadEnv();
  const token = env.META_USER_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN;
  if (!token) throw new Error('META_USER_ACCESS_TOKEN is not in .env');
  const now = Date.now();
  const tests = (readJson(CONFIG_PATH, { tests: [] }).tests || [])
    .filter((t) => now >= Date.parse(t.startDate) && now <= Date.parse(t.endDate) + (REPORT_DAYS_AFTER_END + 1) * 86_400_000);
  if (!tests.length) { console.log('No ad tests in their reporting window.'); return; }

  const state = readJson(STATE_PATH, { alerted: {} });
  const daysLeft = await tokenDaysLeft(env, now);
  const lines = [];
  const newStops = [];
  for (const test of tests) {
    const loadTrybe = test.landingTag.startsWith('trybe') && env.TRYBE_API_KEY
      ? (start, end) => listCreatorPerformance({ apiKey: env.TRYBE_API_KEY, startDate: start, endDate: end })
      : null;
    const r = await checkTest(test, { token, now, loadTrybe });
    lines.push(...renderTestLines(test, r.rows, { ...r, tokenDaysLeft: daysLeft, now }), '');
    for (const row of r.rows) {
      for (const reason of row.eval.reasons) {
        const key = `${row.id}:${reason.split(' ').slice(0, 3).join(' ')}`;
        if (!state.alerted[key]) { state.alerted[key] = new Date(now).toISOString(); newStops.push(`${test.name} · ${row.label}: ${reason}`); }
      }
    }
  }
  const stops = lines.filter((l) => l.includes('STOP RULE HIT')).length;
  const subject = `Ad tests: ${stops ? `${stops} campaign(s) hit a stop rule` : 'all within rules'}`;
  const body = lines.join('\n').trim();
  console.log(`${subject}\n\n${body}`);
  if (!send) return;

  // A rule hit is a finding, not a broken agent: 'info', never 'error'.
  await notify({ subject, body, status: 'info', category: 'paid-ads' });
  if (newStops.length) {
    await notify({
      subject: `Ad test stop rule hit: ${newStops.length} new`,
      body: `${newStops.join('\n')}\n\nNothing was paused. Pause in Ads Manager if you agree.\n\n${body}`,
      status: 'info', category: 'paid-ads', immediate: true,
    });
  }
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    try { await notify({ subject: 'Ad test monitor failed', body: String(err?.stack || err), status: 'error', category: 'paid-ads' }); } catch { /* logged */ }
    process.exit(1);
  });
}
