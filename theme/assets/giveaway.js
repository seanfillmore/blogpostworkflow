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

  // Identity, in priority order:
  //   1. ?e= on the URL — this is how a nurture email brings someone back.
  //      sessionStorage is TAB-SCOPED and does not survive an email-client ->
  //      browser jump, so for return visitors it is almost always empty. That
  //      is the dominant return path, so without this param the ladder would
  //      show a wrong count to exactly the people the campaign drove back.
  //   2. sessionStorage, set by the lander on first entry.
  var email = null;
  try {
    var qp = new URLSearchParams(window.location.search);
    email = qp.get('e') || window.sessionStorage.getItem('gv_email');
    if (email) window.sessionStorage.setItem('gv_email', email);
  } catch (e) { /* private mode, or no URLSearchParams */ }

  var survey = root.querySelector('.gv-survey');
  var ladder = root.querySelector('[data-gv-ladder]');
  var count = root.querySelector('[data-gv-count]');
  var errorEl = survey.querySelector('.gv-error');
  var submitButton = survey.querySelector('button[type="submit"]');

  function fail(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    submitButton.disabled = false;
    submitButton.textContent = 'Save — and get 3 bonus entries';
  }

  // Never display a number we do not know. The markup ships a placeholder of 1;
  // showing that to someone who actually has 11 entries makes the ladder — the
  // campaign's whole engagement mechanic — actively misleading. If we cannot
  // establish the real total, hide the count instead of inventing one.
  function showLadder(entries) {
    if (typeof entries === 'number') {
      count.textContent = String(entries);
      count.parentNode.hidden = false;
    } else {
      count.parentNode.hidden = true;
    }
    ladder.hidden = false;
  }

  // Without an email we cannot attribute answers. Show the ladder's actions so
  // the page is still useful, but post nothing and claim no count.
  if (!email) { survey.hidden = true; showLadder(null); return; }

  // We know who they are, so fetch the authoritative total. A 404 means they
  // have not entered yet; anything else is a transient failure. In both cases
  // fall back to hiding the count rather than showing a fabricated one.
  fetch(endpoint + '/entries?email=' + encodeURIComponent(email))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (body) { showLadder(body && typeof body.entries === 'number' ? body.entries : null); })
    .catch(function () { showLadder(null); });

  survey.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    var data = new FormData(survey);
    var payload = {
      email: email,
      household: data.get('household'),
      frustration: data.get('frustration'),
      currentBrand: data.get('currentBrand')
    };
    if (!payload.household || !payload.frustration || !payload.currentBrand) return;

    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';

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
      .catch(function () { fail('Network error. Please try again.'); });
  });

  var bonus = root.querySelector('[data-gv-bonus]');
  if (bonus) {
    bonus.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = bonus.querySelector('.gv-bonus-error');
      err.hidden = true;
      var handle = bonus.querySelector('[name="igHandle"]').value.trim();
      var fileInput = bonus.querySelector('[name="file"]');
      var rights = bonus.querySelector('[name="rightsGranted"]').checked;
      var file = fileInput.files && fileInput.files[0];

      function showError(msg) { err.textContent = msg; err.hidden = false; }

      if (handle) {
        fetch(endpoint + '/answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, igHandle: handle, instagram: true })
        })
          .then(function (r) { return r.json(); })
          .then(function (b) { if (b && b.entries) count.textContent = String(b.entries); })
          .catch(function () { /* best-effort -- the upload below still runs */ });
      }

      if (!file) return;
      if (!rights) return showError('Please tick the box so we can use your photo.');

      var reader = new FileReader();
      reader.onload = function () {
        var base64 = String(reader.result).split(',')[1];
        fetch(endpoint + '/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, filename: file.name, dataBase64: base64, rightsGranted: true })
        })
          .then(function (r) { return r.json(); })
          .then(function (b) {
            if (!b || !b.ok) return showError((b && b.error) || 'Upload failed. Please try again.');
            count.textContent = String(b.entries);
          })
          .catch(function () { showError('Upload failed. Please try again.'); });
      };
      reader.readAsDataURL(file);
    });
  }
})();
