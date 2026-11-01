import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostGroup, parseRetryAfter, classifyStatus, classifyThrow, legacyStatus,
  fetchWithOutcome, runPool, tallyOutcomes, renderOutcomeTally, degradedReason,
  OUTCOMES, FAILED_OUTCOMES, DEFAULT_CONCURRENCY, DEFAULT_PER_HOST,
  MAX_RATE_LIMIT_RETRIES, MAX_RETRY_WAIT_MS,
} from '../../lib/fetch-pool.js';

// ── hostGroup ────────────────────────────────────────────────────────────────

test('hostGroup folds subdomains onto the registrable domain', () => {
  assert.equal(hostGroup('https://www.nih.gov/x'), 'nih.gov');
  assert.equal(hostGroup('https://pmc.ncbi.nlm.nih.gov/articles/PMC123/'), 'nih.gov');
  assert.equal(hostGroup('https://elle.com/beauty/'), 'elle.com');
  assert.equal(hostGroup('http://WWW.Prevention.COM/a'), 'prevention.com');
});

test('hostGroup keeps the second level under a two-letter TLD', () => {
  assert.equal(hostGroup('https://www.theguardian.co.uk/x'), 'theguardian.co.uk');
  assert.equal(hostGroup('https://news.abc.com.au/x'), 'abc.com.au');
});

test('hostGroup accepts a bare domain — the agent falls back to one', () => {
  // A snapshot with no article URL yields `https://<domain>/`, but the ranked
  // row itself carries only `domain`.
  assert.equal(hostGroup('bettergoods.org'), 'bettergoods.org');
  assert.equal(hostGroup('www.bettergoods.org'), 'bettergoods.org');
});

test('hostGroup returns empty rather than throwing on junk', () => {
  for (const junk of [null, undefined, '', '   ', 'not a url', 'https://']) {
    assert.equal(typeof hostGroup(junk), 'string');
  }
  assert.equal(hostGroup(null), '');
  assert.equal(hostGroup('https://'), '');
});

test('hostGroup ignores port and userinfo', () => {
  assert.equal(hostGroup('https://user:pw@www.elle.com:8443/a'), 'elle.com');
});

// ── status classification ────────────────────────────────────────────────────

test('classifyStatus names every outcome the live corpus produced', () => {
  assert.equal(classifyStatus(200), 'ok');
  assert.equal(classifyStatus(204), 'ok');
  assert.equal(classifyStatus(404), 'not-found');
  assert.equal(classifyStatus(410), 'not-found');
  assert.equal(classifyStatus(403), 'blocked');
  assert.equal(classifyStatus(401), 'blocked');
  assert.equal(classifyStatus(451), 'blocked');
  assert.equal(classifyStatus(429), 'rate-limited');
  assert.equal(classifyStatus(500), 'server-error');
  assert.equal(classifyStatus(418), 'http-error');
  assert.equal(classifyStatus(302), 'http-error');
});

test('a 503 is rate-limited ONLY with a Retry-After', () => {
  // A paced 503 is worth one retry; a bare 503 is an origin that is down, and
  // retrying it immediately buys nothing.
  assert.equal(classifyStatus(503, { retryAfter: '3' }), 'rate-limited');
  assert.equal(classifyStatus(503), 'server-error');
  assert.equal(classifyStatus(503, { retryAfter: '' }), 'server-error');
  assert.equal(classifyStatus(503, { retryAfter: null }), 'server-error');
});

test('classifyThrow separates our own timeout from the network', () => {
  const abort = new Error('aborted'); abort.name = 'AbortError';
  assert.equal(classifyThrow(abort), 'timeout');
  const timeout = new Error('t'); timeout.name = 'TimeoutError';
  assert.equal(classifyThrow(timeout), 'timeout');
  assert.equal(classifyThrow(new TypeError('fetch failed')), 'network-error');
  assert.equal(classifyThrow(null), 'network-error');
});

test('legacyStatus narrows to the vocabulary author-currency already speaks', () => {
  // `not-found` must survive the narrowing: lib/author-currency.js carries a
  // measured decision that a 404 on an author page is NOT a departure.
  assert.equal(legacyStatus('ok'), 'ok');
  assert.equal(legacyStatus('not-found'), 'not-found');
  for (const o of ['blocked', 'timeout', 'rate-limited', 'server-error', 'network-error', 'http-error']) {
    assert.equal(legacyStatus(o), 'error');
  }
});

test('ok is the only non-failure outcome', () => {
  assert.ok(OUTCOMES.includes('ok'));
  assert.ok(!FAILED_OUTCOMES.includes('ok'));
  assert.equal(FAILED_OUTCOMES.length, OUTCOMES.length - 1);
});

// ── parseRetryAfter ──────────────────────────────────────────────────────────

test('parseRetryAfter handles delta-seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('0'), 0);
  const now = Date.parse('2026-09-21T12:00:00Z');
  assert.equal(parseRetryAfter('Mon, 21 Sep 2026 12:00:04 GMT', { now }), 4000);
  // A date already in the past clamps to 0 rather than going negative.
  assert.equal(parseRetryAfter('Mon, 21 Sep 2026 11:00:00 GMT', { now }), 0);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

// ── fetchWithOutcome ─────────────────────────────────────────────────────────

const res = (status, { body = '', headers = {} } = {}) => ({
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => body,
});

test('fetchWithOutcome returns html only on ok', async () => {
  const ok = await fetchWithOutcome('https://x.test/', { fetchImpl: async () => res(200, { body: '<html>hi</html>' }) });
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.html, '<html>hi</html>');

  for (const status of [403, 404, 500, 429]) {
    const r = await fetchWithOutcome('https://x.test/', { fetchImpl: async () => res(status, { body: 'nope' }) });
    assert.equal(r.html, null, `status ${status} must not yield html`);
  }
});

test('fetchWithOutcome caps the body at maxBytes', async () => {
  const r = await fetchWithOutcome('https://x.test/', {
    fetchImpl: async () => res(200, { body: 'x'.repeat(5000) }), maxBytes: 100,
  });
  assert.equal(r.html.length, 100);
});

test('fetchWithOutcome reports a timeout as a timeout, not a network error', async () => {
  const r = await fetchWithOutcome('https://x.test/', {
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.html, null);
});

test('a paced rate limit is retried exactly once, inside the run-wide budget', async () => {
  let calls = 0;
  const slept = [];
  const budget = { spent: 0 };
  const r = await fetchWithOutcome('https://x.test/', {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? res(429, { headers: { 'retry-after': '2' } })
        : res(200, { body: 'ok' });
    },
    rateLimitBudget: budget,
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(slept, [2000]);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.retried, true);
  assert.equal(budget.spent, 1);
});

test('a rate limit that stays rate-limited is returned after ONE retry, not looped', async () => {
  let calls = 0;
  const budget = { spent: 0 };
  const r = await fetchWithOutcome('https://x.test/', {
    fetchImpl: async () => { calls += 1; return res(429, { headers: { 'retry-after': '1' } }); },
    rateLimitBudget: budget, sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(r.outcome, 'rate-limited');
  assert.equal(budget.spent, 1);
});

test('the rate-limit retry budget is shared across the run and stops being spent', async () => {
  const budget = { spent: MAX_RATE_LIMIT_RETRIES };
  let calls = 0;
  const r = await fetchWithOutcome('https://x.test/', {
    fetchImpl: async () => { calls += 1; return res(429, { headers: { 'retry-after': '1' } }); },
    rateLimitBudget: budget, sleep: async () => { throw new Error('must not sleep'); },
  });
  assert.equal(calls, 1, 'budget exhausted: no retry');
  assert.equal(r.outcome, 'rate-limited');
  assert.equal(budget.spent, MAX_RATE_LIMIT_RETRIES);
});

test('a Retry-After longer than we can afford is abandoned, never waited out', async () => {
  let calls = 0;
  const r = await fetchWithOutcome('https://x.test/', {
    fetchImpl: async () => { calls += 1; return res(429, { headers: { 'retry-after': String((MAX_RETRY_WAIT_MS / 1000) + 60) } }); },
    rateLimitBudget: { spent: 0 }, sleep: async () => { throw new Error('must not sleep'); },
  });
  assert.equal(calls, 1);
  assert.equal(r.outcome, 'rate-limited');
});

test('with no shared budget there is no retry at all', async () => {
  let calls = 0;
  await fetchWithOutcome('https://x.test/', {
    fetchImpl: async () => { calls += 1; return res(429, { headers: { 'retry-after': '1' } }); },
    sleep: async () => { throw new Error('must not sleep'); },
  });
  assert.equal(calls, 1);
});

// ── runPool ──────────────────────────────────────────────────────────────────

const tick = () => new Promise((r) => setTimeout(r, 0));

test('runPool visits every item exactly once', async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const seen = [];
  await runPool(items, async (n) => { seen.push(n); }, { concurrency: 7 });
  assert.equal(seen.length, 50);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test('results are indexed by INPUT position, never by completion order', async () => {
  // The whole determinism property: the last item finishes first here, and the
  // ranking downstream must not notice.
  const items = [0, 1, 2, 3, 4];
  const results = await runPool(items, async (n) => {
    await new Promise((r) => setTimeout(r, (items.length - n) * 5));
    return `r${n}`;
  }, { concurrency: 5 });
  assert.deepEqual(results, ['r0', 'r1', 'r2', 'r3', 'r4']);
});

test('runPool never exceeds the global width', async () => {
  let live = 0;
  let peak = 0;
  await runPool(Array.from({ length: 40 }, (_, i) => i), async () => {
    live += 1; peak = Math.max(peak, live);
    await tick(); await tick();
    live -= 1;
  }, { concurrency: 4, perHost: 99 });
  assert.equal(peak, 4);
});

test('width is clamped to the item count — 3 items never start 8 workers', async () => {
  let peak = 0; let live = 0;
  await runPool([1, 2, 3], async () => {
    live += 1; peak = Math.max(peak, live); await tick(); live -= 1;
  }, { concurrency: 8, keyOf: (n) => `h${n}.test` });
  assert.equal(peak, 3);
});

test('an EMPTY key is "unknown host", not "everything on one host"', async () => {
  // hostGroup() returns '' for anything it cannot parse, and the default keyOf
  // returns '' for everything. If those shared a bucket, a caller that passed
  // no keyOf — or a few malformed rows — would silently run at width 1 while
  // reporting the configured concurrency.
  let peak = 0; let live = 0;
  await runPool(Array.from({ length: 10 }, (_, i) => i), async () => {
    live += 1; peak = Math.max(peak, live); await tick(); await tick(); live -= 1;
  }, { concurrency: 4, perHost: 1 });
  assert.equal(peak, 4, 'unkeyed items are bounded by the global width alone');
});

test('unkeyed items do not relax the cap on the keyed ones beside them', async () => {
  const live = new Map(); const peak = new Map();
  const items = [
    { k: '' }, { k: 'a.test' }, { k: '' }, { k: 'a.test' }, { k: 'a.test' }, { k: '' },
  ];
  await runPool(items, async (it) => {
    const key = it.k || '(none)';
    const n = (live.get(key) || 0) + 1;
    live.set(key, n); peak.set(key, Math.max(peak.get(key) || 0, n));
    await tick(); await tick();
    live.set(key, live.get(key) - 1);
  }, { concurrency: 6, perHost: 1, keyOf: (it) => it.k });
  assert.equal(peak.get('a.test'), 1);
  assert.ok(peak.get('(none)') > 1, 'the unkeyed ones still ran in parallel');
});

test('runPool never exceeds perHost for one key', async () => {
  // Every item on ONE host: a pool of width 6 must still send them one at a time.
  const live = new Map();
  const peak = new Map();
  const items = Array.from({ length: 12 }, (_, i) => ({ host: i % 3 === 0 ? 'a.test' : 'b.test', i }));
  await runPool(items, async (it) => {
    const n = (live.get(it.host) || 0) + 1;
    live.set(it.host, n);
    peak.set(it.host, Math.max(peak.get(it.host) || 0, n));
    await tick(); await tick();
    live.set(it.host, live.get(it.host) - 1);
  }, { concurrency: 6, perHost: 1, keyOf: (it) => it.host });
  assert.equal(peak.get('a.test'), 1);
  assert.equal(peak.get('b.test'), 1);
});

test('perHost above 1 is honoured as the ceiling it is', async () => {
  let live = 0; let peak = 0;
  await runPool(Array.from({ length: 10 }, (_, i) => i), async () => {
    live += 1; peak = Math.max(peak, live); await tick(); await tick(); live -= 1;
  }, { concurrency: 6, perHost: 2, keyOf: () => 'one.test' });
  assert.equal(peak, 2);
});

test('a saturated host does not idle the pool — work behind it still proceeds', async () => {
  // Three items on one slow host and three on distinct fast ones. If the pool
  // blocked on the head of the queue the fast ones would finish last.
  const order = [];
  const items = [
    { k: 'slow.test', ms: 30, id: 's1' },
    { k: 'slow.test', ms: 30, id: 's2' },
    { k: 'slow.test', ms: 30, id: 's3' },
    { k: 'f1.test', ms: 0, id: 'f1' },
    { k: 'f2.test', ms: 0, id: 'f2' },
  ];
  await runPool(items, async (it) => {
    await new Promise((r) => setTimeout(r, it.ms));
    order.push(it.id);
  }, { concurrency: 3, perHost: 1, keyOf: (it) => it.k });
  assert.ok(order.indexOf('f1') < order.indexOf('s3'), `fast host starved: ${order.join(',')}`);
  assert.equal(order.length, 5);
});

test('a throwing worker yields {error} at its index and does not stop the pool', async () => {
  const results = await runPool([1, 2, 3], async (n) => {
    if (n === 2) throw new Error('boom');
    return n * 10;
  }, { concurrency: 3 });
  assert.equal(results[0], 10);
  assert.ok(results[1].error instanceof Error);
  assert.equal(results[2], 30);
});

test('runPool on an empty list does nothing and returns nothing', async () => {
  let ran = false;
  assert.deepEqual(await runPool([], async () => { ran = true; }), []);
  assert.deepEqual(await runPool(null, async () => { ran = true; }), []);
  assert.equal(ran, false);
});

test('concurrency 1 is exactly serial — the documented no-deploy fallback', async () => {
  const started = [];
  await runPool([0, 1, 2, 3], async (n) => {
    started.push(n);
    await new Promise((r) => setTimeout(r, (4 - n) * 3));
  }, { concurrency: 1 });
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test('onProgress counts completions and a throwing callback cannot fail the run', async () => {
  const seen = [];
  await runPool([1, 2, 3], async (n) => n, {
    concurrency: 2,
    onProgress: (done, total) => { seen.push([done, total]); if (done === 2) throw new Error('reporting blew up'); },
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[seen.length - 1], [3, 3]);
});

test('the defaults are the measured ones', () => {
  // 6 because 12 measured no faster; 1 per host because the article fetch and
  // the author-page fetch land on the same publisher. See the module header.
  assert.equal(DEFAULT_CONCURRENCY, 6);
  assert.equal(DEFAULT_PER_HOST, 1);
});

// ── tally / degraded ─────────────────────────────────────────────────────────

test('tallyOutcomes counts known outcomes and files junk as network-error', () => {
  const t = tallyOutcomes(['ok', 'ok', 'blocked', 'timeout', 'wat', undefined]);
  assert.equal(t.ok, 2);
  assert.equal(t.blocked, 1);
  assert.equal(t.timeout, 1);
  assert.equal(t['network-error'], 2);
});

test('renderOutcomeTally sorts descending and says so when empty', () => {
  assert.equal(renderOutcomeTally({ blocked: 3, ok: 10, timeout: 1 }), 'ok 10 · blocked 3 · timeout 1');
  assert.equal(renderOutcomeTally({}), 'none');
  assert.equal(renderOutcomeTally({ ok: 0 }), 'none');
  assert.equal(renderOutcomeTally(null), 'none');
});

test('degradedReason stays silent on the measured baseline failure rate', () => {
  // The live 240-URL sample: 212 ok, 28 failures = 11.7%, under the 15% floor.
  const baseline = {
    ok: 212, blocked: 17, 'not-found': 4, timeout: 3, 'rate-limited': 1,
    'network-error': 1, 'server-error': 1, 'http-error': 1,
  };
  assert.equal(degradedReason(baseline), null);
});

test('degradedReason fires and NAMES the outcomes when a pass really degrades', () => {
  const why = degradedReason({ ok: 100, blocked: 250, timeout: 50 });
  assert.ok(why, 'a 75% failure share must be reported');
  assert.match(why, /300 of 400/);
  assert.match(why, /blocked 250/);
  assert.match(why, /timeout 50/);
  assert.ok(!/\bok\b/.test(why), 'the successes are not a reason it degraded');
});

test('degradedReason refuses to judge a sample too small to judge', () => {
  // Three failures out of ten is not evidence of anything.
  assert.equal(degradedReason({ ok: 7, blocked: 3 }), null);
});

test('degradedReason does not fire on a small hand-run inside sampling noise', () => {
  // The real local run of this change: 40 fetches, 7 failures (17.5%). At that
  // sample size the binomial SD around the 11.7% baseline is 5.1pp, so 17.5%
  // is barely one SD out. The per-outcome counts still print; only the banner
  // is withheld.
  assert.equal(degradedReason({ ok: 33, blocked: 4, 'http-error': 3 }), null);
});

test('degradedReason DOES fire on the same share at the scheduled budget', () => {
  // 400 attempts is where 20% is five SD from baseline rather than one.
  const why = degradedReason({ ok: 310, blocked: 60, timeout: 30 });
  assert.ok(why, '90 of 400 must be reported at the scheduled budget');
  assert.match(why, /90 of 400/);
});

test('not-attempted rows are outside the failure share entirely', () => {
  // Rows past the --enrich budget were never fetched, so they can neither
  // degrade a run nor dilute one that degraded.
  assert.equal(degradedReason({ ok: 100, 'not-attempted': 5000 }), null);
  const why = degradedReason({ ok: 10, blocked: 90, 'not-attempted': 5000 });
  assert.match(why, /90 of 100/);
  assert.ok(!/not-attempted/.test(why));
});
