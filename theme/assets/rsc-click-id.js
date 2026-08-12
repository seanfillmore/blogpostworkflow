/**
 * Capture the Google click identifier into a Shopify cart attribute.
 *
 * WHY: Shopify caps order.landing_site at 255 characters, and Google Shopping puts
 * gclid LAST in the query string — so the gclid always arrives server-side as a
 * 4-character stump ("CjwK") while gbraid survives. A stump is worse than nothing:
 * Google accepts it and attributes it to no click. Cart attributes have no such cap
 * and land on the order as note_attributes, which is the only way a complete gclid
 * can reach agents/ads-conversion-uploader.
 *
 * Deliberately tiny and dependency-free. It is inert on every page that is not an ad
 * landing: with no click id in the URL and nothing stored, it does nothing at all and
 * issues no network request.
 */
(function () {
  var KEYS = ['gclid', 'gbraid', 'wbraid'];
  var STORE = 'rsc_click_id';
  var SENT = 'rsc_click_id_sent';
  // Matches the server-side floor in lib/ads-conversions.js. A short value is a
  // truncated or junk id and must never be stored or uploaded.
  var MIN_LEN = 20;

  function ls(op, k, v) {
    // Safari private mode and blocked-storage contexts throw on access. Attribution is
    // never worth breaking a storefront over.
    try { return op === 'get' ? localStorage.getItem(k) : localStorage.setItem(k, v); }
    catch (e) { return null; }
  }

  function fromUrl() {
    var p;
    try { p = new URLSearchParams(window.location.search); } catch (e) { return null; }
    for (var i = 0; i < KEYS.length; i++) {
      var v = p.get(KEYS[i]);
      if (v && v.length >= MIN_LEN) return { type: KEYS[i], value: v };
    }
    return null;
  }

  // Last-click wins: Google attributes to the most recent click, so a fresh id from the
  // URL always overwrites whatever was stored from an earlier visit.
  var found = fromUrl();
  if (found) {
    ls('set', STORE, found.type + ':' + found.value);
  }

  var stored = ls('get', STORE);
  if (!stored) return;

  // Only write to the cart once per distinct id. Without this guard every page view on
  // the session would POST /cart/update.js for no benefit.
  if (ls('get', SENT) === stored) return;

  var sep = stored.indexOf(':');
  var type = stored.slice(0, sep);
  var value = stored.slice(sep + 1);
  if (KEYS.indexOf(type) === -1 || value.length < MIN_LEN) return;

  var attributes = {};
  attributes[type] = value;

  fetch('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attributes: attributes }),
    keepalive: true,
  }).then(function (r) {
    if (r.ok) ls('set', SENT, stored);
  }).catch(function () { /* attribution is best-effort; never surface an error */ });
})();
