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

  // --- referral address: catch a provider typo BEFORE submit ---
  //
  // Official Rules §5 identifies a referral "solely by the referrer's email
  // address entered in that field", and §6 awards a second $536.40 prize to the
  // referrer "named at the time of entry". A mistyped address therefore cannot
  // lawfully be repaired afterwards -- lib/giveaway/referral-audit.js reports
  // those and deliberately does not fix them. This is the last moment it is
  // fixable, so the check lives here.
  //
  // Deliberately LOOKS NOTHING UP. It is pure string work against a fixed list
  // of consumer providers, so it cannot leak whether any address entered the
  // giveaway. An earlier design compared against real entrants over an endpoint;
  // that was dropped because it would have put a Klaviyo call on the entry path
  // and handed out confirmed entrants' addresses to anyone who asked.
  //
  // MIRRORS lib/giveaway/referrer-suggest.js. Kept in sync by
  // tests/theme/giveaway-referrer-typo.test.js, which fails if the two lists
  // drift -- the server module cannot be imported here, because Shopify serves
  // this file and there is no build step.
  var KNOWN_DOMAINS = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
    'aol.com', 'live.com', 'msn.com', 'comcast.net', 'me.com', 'mac.com',
    'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'ymail.com',
    'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
    'charter.net', 'earthlink.net', 'zoho.com', 'yandex.com'
  ];

  function editDistance(a, b) {
    if (a === b) return 0;
    var prev = [];
    for (var k = 0; k <= b.length; k++) prev[k] = k;
    for (var i = 1; i <= a.length; i++) {
      var row = [i];
      for (var j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = row;
    }
    return prev[b.length];
  }

  function suggestDomainTypo(raw) {
    var email = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    var at = email.lastIndexOf('@');
    var local = email.slice(0, at);
    var domain = email.slice(at + 1);
    if (!local || !domain) return null;
    // A real provider, or any domain we have no opinion about, is left alone.
    // This check precedes the distance maths on purpose: mail.com is a genuine
    // provider one edit from gmail.com.
    if (KNOWN_DOMAINS.indexOf(domain) !== -1) return null;
    if (domain.length < 5) return null;
    var best = null; var bestDistance = Infinity; var tied = false;
    for (var i = 0; i < KNOWN_DOMAINS.length; i++) {
      var d = editDistance(domain, KNOWN_DOMAINS[i]);
      if (d === 0 || d > 2) continue;
      if (d < bestDistance) { best = KNOWN_DOMAINS[i]; bestDistance = d; tied = false; }
      else if (d === bestDistance) { tied = true; }
    }
    if (!best || tied) return null; // a tie is not a suggestion
    return local + '@' + best;
  }

  // ONE implementation, wired to BOTH address fields. It was attached to #gv-ref
  // only, and the asymmetry was measurable: on 2026-08-24, across 1,102 entrants,
  // the protected referrer field held ZERO domain typos while the unprotected
  // entrant field held FIVE (hotmail.comi, gmail.comc, yahoo.como, gmail.comin,
  // hotmail.cp) — all five unconfirmed, because the confirmation email cannot
  // reach an address that does not exist.
  //
  // The stakes differ by field and both are unrecoverable after submit. A mistyped
  // REFERRER cannot lawfully be corrected (§5 makes the typed value the sole
  // identifier). A mistyped ENTRANT address is worse in a plainer way: that person
  // never gets the confirm email, so they can never confirm, never be credited,
  // never be sold to, and never be told. They are simply gone, and they do not know.
  function attachTypoCheck(input, note, fix) {
    if (!input || !fix) return;
    var show = function () {
      var typed = (input.value || '').trim();
      if (note) note.hidden = !typed;
      var guess = suggestDomainTypo(typed);
      if (!guess) { fix.hidden = true; fix.textContent = ''; return; }
      // Rebuild rather than append: showing twice without clearing stacks a second
      // "Did you mean" onto the first.
      fix.textContent = 'Did you mean ';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gv-ref-fix-apply';
      btn.textContent = guess;
      btn.addEventListener('click', function () {
        input.value = guess;
        fix.hidden = true;
        // Return focus so a keyboard or screen-reader user is not dropped at the
        // top of the document by the button they just removed from the flow.
        try { input.focus(); } catch (e) { /* focus is best effort */ }
      });
      fix.appendChild(btn);
      fix.appendChild(document.createTextNode('?'));
      fix.hidden = false;
    };
    input.addEventListener('blur', show);
    input.addEventListener('input', function () {
      // Only ever retract on typing; re-proposing mid-word is noise.
      if (note) note.hidden = !(input.value || '').trim();
      fix.hidden = true;
    });
  }

  attachTypoCheck(
    form.querySelector('#gv-ref'),
    form.querySelector('.gv-ref-note'),
    form.querySelector('.gv-ref-fix')
  );
  // No note element on the entrant field — the referrer note explains an
  // irreversible RULES consequence, whereas a suggestion on your own address
  // speaks for itself and a standing warning over the first field of the form
  // would cost entries.
  attachTypoCheck(
    form.querySelector('#gv-email'),
    null,
    form.querySelector('.gv-email-fix')
  );

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    var data = new FormData(form);
    var email = (data.get('email') || '').trim();
    var firstName = (data.get('firstName') || '').trim();
    if (!email || !firstName) return fail('Email and first name are both required.');

    button.disabled = true;
    button.textContent = 'Entering…';

    // Meta match signals. _fbp is set by the pixel; _fbc only exists once a
    // click has carried an fbclid, so construct it in Meta's documented
    // fb.1.<ts>.<fbclid> form when the cookie has not been written yet —
    // otherwise every click-through lead loses its click id and lands at a
    // materially lower match quality.
    function cookie(name) {
      var m = document.cookie.match(new RegExp('(^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[2]) : null;
    }
    var fbc = cookie('_fbc');
    if (!fbc) {
      var clickId = new URLSearchParams(window.location.search).get('fbclid');
      if (clickId) fbc = 'fb.1.' + Date.now() + '.' + clickId;
    }

    fetch(endpoint + '/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email, firstName: firstName, referredBy: data.get('referredBy') || null,
        fbc: fbc, fbp: cookie('_fbp')
      })
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
  // Hoisted to this scope because fail() has to be able to put BOTH the survey
  // and the buy path back exactly as they were before the optimistic hide below.
  var next = root.querySelector('[data-gv-next]');

  // The single rollback point for the optimistic hide in the submit handler.
  // Anything the handler changes before the fetch must be undone here, or a
  // 400/429/502 leaves the entrant staring at a page with no form, no error and
  // no way to claim the +3.
  function fail(msg) {
    survey.hidden = false;
    if (next) next.hidden = true;
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
  // Shown only to someone who named a referrer AND has not confirmed yet.
  //
  // §5 pays the referrer +5 only once the friend they referred confirms, so
  // until this person clicks, their referrer has nothing. Measured 2026-08-22,
  // six of seven referral pairs were stuck at exactly this step. Every other
  // argument on this page is about what the reader gets; this is the only one
  // about what someone else loses.
  //
  // Once they HAVE confirmed the line is false and must not appear — the
  // referrer has been credited.
  var referralStake = root.querySelector('[data-gv-referral-stake]');
  function showReferralStake(body) {
    if (!referralStake) return;
    var named = Boolean(body && body.hasReferrer);
    var confirmed = Boolean(body && body.breakdown && body.breakdown.confirmed);
    referralStake.hidden = !(named && !confirmed);
  }

  fetch(endpoint + '/entries?email=' + encodeURIComponent(email))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (body) {
      showLadder(body && typeof body.entries === 'number' ? body.entries : null);
      showReferralStake(body);
    })
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

    // Hide the form and reveal the buy path HERE, synchronously inside the
    // submit handler, NOT in the .then() below.
    //
    // The form is ~900-1100px tall and .gv-ladder sits directly under it in DOM
    // order, already on screen. Hiding the form snaps the ladder upward. Done in
    // the .then() that runs after POST /answers, that snap lands 15-45s into the
    // session and well past Chrome's 500ms hadRecentInput window on a mobile
    // connection, so it counts in full: measured p75 CLS 0.3141 on this page,
    // 98 of 117 non-zero beacons blaming `section.gv-entered > div.gv-ladder`,
    // median 0.4424. This page is where $30/day of Meta traffic lands.
    //
    // Moved here, the identical shift happens inside the input window and is
    // excluded from CLS. Nothing else about the sequence changes -- see fail()
    // for the rollback that keeps the hide-only-on-success guarantee below.
    survey.hidden = true;
    if (next) next.hidden = false;

    fetch(endpoint + '/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      // A .catch alone covers only a NETWORK failure. On a 400, a 429 or a 502
      // the promise resolves normally with {ok:false}, so the form must be put
      // BACK on every non-success -- otherwise the survey silently vanishes, the
      // +3 rung is lost, no error is shown, and the entrant has no way to know
      // they were not credited and no way to retry. The hide is now optimistic
      // rather than deferred (see the submit handler), but the guarantee is
      // unchanged: the form is only gone for good on a real success, and every
      // failure path -- non-2xx, {ok:false}, malformed body, network error --
      // routes through fail(), which restores it.
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.ok) {
          return fail((res.body && res.body.error) || 'We could not save your answers. Please try again.');
        }
        submitButton.disabled = false;
        submitButton.textContent = 'Save — and get 3 bonus entries';
        // survey.hidden / next.hidden were already set before the fetch. Only
        // the authoritative entry count has to wait for the response.
        showLadder(res.body.entries);
      })
      .catch(function () { fail('Network error. Please try again.'); });
  });

  var bonus = root.querySelector('[data-gv-bonus]');
  if (bonus) {
    var bonusButton = bonus.querySelector('button[type="submit"]');

    bonus.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = bonus.querySelector('.gv-bonus-error');
      var ok = bonus.querySelector('.gv-bonus-ok');
      err.hidden = true;
      if (ok) ok.hidden = true;
      // Any failed leg suppresses the success confirmation. The Instagram and
      // upload legs settle independently, so "handle credited, upload failed"
      // is a real outcome — reporting it as claimed would be a lie.
      var hadError = false;
      var handle = bonus.querySelector('[name="igHandle"]').value.trim();
      var fileInput = bonus.querySelector('[name="file"]');
      var rights = bonus.querySelector('[name="rightsGranted"]').checked;
      var file = fileInput.files && fileInput.files[0];

      function showError(msg) { err.textContent = msg; err.hidden = false; hadError = true; }

      // A file without granted rights never reaches /upload, but an
      // Instagram handle submitted alongside it is still credited below --
      // the rights gate applies to the photo only, not to the whole form.
      var willUpload = !!file && rights;
      if (file && !rights) showError('Please tick the box so we can use your photo.');
      if (!handle && !willUpload) return; // nothing is actually going to be sent

      // Disabled for the whole submission, not per-fetch: a double-click or
      // a slow-connection double-tap must not fire two overlapping
      // /answers + /upload pairs. Mirrors the entry form (button state at
      // the top of this file) and the survey form above.
      bonusButton.disabled = true;
      bonusButton.textContent = 'Saving…';

      var inFlight = (handle ? 1 : 0) + (willUpload ? 1 : 0);
      function requestSettled() {
        inFlight -= 1;
        if (inFlight > 0) return;
        bonusButton.disabled = false;
        bonusButton.textContent = 'Claim my bonus entries';
        if (hadError) return;
        // The count lives ABOVE this form, so on a phone it can update entirely
        // off-screen. Without a confirmation next to the button, a successful
        // claim is indistinguishable from nothing happening.
        if (ok) {
          ok.textContent = 'Claimed. You\u2019re at ' + count.textContent + ' entries.';
          ok.hidden = false;
        }
        // Clear the inputs so a second tap cannot re-send the same photo.
        var handleField = bonus.querySelector('[name="igHandle"]');
        var rightsField = bonus.querySelector('[name="rightsGranted"]');
        if (handleField) handleField.value = '';
        if (rightsField) rightsField.checked = false;
        fileInput.value = '';
      }

      if (handle) {
        fetch(endpoint + '/answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, igHandle: handle, instagram: true })
        })
          .then(function (r) { return r.json(); })
          .then(function (b) { if (b && b.entries) count.textContent = String(b.entries); })
          .catch(function () { /* best-effort -- the upload below still runs */ })
          .then(requestSettled);
      }

      if (willUpload) {
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
              if (!b || !b.ok) { showError((b && b.error) || 'Upload failed. Please try again.'); return; }
              count.textContent = String(b.entries);
            })
            .catch(function () { showError('Upload failed. Please try again.'); })
            .then(requestSettled);
        };
        // Without this, a failed local file read (corrupt file, permission
        // issue, a file that vanished between selection and read) never
        // fires onload, so requestSettled() is never called for this leg --
        // inFlight never returns to 0 and the button is stuck on "Saving…"
        // forever, with no explanation, for exactly the +10 rung.
        reader.onerror = function () {
          showError('Could not read that file. Please try again.');
          requestSettled();
        };
        try {
          reader.readAsDataURL(file);
        } catch (readErr) {
          // readAsDataURL can throw synchronously (e.g. InvalidStateError)
          // rather than firing onerror, depending on the browser and why it
          // failed -- same stuck-button risk, same fix.
          showError('Could not read that file. Please try again.');
          requestSettled();
        }
      }
    });
  }
})();
