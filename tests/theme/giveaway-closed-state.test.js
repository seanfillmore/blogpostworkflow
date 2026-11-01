// tests/theme/giveaway-closed-state.test.js
//
// Entries close at 23:59:59 PT on September 14, 2026, and nothing on the
// storefront said so: the entry form kept taking submissions and the entered
// page kept offering +3 and +10 bonus entries that the frozen pool would never
// count. The server now refuses those writes; this pins what the entrant SEES,
// so a closed giveaway reads as closed instead of as a form that errors.
//
// Runs the real theme file in a real browser with the clock stubbed either side
// of the close.
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const themeJs = readFileSync(join(ROOT, 'theme', 'assets', 'giveaway.js'), 'utf8');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));

const OPEN_NOW = Date.parse('2026-09-15T06:59:00Z');
const CLOSED_NOW = Date.parse('2026-09-15T07:00:00Z');

// Trimmed from theme/sections/giveaway-entry.liquid.
const ENTRY_MARKUP = `
<section class="gv-entry" id="gv-entry">
  <div class="gv-copy">
    <form class="gv-form" novalidate>
      <input id="gv-email" name="email" type="email">
      <input id="gv-first" name="firstName" type="text">
      <input id="gv-ref" name="referredBy" type="email">
      <p class="gv-ref-note" hidden></p>
      <p class="gv-ref-fix" hidden></p>
      <p class="gv-email-fix" hidden></p>
      <button type="submit">Enter free</button>
      <p class="gv-error" hidden role="alert"></p>
    </form>
  </div>
</section>`;

// Trimmed from theme/sections/giveaway-entered.liquid.
const ENTERED_MARKUP = `
<section class="gv-entered" data-gv-entered>
  <h1 data-gv-headline>One more step — check your email.</h1>
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
    <form class="gv-bonus" data-gv-bonus>
      <input name="igHandle"><input name="file" type="file"><input name="rightsGranted" type="checkbox">
      <button type="submit">Claim my bonus entries</button>
      <p class="gv-bonus-error" hidden></p><p class="gv-bonus-ok" hidden></p>
    </form>
  </div>
  <aside class="gv-next" data-gv-next hidden><a href="/products/coconut-soap">Shop</a></aside>
</section>`;

let browser;
let server;
let origin;

before(async () => {
  // --no-sandbox: the production box runs as root. See giveaway-survey-shift.test.js.
  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8">${req.url.startsWith('/entered') ? ENTERED_MARKUP : ENTRY_MARKUP}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

async function load(path, nowMs, entriesBody) {
  const page = await browser.newPage();
  await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
  await page.evaluate((now, body) => {
    Date.now = () => now;
    window.RSC_GIVEAWAY_ENDPOINT = 'https://gv.example.test/api/giveaway';
    window.sessionStorage.setItem('gv_email', 'entrant@example.test');
    window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }, nowMs, entriesBody ?? { ok: true, entries: 6, breakdown: { confirmed: true, survey: true }, hasReferrer: false });
  await page.addScriptTag({ content: themeJs });
  return page;
}

test('after the close the entry form is gone and the page says entries are closed', async () => {
  const page = await load('/', CLOSED_NOW);
  const s = await page.evaluate(() => ({
    formHidden: document.querySelector('.gv-form').hidden,
    notice: document.querySelector('[data-gv-closed]')?.textContent || null,
    noticeHidden: document.querySelector('[data-gv-closed]')?.hidden ?? null,
  }));
  await page.close();
  assert.equal(s.formHidden, true);
  assert.match(s.notice, /closed/i);
  assert.equal(s.noticeHidden, false);
});

test('before the close the entry form is untouched and there is no closed notice', async () => {
  const page = await load('/', OPEN_NOW);
  const s = await page.evaluate(() => ({
    formHidden: document.querySelector('.gv-form').hidden,
    notice: document.querySelector('[data-gv-closed]'),
  }));
  await page.close();
  assert.equal(s.formHidden, false);
  assert.equal(s.notice, null);
});

test('after the close the entered page offers no bonus entries, but still shows what they hold', async () => {
  const page = await load('/entered', CLOSED_NOW);
  await page.waitForFunction(() => !document.querySelector('[data-gv-ladder]').hidden);
  await page.waitForFunction(() => document.querySelector('[data-gv-count]').textContent === '6');
  const s = await page.evaluate(() => ({
    headline: document.querySelector('[data-gv-headline]').textContent.trim(),
    lead: document.querySelector('[data-gv-lead]').textContent.trim(),
    surveyHidden: document.querySelector('.gv-survey').hidden,
    bonusHidden: document.querySelector('[data-gv-bonus]').hidden,
    nextHidden: document.querySelector('[data-gv-next]').hidden,
  }));
  await page.close();
  assert.match(s.headline, /closed/i, 'the confirmed-entrant copy must not overwrite the closed state');
  assert.doesNotMatch(s.lead, /confirmation link|check your email/i);
  assert.equal(s.surveyHidden, true);
  assert.equal(s.bonusHidden, true);
  assert.equal(s.nextHidden, false, 'the buy path stays visible after the close');
});

test('before the close the entered page keeps the survey and the bonus form', async () => {
  const page = await load('/entered', OPEN_NOW, { ok: true, entries: 1, breakdown: { confirmed: false } });
  await page.waitForFunction(() => !document.querySelector('[data-gv-ladder]').hidden);
  const s = await page.evaluate(() => ({
    headline: document.querySelector('[data-gv-headline]').textContent.trim(),
    surveyHidden: document.querySelector('.gv-survey').hidden,
    bonusHidden: document.querySelector('[data-gv-bonus]').hidden,
  }));
  await page.close();
  assert.equal(s.headline, 'One more step — check your email.');
  assert.equal(s.surveyHidden, false);
  assert.equal(s.bonusHidden, false);
});

test('the theme closes at exactly the instant config/giveaway.json says entries close', () => {
  // Shopify serves this file with no build step, so the instant exists twice by
  // necessity. A drift closes the storefront early on live entrants or leaves it
  // open after the server has stopped accepting.
  const m = themeJs.match(/var ENTRY_CLOSES_AT = '([^']+)';/);
  assert.ok(m, 'theme/assets/giveaway.js must declare ENTRY_CLOSES_AT');
  assert.equal(Date.parse(m[1]), Date.parse(config.entryClosesAt));
});
