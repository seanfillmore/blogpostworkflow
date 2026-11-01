// lib/trybe.js
//
// REST client for the Trybe Brand API (jointrybe.com), the UGC creator platform
// Real Skin Care runs its creator program through.
//
// Host:  https://api.jointrybe.com/v1   (docs.jointrybe.com does NOT resolve)
// Spec:  GET /v1/openapi.json           (OpenAPI 3.1, "Trybe Brand API")
// Auth:  Authorization: Bearer <TRYBE_API_KEY>
//
// What the API can and cannot do, verified against the live spec 2026-09-22:
//   READ   creators, creator detail (programs + commission), creator performance,
//          submissions (status, products, transcript, expiring asset url)
//   WRITE  exactly three review actions on a PENDING submission:
//          approve, reject, request-revision (each takes a comment)
//   NOT    messaging creators, sample requests or limits, programs, briefs,
//          commission rates. Those are dashboard-only.
//
// Lists are cursor-paginated: `{ data, has_more, next_cursor }`, `limit` capped
// at 100. `fetchImpl` is injectable so every function is testable without a
// network call; nothing here reads .env.

export const TRYBE_BASE_URL = 'https://api.jointrybe.com/v1';

const PAGE_LIMIT = 100;
// Hard stop on pagination. 50 pages x 100 rows is far past anything this
// program will hold; a cursor that never ends is an API bug, not data.
const MAX_PAGES = 50;

async function trybeRequest(path, { apiKey, fetchImpl = fetch, method = 'GET', params, body } = {}) {
  if (!apiKey) throw new Error('trybe: no TRYBE_API_KEY');
  const url = new URL(TRYBE_BASE_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetchImpl(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text for the error */ }
  if (!res.ok) {
    const detail = json?.error?.message || json?.error || text.slice(0, 200);
    throw new Error(`trybe: ${method} ${path} -> HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return json;
}

/** Walk every page of a list endpoint. */
export async function listAll(path, { apiKey, fetchImpl, params } = {}) {
  const rows = [];
  let after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await trybeRequest(path, { apiKey, fetchImpl, params: { ...params, limit: PAGE_LIMIT, after } });
    if (!res || !Array.isArray(res.data)) throw new Error(`trybe: ${path} returned no data array`);
    rows.push(...res.data);
    if (!res.has_more || !res.next_cursor) return rows;
    after = res.next_cursor;
  }
  throw new Error(`trybe: ${path} still paginating after ${MAX_PAGES} pages`);
}

export function listCreators(opts) {
  return listAll('/creators', opts);
}

/** @param {{status?: 'pending'|'approved'|'rejected'|'revision_requested'}} [filter] */
export function listSubmissions({ status, ...opts } = {}) {
  return listAll('/submissions', { ...opts, params: { status } });
}

/** Defaults to Trybe's own window: 30 complete UTC days ending yesterday. */
export function listCreatorPerformance({ startDate, endDate, ...opts } = {}) {
  return listAll('/creator-performance', { ...opts, params: { start_date: startDate, end_date: endDate } });
}

/**
 * Ask the creator to revise a PENDING submission. Trybe answers 400 when the
 * submission is no longer pending, which the caller should treat as "someone
 * reviewed it first", not as a failure of this agent.
 */
export function requestRevision(submissionId, comment, { apiKey, fetchImpl } = {}) {
  if (!comment || !comment.trim()) throw new Error('trybe: request-revision needs a comment');
  return trybeRequest(`/submissions/${encodeURIComponent(submissionId)}/request-revision`, {
    apiKey, fetchImpl, method: 'POST', body: { comment },
  });
}
