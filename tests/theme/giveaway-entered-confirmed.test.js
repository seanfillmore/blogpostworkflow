// tests/theme/giveaway-entered-confirmed.test.js
//
// /pages/giveaway-entered is where a NEW entrant lands after submitting, and it
// is also where EVERY nurture and reminder email sends a RETURNING entrant
// (`?e=<email>`). The static headline was written for the first audience only:
// "One more step — check your email. We just sent a confirmation link."
//
// On 2026-09-11 an entrant who had confirmed on 2026-08-25 clicked the
// "Your entries so far" reminder, was told a confirmation link had just been
// sent, waited, and wrote in to say it never arrived. Nothing had been sent —
// there was nothing to send. 51 distinct entrants loaded this page that day.
//
// The fix reads `breakdown.confirmed` from GET /entries (already fetched on
// load) and swaps the copy for a confirmed entrant. This test runs the real
// theme file in a real browser and pins: confirmed → confirmed copy and a
// banked confirm rung; unconfirmed → the check-your-email copy is untouched;
// a failed lookup → the page is left exactly as shipped, because the default
// copy is the right one for the conversion-critical first-visit case.
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const themeJs = readFileSync(join(ROOT, 'theme', 'assets', 'giveaway.js'), 'utf8');
const sectionLiquid = readFileSync(join(ROOT, 'theme', 'sections', 'giveaway-entered.liquid'), 'utf8');

const PENDING_HEADLINE = 'One more step — check your email.';

// Trimmed from theme/sections/giveaway-entered.liquid — the elements giveaway.js
// queries for this behaviour, with the same data hooks.
const MARKUP = `
<section class="gv-entered" data-gv-entered>
  <h1 data-gv-headline>${PENDING_HEADLINE}</h1>
  <p class="gv-lead" data-gv-lead>We just sent a confirmation link.</p>
  <p class="gv-lead-sub" data-gv-lead-sub>Your entry is already counted. Confirming is what multiplies it.</p>
  <p class="gv-referral-stake" data-gv-referral-stake hidden></p>
  <form class="gv-survey" data-step="required">
    <button type="submit">Save — and get 3 bonus entries</button>
    <p class="gv-error" hidden role="alert"></p>
  </form>
  <div class="gv-ladder" data-gv-ladder hidden>
    <h2>Your entries: <span data-gv-count>1</span></h2>
    <ul><li data-rung="confirm">Confirm your email — <strong>+2</strong></li></ul>
  </div>
</section>`;

let browser;
let server;
let origin;

before(async () => {
  // --no-sandbox: the production box runs as root. See giveaway-survey-shift.test.js.
  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8">${MARKUP}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

/** Load the page with GET /entries stubbed, and report what the entrant reads. */
async function visit(entriesResponse) {
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate((res) => {
    window.RSC_GIVEAWAY_ENDPOINT = 'https://gv.example.test/api/giveaway';
    window.sessionStorage.setItem('gv_email', 'entrant@example.test');
    window.fetch = function () {
      if (res.reject) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: res.status === 200, json: function () { return Promise.resolve(res.body); } });
    };
  }, entriesResponse);
  await page.addScriptTag({ content: themeJs });
  await page.waitForFunction(() => !document.querySelector('[data-gv-ladder]').hidden);
  const state = await page.evaluate(() => ({
    headline: document.querySelector('[data-gv-headline]').textContent.trim(),
    lead: document.querySelector('[data-gv-lead]').textContent.trim(),
    leadSub: document.querySelector('[data-gv-lead-sub]').textContent.trim(),
    leadSubHidden: document.querySelector('[data-gv-lead-sub]').hidden,
    rung: document.querySelector('[data-rung="confirm"]').textContent.trim(),
  }));
  await page.close();
  return state;
}

test('a confirmed entrant is not told to go and look for a confirmation email', async () => {
  const s = await visit({ status: 200, body: { ok: true, entries: 6, breakdown: { confirmed: true, survey: true }, hasReferrer: false } });
  assert.notEqual(s.headline, PENDING_HEADLINE);
  assert.match(s.headline, /confirmed/i);
  for (const text of [s.headline, s.lead, s.leadSub]) {
    assert.doesNotMatch(text, /check your (email|inbox)|just sent|spam|promotions/i, `still asks them to wait for an email: "${text}"`);
  }
  // Text is swapped, never hidden — hiding a line after the fetch is an
  // unprovoked layout shift on a page with a measured CLS history.
  assert.equal(s.leadSubHidden, false);
  assert.match(s.rung, /confirmed/i);
  assert.doesNotMatch(s.rung, /^Confirm your email/);
});

test('an unconfirmed entrant still gets the check-your-email copy', async () => {
  const s = await visit({ status: 200, body: { ok: true, entries: 1, breakdown: { confirmed: false }, hasReferrer: false } });
  assert.equal(s.headline, PENDING_HEADLINE);
  assert.match(s.lead, /confirmation link/);
  assert.match(s.rung, /^Confirm your email/);
});

for (const [name, res] of [
  ['a 404', { status: 404, body: { ok: false, error: 'not found' } }],
  ['a 502', { status: 502, body: { ok: false } }],
  ['a network error', { reject: true }],
  ['a body with no breakdown', { status: 200, body: { ok: true, entries: 3 } }],
]) {
  test(`${name} leaves the shipped copy untouched`, async () => {
    const s = await visit(res);
    assert.equal(s.headline, PENDING_HEADLINE);
    assert.match(s.rung, /^Confirm your email/);
  });
}

test('the section carries the data hooks giveaway.js reads', () => {
  for (const hook of ['data-gv-headline', 'data-gv-lead', 'data-gv-lead-sub', 'data-rung="confirm"']) {
    assert.ok(sectionLiquid.includes(hook), `theme/sections/giveaway-entered.liquid is missing ${hook}`);
  }
});
