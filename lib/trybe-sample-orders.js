// lib/trybe-sample-orders.js
//
// Reads the Shopify orders Trybe creates for creator samples ($0, app
// "Trybe UGC", tags `sample-request` + `trybe`). Shared by agents/trybe-review
// (who to nudge, in the digest) and agents/creator-outreach (who to email).
// The pure interpretation of these orders lives in lib/trybe-samples.js.
//
// lib/shopify.js throws at import without OAuth credentials, so it is imported
// lazily here and never at module scope.

export const SAMPLE_LOOKBACK_DAYS = 60;

const SAMPLE_ORDERS_QUERY = `query($c: String, $q: String) {
  orders(first: 100, after: $c, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name createdAt cancelledAt tags note email
      shippingAddress { name }
      lineItems(first: 20) { nodes { title } }
      fulfillments {
        status displayStatus deliveredAt estimatedDeliveryAt createdAt
        trackingInfo { company number url }
      }
    }
  }
}`;

export async function fetchSampleOrders({ now = Date.now(), lookbackDays = SAMPLE_LOOKBACK_DAYS, graphql } = {}) {
  const run = graphql || (await import('./shopify.js')).shopifyGraphQL;
  const since = new Date(now - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const q = `tag:sample-request created_at:>=${since}`;
  const out = [];
  let c = null;
  for (let page = 0; page < 20; page++) {
    const res = await run(SAMPLE_ORDERS_QUERY, { c, q });
    const conn = res.orders || res.data?.orders;
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return out;
    c = conn.pageInfo.endCursor;
  }
  return out;
}
