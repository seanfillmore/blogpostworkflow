/* presell-buy.js: buy box for the pre-sell page (sections/presell-listicle.liquid).
   Posts the chosen scent and quantity (or the scent's 4-pack) to /cart/add.js,
   then goes straight to /checkout. Without JS the form still posts one jar to
   /cart/add. */
(function () {
  var FALLBACK = 'Sorry, that did not go through. Please try again.';
  var MAX_QTY = 10;
  var DEFAULT_STEPPER_MAX = 3; // when data-max is missing or unreadable

  /** Integer 1..10; anything unreadable is 1. */
  function clampQuantity(q) {
    var n = Math.floor(Number(q));
    if (!isFinite(n) || n < 1) return 1;
    return n > MAX_QTY ? MAX_QTY : n;
  }

  /** Cents -> money_without_trailing_zeros: "$28", "$27.50", "$1,234". */
  function formatMoney(cents, prefix) {
    var c = Math.round(Number(cents));
    var whole = String(Math.floor(c / 100));
    var rem = c % 100;
    var grouped = '';
    while (whole.length > 3) {
      grouped = ',' + whole.slice(-3) + grouped;
      whole = whole.slice(0, -3);
    }
    grouped = whole + grouped;
    return (prefix || '') + grouped + (rem ? '.' + (rem < 10 ? '0' : '') + rem : '');
  }

  function createBuy(deps) {
    var pending = false;
    return {
      submit: function (variantId, quantity) {
        if (pending) return Promise.resolve({ ok: false, error: 'Already adding to your cart.' });
        pending = true;
        var done = function (result) { pending = false; return result; };
        var body = JSON.stringify({ items: [{ id: Number(variantId), quantity: clampQuantity(quantity) }] });
        return Promise.resolve()
          .then(function () {
            return deps.fetch('/cart/add.js', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: body
            });
          })
          .then(function (res) {
            if (res && res.ok) {
              try { deps.navigate('/checkout'); } catch (e) { return done({ ok: false, error: FALLBACK }); }
              return done({ ok: true });
            }
            return Promise.resolve(res && res.json ? res.json() : null)
              .then(function (d) { return d; }, function () { return null; })
              .then(function (d) {
                return done({ ok: false, error: (d && (d.description || d.message)) || FALLBACK });
              });
          }, function (err) {
            return done({ ok: false, error: FALLBACK });
          });
      }
    };
  }

  // token name -> pick field
  var TOKEN_FIELDS = [
    ['priceToken', 'price'], ['scentToken', 'scent'], ['quantityToken', 'quantity'],
    ['totalToken', 'total'], ['packPriceToken', 'packPrice'], ['packUnitToken', 'packUnit']
  ];

  /**
   * Replace every token in ONE left-to-right pass over the template, so a value
   * just written in (say "$112") is never rescanned for another token (the
   * quantity token "2"). Plain string compares, never String.replace, so a "$"
   * in a value stays literal. Longest token wins at a position.
   */
  function relabel(template, tokens, pick) {
    var pairs = [];
    for (var i = 0; i < TOKEN_FIELDS.length; i++) {
      var t = tokens[TOKEN_FIELDS[i][0]];
      var v = pick[TOKEN_FIELDS[i][1]];
      if (t && v !== undefined && v !== null) pairs.push([t, String(v)]);
    }
    pairs.sort(function (a, b) { return b[0].length - a[0].length; });
    var out = '';
    var pos = 0;
    while (pos < template.length) {
      var hit = null;
      for (var j = 0; j < pairs.length; j++) {
        if (template.substr(pos, pairs[j][0].length) === pairs[j][0]) { hit = pairs[j]; break; }
      }
      if (hit) { out += hit[1]; pos += hit[0].length; }
      else { out += template.charAt(pos); pos += 1; }
    }
    return out;
  }

  function on(el, type, fn) { if (el && el.addEventListener) el.addEventListener(type, fn); }
  function intAttr(el, name) {
    var v = el && el.getAttribute ? el.getAttribute(name) : null;
    var n = parseInt(v, 10);
    return isFinite(n) ? n : null;
  }

  function bind(doc, win) {
    win = win || window;
    var form = doc.querySelector('form[data-presell-buy]');
    if (!form) return;
    var select = form.querySelector('select[name=id]');
    var button = form.querySelector('[data-presell-submit]');
    var errorEl = form.querySelector('[data-presell-error]');
    var stepper = form.querySelector('[data-presell-qty]');
    var dec = form.querySelector('[data-presell-qty-dec]');
    var inc = form.querySelector('[data-presell-qty-inc]');
    var qtyOut = form.querySelector('[data-presell-qty-value]');
    var qtyInput = form.querySelector('input[name=quantity]');
    var hint = form.querySelector('[data-presell-qty-hint]');
    var hintButton = form.querySelector('[data-presell-qty-hint-buy]');
    var banner = doc.querySelector('[data-presell-pack]');
    var packButton = doc.querySelector('[data-presell-pack-buy]');
    var packError = doc.querySelector('[data-presell-pack-error]');
    var attr = function (n) { return form.getAttribute(n) || ''; };
    var tokens = {
      priceToken: attr('data-price-token'), scentToken: attr('data-scent-token'),
      quantityToken: attr('data-quantity-token'), totalToken: attr('data-total-token'),
      packPriceToken: attr('data-pack-price-token'), packUnitToken: attr('data-pack-unit-token')
    };
    var labels = doc.querySelectorAll('[data-presell-label][data-presell-template]');
    var rawMax = intAttr(stepper, 'data-max');
    var maxQty = rawMax && rawMax > 0 ? clampQuantity(rawMax) : DEFAULT_STEPPER_MAX;
    var qty = 1;
    var buy = createBuy({
      fetch: function (u, o) { return win.fetch(u, o); },
      navigate: function (u) { win.location.href = u; }
    });

    function current() {
      return select && select.options ? select.options[select.selectedIndex] : null;
    }
    /** The selected scent's 4-pack, or null when there is none or it is not a deal. */
    function packFor(opt) {
      if (!opt || !opt.getAttribute) return null;
      var id = opt.getAttribute('data-pack-id');
      var packCents = intAttr(opt, 'data-pack-cents');
      var unitCents = intAttr(opt, 'data-price-cents');
      if (!id || packCents === null || unitCents === null || packCents <= 0) return null;
      if (packCents > unitCents * 3) return null; // "get the 4th free" would be false
      return { id: id, price: opt.getAttribute('data-pack-price') || '', unit: opt.getAttribute('data-pack-unit') || '' };
    }

    function refresh() {
      var opt = current();
      if (!opt) return;
      var price = opt.getAttribute('data-price') || '';
      var cents = intAttr(opt, 'data-price-cents');
      var prefix = '';
      for (var k = 0; k < price.length && (price.charAt(k) < '0' || price.charAt(k) > '9'); k++) prefix += price.charAt(k);
      var pack = packFor(opt);
      var pick = {
        scent: opt.getAttribute('data-scent') || opt.text,
        price: price,
        packPrice: pack ? pack.price : undefined,
        packUnit: pack ? pack.unit : undefined
      };
      // The quantity token is a bare digit ("2"), so it is only ever applied to
      // the multi-jar templates it was written for, never to per-jar copy.
      var multiPick = {
        scent: pick.scent,
        price: price,
        quantity: String(qty),
        total: cents === null ? price : formatMoney(cents * qty, prefix)
      };
      for (var i = 0; i < labels.length; i++) {
        var multi = labels[i].getAttribute('data-presell-template-multi');
        labels[i].textContent = qty > 1 && multi
          ? relabel(multi, tokens, multiPick)
          : relabel(labels[i].getAttribute('data-presell-template'), tokens, pick);
      }
      if (qtyOut) qtyOut.textContent = String(qty);
      if (qtyInput) qtyInput.value = String(qty);
      if (dec) dec.disabled = qty <= 1;
      if (inc) inc.disabled = qty >= maxQty;
      if (banner) banner.hidden = !pack;
      // At 3 jars the single-jar total equals (or beats) the pack price, so
      // point at the 4th jar. Same honesty guard as the banner.
      if (hint) hint.hidden = !(pack && qty >= 3);
    }

    function step(delta) {
      return function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var next = qty + delta;
        if (next < 1 || next > maxQty) return;
        qty = next;
        refresh();
      };
    }

    function setBusy(busy) {
      if (button) button.disabled = busy;
      if (packButton) packButton.disabled = busy;
      if (hintButton) hintButton.disabled = busy;
    }
    function hideErrors() {
      if (errorEl) errorEl.hidden = true;
      if (packError) packError.hidden = true;
    }
    function run(variantId, quantity, errTarget) {
      setBusy(true);
      hideErrors();
      buy.submit(variantId, quantity).then(function (r) {
        if (!r.ok) {
          if (errTarget) {
            errTarget.textContent = r.error;
            errTarget.hidden = false;
          }
          setBusy(false);
        }
      });
    }

    on(select, 'change', refresh);
    on(dec, 'click', step(-1));
    on(inc, 'click', step(1));
    refresh();

    // Back from /checkout can restore this page from the bfcache with the
    // buttons still disabled from the successful add.
    on(win, 'pageshow', function (e) {
      if (e && e.persisted) {
        setBusy(false);
        hideErrors();
      }
    });

    function busy() {
      return (button && button.disabled) || (packButton && packButton.disabled) || (hintButton && hintButton.disabled);
    }
    function buyPack(errTarget) {
      return function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (busy()) return;
        var pack = packFor(current());
        if (!pack) return;
        run(pack.id, 1, errTarget);
      };
    }
    on(packButton, 'click', buyPack(packError));
    on(hintButton, 'click', buyPack(errorEl));

    on(form, 'submit', function (e) {
      e.preventDefault();
      if (busy()) return;
      run(select.value, qty, errorEl);
    });

    // LAST, after every listener is attached. The cart-drawer app (Zipify OCU)
    // captures clicks on any form whose action is /cart/add, adds the item
    // itself and opens its drawer, so this handler never runs and the shopper
    // never reaches checkout (seen on the preview theme 2026-10-19). The action
    // is only the no-JS fallback; with JS bound it has done its job.
    if (form.removeAttribute) form.removeAttribute('action');
  }

  var api = { createBuy: createBuy, relabel: relabel, bind: bind, clampQuantity: clampQuantity, formatMoney: formatMoney };
  if (typeof window !== 'undefined') {
    window.PresellBuy = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { bind(document); });
    else bind(document);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
