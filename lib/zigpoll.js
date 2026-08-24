/**
 * Zigpoll Web API v1 client — on-site survey responses.
 *
 * Required .env key:
 *   ZIGPOLL_API_TOKEN — a Private Key from the Zigpoll dashboard
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
 * NOT YET VERIFIED AGAINST A LIVE 200. No private key existed when this was
 * written, and one can only be minted from the Zigpoll dashboard UI — there is
 * no API for it, and the MCP server exposes no tool for it either. The endpoint
 * path, the auth header and the `{ data, hasNextPage, endCursor }` envelope all
 * come from Zigpoll's published OpenAPI spec and its cursor-pagination example.
 * The response SHAPES are firmer than that: they were read off the live account
 * through the MCP server, which is how `metadata.shopify_line_items` is known to
 * be a comma-separated string rather than the array it looks like it should be.
 * First run with a real key should be `--collect` alone, and the record count
 * checked against the account (99 responses / 17 open-ended on 2026-08-24).
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
 * selected. For a fixed-choice answer it is the option's own title, which is
 * our copy rather than the customer's words and is worthless as voice-of-
 * customer evidence. `valueType` distinguishes them: 'vote' for a selected
 * option, anything else (e.g. 'text') for typed input.
 *
 * A write-in "other" option is the awkward case — it both records text and
 * counts as a vote. Zigpoll's own `filter=open-ended` keeps those, and they are
 * the single richest source in this account (every verbatim on the live
 * post-purchase survey arrived through the "Other" write-in), so text wins over
 * valueType whenever both are present and the text is not simply echoing an
 * answer option's title.
 */
export function responseText(r) {
  const text = String(r?.response || '').trim();
  if (!text) return null;
  const optionTitles = (r?.answers || [])
    .map((a) => String(a?.title || '').trim().toLowerCase())
    .filter(Boolean);
  if (optionTitles.includes(text.toLowerCase())) return null;
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
    const hint = res.status === 422 ? ' (422 here means a bad or missing ZIGPOLL_API_TOKEN)' : '';
    throw new Error(`Zigpoll ${path} failed: ${res.status} ${res.statusText || ''}${hint}`.trim());
  }
  return res.json();
}

/**
 * The account id for the authenticated key. Every RSC key is scoped to one
 * account, so this takes the first and does not page.
 */
export async function resolveAccountId({ apiKey, fetchImpl = fetch }) {
  const body = await zigpollGet('/accounts', {}, { apiKey, fetchImpl });
  const accounts = body?.data || body?.accounts || [];
  return accounts[0]?._id || accounts[0]?.id || null;
}

/**
 * Every response for an account, walking Zigpoll's cursor pagination.
 *
 * `filter: 'open-ended'` is passed server-side so a store with thousands of
 * fixed-choice votes never ships them over the wire; `responseText` still
 * screens what comes back, because a write-in "other" matches both filters.
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
