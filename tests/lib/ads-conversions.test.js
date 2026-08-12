import { strict as assert } from 'node:assert';
import {
  extractClickId,
  buildConversionEvent,
  buildIngestRequest,
  selectUploadableOrders,
} from '../../lib/ads-conversions.js';

// Shopify caps `landing_site` at 255 characters. On a Google Shopping ad click the
// parameter order puts gclid LAST, so it is the one that gets sliced — real orders
// #2322/#2329 both arrived with a 4-character gclid ("CjwK") and an intact 34-character
// gbraid. Uploading the stump would be silently attributed to nothing, so the stump must
// be rejected and the intact gbraid used instead.
const TRUNCATED = '/products/coconut-lotion?variant=44414530781354&country=US&currency=USD'
  + '&utm_medium=product_sync&utm_source=google&utm_content=sag_organic'
  + '&utm_campaign=sag_organic&gad_source=1&gad_campaignid=24050427048'
  + '&gbraid=0AAAAAosZu9vrDsIv2dFxV_X3CiCYneab2&gclid=CjwK';

{
  const id = extractClickId(TRUNCATED);
  assert.equal(id.type, 'gbraid', 'must fall back to gbraid when gclid is a truncated stump');
  assert.equal(id.value, '0AAAAAosZu9vrDsIv2dFxV_X3CiCYneab2');
}

// A full-length gclid is the highest-fidelity identifier and wins over gbraid.
{
  const full = 'Cj0KCQjw2N7GBhDeARIsAJb8Rvw8yQ7pQ0mKqRr1a2b3c4d5e6f7g8h9i0jKlMnOpQrStUvWxYz';
  const id = extractClickId(`/p?gbraid=0AAAAAosZu9vrDsIv2dFxV_X3CiCYneab2&gclid=${full}`);
  assert.equal(id.type, 'gclid');
  assert.equal(id.value, full);
}

// wbraid (web-to-app) is accepted when it is the only identifier present.
{
  assert.equal(extractClickId('/p?wbraid=Cj0abcdefghijklmnopqrstuvwxyz12345').type, 'wbraid');
}

// Organic and AI-referral landing pages carry no click id and must be skipped entirely,
// not uploaded with an empty identifier.
{
  assert.equal(extractClickId('/blogs/news/best-non-toxic-body-lotion-2025'), null);
  assert.equal(extractClickId('/products/coconut-lotion?utm_source=chatgpt.com&utm_medium=feed'), null);
  assert.equal(extractClickId(''), null);
  assert.equal(extractClickId(null), null);
}

// A gbraid that is itself truncated is unusable — reject rather than upload garbage.
{
  assert.equal(extractClickId('/p?gbraid=0AAA'), null);
}

// --- Payload construction (Data Manager API) ----------------------------------------
// ConversionUploadService is closed to new integrations as of 2026 ("Usage of
// ConversionUploadService.UploadClickConversions is limited to existing users"), so
// events go to datamanager.googleapis.com/v1/events:ingest instead.

const ORDER = {
  order_number: 2322,
  created_at: '2026-07-31T18:47:07-06:00',
  total_price: '37.19',
  currency: 'USD',
  landing_site: TRUNCATED,
};

{
  const e = buildConversionEvent(ORDER);
  assert.deepEqual(e.adIdentifiers, { gbraid: '0AAAAAosZu9vrDsIv2dFxV_X3CiCYneab2' },
    'must send only the intact identifier, never the truncated gclid');
  assert.equal(e.conversionValue, 37.19);
  assert.equal(e.currency, 'USD');
  assert.equal(e.eventSource, 'WEB');

  // Data Manager takes ISO 8601 with offset, which is exactly Shopify's format — pass it
  // through rather than reformatting. Re-basing to UTC would move the event into a
  // different local day and can push it outside the click lookback window.
  assert.equal(e.eventTimestamp, '2026-07-31T18:47:07-06:00');

  // transactionId is what makes re-running the agent idempotent — Google deduplicates on
  // it, so a daily cron re-reading the same window cannot double-count.
  assert.equal(e.transactionId, '2322');
}

// A malformed timestamp must fail loudly rather than silently uploading a bad event.
{
  assert.throws(() => buildConversionEvent({ ...ORDER, created_at: '31/07/2026' }), /timestamp/i);
}

// The request wraps events with the destination account + conversion action, and carries
// validateOnly so a dry run can be proven against Google before anything is written.
{
  const req = buildIngestRequest([ORDER], {
    accountId: '5099369750', conversionActionId: '7718887636', validateOnly: true,
  });
  assert.deepEqual(req.destinations, [{
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '5099369750' },
    productDestinationId: '7718887636',
  }]);
  assert.equal(req.events.length, 1);
  assert.equal(req.validateOnly, true);
  assert.equal(req.events[0].transactionId, '2322');
}

// --- Order selection ----------------------------------------------------------------

const NOW = new Date('2026-08-12T12:00:00-07:00');

const orders = [
  { ...ORDER, order_number: 1, created_at: '2026-08-10T10:00:00-06:00' },              // paid, recent
  { ...ORDER, order_number: 2, landing_site: '/blogs/news/x' },                        // no click id
  { ...ORDER, order_number: 3, total_price: '0.00', created_at: '2026-08-10T10:00:00-06:00' }, // $0
  { ...ORDER, order_number: 4, created_at: '2026-01-01T10:00:00-06:00' },              // outside lookback
];

{
  const picked = selectUploadableOrders(orders, { now: NOW, lookbackDays: 90 });
  assert.deepEqual(picked.map(o => o.order_number), [1],
    'only paid, click-identified orders inside the lookback window are uploadable');
}

// Cancelled orders are revenue that never happened — uploading them teaches Smart Bidding
// to chase refunds.
{
  const cancelled = [{ ...ORDER, order_number: 5, created_at: '2026-08-10T10:00:00-06:00',
    cancelled_at: '2026-08-11T10:00:00-06:00' }];
  assert.deepEqual(selectUploadableOrders(cancelled, { now: NOW, lookbackDays: 90 }), []);
}

console.log('ads-conversions: all assertions passed');
