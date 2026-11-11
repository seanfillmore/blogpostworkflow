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
    { name: 'Cleaning soap', shipQty: 300, sourced: false, orderBy: null, coverDays: 60 },
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
  assert.match(html, /1 other item has nothing to ship in the next 45 days/); // Oil: no shipment needed, hidden
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

test('fix1: no "raw material" wording; components heading', () => {
  const { html, text } = renderMonthly(base());
  assert.ok(!/raw material/i.test(html) && !/raw material/i.test(text));
  assert.match(html, /Components to make or order/); assert.match(text, /Components to make or order/);
});
test('fix2: no negative zero', () => {
  const m = base(); m.projection[0].onHand = -0; m.projection[0].forecast30 = -0.2;
  const { html, text } = renderMonthly(m);
  assert.ok(!/-0\b/.test(text)); assert.ok(!/>-0</.test(html));
});
test('fix3: shipQty without shipBy', () => {
  const m = base(); m.projection[0].shipBy = null; m.projection[0].shipQty = 400;
  const { html, text } = renderMonthly(m);
  assert.match(html, /400 units needed/); assert.match(text, /400 units needed/);
  assert.ok(!/units by (<|\s*$|\n)/m.test(html + text));
});
test('fix4: zero low target gives no Infinity or NaN', () => {
  const m = base(); m.goal.target = [0, 100000];
  const { html, text } = renderMonthly(m);
  assert.ok(!/Infinity|NaN/.test(html + text));
});
test('fix5: net is n/a when ads are down even if given', () => {
  const m = base(); m.pnl.find((r) => r.line === 'net').curr = 4000;
  const { html, text } = renderMonthly(m);
  const row = html.split('<tr').find((r) => r.includes('>Net<'));
  assert.ok(!row.includes('$4,000')); assert.ok(!/Net: \$4,000/.test(text));
});
test('fix6: product and ship cells wrap', () => {
  const { html } = renderMonthly(base());
  const row = html.split('<tr').find((r) => r.includes('Cast Iron Soap 3 Pack'));
  const cells = row.split('<td').slice(1);
  assert.ok(!cells[0].includes('white-space:nowrap'));
  assert.ok(!cells[5].split('>')[0].includes('white-space:nowrap')); // Ship is the 6th cell; its own style wraps (inner lines are nowrap by design)
});
test('fix7: alert escapes', () => {
  const r = renderAlert([{ label: 'A <b>&"x"', coverDays: 3, onHand: 1, reason: 'below_threshold' }]);
  assert.match(r.html, /A &lt;b&gt;&amp;&quot;x&quot;/); assert.ok(!r.html.includes('<b>&'));
});

test('final-fix: alert rows show the on-hand split and the quantity with its date', () => {
  const r = renderAlert([
    { label: 'Supreme Care Set', coverDays: 13, onHand: 181, fba: 100, awd: 60, inbound: 21, shipQty: 1732, shipBy: '2026-11-11', reason: 'below_threshold' },
    { label: 'cleaning soap (all products)', coverDays: 33, onHand: 1018, fba: 800, awd: 200, inbound: 18, shipQty: 3173, needBy: '2026-11-11', component: true, reason: 'below_threshold' },
  ], { alertBelowDays: 45 });
  for (const s of [r.html, r.text]) {
    assert.match(s, /FBA 100 \/ AWD 60 \/ inbound 21/);
    assert.match(s, /1,732 units by 11 Nov 2026/);
    assert.match(s, /make 3,173 by 11 Nov 2026/);
    assert.match(s, /below 45 days/);
    assert.doesNotMatch(s, /60 days/);
    assert.doesNotMatch(s, /—/);
  }
});

test('final-fix: made-in-house component shows make by date', () => {
  const m = base();
  m.components[1].needBy = '2026-11-25';
  const { html, text } = renderMonthly(m);
  assert.match(html, /make by 25 Nov 2026/);
  assert.match(text, /make by 25 Nov 2026/);
});

test('final-fix: month-before ad data missing is a data note', () => {
  const m = { ...base(), sourceErrors: [], adsMissingMonths: ['2026-09'] };
  const { html, text } = renderMonthly(m);
  for (const s of [html, text]) assert.match(s, /Ad spend for September 2026 is not available/);
});

test('final-fix: unknown actual renders n/a, not no forecast', () => {
  const m = { ...base(), forecastVsActual: [{ label: 'Gone', forecast30: 40, actual: null }] };
  const { html, text } = renderMonthly(m);
  assert.match(text, /forecast 40, actual n\/a/);
  assert.doesNotMatch(html.split('Forecast vs actual')[1].split('Monthly sales')[0], /no forecast/);
});

test('final-fix: goal text from config and the ordered-sales note', () => {
  const m = { ...base(), goal: { lastMonth: 29900, target: [50000, 90000], by: '2028-03', neededMonthlyGrowthPct: 3.1 } };
  const { html, text } = renderMonthly(m);
  for (const s of [html, text]) {
    assert.match(s, /reach \$50,000 by March 2028/);
    assert.doesNotMatch(s, /November 2027/);
    assert.match(s, /ordered sales/);
    assert.match(s, /settlement/);
  }
});

test('priority: ASIN on every product line, in HTML and text', () => {
  const m = base();
  m.projection[0].asin = 'B08BTQK5Z9'; m.projection[1].asin = 'B08BTVXLXN'; m.projection[2].asin = 'B0771WC1Q1';
  const { html, text } = renderMonthly(m);
  // Oil (B0771WC1Q1) needs no shipment, so the 45-day rule hides it.
  for (const a of ['B08BTQK5Z9', 'B08BTVXLXN']) { assert.ok(html.includes(a), a); assert.ok(text.includes(a), a); }
  assert.match(html, />ASIN</);
});

test('priority: out of stock first, then soonest ship date (lines with nothing to ship are hidden)', () => {
  const m = base();
  m.projection = [
    { asin: 'A-NOFC', label: 'No forecast', onHand: 5, coverDays: null, shipBy: null, shipQty: null },
    { asin: 'A-LATE', label: 'Ships later', onHand: 400, coverDays: 80, shipBy: '2026-12-20', shipQty: 100 },
    { asin: 'A-NONE', label: 'Nothing needed', onHand: 900, coverDays: 300, shipBy: null, shipQty: 0 },
    { asin: 'A-OOS2', label: 'Out two', onHand: 0, coverDays: 0, shipBy: '2026-11-10', shipQty: 50 },
    { asin: 'A-SOON', label: 'Ships soon', onHand: 100, coverDays: 20, shipBy: '2026-11-10', shipQty: 300 },
    { asin: 'A-OOS1', label: 'Out one', onHand: 0, coverDays: 0, shipBy: '2026-11-10', shipQty: 900 },
  ].map((p) => ({ forecast30: 1, forecast60: 2, forecast90: 3, ...p }));
  const { html, text } = renderMonthly(m);
  const order = (s) => ['A-OOS1', 'A-OOS2', 'A-SOON', 'A-LATE'].map((a) => s.indexOf(a));
  for (const s of [html, text]) {
    const idx = order(s);
    assert.ok(idx.every((v) => v >= 0), 'all present');
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'in priority order');
  }
});

test('priority: an out-of-stock row is visibly marked across the whole row', () => {
  const m = base();
  m.projection = [{ asin: 'A-OOS', label: 'Gone', onHand: 0, coverDays: 0, forecast30: 1, forecast60: 2, forecast90: 3, shipBy: '2026-11-10', shipQty: 50 }];
  const { html } = renderMonthly(m);
  const at = html.indexOf('A-OOS');
  const row = html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
  assert.match(row, /OUT OF STOCK/);
  assert.ok((row.match(/background:#f7dfdc/gi) || []).length >= 6, 'every cell tinted');
});

test('45-day window: only lines that ship within 45 days of the report date (or are out of stock) are shown', () => {
  const m = base();
  m.reportDate = '2026-11-10';
  m.projection = [
    { asin: 'A-OOS', label: 'Gone', onHand: 0, coverDays: 0, shipBy: '2026-11-10', shipQty: 50 },
    { asin: 'A-D45', label: 'Day 45', onHand: 300, coverDays: 100, shipBy: '2026-12-25', shipQty: 200 },
    { asin: 'A-D46', label: 'Day 46', onHand: 300, coverDays: 101, shipBy: '2026-12-26', shipQty: 200 },
    { asin: 'A-NONE', label: 'Nothing', onHand: 900, coverDays: 300, shipBy: null, shipQty: 0 },
    { asin: 'A-NOFC', label: 'Unknown', onHand: 5, coverDays: null, shipBy: null, shipQty: null },
    { asin: 'A-NEW', label: 'Launch', launch: true, onHand: 0, coverDays: null, shipBy: '2026-11-10', shipQty: 100 },
  ].map((p) => ({ forecast30: 1, forecast60: 2, forecast90: 3, ...p }));
  m.components = [
    { name: 'Soon soap', shipQty: 100, sourced: false, needBy: '2026-11-20', orderBy: null, coverDays: 30 },
    { name: 'Later oil', shipQty: 100, sourced: false, needBy: '2027-02-01', orderBy: null, coverDays: 120 },
    { name: 'China part', shipQty: 100, sourced: true, needBy: '2027-01-10', orderBy: '2026-11-26', coverDays: 60 },
    { name: 'Idle stick', shipQty: 0, sourced: false, needBy: null, orderBy: null, coverDays: 400 },
  ];
  const { html, text } = renderMonthly(m);
  for (const s of [html, text]) {
    for (const shown of ['A-OOS', 'A-D45', 'A-NEW', 'Soon soap', 'China part']) assert.ok(s.includes(shown), `${shown} shown`);
    for (const hidden of ['A-D46', 'A-NONE', 'A-NOFC', 'Later oil', 'Idle stick']) assert.ok(!s.includes(hidden), `${hidden} hidden`);
    assert.match(s, /3 other items have nothing to ship in the next 45 days/);
  }
});

test('layout: ship quantity and date sit on two unbroken lines; product and ship cells have a minimum width', () => {
  const m = base();
  const { html } = renderMonthly(m);
  const at = html.indexOf('Cast Iron Soap 3 Pack');
  const row = html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
  const cells = row.split('<td').slice(1);
  assert.match(cells[5], /<span style="white-space:nowrap;">400 units<\/span><br><span style="white-space:nowrap;[^"]*">by 20 Nov 2026<\/span>/);
  assert.match(cells[0], /min-width:\d+px/);
  assert.match(cells[5], /min-width:\d+px/);
});

test('layout: one combined 30 / 60 / 90 forecast column; missing numbers show a dash', () => {
  const m = base();
  m.projection = [
    { asin: 'A1', label: 'Kit', onHand: 50, coverDays: 20, forecast30: 99, forecast60: 217, forecast90: 338, shipBy: '2026-11-10', shipQty: 400 },
    { asin: 'A2', label: 'New one', launch: true, onHand: 0, coverDays: null, forecast30: null, forecast60: null, forecast90: null, shipBy: '2026-11-10', shipQty: 100 },
  ];
  const { html } = renderMonthly(m);
  assert.match(html, />Forecast 30 \/ 60 \/ 90 days</);
  assert.match(html, /99 \/ 217 \/ 338/);
  const at = html.indexOf('New one');
  const row = html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
  assert.ok(!row.includes('no forecast'), 'no repeated "no forecast" text');
  assert.match(row, />\u2013</);
});
