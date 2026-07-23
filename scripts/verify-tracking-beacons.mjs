/**
 * Phase 0 Task 3 groundwork — verify whether the analytics/ads conversion
 * beacons actually FIRE for real users, vs. the aborts seen in the no-consent
 * headless run.
 *
 * Shopify Consent Mode blocks marketing pixels (GA4, Google Ads, TikTok) until
 * the visitor grants consent — so headless aborts may be expected, not broken.
 * This loads the page, reads Shopify's Customer Privacy state, then GRANTS
 * consent and reloads, capturing every tracking beacon and its outcome in both
 * passes so we can tell "consent-gated" apart from "actually broken."
 *
 *   node scripts/verify-tracking-beacons.mjs [url]   (default homepage)
 */
import puppeteer, { KnownDevices } from 'puppeteer';

const URL = process.argv[2] || 'https://www.realskincare.com/';

const VENDORS = [
  ['Google Ads (conv/remarketing)', /google\.com\/(ccm|pagead|rmkt|measurement)|googleadservices|doubleclick\.net/],
  ['GA4 (g/collect)', /google-analytics\.com|analytics\.google\.com\/g\/collect|\/g\/collect/],
  ['Google Tag Manager', /googletagmanager\.com/],
  ['TikTok', /tiktok/],
  ['Shopify analytics (monorail)', /monorail-edge\.shopifysvc\.com|\/api\/collect|\/sf_private_access_tokens/],
  ['Microsoft Clarity', /clarity\.ms/],
  ['Ahrefs', /ahrefs\.com/],
  ['Merchant Center', /merchant-center-analytics/],
];
const vendorOf = (u) => (VENDORS.find(([, re]) => re.test(u)) || ['Other', null])[0];
const isTracking = (u) => VENDORS.some(([, re]) => re.test(u));

async function pass(page, label) {
  const beacons = new Map(); // url -> {vendor, status, failure}
  const onReq = (req) => {
    const u = req.url();
    if (isTracking(u)) beacons.set(req._requestId || u + Math.random(), { url: u, vendor: vendorOf(u), status: null, failure: null });
  };
  const onResp = (res) => {
    const u = res.url();
    if (!isTracking(u)) return;
    for (const [, b] of beacons) if (b.url === u && b.status === null) { b.status = res.status(); break; }
  };
  const onFail = (req) => {
    const u = req.url();
    if (!isTracking(u)) return;
    for (const [, b] of beacons) if (b.url === u && b.failure === null && b.status === null) { b.failure = req.failure()?.errorText; break; }
  };
  page.on('request', onReq);
  page.on('response', onResp);
  page.on('requestfailed', onFail);

  await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3500));

  page.off('request', onReq);
  page.off('response', onResp);
  page.off('requestfailed', onFail);

  // Aggregate by vendor
  const agg = {};
  for (const [, b] of beacons) {
    (agg[b.vendor] ??= { fired: 0, aborted: 0, statuses: new Set() });
    if (b.failure) agg[b.vendor].aborted++;
    else { agg[b.vendor].fired++; if (b.status != null) agg[b.vendor].statuses.add(b.status); }
  }
  console.log(`\n--- ${label} ---`);
  if (!Object.keys(agg).length) { console.log('  (no tracking beacons observed)'); return; }
  for (const [v, s] of Object.entries(agg)) {
    const st = [...s.statuses].join(',') || '-';
    console.log(`  ${v.padEnd(32)} fired ${s.fired}  aborted ${s.aborted}  [status ${st}]`);
  }
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate(KnownDevices['iPhone 13']);

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
await new Promise((r) => setTimeout(r, 2000));

// Read consent state
const consent = await page.evaluate(() => {
  const cp = window.Shopify && window.Shopify.customerPrivacy;
  if (!cp) return { hasCustomerPrivacy: false };
  const out = { hasCustomerPrivacy: true, methods: Object.keys(cp).filter((k) => typeof cp[k] === 'function') };
  try { out.current = cp.currentVisitorConsent ? cp.currentVisitorConsent() : null; } catch (e) { out.err = e.message; }
  try { out.shouldShowBanner = cp.shouldShowGDPRBanner ? cp.shouldShowGDPRBanner() : null; } catch (e) {}
  return out;
});
console.log(`URL: ${URL}`);
console.log('Shopify Customer Privacy:', JSON.stringify(consent));

// PASS 1 — as-is (default consent)
await pass(page, 'PASS 1 — default consent state');

// Grant consent, then PASS 2
const granted = await page.evaluate(() => new Promise((resolve) => {
  const cp = window.Shopify && window.Shopify.customerPrivacy;
  if (!cp || !cp.setTrackingConsent) return resolve('no setTrackingConsent');
  try {
    cp.setTrackingConsent({ analytics: true, marketing: true, preferences: true, sale_of_data: true }, () => resolve('granted'));
    setTimeout(() => resolve('granted (timeout)'), 4000);
  } catch (e) { resolve('error: ' + e.message); }
}));
console.log('\nConsent grant result:', granted);
await pass(page, 'PASS 2 — consent granted');

console.log('\nInterpretation: beacons that ABORT in pass 1 but FIRE in pass 2 were consent-gated (normal).');
console.log('Beacons that abort in BOTH passes are genuinely broken and would lose conversions.');
await browser.close();
