/**
 * Zigpoll Web API v1 client — on-site survey responses.
 *
 * Required .env key:
 *   ZIGPOLL_API_KEY — a Private Key from the Zigpoll dashboard
 *                       (Integrations → Private Keys → Add Key)
 *   ZIGPOLL_ACCOUNT_ID — optional; discovered via /accounts when absent.
 *
 * NOT the Claude Code MCP credential. Zigpoll also ships an MCP server at
 * https://mcp.zigpoll.com/mcp, but that authenticates with a per-user OAuth
 * token held in the operator's macOS Keychain. Nothing on the production cron
 * box can read it, so every unattended path uses this REST client and a
 * dashboard-issued private key instead. The MCP is for interactive work.
 *
 * Auth is the raw key in an `Authorization` header — no `Bearer ` prefix. The
 * docs' own example passes the bare key, and a prefixed value is rejected.
 *
 * Docs: https://apidocs.zigpoll.com/  (index at .../llms.txt)
 *
 * VERIFIED AGAINST THE LIVE API 2026-08-24 with a real private key: `/me`
 * returns 200, the envelope really is `{ data, hasNextPage, endCursor }`, and
 * `filter=open-ended` returns exactly the account's 17 write-ins against 99
 * total responses. One assumption did NOT survive that check — see `responseText`
 * on why `answers` is not consulted.
 *
 * A private key can only be minted from the Zigpoll dashboard UI (Integrations →
 * Private Keys); there is no API for it and the MCP server exposes no tool for
 * it either.
 */

const ZIGPOLL_BASE = 'https://v1.zigpoll.com';

/** Zigpoll caps `limit` at 5000; ask for a page size well inside that. */
const PAGE_SIZE = 500;

/**
 * Hard ceiling on pages walked in one call. The store takes ~0.5 orders/day and
 * the account has ~100 lifetime responses, so this is unreachable in practice —
 * it exists so a pagination bug (a cursor that never advances) burns 40 requests
 * rather than looping until the process is killed.
 */
const MAX_PAGES = 40;

// ── pure helpers (exported for testing) ───────────────────────────────────────

/**
 * The free text a participant typed, or null when the response carries none.
 *
 * `response` is Zigpoll's display string for everything the participant
 * selected. For a fixed-choice answer it is the OPTION'S OWN TITLE — our copy,
 * not the customer's words, and worthless as voice-of-customer evidence.
 * `valueType` is the discriminator: `vote` for a selected option,
 * `dynamic-response` for typed input.
 *
 * Measured against the live account 2026-08-24, which settles a claim in
 * Zigpoll's docs that would otherwise be a trap here. The docs say a write-in
 * "other" "counts as a vote", which reads as though such a row arrives as
 * `valueType: 'vote'` and would be dropped by the rule above. It does not: all
 * 99 responses split 82 `vote` / 17 `dynamic-response`, and **every one of the
 * 17 write-ins is `dynamic-response`**. What the docs mean is that a write-in
 * matches either `filter` value, not that its `valueType` is `vote`. So the
 * rule is safe, and it is the one that matters — those 17 write-ins are the
 * entire verbatim corpus this source exists to collect.
 *
 * `answers` is deliberately NOT consulted. It is absent on all 17 write-ins,
 * so a rule comparing text against option titles would never fire — and would
 * silently drop a genuine write-in if Zigpoll ever started populating it. One
 * customer really did type "Google" into the Other box on a survey that already
 * offered Google as an option.
 */
export function responseText(r) {
  const text = String(r?.response || '').trim();
  if (!text) return null;
  if (r?.valueType === 'vote') return null;
  return text;
}

/**
 * Product titles from a response's Shopify order.
 *
 * `metadata.shopify_line_items` is a COMMA-SEPARATED STRING of variant titles,
 * not an array — e.g.
 *   "Foam Soap Refill | 32oz - Orange Zest, Moisturizing Coconut Soap | 3.4oz"
 * Titles carry `|` and `-` of their own, so comma is the only usable separator.
 * A title containing a literal comma splits wrong; that is tolerable because the
 * only consumer is cluster classification, and both halves of a bad split still
 * carry the product noun that classifies them.
 *
 * Returns [] for a response with no order attached (exit-intent and cart
 * surveys), which callers must distinguish from "order with no skin products".
 */
export function lineItemTitles(r) {
  const raw = r?.metadata?.shopify_line_items;
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** ISO day (YYYY-MM-DD) a response was created, or null. */
export function responseDay(r) {
  const t = String(r?.createdAt || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function zigpollGet(path, params, { apiKey, fetchImpl = fetch }) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  const res = await fetchImpl(`${ZIGPOLL_BASE}${path}?${qs}`, {
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    // 422 is Zigpoll's answer to a missing or invalid key, NOT a malformed
    // request — verified 2026-08-24: a bogus key returns 422 on `/me`,
    // `/responses` and on a path that does not exist, so auth is rejected
    // before routing. Say so, or the next reader spends the afternoon
    // adjusting query parameters that were never the problem.
    const hint = res.status === 422 ? ' (422 here means a bad or missing ZIGPOLL_API_KEY)' : '';
    throw new Error(`Zigpoll ${path} failed: ${res.status} ${res.statusText || ''}${hint}`.trim());
  }
  return res.json();
}

/**
 * The account id for the authenticated key. Every RSC key is scoped to one
 * account, so this takes the first and does not page.
 *
 * NOT every Zigpoll endpoint uses the same envelope, and assuming otherwise is
 * how this function failed its first live call. Verified 2026-08-24:
 *   /responses → { data: [...], hasNextPage, endCursor }   (cursor-paginated)
 *   /accounts  → [ ... ]                                   (a BARE array)
 *   /me        → { ... }                                   (a bare object)
 * Only the paginated endpoints wrap in `data`. Both shapes are accepted here so
 * a future envelope change degrades instead of throwing.
 */
export async function resolveAccountId({ apiKey, fetchImpl = fetch }) {
  const body = await zigpollGet('/accounts', {}, { apiKey, fetchImpl });
  const accounts = Array.isArray(body) ? body : (body?.data || body?.accounts || []);
  const first = accounts[0];
  // /me returns `accounts` as an array of bare id STRINGS, so a caller that
  // reaches this with that shape still gets an id rather than undefined.
  if (typeof first === 'string') return first;
  return first?._id || first?.id || null;
}

/**
 * Every response for an account, walking Zigpoll's cursor pagination.
 *
 * `filter: 'open-ended'` is passed server-side so a store with thousands of
 * fixed-choice votes never ships them over the wire — measured on the live
 * account, that is 17 rows instead of 99. `responseText` still screens what
 * comes back: the two agree today, and a client that trusts a server-side
 * filter completely has no way to notice when they stop agreeing.
 *
 * Throws on a failed request — callers decide whether that degrades the run or
 * fails it. voice-of-customer treats it as a partial corpus, matching how it
 * already handles Tavily and DataForSEO.
 */
export async function fetchResponses({
  apiKey,
  accountId,
  filter = 'open-ended',
  createdAfter,
  fetchImpl = fetch,
  maxPages = MAX_PAGES,
} = {}) {
  if (!apiKey) throw new Error('Zigpoll: no apiKey');
  const account = accountId || (await resolveAccountId({ apiKey, fetchImpl }));
  if (!account) throw new Error('Zigpoll: could not resolve an accountId');

  const out = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const body = await zigpollGet(
      '/responses',
      { accountId: account, limit: String(PAGE_SIZE), filter, createdAfter, startCursor: cursor },
      { apiKey, fetchImpl },
    );
    const rows = body?.data || [];
    out.push(...rows);
    // An unchanged cursor means the server is not advancing; stop rather than
    // re-request the same page until maxPages.
    const next = body?.endCursor || '';
    if (!body?.hasNextPage || !next || next === cursor) break;
    cursor = next;
  }
  return out;
}
