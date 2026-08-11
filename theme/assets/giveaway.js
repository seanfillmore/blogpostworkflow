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

// --- entered page: survey submit + ladder ---
(function () {
  var endpoint = window.RSC_GIVEAWAY_ENDPOINT;
  var root = document.querySelector('[data-gv-entered]');
  if (!root || !endpoint) return;

  var email = null;
  try { email = window.sessionStorage.getItem('gv_email'); } catch (e) { /* private mode */ }

  var survey = root.querySelector('.gv-survey');
  var ladder = root.querySelector('[data-gv-ladder]');
  var count = root.querySelector('[data-gv-count]');

  function showLadder(entries) {
    if (typeof entries === 'number') count.textContent = String(entries);
    ladder.hidden = false;
  }

  // Without an email we cannot attribute answers. Skip straight to the ladder
  // rather than silently posting orphaned data.
  if (!email) { survey.hidden = true; showLadder(null); return; }

  survey.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(survey);
    var payload = {
      email: email,
      household: data.get('household'),
      frustration: data.get('frustration'),
      currentBrand: data.get('currentBrand')
    };
    if (!payload.household || !payload.frustration || !payload.currentBrand) return;

    var button = survey.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving…';

    fetch(endpoint + '/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        survey.hidden = true;
        showLadder(body && body.entries);
      })
      .catch(function () {
        button.disabled = false;
        button.textContent = 'Save — and get 3 bonus entries';
      });
  });
})();
