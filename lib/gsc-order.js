/**
 * Search Console's searchAnalytics.query has NO `orderBy` parameter. It ignores
 * the field and returns rows sorted by CLICKS descending, truncated at
 * `rowLimit`. Nine helpers in lib/gsc.js passed `orderBy: impressions` anyway,
 * so every "top N by impressions" was really "top N by clicks" — and on pages
 * that earn few clicks, effectively arbitrary. Found 2026-09-21: the
 * moisturizer page's "top query" came back as "how do i print all this
 * information" (1 impression) instead of "how to make natural moisturizer"
 * (7,051). content-refresher takes that first row as a page's primary keyword.
 *
 * `planOrderedQuery` rewrites a request so the order can be applied locally:
 * strip `orderBy`, and when it asks for anything other than clicks (the API's
 * native order) widen `rowLimit` to the API maximum so the true top rows are in
 * the response. `applyOrder` then sorts and trims to what the caller asked for.
 * Pure, so it is testable without credentials.
 */

export const GSC_MAX_ROW_LIMIT = 25000;

export function planOrderedQuery(body) {
  const { orderBy, ...rest } = body || {};
  const order = Array.isArray(orderBy) && orderBy[0]?.fieldName ? orderBy[0] : null;
  const requestedLimit = rest.rowLimit ?? 1000;
  if (!order) return { body: rest, order: null, requestedLimit };
  const native = order.fieldName === 'clicks' && (order.sortOrder || 'DESCENDING') === 'DESCENDING';
  return {
    body: native ? rest : { ...rest, rowLimit: GSC_MAX_ROW_LIMIT },
    order: native ? null : order,
    requestedLimit,
  };
}

export function applyOrder(rows, order, requestedLimit) {
  if (!order) return rows;
  const dir = (order.sortOrder || 'DESCENDING') === 'ASCENDING' ? 1 : -1;
  const f = order.fieldName;
  return [...rows].sort((a, b) => dir * ((a?.[f] ?? 0) - (b?.[f] ?? 0))).slice(0, requestedLimit);
}
