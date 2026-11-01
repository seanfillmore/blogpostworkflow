import { shopifyGraphQL } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
let cursor = null; const orders = [];
do {
  const r = await shopifyGraphQL(`query($c: String) { orders(first: 100, after: $c, reverse: true, query: "created_at:>=2026-06-15") { pageInfo { hasNextPage endCursor } nodes { name createdAt tags sourceName customAttributes { key value } landingPageUrl: customerJourneySummary { firstVisit { landingPage } } lineItems(first: 30) { nodes { title quantity customAttributes { key value } originalTotalSet { shopMoney { amount } } } } } } }`, { c: cursor });
  orders.push(...r.orders.nodes); cursor = r.orders.pageInfo.hasNextPage ? r.orders.pageInfo.endCursor : null;
} while (cursor);
const ocuRe = /ocu|zipify|upsell/i;
let ocuOrders = 0; const keys = new Map(); const examples = [];
for (const o of orders) {
  const hits = [];
  for (const t of o.tags) if (ocuRe.test(t)) hits.push(`tag:${t}`);
  for (const a of o.customAttributes) { keys.set(`order:${a.key}`, (keys.get(`order:${a.key}`) || 0) + 1); if (ocuRe.test(a.key + a.value)) hits.push(`attr:${a.key}=${a.value}`); }
  for (const li of o.lineItems.nodes) for (const a of li.customAttributes) { keys.set(`line:${a.key}`, (keys.get(`line:${a.key}`) || 0) + 1); if (ocuRe.test(a.key + a.value)) hits.push(`line:${li.title}:${a.key}=${String(a.value).slice(0, 40)}`); }
  if (hits.length) { ocuOrders++; if (examples.length < 8) examples.push({ name: o.name, at: o.createdAt, landing: o.landingPageUrl?.firstVisit?.landingPage?.slice(0, 80), hits: hits.slice(0, 4) }); }
}
console.log(`orders since 2026-06-15: ${orders.length}; with an OCU/upsell marker: ${ocuOrders}`);
console.log('attribute keys seen:', JSON.stringify(Object.fromEntries([...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))));
console.log(JSON.stringify(examples, null, 2));
