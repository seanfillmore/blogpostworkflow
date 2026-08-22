// Salvaged from feature/growth-plan-1m before that branch was deleted (2026-08-21).
// The rest of that branch was superseded (dead Klaviyo flow ID XEMgA7, a PDF
// pipeline main has since replaced, a $99 price point that shipped at $121);
// this diagnostic had no equivalent on main and was lifted on its own.
/**
 * Phase 0 Task 2 — reproduce the JS console errors behind Clarity's 12.4%
 * scriptErrorPct. Loads each URL in headless Chromium (mobile viewport, since
 * ~69% of sessions are mobile), captures:
 *   - console.error messages
 *   - uncaught page errors (with stack)
 *   - failed network requests (blocked/4xx/5xx script+asset loads)
 * and attributes each to a source file so we know if it's theme code or an app.
 *
 *   node scripts/capture-console-errors.mjs [url ...]
 * Defaults to homepage + hero PDP + a top blog landing page.
 */
import puppeteer, { KnownDevices } from 'puppeteer';

const URLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://www.realskincare.com/',
      'https://www.realskincare.com/products/sensitive-skin-starter-set',
      'https://www.realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing',
    ];

const host = (u) => {
  try { return new URL(u).host; } catch { return u; }
};

async function auditUrl(browser, url) {
  const page = await browser.newPage();
  await page.emulate(KnownDevices['iPhone 13'] ?? { viewport: { width: 390, height: 844, isMobile: true }, userAgent: 'Mozilla/5.0 (iPhone)' });

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      consoleErrors.push({ text: msg.text(), src: loc?.url ? `${host(loc.url)}${new URL(loc.url).pathname}` : '(inline)' });
    }
  });
  page.on('pageerror', (err) => pageErrors.push({ message: err.message, stackTop: (err.stack || '').split('\n')[1]?.trim() || '' }));
  page.on('requestfailed', (req) => failedRequests.push({ url: `${host(req.url())}${new URL(req.url()).pathname}`, reason: req.failure()?.errorText, type: req.resourceType() }));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push({ url: `${host(res.url())}${new URL(res.url()).pathname}`, reason: `HTTP ${res.status()}`, type: res.request().resourceType() });
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3000)); // let deferred app scripts run
    // Interact minimally to trigger add-to-cart / lazy handlers where present.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {
    pageErrors.push({ message: `NAVIGATION: ${e.message}`, stackTop: '' });
  }

  await page.close();
  return { url, consoleErrors, pageErrors, failedRequests };
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
for (const url of URLS) results.push(await auditUrl(browser, url));
await browser.close();

// --- Report ---
const tally = {};
const bump = (src) => { tally[src] = (tally[src] || 0) + 1; };

for (const r of results) {
  console.log(`\n=== ${r.url} ===`);
  console.log(`  console.error: ${r.consoleErrors.length}  pageerror: ${r.pageErrors.length}  failedRequests: ${r.failedRequests.length}`);
  for (const e of r.consoleErrors) { console.log(`  [console] ${e.text.slice(0, 140)}  <- ${e.src}`); bump(e.src); }
  for (const e of r.pageErrors) { console.log(`  [uncaught] ${e.message.slice(0, 140)}  @ ${e.stackTop.slice(0, 100)}`); bump(e.stackTop || 'inline'); }
  for (const e of r.failedRequests) { console.log(`  [netfail ${e.reason}] ${e.type} ${e.url}`); bump(e.url); }
}

console.log('\n=== Source tally (most frequent first) ===');
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([src, n]) => console.log(`  ${n}x  ${src}`));
