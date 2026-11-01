import { shopifyGraphQL } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
const r = await shopifyGraphQL(`{ orders(first: 100, reverse: true, query: "created_at:>=2026-06-15") { nodes { name createdAt tags currentSubtotalPriceSet { shopMoney { amount } } lineItems(first: 30) { nodes { title quantity customAttributes { key } discountedTotalSet { shopMoney { amount } } } } } } }`);
let total = 0, all = 0;
for (const o of r.orders.nodes) {
  all += Number(o.currentSubtotalPriceSet.shopMoney.amount);
  const ocuTags = o.tags.filter((t) => /ocu/i.test(t));
  if (!ocuTags.length) continue;
  const lines = o.lineItems.nodes.filter((l) => l.customAttributes.some((a) => /_ocu/.test(a.key)));
  const v = lines.reduce((n, l) => n + Number(l.discountedTotalSet.shopMoney.amount), 0); total += v;
  console.log(o.name, o.createdAt.slice(0, 10), ocuTags.join(' + '), '| order subtotal $' + o.currentSubtotalPriceSet.shopMoney.amount, '| upsell lines $' + v.toFixed(2), lines.map((l) => l.title.slice(0, 30)).join('; ') || '(post-purchase: not a tagged line)');
}
console.log(`upsell line revenue on tagged lines $${total.toFixed(2)} of $${all.toFixed(2)} subtotal across ${r.orders.nodes.length} orders`);
