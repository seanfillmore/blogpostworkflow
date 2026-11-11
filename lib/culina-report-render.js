/**
 * Culina monthly report and stock-alert email rendering. Pure: no I/O.
 * Inline CSS only, table layout, no images, no web fonts: the reader uses Hushmail
 * webmail and Apple Mail on iPad, and Hushmail blocks remote content.
 * Money is signed (costs negative) and shown with a true minus sign.
 */
const C = { bg: '#f6f4f1', surface: '#ffffff', text: '#1d1b19', muted: '#6a645d', rule: '#ddd6cd', accent: '#9a3b1c', good: '#2f6b3a', bad: '#a32b22', warn: '#8a5a00' };
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Helvetica Neue', Arial, sans-serif";
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const SHIP_WARN_DAYS = 14;
const DAY_MS = 86400000;

const PNL_LABELS = {
  sales: 'Sales', fba: 'FBA fulfilment', referral: 'Referral fees', promotions: 'Promotions', refunds: 'Refunds',
  cogs: 'Product cost', contribution: 'Contribution', adSpend: 'Ad spend', ad: 'Ad spend', freight: 'Freight to Amazon',
  storage: 'Storage and AWD', couponFees: 'Coupon and deal fees', reimbursements: 'Amazon reimbursements', net: 'Net',
};
const PNL_STRONG = new Set(['contribution', 'net']);
const DEFAULT_GOAL_BY = '2027-11';
const GOAL_NOTE = 'Last month here is ordered sales by Pacific calendar month. The P&L uses Amazon settlement data, so the two sales figures can differ slightly.';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (n) => Math.round(Math.abs(n)).toLocaleString('en-US');
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const money = (n) => (!isNum(n) ? 'n/a' : `${n < 0 && Math.round(n) !== 0 ? '−' : ''}$${num(n)}`);
const signedMoney = (n) => (!isNum(n) ? 'n/a' : n > 0 ? `+$${num(n)}` : money(n));
const units = (n) => (isNum(n) ? (Math.round(n) + 0).toLocaleString('en-US').replace(/^-0$/, '0') : 'no forecast');

function monthName(m) {
  const g = /^(\d{4})-(\d{2})$/.exec(String(m ?? ''));
  return g ? `${MONTHS[+g[2] - 1]} ${g[1]}` : String(m ?? '');
}
function monthShort(m) {
  const g = /^(\d{4})-(\d{2})$/.exec(String(m ?? ''));
  return g ? `${SHORT[+g[2] - 1]} ${g[1].slice(2)}` : String(m ?? '');
}
function dateLabel(d) {
  const g = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d ?? ''));
  return g ? `${+g[3]} ${SHORT[+g[2] - 1]} ${g[1]}` : String(d ?? '');
}
const daysUntil = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// ---- html helpers -------------------------------------------------------
const TD = `padding:8px 10px;border-bottom:1px solid ${C.rule};font-family:${SANS};font-size:14px;color:${C.text};white-space:nowrap;`;
const NUM = 'text-align:right;font-variant-numeric:tabular-nums;';
const th = (t, right) => `<th style="padding:8px 10px;border-bottom:2px solid ${C.rule};background:${C.bg};font-family:${SANS};font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};text-align:${right ? 'right' : 'left'};white-space:nowrap;">${esc(t)}</th>`;
const td = (t, { right, color, bold, bg, raw, wrap } = {}) =>
  `<td style="${wrap ? TD.replace('white-space:nowrap;', '') : TD}${right ? NUM : ''}${color ? `color:${color};` : ''}${bold ? 'font-weight:700;' : ''}${bg ? `background:${bg};` : ''}">${raw ? t : esc(t)}</td>`;
const wrapTable = (head, rows) =>
  `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid ${C.rule};background:${C.surface};"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;background:${C.surface};"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
const h2 = (t) => `<h2 style="margin:0 0 10px;padding:0 0 6px;border-bottom:1px solid ${C.rule};font-family:${SERIF};font-size:21px;line-height:1.2;color:${C.text};">${esc(t)}</h2>`;
const para = (t, { color = C.muted, size = 13, raw } = {}) => `<p style="margin:8px 0 0;font-family:${SANS};font-size:${size}px;line-height:1.5;color:${color};">${raw ? t : esc(t)}</p>`;
const section = (title, body) => `<tr><td style="padding:22px 0 0;background:${C.bg};">${h2(title)}${body}</td></tr>`;
const page = (title, inner, preheader) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>` +
  `<body style="margin:0;padding:0;background:${C.bg};"><div style="display:none;max-height:0;overflow:hidden;">${esc(preheader)}</div>` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:20px 16px;background:${C.bg};">` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:${C.bg};">${inner}</table></td></tr></table></body></html>`;
const header = (title, sub) =>
  `<tr><td style="padding:0 0 4px;background:${C.bg};"><div style="font-family:${SANS};font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};">Culina</div>` +
  `<h1 style="margin:6px 0 0;font-family:${SERIF};font-size:28px;line-height:1.15;color:${C.text};">${esc(title)}</h1>${sub ? para(sub) : ''}</td></tr>`;

// ---- sections -----------------------------------------------------------
function projectionRow(p, reportDate) {
  const out = p.onHand === 0;
  const soon = !out && p.shipBy && reportDate && daysUntil(reportDate, p.shipBy) <= SHIP_WARN_DAYS;
  const colour = out ? C.bad : soon ? C.warn : undefined;
  let ship;
  if (p.shipQty === null || p.shipQty === undefined) ship = 'no forecast';
  else if (!p.shipBy && p.shipQty === 0) ship = 'No shipment needed in 90 days';
  else ship = p.shipBy ? `${units(p.shipQty)} units by ${dateLabel(p.shipBy)}` : `${units(p.shipQty)} units needed`;
  const label = out ? `${esc(p.label)} <span style="font-size:11px;font-weight:700;color:${C.bad};">OUT OF STOCK</span>` : esc(p.label);
  return (
    `<tr>${td(label, { raw: true, color: colour, bold: !!colour, wrap: true })}${td(units(p.onHand), { right: true, color: colour })}` +
    `${td(isNum(p.coverDays) ? `${p.coverDays} days` : 'no forecast', { right: true, color: colour })}` +
    `${td(units(p.forecast30), { right: true })}${td(units(p.forecast60), { right: true })}${td(units(p.forecast90), { right: true })}` +
    `${td(ship, { color: colour, bold: !!colour, wrap: true })}</tr>`
  );
}
function componentWhere(c, lower) {
  if (c.sourced) return `China, 45-day lead${c.orderBy ? `, order by ${dateLabel(c.orderBy)}` : ''}`;
  return `${lower ? 'made' : 'Made'} in house, 14-day lead${c.needBy ? `, make by ${dateLabel(c.needBy)}` : ''}`;
}
const actualCell = (n) => (isNum(n) ? units(n) : 'n/a');
function projectionSection(m) {
  const rows = (m.projection || []).map((p) => projectionRow(p, m.reportDate)).join('');
  let html = wrapTable(['Product', 'On hand', 'Cover', '30 days', '60 days', '90 days', 'Ship'].map((t, i) => th(t, i > 0 && i < 6)).join(''), rows);
  html += para('On hand counts Amazon stock, AWD and inbound shipments. Forecast is units expected to sell. Rows in amber ship within 14 days.');
  const comps = m.components || [];
  if (comps.length) {
    const crow = comps
      .map((c) => {
        const where = componentWhere(c, false);
        return `<tr>${td(c.name)}${td(units(c.shipQty), { right: true })}${td(isNum(c.coverDays) ? `${c.coverDays} days` : 'no forecast', { right: true })}${td(where)}</tr>`;
      })
      .join('');
    html += `<h3 style="margin:18px 0 8px;font-family:${SERIF};font-size:16px;color:${C.text};">Components to make or order</h3>` +
      wrapTable(['Part', 'Needed', 'Cover', 'Sourcing'].map((t, i) => th(t, i === 1 || i === 2)).join(''), crow);
  }
  return section('Stock and what to ship', html);
}
function forecastSection(m) {
  const f = m.forecastVsActual;
  if (!f) return section('Forecast vs actual', para('First report, no prior forecast to compare against.', { size: 14 }));
  const rows = f
    .map((r) => {
      const diff = isNum(r.forecast30) && isNum(r.actual) ? r.actual - r.forecast30 : null;
      const pct = diff !== null && r.forecast30 > 0 ? ` (${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(Math.round((diff / r.forecast30) * 100))}%)` : '';
      return `<tr>${td(r.label)}${td(units(r.forecast30), { right: true })}${td(actualCell(r.actual), { right: true })}${td(diff === null ? 'n/a' : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(Math.round(diff))}${pct}`, { right: true })}</tr>`;
    })
    .join('');
  return section('Forecast vs actual', wrapTable(['Product', 'Forecast', 'Actual', 'Difference'].map((t, i) => th(t, i > 0)).join(''), rows) + para('Units forecast last month against units actually sold.'));
}
function salesSection(m) {
  const data = m.monthlySales || [];
  const max = Math.max(1, ...data.map((d) => d.sales || 0));
  const last = data.length - 1;
  const rows = data
    .map((d, i) => {
      const w = Math.max(1, Math.round(((d.sales || 0) / max) * 100));
      const fill = i === last ? C.accent : '#3a3632';
      return `<tr><td style="padding:4px 10px 4px 0;font-family:${SANS};font-size:13px;color:${C.muted};white-space:nowrap;width:64px;background:${C.surface};">${esc(monthShort(d.month))}</td>` +
        `<td style="padding:4px 0;background:${C.surface};"><table role="presentation" cellpadding="0" cellspacing="0" width="${w}%"><tr><td style="background:${fill};height:16px;font-size:1px;line-height:16px;">&nbsp;</td></tr></table></td>` +
        `<td style="padding:4px 0 4px 10px;font-family:${SANS};font-size:13px;text-align:right;white-space:nowrap;width:80px;font-variant-numeric:tabular-nums;color:${C.text};background:${C.surface};">${esc(money(d.sales))}</td></tr>`;
    })
    .join('');
  const body = data.length
    ? `<div style="border:1px solid ${C.rule};background:${C.surface};padding:12px 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.surface};">${rows}</table></div>` + para('Ordered product sales on Amazon, by month.')
    : para('No monthly sales available.', { size: 14 });
  return section('Monthly sales', body);
}
function pnlSection(m) {
  const adsDown = (m.sourceErrors || []).includes('ads');
  const rows = (m.pnl || [])
    .map((r) => {
      const strong = PNL_STRONG.has(r.line);
      const isAd = r.line === 'adSpend' || r.line === 'ad' || (adsDown && r.line === 'net');
      const curr = isAd && adsDown ? null : r.curr;
      const chg = isAd && adsDown ? null : r.change;
      const cc = isNum(chg) && chg !== 0 ? (chg > 0 ? C.good : C.bad) : undefined;
      return `<tr>${td(PNL_LABELS[r.line] || r.line, { bold: strong })}${td(money(curr), { right: true, bold: strong })}${td(money(isAd && adsDown ? null : r.prev), { right: true, color: C.muted })}${td(signedMoney(chg), { right: true, color: cc })}</tr>`;
    })
    .join('');
  const hdr = ['', monthName(m.month), 'Month before', 'Change'].map((t, i) => th(t, i > 0)).join('');
  return section('Profit and loss', wrapTable(hdr, rows) + para("Calculated from Amazon's settlement data, ad reports and our product costs, so it can differ slightly from SellerBoard.") + para('Costs are negative. Net is after ad spend, freight to Amazon and storage.'));
}
function goalSection(m) {
  const g = m.goal || {};
  const [lo, hi] = g.target || [75000, 100000];
  const pct = isNum(g.lastMonth) && lo > 0 ? Math.round((g.lastMonth / lo) * 100) : null;
  const lines = [
    ['Last month', money(g.lastMonth)],
    ['Monthly target', `${money(lo)} to ${money(hi)}`],
    ['Share of the low target', pct === null ? 'n/a' : `${pct}%`],
    [`Growth needed each month to reach ${money(lo)} by ${monthName(g.by || DEFAULT_GOAL_BY)}`, isNum(g.neededMonthlyGrowthPct) ? `${g.neededMonthlyGrowthPct}%` : 'n/a'],
  ];
  const rows = lines.map(([k, v]) => `<tr>${td(k)}${td(v, { right: true, bold: true })}</tr>`).join('');
  return section('Goal progress', `<div style="border:1px solid ${C.rule};background:${C.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${C.surface};">${rows}</table></div>` + para(GOAL_NOTE));
}
function notes(m) {
  const items = [];
  const errs = m.sourceErrors || [];
  const msg = { ads: 'Ad spend not available this month, so ad spend and net are shown as n/a.', finance: 'Amazon finance data was not available, so P&L figures may be missing.', seasonal: 'Seasonal search data was not available, so forecasts use recent sales pace only.', stock: 'Stock data was not available, so the stock table may be incomplete.' };
  for (const e of errs) items.push(msg[e] || `Source "${e}" was not available.`);
  for (const mo of m.adsMissingMonths || []) items.push(`Ad spend for ${monthName(mo)} is not available (Amazon keeps ad reports for about 60 days), so that month's ad spend and net show n/a.`);
  if ((m.unassignedCampaigns || []).length) items.push(`Ad campaigns we could not assign to Culina or Real Skin Care, so left out of ad spend: ${m.unassignedCampaigns.join(', ')}.`);
  if ((m.missingCogs || []).length) items.push(`No product cost on file for: ${m.missingCogs.join(', ')}. Product cost and contribution are understated.`);
  if ((m.unmappedStock || []).length) items.push(`Stock we could not match to a product: ${m.unmappedStock.map((u) => `${u.sku} (${u.onhand} on hand, ${u.inbound} inbound)`).join(', ')}.`);
  return items;
}

export function renderMonthly(model) {
  const m = model || {};
  const title = `Culina monthly report: ${monthName(m.month)}`;
  const n = notes(m);
  const noteHtml = n.length ? section('Data notes', `<ul style="margin:0;padding-left:20px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};">${n.map((x) => `<li style="margin:0 0 4px;">${esc(x)}</li>`).join('')}</ul>`) : '';
  const inner = header(title, m.reportDate ? `Prepared ${dateLabel(m.reportDate)}` : '') + projectionSection(m) + forecastSection(m) + salesSection(m) + pnlSection(m) + goalSection(m) + noteHtml;
  const html = page(title, inner, `Stock, forecast and P&L for ${monthName(m.month)}`);

  // plain text
  const T = [title, ''];
  T.push('STOCK AND WHAT TO SHIP');
  for (const p of m.projection || []) {
    const ship = p.shipQty == null ? 'no forecast' : !p.shipBy && p.shipQty === 0 ? 'No shipment needed in 90 days' : p.shipBy ? `${units(p.shipQty)} units by ${dateLabel(p.shipBy)}` : `${units(p.shipQty)} units needed`;
    T.push(`- ${p.label}${p.onHand === 0 ? ' (OUT OF STOCK)' : ''}: ${units(p.onHand)} on hand, cover ${isNum(p.coverDays) ? `${p.coverDays} days` : 'no forecast'}, forecast 30/60/90 days ${units(p.forecast30)}/${units(p.forecast60)}/${units(p.forecast90)}. Ship: ${ship}`);
  }
  if ((m.components || []).length) {
    T.push('', 'Components to make or order');
    for (const c of m.components) T.push(`- ${c.name}: ${units(c.shipQty)} needed, ${componentWhere(c, true)}`);
  }
  T.push('', 'FORECAST VS ACTUAL');
  if (!m.forecastVsActual) T.push('First report, no prior forecast to compare against.');
  else for (const r of m.forecastVsActual) T.push(`- ${r.label}: forecast ${units(r.forecast30)}, actual ${actualCell(r.actual)}`);
  T.push('', 'MONTHLY SALES');
  for (const d of m.monthlySales || []) T.push(`- ${monthShort(d.month)}: ${money(d.sales)}`);
  T.push('', 'PROFIT AND LOSS', `${monthName(m.month)} against the month before. Calculated from Amazon's settlement data, ad reports and our product costs, so it can differ slightly from SellerBoard.`);
  const adsDown = (m.sourceErrors || []).includes('ads');
  for (const r of m.pnl || []) {
    const ad = (r.line === 'adSpend' || r.line === 'ad' || r.line === 'net') && adsDown;
    T.push(`- ${PNL_LABELS[r.line] || r.line}: ${money(ad ? null : r.curr)} (before ${money(ad ? null : r.prev)}, change ${signedMoney(ad ? null : r.change)})`);
  }
  const g = m.goal || {};
  const [glo, ghi] = g.target || [75000, 100000];
  T.push('', 'GOAL PROGRESS', `Last month: ${money(g.lastMonth)}`, `Monthly target: ${money(glo)} to ${money(ghi)}`, `Growth needed each month to reach ${money(glo)} by ${monthName(g.by || DEFAULT_GOAL_BY)}: ${isNum(g.neededMonthlyGrowthPct) ? `${g.neededMonthlyGrowthPct}%` : 'n/a'}`, GOAL_NOTE);
  if (n.length) { T.push('', 'DATA NOTES'); for (const x of n) T.push(`- ${x}`); }
  return { subject: title, html, text: T.join('\n') + '\n' };
}

/**
 * `opts`: { alertBelowDays, leadDays, sourcedLeadDays } from config. Rows may carry the
 * on-hand split (fba, awd, inbound) and the quantity to ship with its date: shipQty with
 * shipBy for an Amazon item, or with needBy and `component: true` for a component.
 */
export function renderAlert(rows, opts = {}) {
  const list = rows || [];
  const below = opts.alertBelowDays ?? 60;
  const lead = opts.leadDays ?? 14;
  const sourcedLead = opts.sourcedLeadDays ?? 45;
  const subject = `Culina stock alert: ${list.length} item(s) low`;
  const why = (r) => (r.reason === 'out_of_stock' || r.onHand === 0 ? 'Out of stock' : r.reason === 'reminder' ? 'Still low (reminder)' : 'Low stock');
  const split = (r) => ([r.fba, r.awd, r.inbound].every(isNum) ? `FBA ${units(r.fba)} / AWD ${units(r.awd)} / inbound ${units(r.inbound)}` : '');
  const onHandText = (r) => `${units(r.onHand)}${split(r) ? ` (${split(r)})` : ''}`;
  const toShip = (r) => {
    if (r.shipQty === null || r.shipQty === undefined) return 'no forecast';
    const date = r.component ? r.needBy : r.shipBy;
    if (r.component) return date ? `make ${units(r.shipQty)} by ${dateLabel(date)}` : `make ${units(r.shipQty)}`;
    if (!date && r.shipQty === 0) return 'none needed in 90 days';
    return date ? `${units(r.shipQty)} units by ${dateLabel(date)}` : `${units(r.shipQty)} units needed`;
  };
  const trs = list
    .map((r) => {
      const out = r.onHand === 0 || r.reason === 'out_of_stock';
      const col = out ? C.bad : C.warn;
      return `<tr>${td(r.label, { bold: true, wrap: true })}${td(onHandText(r), { right: true, wrap: true })}${td(isNum(r.coverDays) ? `${r.coverDays} days` : 'none', { right: true, color: col, bold: true })}${td(why(r), { color: col, bold: true })}${td(toShip(r), { wrap: true })}</tr>`;
    })
    .join('');
  const note = `Cover counts Amazon stock, AWD and inbound shipments. We alert when cover falls below ${below} days. The quantity brings cover back to the target. Made in house items take about ${lead} days to restock, sourced parts about ${sourcedLead}.`;
  const body = section('Low stock', wrapTable(['Product', 'On hand', 'Cover', 'Status', 'To ship'].map((t, i) => th(t, i === 1 || i === 2)).join(''), trs) + para(note));
  const html = page(subject, header(subject, '') + body, subject);
  const text = [subject, '', ...list.map((r) => `- ${r.label}: ${onHandText(r)} on hand, cover ${isNum(r.coverDays) ? `${r.coverDays} days` : 'none'}. ${why(r)}. To ship: ${toShip(r)}`), '', note].join('\n') + '\n';
  return { subject, html, text };
}
