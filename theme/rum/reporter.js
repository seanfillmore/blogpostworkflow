/**
 * Real User Monitoring reporter — source half of theme/assets/rsc-rum.js.
 *
 * Runs in the storefront after the vendored web-vitals attribution build, which
 * exposes window.webVitals. Collects the Core Web Vitals for the current page
 * view and beacons them to the dashboard's /api/rum collector.
 *
 * Why this exists: CrUX has no field data for realskincare.com at URL *or*
 * origin level (traffic is below Google's reporting threshold) and Clarity has
 * no timing metric at all, so lab PageSpeed scores were our only signal. Those
 * are a throttled stress test, not what buyers experience. This closes that gap.
 *
 * Config comes from window.__RSC_RUM, set by snippets/rsc-rum.liquid.
 *
 * Do not edit theme/assets/rsc-rum.js directly — run scripts/build-rum-asset.mjs.
 */
(function () {
  var cfg = window.__RSC_RUM || {};
  var wv = window.webVitals;
  if (!cfg.endpoint || !wv) return;

  // Sampling is a no-op at current traffic (~33 real sessions/day) but exists so
  // the rate can be dialled back from the snippet without a code change.
  var sample = typeof cfg.sample === 'number' ? cfg.sample : 1;
  if (sample < 1 && Math.random() > sample) return;

  var queued = {};
  var sent = {};

  function round(n, places) {
    var f = Math.pow(10, places || 0);
    return Math.round(n * f) / f;
  }

  // Keep selectors bounded — they end up in a JSONL file and some Shopify app
  // wrappers produce very long selector chains.
  function selector(s) {
    return typeof s === 'string' && s ? s.slice(0, 300) : null;
  }

  function attributionFor(metric) {
    var a = metric.attribution;
    if (!a) return null;
    switch (metric.name) {
      case 'LCP':
        return {
          element: selector(a.element),
          url: typeof a.url === 'string' ? a.url.slice(0, 300) : null,
          ttfb: round(a.timeToFirstByte || 0),
          loadDelay: round(a.resourceLoadDelay || 0),
          loadDuration: round(a.resourceLoadDuration || 0),
          renderDelay: round(a.elementRenderDelay || 0),
        };
      case 'CLS':
        return {
          element: selector(a.largestShiftTarget),
          largestShiftValue: round(a.largestShiftValue || 0, 4),
          largestShiftTime: round(a.largestShiftTime || 0),
        };
      case 'INP':
        return {
          element: selector(a.interactionTarget),
          interactionType: a.interactionType || null,
          inputDelay: round(a.inputDelay || 0),
          processingDuration: round(a.processingDuration || 0),
          presentationDelay: round(a.presentationDelay || 0),
        };
      default:
        return null;
    }
  }

  function record(metric) {
    queued[metric.name] = {
      name: metric.name,
      // CLS is a unitless fraction; everything else is milliseconds.
      value: metric.name === 'CLS' ? round(metric.value, 4) : round(metric.value, 1),
      rating: metric.rating,
      navigationType: metric.navigationType || null,
      attr: attributionFor(metric),
    };
  }

  function flush() {
    var metrics = [];
    for (var name in queued) {
      if (!sent[name]) {
        metrics.push(queued[name]);
        sent[name] = true;
      }
    }
    if (!metrics.length) return;

    var conn = navigator.connection || {};
    var body = JSON.stringify({
      v: 1,
      path: location.pathname.slice(0, 300),
      template: cfg.template || null,
      vw: window.innerWidth || null,
      conn: conn.effectiveType || null,
      saveData: conn.saveData === true,
      metrics: metrics,
    });

    // fetch+keepalive over sendBeacon: sendBeacon cannot set headers, and the
    // free ngrok tunnel needs ngrok-skip-browser-warning to avoid its
    // interstitial. Falls back to sendBeacon where keepalive is unsupported.
    try {
      if (window.fetch) {
        fetch(cfg.endpoint, {
          method: 'POST',
          body: body,
          keepalive: true,
          mode: 'cors',
          credentials: 'omit',
          headers: {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': '1',
          },
        }).catch(function () {});
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(cfg.endpoint, body);
      }
    } catch (e) { /* never let telemetry break the page */ }
  }

  // Registration order matters. web-vitals finalises LCP/CLS/INP from its own
  // visibilitychange listeners, so ours must be registered *after* these calls
  // to run last and see every metric. Listeners fire in registration order.
  wv.onLCP(record);
  wv.onCLS(record);
  wv.onINP(record);
  wv.onTTFB(record);
  wv.onFCP(record);

  addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
  addEventListener('pagehide', flush);
})();
