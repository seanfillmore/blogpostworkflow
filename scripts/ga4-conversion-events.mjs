/**
 * Phase 0 Task 3 — explain the GA4 "conversion" overcount by breaking it down
 * per event name. If events other than `purchase` are marked as key events,
 * GA4's conversion count balloons past actual orders and any ad optimization
 * on it optimizes for the wrong thing.
 *
 *   node scripts/ga4-conversion-events.mjs [days]   (default 30)
 */
import { readFileSync } from 'fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const PROPERTY_ID = env.GOOGLE_ANALYTICS_PROPERTY_ID;
async function token() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error('OAuth: ' + (await res.text()).slice(0, 200));
  return (await res.json()).access_token;
}

async function runReport(body) {
  const t = await token();
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('runReport: ' + (await res.text()).slice(0, 300));
  return res.json();
}

const days = Number(process.argv[2]) || 30;
const end = new Date().toISOString().slice(0, 10);
const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

// keyEvents = the modern "conversions". Also pull eventCount for context.
const rep = await runReport({
  dateRanges: [{ startDate: start, endDate: end }],
  dimensions: [{ name: 'eventName' }],
  metrics: [{ name: 'keyEvents' }, { name: 'eventCount' }],
  orderBys: [{ metric: { metricName: 'keyEvents' }, desc: true }],
  limit: 50,
});

console.log(`\nGA4 events — ${days}d (${start}..${end}), property ${PROPERTY_ID}`);
console.log('─'.repeat(60));
console.log('  keyEvents  eventCount  eventName');
let totalKey = 0;
for (const row of rep.rows || []) {
  const name = row.dimensionValues[0].value;
  const key = Math.round(parseFloat(row.metricValues[0].value));
  const cnt = Math.round(parseFloat(row.metricValues[1].value));
  totalKey += key;
  const flag = key > 0 && name !== 'purchase' ? '  <-- inflates "conversions" if not purchase' : '';
  if (key > 0 || ['purchase', 'add_to_cart', 'begin_checkout', 'view_item'].includes(name))
    console.log(`  ${String(key).padStart(8)}  ${String(cnt).padStart(9)}  ${name}${flag}`);
}
console.log('─'.repeat(60));
console.log(`  TOTAL keyEvents (GA4 "conversions"): ${totalKey}`);
console.log('  Compare to actual Shopify orders (scripts/growth-scoreboard.mjs). If total >> orders,');
console.log('  the fix is: mark ONLY `purchase` as a key event, and set Google Ads primary');
console.log('  conversion = the purchase import, not a page-view/engagement event.');
