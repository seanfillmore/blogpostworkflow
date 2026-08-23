// tests/theme/giveaway-survey-shift.test.js
//
// /pages/giveaway-entered is where $30/day of Meta traffic lands, and its CLS
// p75 was 0.3141 (RED) measured from real users. The cause was not page load:
// 98 of 117 non-zero-CLS beacons over 8 days blamed
// `section.gv-entered > div.gv-ladder`, median 0.4424, at p50 28.4s into the
// session. The survey form is ~900-1100px tall and .gv-ladder sits directly
// under it in DOM order, already on screen; hiding the form snaps the ladder
// upward. Done in the .then() after POST /answers that snap lands well past
// Chrome's 500ms hadRecentInput window, so it counted in full.
//
// The fix is timing only: hide the form synchronously inside the submit
// handler, before the fetch. That trades a deferred hide for an optimistic one,
// and an optimistic hide is only safe if EVERY failure puts the form back --
// otherwise a 400/429/502 leaves the entrant with no form, no error and no way
// to claim the +3, which is the exact bug giveaway.js:259-263 was written to
// fix. This test pins both halves at once: it runs the real theme file in a
// real browser and asserts the hide is synchronous AND that every failure mode
// restores a resubmittable form.
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const themeJs = readFileSync(join(ROOT, 'theme', 'assets', 'giveaway.js'), 'utf8');
const themeCss = readFileSync(join(ROOT, 'theme', 'assets', 'giveaway.css'), 'utf8');

// Trimmed from theme/sections/giveaway-entered.liquid — the elements giveaway.js
// actually queries, in the DOM order that produces the shift.
const MARKUP = `
<section class="gv-entered" data-gv-entered>
  <p class="gv-referral-stake" data-gv-referral-stake hidden></p>
  <form class="gv-survey" data-step="required">
    <fieldset><legend>Who's the soap for?</legend>
      <label><input type="radio" name="household" value="solo" required> Just me</label>
    </fieldset>
    <fieldset><legend>Frustration</legend>
      <label><input type="radio" name="frustration" value="dry" required> Dry and flaky</label>
    </fieldset>
    <fieldset><legend>Using now</legend>
      <label><input type="radio" name="currentBrand" value="cerave" required> CeraVe</label>
    </fieldset>
    <button type="submit">Save — and get 3 bonus entries</button>
    <p class="gv-error" hidden role="alert"></p>
  </form>
  <div class="gv-ladder" data-gv-ladder hidden>
    <h2>Your entries: <span data-gv-count>1</span></h2>
  </div>
  <aside class="gv-next" data-gv-next hidden><a href="/products/x">Shop</a></aside>
</section>`;

let browser;
let server;
let origin;

// Served over http:// rather than page.setContent(), because setContent leaves
// the page on an opaque origin where sessionStorage throws SecurityError — and
// giveaway.js reads sessionStorage to establish identity, so on an opaque origin
// the file would take its no-email early-return and never reach the code under
// test.
before(async () => {
  browser = await puppeteer.launch({ headless: 'new' });
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><style>${themeCss}</style>${MARKUP}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

/**
 * Load the real theme JS against the real theme CSS, stub the two endpoints,
 * submit the survey, and report what the entrant is left looking at.
 *
 * `answersResponse` describes what POST /answers does:
 *   { status, body }  — an HTTP reply
 *   { reject: true }  — a network failure
 *   { hang: true }    — never settles, which is how the synchronous-hide
 *                       assertion distinguishes "hidden before the fetch" from
 *                       "hidden after it".
 */
async function submitSurvey(answersResponse) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 }); // iPhone-ish, the measured cohort
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  await page.evaluate((res) => {
    // NB: the stub dispatches on /answers FIRST and the endpoint host is not
    // "entries.*". Matching '/entries' first against a host like
    // https://entries.example.test/ hits the '//entries' in the authority, so
    // the POST silently took the GET branch and every case looked like a
    // failure -- including the two that were supposed to prove the fix.
    window.RSC_GIVEAWAY_ENDPOINT = 'https://gv.example.test/api/giveaway';
    window.sessionStorage.setItem('gv_email', 'entrant@example.test');
    window.__calls = [];
    window.fetch = function (url, init) {
      window.__calls.push(String(url));
      // POST /answers — the call under test.
      if (String(url).indexOf('/api/giveaway/answers') !== -1) {
        if (res.hang) return new Promise(function () {});
        if (res.reject) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({
          ok: res.status >= 200 && res.status < 300,
          json: function () { return Promise.resolve(res.body); },
        });
      }
      // GET /entries — the page-load call that reveals the ladder.
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ entries: 8, hasReferrer: false }); } });
    };
  }, answersResponse);

  await page.addScriptTag({ content: themeJs });
  await page.waitForFunction(() => !document.querySelector('[data-gv-ladder]').hidden);

  // Fill and submit exactly as a person would.
  await page.evaluate(() => {
    document.querySelector('input[name="household"]').click();
    document.querySelector('input[name="frustration"]').click();
    document.querySelector('input[name="currentBrand"]').click();
  });
  await page.click('.gv-survey button[type="submit"]');

  // One microtask drain for the settled cases; the hanging case never settles,
  // so this only ever proves the hide did not wait on the response.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));

  const state = await page.evaluate(() => ({
    surveyHidden: document.querySelector('.gv-survey').hidden,
    surveyRendered: document.querySelector('.gv-survey').getBoundingClientRect().height > 0,
    nextHidden: document.querySelector('[data-gv-next]').hidden,
    errorHidden: document.querySelector('.gv-error').hidden,
    errorText: document.querySelector('.gv-error').textContent,
    buttonDisabled: document.querySelector('.gv-survey button[type="submit"]').disabled,
    buttonLabel: document.querySelector('.gv-survey button[type="submit"]').textContent,
    count: document.querySelector('[data-gv-count]').textContent,
    posted: window.__calls.filter((u) => u.indexOf('/answers') !== -1).length,
  }));
  await page.close();
  return state;
}

test('the form is hidden synchronously on submit, without waiting for the response', async () => {
  // This IS the CLS fix. The response never arrives, so if the form is gone the
  // hide cannot have happened in the .then() — it happened inside the submit
  // handler, within Chrome's 500ms hadRecentInput window, where the resulting
  // shift is excluded from CLS.
  const s = await submitSurvey({ hang: true });
  assert.equal(s.posted, 1, 'the POST must still be made');
  assert.equal(s.surveyHidden, true, 'the survey must be hidden before the response settles');
  assert.equal(s.surveyRendered, false, 'giveaway.css must actually collapse it to zero height');
  assert.equal(s.nextHidden, false, 'the buy path must be revealed at the same moment');
});

test('a successful save leaves the form gone and shows the authoritative count', async () => {
  const s = await submitSurvey({ status: 200, body: { ok: true, entries: 11 } });
  assert.equal(s.surveyHidden, true);
  assert.equal(s.nextHidden, false);
  assert.equal(s.errorHidden, true, 'no error on success');
  assert.equal(s.count, '11', 'the count still comes from the response, not the optimistic hide');
});

// The rollback guarantee giveaway.js:259-263 exists to protect: a non-2xx and a
// {ok:false} both resolve the promise normally, so neither is caught by .catch.
for (const [name, res, expectedError] of [
  ['a 400', { status: 400, body: { ok: false, error: 'Missing answers.' } }, 'Missing answers.'],
  ['a 429', { status: 429, body: { ok: false, error: 'Too many requests.' } }, 'Too many requests.'],
  ['a 502', { status: 502, body: { ok: false } }, 'We could not save your answers. Please try again.'],
  ['a 200 carrying {ok:false}', { status: 200, body: { ok: false, error: 'Not credited.' } }, 'Not credited.'],
  ['a network error', { reject: true }, 'Network error. Please try again.'],
]) {
  test(`${name} puts the form back and lets the entrant resubmit`, async () => {
    const s = await submitSurvey(res);
    assert.equal(s.surveyHidden, false, 'the survey must come back — this is the whole rollback');
    assert.equal(s.surveyRendered, true, 'and must actually be on screen again');
    assert.equal(s.nextHidden, true, 'the buy path must be hidden again; the +3 rung is still the ask');
    assert.equal(s.errorHidden, false, 'the entrant must be told');
    // Pinned exactly, not just "non-empty": a generic message everywhere is the
    // signature of a stub that never dispatched on the right call, which is how
    // this suite first passed five tests it had not actually exercised.
    assert.equal(s.errorText, expectedError, 'with the message this failure mode should produce');
    assert.equal(s.buttonDisabled, false, 'and must be able to try again');
    assert.equal(s.buttonLabel, 'Save — and get 3 bonus entries', 'not left frozen at "Saving…"');
  });
}
