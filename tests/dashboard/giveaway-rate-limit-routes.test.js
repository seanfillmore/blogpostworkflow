// tests/dashboard/giveaway-rate-limit-routes.test.js
// Pins the two-budget split from review Finding 1: /enter (the only route
// that CREATES a Klaviyo profile) gets a tight 5/hour budget; /answers and
// /upload (which only mutate an existing profile) share a looser 30/hour
// budget. The two must be genuinely independent -- exhausting one must not
// 429 the other, or a real entrant doing enter -> answers -> Instagram ->
// upload could lose the +10 upload rung to a single accidental double-tap.
//
// Each request below carries a deliberately invalid JSON body, so every
// handler 400s during body-parsing -- before it would ever reach Klaviyo or
// Shopify. That lets this test drive the REAL exported route handlers (not
// a re-implementation of the limiter) with no network stubbing required.
// Finding 3 (accepted, unchanged): the rate check runs before body parsing,
// so these 400s still consume a slot -- which is exactly what this test
// relies on to exhaust a budget cheaply.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import routes from '../../agents/dashboard/routes/giveaway.js';

function findRoute(method, path) {
  const r = routes.find((route) => route.method === method && route.match(path));
  assert.ok(r, `no route matched ${method} ${path}`);
  return r;
}

/** Fake IncomingMessage: delivers `body` synchronously once 'end' is wired up. */
function makeReq(ip, body = 'not json') {
  const listeners = {};
  return {
    url: '/x',
    headers: { 'cf-connecting-ip': ip },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      listeners[event] = cb;
      if (event === 'end') {
        // readCappedBody always registers 'data' before 'end', so by the
        // time 'end' is wired up, 'data' is already attached -- deliver the
        // whole body in one synchronous shot.
        if (listeners.data) listeners.data(Buffer.from(body));
        cb();
      }
      return this;
    },
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (body) => { res.body = body; };
  return res;
}

test('the /enter budget (5/hour) 429s past its limit', async () => {
  const enter = findRoute('POST', '/api/giveaway/enter');
  const ip = 'test-1.1.1.1';
  for (let i = 0; i < 5; i += 1) {
    const res = makeRes();
    await enter.handler(makeReq(ip), res);
    assert.equal(res.statusCode, 400, `request ${i + 1} of 5 should reach validation (bad JSON), not be rate-limited`);
  }
  const res = makeRes();
  await enter.handler(makeReq(ip), res);
  assert.equal(res.statusCode, 429, 'the 6th /enter request in the window must be refused');
});

test('exhausting /enter does NOT consume the /answers + /upload budget for the same IP', async () => {
  const enter = findRoute('POST', '/api/giveaway/enter');
  const answers = findRoute('POST', '/api/giveaway/answers');
  const upload = findRoute('POST', '/api/giveaway/upload');
  const ip = 'test-2.2.2.2';

  for (let i = 0; i < 5; i += 1) await enter.handler(makeReq(ip), makeRes());
  const exhausted = makeRes();
  await enter.handler(makeReq(ip), exhausted);
  assert.equal(exhausted.statusCode, 429, 'sanity check: /enter really is exhausted for this IP');

  const answersRes = makeRes();
  await answers.handler(makeReq(ip), answersRes);
  assert.equal(answersRes.statusCode, 400, '/answers must still be reachable -- it has its own budget');

  const uploadRes = makeRes();
  await upload.handler(makeReq(ip), uploadRes);
  assert.equal(uploadRes.statusCode, 400, '/upload must still be reachable -- an entrant must not lose the +10 rung to /enter retries');
});

test('the /answers + /upload budget (30/hour, shared) 429s past its limit and does not touch /enter', async () => {
  const answers = findRoute('POST', '/api/giveaway/answers');
  const upload = findRoute('POST', '/api/giveaway/upload');
  const enter = findRoute('POST', '/api/giveaway/enter');
  const ip = 'test-3.3.3.3';

  // Spend the shared 30-request budget across both routes, mirroring a real
  // funnel that touches both endpoints.
  for (let i = 0; i < 15; i += 1) await answers.handler(makeReq(ip), makeRes());
  for (let i = 0; i < 15; i += 1) await upload.handler(makeReq(ip), makeRes());

  const overBudget = makeRes();
  await answers.handler(makeReq(ip), overBudget);
  assert.equal(overBudget.statusCode, 429, 'the 31st /answers-or-upload request in the window must be refused');

  const overBudget2 = makeRes();
  await upload.handler(makeReq(ip), overBudget2);
  assert.equal(overBudget2.statusCode, 429, '/upload shares the same exhausted budget as /answers');

  // /enter for this same IP must be completely unaffected.
  const enterRes = makeRes();
  await enter.handler(makeReq(ip), enterRes);
  assert.equal(enterRes.statusCode, 400, '/enter must still be reachable -- exhausting the mutate budget must not block new entrants');
});

test('the full real funnel (enter, survey, Instagram, upload) never trips a 429', async () => {
  // This is the exact scenario Finding 1 was about: a single clean pass
  // through the real funnel used to consume 4 of the old shared 5/hour
  // budget, leaving one spare -- one accidental double-tap was enough to
  // 429 a genuine entrant out of the +10 upload rung.
  const enter = findRoute('POST', '/api/giveaway/enter');
  const answers = findRoute('POST', '/api/giveaway/answers');
  const upload = findRoute('POST', '/api/giveaway/upload');
  const ip = 'test-4.4.4.4';

  const steps = [
    ['enter', enter],
    ['answers (survey)', answers],
    ['answers (Instagram handle)', answers],
    ['upload', upload],
  ];
  for (const [label, route] of steps) {
    const res = makeRes();
    await route.handler(makeReq(ip), res);
    assert.equal(res.statusCode, 400, `${label} should reach validation (bad JSON), never a 429, on a first clean pass`);
  }

  // Repeat the mutate half (answers + upload) a second time, simulating a
  // slow-connection double submit -- must still have plenty of headroom on
  // the 30/hour shared budget (only 3 of 30 spent so far: 2 answers + 1 upload).
  const secondAnswers = makeRes();
  await answers.handler(makeReq(ip), secondAnswers);
  assert.equal(secondAnswers.statusCode, 400, 'plenty of mutate-budget headroom remains after one full funnel pass');

  const secondUpload = makeRes();
  await upload.handler(makeReq(ip), secondUpload);
  assert.equal(secondUpload.statusCode, 400, 'plenty of mutate-budget headroom remains after one full funnel pass');
});
