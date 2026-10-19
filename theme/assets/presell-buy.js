/* presell-buy.js: buy box for the pre-sell page (sections/presell-listicle.liquid).
   Posts the chosen scent to /cart/add.js, then goes straight to /checkout.
   Without JS the form still posts to /cart/add. */
(function () {
  var FALLBACK = 'Sorry, that did not go through. Please try again.';

  function createBuy(deps) {
    var pending = false;
    return {
      submit: function (variantId) {
        if (pending) return Promise.resolve({ ok: false, error: 'Already adding to your cart.' });
        pending = true;
        var done = function (result) { pending = false; return result; };
        var body = JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] });
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

  function relabel(template, tokens, pick) {
    var out = template;
    if (tokens.priceToken) out = out.split(tokens.priceToken).join(pick.price);
    if (tokens.scentToken) out = out.split(tokens.scentToken).join(pick.scent);
    return out;
  }

  function bind(doc, win) {
    win = win || window;
    var form = doc.querySelector('form[data-presell-buy]');
    if (!form) return;
    var select = form.querySelector('select[name=id]');
    var button = form.querySelector('[data-presell-submit]');
    var errorEl = form.querySelector('[data-presell-error]');
    var tokens = { priceToken: form.getAttribute('data-price-token') || '', scentToken: form.getAttribute('data-scent-token') || '' };
    var labels = doc.querySelectorAll('[data-presell-label][data-presell-template]');
    var buy = createBuy({
      fetch: function (u, o) { return win.fetch(u, o); },
      navigate: function (u) { win.location.href = u; }
    });

    function refresh() {
      var opt = select.options[select.selectedIndex];
      if (!opt) return;
      var pick = { scent: opt.getAttribute('data-scent') || opt.text, price: opt.getAttribute('data-price') || '' };
      for (var i = 0; i < labels.length; i++) {
        labels[i].textContent = relabel(labels[i].getAttribute('data-presell-template'), tokens, pick);
      }
    }
    select.addEventListener('change', refresh);
    refresh();

    // Back from /checkout can restore this page from the bfcache with the button
    // still disabled from the successful add.
    win.addEventListener('pageshow', function (e) {
      if (e && e.persisted) {
        button.disabled = false;
        errorEl.hidden = true;
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      errorEl.hidden = true;
      buy.submit(select.value).then(function (r) {
        if (!r.ok) {
          errorEl.textContent = r.error;
          errorEl.hidden = false;
          button.disabled = false;
        }
      });
    });
  }

  var api = { createBuy: createBuy, relabel: relabel, bind: bind };
  if (typeof window !== 'undefined') {
    window.PresellBuy = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { bind(document); });
    else bind(document);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
