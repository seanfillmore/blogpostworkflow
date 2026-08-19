// tests/lib/bing-webmaster.test.js
//
// Bing is stubbed at the fetch boundary — nothing here touches the live API.
//
// The three things under test are the three places Bing disagrees with GSC, and every
// one of them fails silently if it is wrong: a mis-parsed WCF date lands a row on the
// wrong calendar day, a missing CTR reads as 0% rather than as absent, and the -1
// position sentinel reads as a rank of -1 that drags any average below zero.

import { strict as assert } from 'node:assert';
import { test, beforeEach, afterEach } from 'node:test';
import {
  parseMicrosoftDate,
  computeCtr,
  normalizePosition,
  normalizeTrafficRow,
  normalizeStatRow,
  redactUrl,
  bingRequest,
  getRankAndTrafficStats,
  getQueryStats,
  getPageStats,
  resolveCredentials,
  DEFAULT_SITE_URL,
} from '../../lib/bing-webmaster.js';

const realFetch = globalThis.fetch;

// Credentials come from the caller in every test, and the .env fallback is pointed at a
// path that does not exist, so a developer's real key can never reach a stubbed fetch.
const CREDS = { env: { BINGWEBMASTER_API: 'test-key' }, envFile: '/nonexistent/.env' };

let calls = [];

function stubBing(responder) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return responder(String(url));
  };
}

const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

beforeEach(() => { stubBing(() => ok({ d: [] })); });
afterEach(() => { globalThis.fetch = realFetch; });

// ── date parsing ──────────────────────────────────────────────────────────────

test('parseMicrosoftDate applies the negative offset the string declares', () => {
  // Real row: epoch is 2026-02-17T08:00:00Z, which is midnight on the 17th at -0800.
  // Reading the epoch as UTC would also give the 17th here, so this case alone does
  // not prove the offset is honoured — the PDT case below is the one that does.
  assert.equal(parseMicrosoftDate('/Date(1771315200000-0800)/'), '2026-02-17');
});

test('parseMicrosoftDate reads the offset off the string rather than assuming one', () => {
  // Bing does NOT emit a constant offset: the same account returns -0800 in winter
  // rows and -0700 in summer rows. Real summer row — epoch 2026-08-17T07:00:00Z,
  // which is midnight on the 17th at -0700.
  assert.equal(parseMicrosoftDate('/Date(1786950000000-0700)/'), '2026-08-17');
  // The identical epoch labelled -0800 is a DIFFERENT calendar day. That is the bug
  // hardcoding one offset would introduce across every PDT row in the feed.
  assert.equal(parseMicrosoftDate('/Date(1786950000000-0800)/'), '2026-08-16');
});

test('parseMicrosoftDate crosses the day boundary in both directions', () => {
  // 2026-02-17T23:00:00Z shifted +0200 is 01:00 on the 18th.
  assert.equal(parseMicrosoftDate('/Date(1771369200000+0200)/'), '2026-02-18');
  // 2026-02-17T04:00:00Z shifted -0800 is 20:00 on the 16th.
  assert.equal(parseMicrosoftDate('/Date(1771300800000-0800)/'), '2026-02-16');
  // A bare epoch with no offset is read as UTC.
  assert.equal(parseMicrosoftDate('/Date(1771369200000)/'), '2026-02-17');
});

test('parseMicrosoftDate throws rather than inventing a date', () => {
  // A silent null here would write rows with `date: null` into the only copy of this
  // history. Loud failure is the whole point.
  assert.throws(() => parseMicrosoftDate('2026-02-17'), /unrecognized format/);
  assert.throws(() => parseMicrosoftDate('/Date(abc-0800)/'), /unrecognized format/);
  assert.throws(() => parseMicrosoftDate(null), /expected a string/);
  assert.throws(() => parseMicrosoftDate(1771315200000), /expected a string/);
});

// ── CTR ───────────────────────────────────────────────────────────────────────

test('computeCtr fills in the field Bing does not return', () => {
  assert.equal(computeCtr(167, 13224), 0.0126); // the real 6-month site figure, 1.26%
  assert.equal(computeCtr(1, 4), 0.25);
  assert.equal(computeCtr(0, 61), 0);
});

test('computeCtr never returns NaN or Infinity on a zero-impression row', () => {
  // A NaN here poisons every downstream average without ever throwing.
  for (const ctr of [computeCtr(0, 0), computeCtr(3, 0), computeCtr(undefined, undefined)]) {
    assert.equal(ctr, 0);
    assert.ok(Number.isFinite(ctr));
  }
});

// ── position sentinel ─────────────────────────────────────────────────────────

test('normalizePosition treats -1 as absent, not as a rank', () => {
  assert.equal(normalizePosition(-1), null);
  assert.equal(normalizePosition(0), null);
  assert.equal(normalizePosition(undefined), null);
  assert.equal(normalizePosition('not a number'), null);
  assert.equal(normalizePosition(3), 3);
  assert.equal(normalizePosition('5'), 5);
});

test('a row with clicks can still carry AvgClickPosition -1', () => {
  // Measured 2026-08-17: all 153 query rows carrying clicks reported -1. Inferring
  // "clicks > 0 therefore the position is real" would import 153 ranks of -1.
  const row = normalizeStatRow({
    Query: 'real skincare',
    Date: '/Date(1771574400000-0800)/',
    Clicks: 1,
    Impressions: 2,
    AvgImpressionPosition: 3,
    AvgClickPosition: -1,
  });
  assert.equal(row.clicks, 1);
  assert.equal(row.clickPosition, null);
  assert.equal(row.impressionPosition, 3);
  assert.equal(row.ctr, 0.5);
  assert.equal(row.date, '2026-02-20');
});

// ── row normalizers ───────────────────────────────────────────────────────────

test('normalizeTrafficRow drops the WCF envelope and adds CTR', () => {
  assert.deepEqual(
    normalizeTrafficRow({ Clicks: 2, Date: '/Date(1771401600000-0800)/', Impressions: 62 }),
    { date: '2026-02-18', clicks: 2, impressions: 62, ctr: 0.0323 },
  );
});

test('normalizeStatRow labels a page row `page`, not `query`', () => {
  // GetPageStats returns the SAME `QueryStats` type as GetQueryStats, with the URL in
  // the `Query` field. Left as `query`, every page URL would look like a search term.
  const url = 'https://www.realskincare.com/';
  const row = normalizeStatRow(
    { Query: url, Date: '/Date(1771574400000-0800)/', Clicks: 1, Impressions: 1, AvgImpressionPosition: 1, AvgClickPosition: -1 },
    'page',
  );
  assert.equal(row.page, url);
  assert.equal(row.query, undefined);
});

// ── request handling ──────────────────────────────────────────────────────────

test('bingRequest calls the apex site URL and never leaks the key in an error', () => {
  assert.equal(resolveCredentials(CREDS).siteUrl, DEFAULT_SITE_URL);
  assert.equal(DEFAULT_SITE_URL, 'https://realskincare.com/');
  // The www form GSC_SITE_URL uses returns HTTP 400 / NotAuthorized from Bing.
  assert.ok(!DEFAULT_SITE_URL.includes('www.'));
  assert.equal(
    redactUrl('https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?apikey=SECRET&siteUrl=x'),
    'https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?apikey=<redacted>&siteUrl=x',
  );
});

test('bingRequest sends the key and the site, and asks the named method', async () => {
  stubBing(() => ok({ d: [] }));
  await bingRequest('GetPageStats', CREDS);
  const url = calls[0];
  assert.ok(url.startsWith('https://ssl.bing.com/webmaster/api.svc/json/GetPageStats?'));
  assert.ok(url.includes('apikey=test-key'));
  assert.ok(url.includes(`siteUrl=${encodeURIComponent(DEFAULT_SITE_URL)}`));
});

test('bingRequest throws on an ErrorCode payload — including one served with HTTP 200', async () => {
  stubBing(() => ({ ok: false, status: 400, text: async () => JSON.stringify({ ErrorCode: 3, Message: 'ERROR!!! InvalidApiKey' }) }));
  await assert.rejects(bingRequest('GetQueryStats', CREDS), /ErrorCode 3: ERROR!!! InvalidApiKey/);

  stubBing(() => ok({ ErrorCode: 14, Message: 'ERROR!!! NotAuthorized' }));
  await assert.rejects(bingRequest('GetQueryStats', CREDS), /ErrorCode 14/);
});

test('a thrown request carries a redacted URL, never the key', async () => {
  stubBing(() => ({ ok: false, status: 500, text: async () => 'upstream exploded' }));
  await assert.rejects(bingRequest('GetQueryStats', CREDS), (err) => {
    assert.ok(!err.message.includes('test-key'), 'the API key leaked into the error message');
    assert.ok(err.message.includes('apikey=<redacted>'));
    assert.ok(err.message.includes('HTTP 500'));
    return true;
  });
});

test('bingRequest throws on a non-JSON body and on a missing `d` array', async () => {
  stubBing(() => ({ ok: true, status: 200, text: async () => '<html>maintenance</html>' }));
  await assert.rejects(bingRequest('GetQueryStats', CREDS), /non-JSON response/);

  stubBing(() => ok({ notD: [] }));
  await assert.rejects(bingRequest('GetQueryStats', CREDS), /expected an array under "d"/);
});

test('bingRequest throws when no API key is configured', async () => {
  await assert.rejects(
    bingRequest('GetQueryStats', { env: {}, envFile: '/nonexistent/.env' }),
    /Missing BINGWEBMASTER_API/,
  );
});

test('a caller-supplied BING_SITE_URL overrides the apex default', () => {
  const creds = resolveCredentials({
    env: { BINGWEBMASTER_API: 'k', BING_SITE_URL: 'https://other.example/' },
    envFile: '/nonexistent/.env',
  });
  assert.equal(creds.siteUrl, 'https://other.example/');
});

// ── public wrappers ───────────────────────────────────────────────────────────

test('getRankAndTrafficStats normalizes and sorts ascending by date', async () => {
  stubBing(() => ok({
    d: [
      { Clicks: 2, Date: '/Date(1771401600000-0800)/', Impressions: 62 },
      { Clicks: 0, Date: '/Date(1771315200000-0800)/', Impressions: 61 },
    ],
  }));
  const rows = await getRankAndTrafficStats(CREDS);
  assert.deepEqual(rows.map((r) => r.date), ['2026-02-17', '2026-02-18']);
  assert.deepEqual(rows[0], { date: '2026-02-17', clicks: 0, impressions: 61, ctr: 0 });
});

test('getQueryStats and getPageStats read the same wire shape into different keys', async () => {
  const wire = {
    d: [{
      Query: 'cinnamon toothpaste',
      Date: '/Date(1771574400000-0800)/',
      Clicks: 2,
      Impressions: 36,
      AvgImpressionPosition: 4,
      AvgClickPosition: -1,
    }],
  };
  stubBing(() => ok(wire));
  const [q] = await getQueryStats(CREDS);
  const [p] = await getPageStats(CREDS);

  assert.equal(q.query, 'cinnamon toothpaste');
  assert.equal(p.page, 'cinnamon toothpaste');
  for (const row of [q, p]) {
    assert.equal(row.ctr, 0.0556);
    assert.equal(row.clickPosition, null);
    assert.equal(row.impressionPosition, 4);
    assert.equal(row.date, '2026-02-20');
  }
});
