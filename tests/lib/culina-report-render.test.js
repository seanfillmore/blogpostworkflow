import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMonthly, renderAlert } from '../../lib/culina-report-render.js';

const pnl = [
  { line: 'sales', curr: 31200.5, prev: 29900, change: 1300.5 },
  { line: 'fba', curr: -5000, prev: -4800, change: -200 },
  { line: 'adSpend', curr: null, prev: -3000, change: null },
  { line: 'net', curr: null, prev: 5000, change: null },
];
const base = () => ({
  month: '2026-10',
  reportDate: '2026-11-10',
  projection: [
    { label: 'Cast Iron Soap 3 Pack', onHand: 120, coverDays: 70, forecast30: 80, forecast60: 150, forecast90: 230, shipBy: '2026-11-20', shipQty: 400 },
    { label: 'Scrub <Big>', onHand: 0, coverDays: null, forecast30: 10, forecast60: 20, forecast90: 30, shipBy: null, shipQty: null },
    { label: 'Oil', onHand: 900, coverDays: 200, forecast30: 50, forecast60: 100, forecast90: 150, shipBy: null, shipQty: 0 },
  ],
  components: [
    { name: 'Chainmail', shipQty: 500, sourced: true, orderBy: '2026-12-01', coverDays: 40 },
    { name: 'Soap base', shipQty: 300, sourced: false, orderBy: null, coverDays: 60 },
  ],
  forecastVsActual: [{ label: 'Oil', forecast30: 50, actual: 61 }],
  monthlySales: [{ month: '2026-09', sales: 31200 }, { month: '2026-10', sales: 29900 }],
  pnl,
  unassignedCampaigns: ['Mystery <Camp>'],
  missingCogs: ['SKU-9'],
  unmappedStock: [{ sku: 'ZZ', onhand: 4, inbound: 2 }],
  sourceErrors: ['ads'],
  goal: { lastMonth: 29900, target: [75000, 100000], neededMonthlyGrowthPct: 8.2 },
});

test('five section headings in order, subject', () => {
  const { subject, html } = renderMonthly(base());
  assert.equal(subject, 'Culina monthly report: October 2026');
  const heads = ['Stock and what to ship', 'Forecast vs actual', 'Monthly sales', 'Profit and loss', 'Goal progress'];
  let at = -1;
  for (const h of heads) { const i = html.indexOf(`>${h}<`); assert.ok(i > at, h); at = i; }
});
test('no svg, em dash, agency, remote images or fonts', () => {
  const { html, text } = renderMonthly(base());
  for (const s of [html, text, renderAlert([{ label: 'A', coverDays: 3, onHand: 0, reason: 'out_of_stock' }]).html]) {
    assert.ok(!/<svg/i.test(s) && !s.includes('—') && !/agenc/i.test(s) && !/fonts\.googleapis/.test(s));
    assert.ok(!/<img[^>]+src=["']?http/i.test(s));
  }
});
test('null forecastVsActual', () => {
  const m = base(); m.forecastVsActual = null;
  assert.match(renderMonthly(m).html, /First report, no prior forecast/);
});
test('ads source error', () => {
  const { html, text } = renderMonthly(base());
  assert.match(html, /Ad spend not available/);
  assert.match(text, /Ad spend not available/);
  const row = html.split('<tr').find((r) => r.includes('Ad spend'));
  assert.match(row, /n\/a/); assert.ok(!row.includes('$0'));
});
test('unassigned, escaping, data notes', () => {
  const { html } = renderMonthly(base());
  assert.match(html, /Mystery &lt;Camp&gt;/); assert.ok(!html.includes('<Camp>'));
  assert.match(html, /Scrub &lt;Big&gt;/);
  assert.match(html, /SKU-9/); assert.match(html, /ZZ/);
});
test('projection states and highlights', () => {
  const { html } = renderMonthly(base());
  assert.match(html, /OUT OF STOCK/); assert.match(html, /no forecast/);
  assert.match(html, /No shipment needed in 90 days/);
  assert.match(html, /#8a5a00/); // ship by within 14 days
  assert.match(html, /China, 45-day lead/);
});
test('money format and goal', () => {
  const { html, text } = renderMonthly(base());
  assert.match(html, /−\$5,000/); assert.match(html, /\$31,201/);
  assert.match(html, /\$75,000/); assert.match(html, /8\.2%/);
  assert.match(text, /SellerBoard/);
});
test('no data notes section when clean', () => {
  const m = base(); m.unassignedCampaigns = []; m.missingCogs = []; m.unmappedStock = []; m.sourceErrors = [];
  assert.ok(!/Data notes/.test(renderMonthly(m).html));
});
test('alert', () => {
  const r = renderAlert([{ label: 'Soap', coverDays: 40, onHand: 50, reason: 'below_threshold' }, { label: 'Oil', coverDays: null, onHand: 0, reason: 'out_of_stock' }]);
  assert.equal(r.subject, 'Culina stock alert: 2 item(s) low');
  assert.match(r.html, /Soap/); assert.match(r.text, /Oil/);
});
