// theme/assets/giveaway.js
// Entry submission. On success, hand off to the entered page, which is where
// the survey and the entry ladder live. There is NO offer on that page --
// the BOGO is the day-30 consolation prize.
(function () {
  var endpoint = window.RSC_GIVEAWAY_ENDPOINT;
  var form = document.querySelector('.gv-form');
  if (!form || !endpoint) return;
  var errorEl = form.querySelector('.gv-error');
  var button = form.querySelector('button[type="submit"]');

  function fail(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    button.disabled = false;
    button.textContent = 'Enter free';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    var data = new FormData(form);
    var email = (data.get('email') || '').trim();
    var firstName = (data.get('firstName') || '').trim();
    if (!email || !firstName) return fail('Email and first name are both required.');

    button.disabled = true;
    button.textContent = 'Entering…';

    fetch(endpoint + '/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, firstName: firstName, referredBy: data.get('referredBy') || null })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.body.ok) return fail(res.body.error || 'Something went wrong. Please try again.');
        try { window.sessionStorage.setItem('gv_email', email); } catch (err) { /* private mode */ }
        window.location.href = '/pages/giveaway-entered';
      })
      .catch(function () { fail('Network error. Please try again.'); });
  });
})();
