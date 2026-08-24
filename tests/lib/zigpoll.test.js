import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  responseText,
  lineItemTitles,
  responseDay,
  fetchResponses,
  resolveAccountId,
} from '../../lib/zigpoll.js';

// ── responseText ─────────────────────────────────────────────────────────────

test('responseText returns null for a plain fixed-choice vote', () => {
  // `response` echoes the option's own title — our copy, not the customer's.
  assert.equal(
    responseText({ response: 'Very Satisfied', answers: [{ title: 'Very Satisfied' }], valueType: 'vote' }),
    null,
  );
});

test('responseText keeps a write-in that differs from every option title', () => {
  // The shape every real verbatim on this account has: an "Other" write-in,
  // which Zigpoll records as BOTH a vote and free text.
  assert.equal(
    responseText({ response: 'Originally found on Amazon', answers: [{ title: 'Other' }], valueType: 'vote' }),
    'Originally found on Amazon',
  );
});

test('responseText matches an option title case-insensitively', () => {
  assert.equal(responseText({ response: 'google', answers: [{ title: 'Google' }] }), null);
});

test('responseText keeps free text when there are no answer components', () => {
  assert.equal(responseText({ response: 'too expensive for me', valueType: 'text' }), 'too expensive for me');
});

test('responseText returns null for empty or whitespace text', () => {
  assert.equal(responseText({ response: '   ' }), null);
  assert.equal(responseText({}), null);
  assert.equal(responseText(null), null);
});

// ── lineItemTitles ───────────────────────────────────────────────────────────

test('lineItemTitles splits the comma-separated string Zigpoll actually stores', () => {
  // Verbatim shape from the live account: titles carry `|` and `-` of their own.
  const r = {
    metadata: {
      shopify_line_items:
        'Foam Soap Refill | 32oz - Orange Zest, Foaming Liquid Coconut Oil Soap | 8oz - Coconut Breeze',
    },
  };
  assert.deepEqual(lineItemTitles(r), [
    'Foam Soap Refill | 32oz - Orange Zest',
    'Foaming Liquid Coconut Oil Soap | 8oz - Coconut Breeze',
  ]);
});

test('lineItemTitles returns [] when no order is attached', () => {
  // Exit-intent and cart responses have no Shopify order at all.
  assert.deepEqual(lineItemTitles({ metadata: {} }), []);
  assert.deepEqual(lineItemTitles({}), []);
  assert.deepEqual(lineItemTitles(null), []);
});

test('lineItemTitles ignores a non-string value rather than throwing', () => {
  assert.deepEqual(lineItemTitles({ metadata: { shopify_line_items: ['a', 'b'] } }), []);
});

// ── responseDay ──────────────────────────────────────────────────────────────

test('responseDay takes the ISO day, or null when unparseable', () => {
  assert.equal(responseDay({ createdAt: '2026-07-30T13:47:31.000Z' }), '2026-07-30');
  assert.equal(responseDay({ createdAt: 'not a date' }), null);
  assert.equal(responseDay({}), null);
});

// ── fetchResponses ───────────────────────────────────────────────────────────

function stubFetch(pages) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const page = pages.shift();
    if (!page) throw new Error('stub exhausted');
    return { ok: true, status: 200, json: async () => page };
  };
  return { impl, calls };
}

test('fetchResponses walks the cursor until hasNextPage is false', async () => {
  const { impl, calls } = stubFetch([
    { data: [{ _id: 'a' }], hasNextPage: true, endCursor: 'c1' },
    { data: [{ _id: 'b' }], hasNextPage: false, endCursor: '' },
  ]);
  const out = await fetchResponses({ apiKey: 'k', accountId: 'acct', fetchImpl: impl });
  assert.deepEqual(out.map((r) => r._id), ['a', 'b']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('startCursor=c1'), 'second call carries the cursor');
});

test('fetchResponses sends the open-ended filter and the account id', async () => {
  const { impl, calls } = stubFetch([{ data: [], hasNextPage: false }]);
  await fetchResponses({ apiKey: 'k', accountId: 'acct', fetchImpl: impl });
  assert.ok(calls[0].includes('accountId=acct'));
  assert.ok(calls[0].includes('filter=open-ended'));
});

test('fetchResponses stops when the cursor stops advancing', async () => {
  // A server that keeps saying hasNextPage with the same cursor would otherwise
  // loop until maxPages, re-requesting one page.
  const { impl, calls } = stubFetch([
    { data: [{ _id: 'a' }], hasNextPage: true, endCursor: 'same' },
    { data: [{ _id: 'a' }], hasNextPage: true, endCursor: 'same' },
    { data: [{ _id: 'a' }], hasNextPage: true, endCursor: 'same' },
  ]);
  const out = await fetchResponses({ apiKey: 'k', accountId: 'acct', fetchImpl: impl });
  assert.equal(calls.length, 2, 'stops on the repeat rather than walking to maxPages');
  assert.equal(out.length, 2);
});

test('fetchResponses honours maxPages as a backstop', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({
    data: [{ _id: `r${i}` }], hasNextPage: true, endCursor: `c${i}`,
  }));
  const { impl, calls } = stubFetch(pages);
  await fetchResponses({ apiKey: 'k', accountId: 'acct', fetchImpl: impl, maxPages: 3 });
  assert.equal(calls.length, 3);
});

test('fetchResponses sends the bare key, with no Bearer prefix', async () => {
  let seen = null;
  const impl = async (_url, opts) => {
    seen = opts.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ data: [], hasNextPage: false }) };
  };
  await fetchResponses({ apiKey: 'rawkey', accountId: 'acct', fetchImpl: impl });
  assert.equal(seen, 'rawkey');
});

test('fetchResponses throws on a non-ok response', async () => {
  const impl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) });
  await assert.rejects(
    () => fetchResponses({ apiKey: 'k', accountId: 'acct', fetchImpl: impl }),
    /401/,
  );
});

test('fetchResponses throws without an apiKey rather than calling out', async () => {
  let called = false;
  const impl = async () => { called = true; };
  await assert.rejects(() => fetchResponses({ fetchImpl: impl }), /no apiKey/);
  assert.equal(called, false);
});

test('fetchResponses resolves the account id when none is supplied', async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('/accounts')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ _id: 'discovered' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [], hasNextPage: false }) };
  };
  await fetchResponses({ apiKey: 'k', fetchImpl: impl });
  assert.ok(calls[0].includes('/accounts'));
  assert.ok(calls[1].includes('accountId=discovered'));
});

test('resolveAccountId returns null when the account list is empty', async () => {
  const impl = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  assert.equal(await resolveAccountId({ apiKey: 'k', fetchImpl: impl }), null);
});
