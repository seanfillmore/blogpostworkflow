/**
 * AOV analysis — paginated pull of every order in a window.
 *
 *   node scripts/aov-analysis.mjs [days]   (default 365)
 *
 * Exists because lib/shopify.js getOrders() caps at limit=250 with no Link-header
 * pagination, so any window with more than 250 orders silently truncates. June 2024
 * alone had 239 orders. That is how conflicting AOV figures ($19 vs $46) ended up
 * on record — see docs/bundle-marketing-plan.md section 5.
 *
 * Reports AOV by definition (total_price vs subtotal_price, comped orders in vs out),
 * by source, by new-vs-repeat customer, by trailing window, and by month. Use the
 * monthly trend before quoting any single number: the store has a structural break
 * around 2025-09 and averaging across it describes no actual period.
 */
import { getAccessToken, STORE, API_VERSION } from '../lib/shopify.js';

const DAYS = Number(process.argv[2] || 365);
const since = new Date(Date.now() - DAYS * 864e5).toISOString();

async function fetchAll() {
  const token = await getAccessToken();
  let url = `https://${STORE}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${since}&limit=250`;
  const out = [];
  let page = 0;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    out.push(...data.orders);
    page++;
    const link = res.headers.get('link') || '';
    const next = link.split(',').find(s => s.includes('rel="next"'));
    url = next ? next.match(/<([^>]+)>/)[1] : null;
    process.stderr.write(`\rpage ${page} — ${out.length} orders`);
    await new Promise(r => setTimeout(r, 300));
  }
  process.stderr.write('\n');
  return out;
}

const n = a => a.length;
const sum = (a, f) => a.reduce((s, o) => s + f(o), 0);
const money = o => Number(o.total_price || 0);
const subtotal = o => Number(o.subtotal_price || 0);
const aov = a => (n(a) ? sum(a, money) / n(a) : 0);
const aovSub = a => (n(a) ? sum(a, subtotal) / n(a) : 0);
const f = x => '$' + x.toFixed(2);

const orders = await fetchAll();

console.log(`\nWINDOW: trailing ${DAYS} days (since ${since.slice(0, 10)})`);
console.log(`RAW: ${n(orders)} orders, gross ${f(sum(orders, money))}\n`);

// ---- slices -------------------------------------------------------------
const cancelled = orders.filter(o => o.cancelled_at);
const test = orders.filter(o => o.test);
const zero = orders.filter(o => money(o) === 0);
const live = orders.filter(o => !o.cancelled_at && !o.test && money(o) > 0);

console.log('EXCLUSIONS');
console.log(`  cancelled          ${n(cancelled)}`);
console.log(`  test orders        ${n(test)}`);
console.log(`  $0.00 (comped)     ${n(zero)}`);
console.log(`  --> LIVE PAID      ${n(live)}  gross ${f(sum(live, money))}\n`);

console.log('AOV BY DEFINITION (live paid orders)');
console.log(`  total_price    (incl ship+tax)  ${f(aov(live))}`);
console.log(`  subtotal_price (goods only)     ${f(aovSub(live))}\n`);

console.log('AOV IF YOU DO NOT EXCLUDE ANYTHING');
const notCancelled = orders.filter(o => !o.cancelled_at);
console.log(`  all orders incl $0 comped       ${f(aov(notCancelled))}   (${n(notCancelled)} orders)`);

// ---- channel ------------------------------------------------------------
const byChannel = {};
for (const o of live) {
  const k = o.source_name || 'unknown';
  (byChannel[k] ||= []).push(o);
}
console.log('\nAOV BY SOURCE');
for (const [k, v] of Object.entries(byChannel).sort((a, b) => n(b[1]) - n(a[1]))) {
  console.log(`  ${k.padEnd(22)} ${String(n(v)).padStart(4)} orders   AOV ${f(aov(v))}   rev ${f(sum(v, money))}`);
}

// ---- new vs repeat ------------------------------------------------------
const byCustomer = {};
for (const o of live) {
  const id = o.customer?.id || `guest:${o.email || o.id}`;
  (byCustomer[id] ||= []).push(o);
}
const repeatIds = Object.entries(byCustomer).filter(([, v]) => v.length > 1).map(([k]) => k);
const repeatOrders = live.filter(o => repeatIds.includes(String(o.customer?.id || `guest:${o.email || o.id}`)));
const firstOrders = live.filter(o => !repeatIds.includes(String(o.customer?.id || `guest:${o.email || o.id}`)));
console.log('\nNEW vs REPEAT CUSTOMERS');
console.log(`  customers total      ${Object.keys(byCustomer).length}`);
console.log(`  repeat customers     ${repeatIds.length}  (${(repeatIds.length / Object.keys(byCustomer).length * 100).toFixed(1)}%)`);
console.log(`  one-order cust AOV   ${f(aov(firstOrders))}  (${n(firstOrders)} orders)`);
console.log(`  repeat-cust AOV      ${f(aov(repeatOrders))}  (${n(repeatOrders)} orders)`);
console.log(`  repeat share of rev  ${(sum(repeatOrders, money) / sum(live, money) * 100).toFixed(1)}%`);

// per-customer lifetime value in window
const ltvs = Object.values(byCustomer).map(v => sum(v, money));
const avgLtv = ltvs.reduce((a, b) => a + b, 0) / ltvs.length;
console.log(`  avg revenue PER CUSTOMER in window  ${f(avgLtv)}   <-- often mistaken for AOV`);

// ---- trailing windows ---------------------------------------------------
console.log('\nAOV BY TRAILING WINDOW (live paid)');
for (const d of [30, 60, 90, 180, 365]) {
  const cut = Date.now() - d * 864e5;
  const w = live.filter(o => new Date(o.created_at).getTime() >= cut);
  if (!n(w)) continue;
  console.log(`  last ${String(d).padStart(3)}d   ${String(n(w)).padStart(4)} orders   AOV ${f(aov(w))}   rev ${f(sum(w, money))}`);
}

// ---- units per order ----------------------------------------------------
const units = o => (o.line_items || []).reduce((s, li) => s + li.quantity, 0);
console.log(`\nUNITS PER ORDER (live paid): ${(sum(live, units) / n(live)).toFixed(2)}`);
console.log(`AVG UNIT PRICE: ${f(sum(live, subtotal) / sum(live, units))}`);

// ---- monthly trend ------------------------------------------------------
const byMonth = {};
for (const o of live) {
  const k = o.created_at.slice(0, 7);
  (byMonth[k] ||= []).push(o);
}
console.log('\nMONTHLY (live paid)');
for (const [k, v] of Object.entries(byMonth).sort()) {
  console.log(`  ${k}  ${String(n(v)).padStart(3)} orders   AOV ${f(aov(v))}   rev ${f(sum(v, money))}`);
}
