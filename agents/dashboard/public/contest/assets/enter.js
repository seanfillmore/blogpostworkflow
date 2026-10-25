// Competitor page: enter a dish, or edit it later with the private ?edit=<token> link.
// Every piece of user text goes into the page with textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const editToken = new URLSearchParams(location.search).get('edit');
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const BIG_FILE = 8 * 1024 * 1024;

const form = $('dish-form');
let allergenKeys = [];
let chosenFile = null;
let previewUrl = null;

function show(el, on = true) { el.hidden = !on; }

function message(kind, title, body) {
  const box = $('message');
  box.className = `notice notice-${kind}`;
  box.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = title;
  box.append(strong);
  if (body) {
    const p = document.createElement('p');
    p.textContent = body;
    box.append(p);
  }
  show(box);
}

function formError(text) {
  const box = $('form-error');
  box.replaceChildren();
  if (!text) return show(box, false);
  const lines = Array.isArray(text) ? text : [text];
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    p.style.margin = '2px 0';
    box.append(p);
  }
  show(box);
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const capitalise = (s) => {
  if (!s) return s;
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

// ---- building the form ------------------------------------------------------

function buildCategories(categories, selected) {
  const sel = $('categoryId');
  sel.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a category';
  sel.append(placeholder);
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.append(opt);
  }
  sel.value = selected && categories.some((c) => c.id === selected) ? selected : '';
}

function buildAllergens(labels, selected = []) {
  const box = $('allergens');
  box.replaceChildren();
  allergenKeys = Object.keys(labels);
  for (const key of allergenKeys) {
    const label = document.createElement('label');
    label.className = key === 'none' ? 'check check-none' : 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'allergens';
    input.value = key;
    input.checked = selected.includes(key);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      // "None of these" and the real allergens cannot both be ticked.
      for (const other of box.querySelectorAll('input')) {
        if (other === input) continue;
        if (key === 'none' || other.value === 'none') other.checked = false;
      }
    });
    const text = document.createElement('span');
    text.textContent = labels[key];
    label.append(input, text);
    box.append(label);
  }
}

function wireCounters() {
  for (const el of form.querySelectorAll('[data-counter]')) {
    let counter = el.parentElement.querySelector('.counter');
    if (!counter) {
      counter = document.createElement('span');
      counter.className = 'counter';
      counter.setAttribute('aria-live', 'polite');
      el.after(counter);
    }
    const max = Number(el.maxLength);
    const update = () => {
      const n = el.value.length;
      counter.textContent = `${n.toLocaleString()} of ${max.toLocaleString()} characters`;
      counter.classList.toggle('near', n >= max * 0.9);
    };
    if (!el.dataset.wired) {
      el.dataset.wired = '1';
      el.addEventListener('input', update);
    }
    update();
  }
}

function setPreview(src, altText) {
  const img = $('photo-preview');
  if (!src) {
    img.hidden = true;
    img.removeAttribute('src');
    show($('photo-empty'));
    show($('photo-hint'), false);
    $('photo-pick').classList.remove('has-photo');
    return;
  }
  img.onerror = () => {
    // Some phones (HEIC) cannot preview here. The file is still chosen.
    img.hidden = true;
    const empty = $('photo-empty');
    empty.replaceChildren();
    const a = document.createElement('span');
    a.textContent = 'Photo chosen';
    const b = document.createElement('span');
    b.className = 'sub';
    b.textContent = `${altText || 'Your photo'} (no preview on this phone)`;
    empty.append(a, document.createElement('br'), b);
    show(empty);
  };
  img.src = src;
  img.hidden = false;
  show($('photo-empty'), false);
  show($('photo-hint'));
  $('photo-pick').classList.add('has-photo');
}

$('photo').addEventListener('change', () => {
  const file = $('photo').files && $('photo').files[0];
  if (!file) return;
  chosenFile = file;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  setPreview(previewUrl, file.name);
  formError(null);
});

function fill(dish) {
  $('cook').value = dish.cook || '';
  $('name').value = dish.name || '';
  $('ingredients').value = dish.ingredients || '';
  $('recipe').value = dish.recipe || '';
  for (const box of form.querySelectorAll('input[name="allergens"]')) {
    box.checked = (dish.allergens || []).includes(box.value);
  }
  if (dish.photoUrl) setPreview(dish.photoUrl, 'Your dish photo');
  wireCounters();
}

// ---- checking and sending ---------------------------------------------------

function checkForm() {
  const problems = [];
  const mark = (id, bad) => $(id).setAttribute('aria-invalid', bad ? 'true' : 'false');
  const need = (id, text) => {
    const bad = !$(id).value.trim();
    mark(id, bad);
    if (bad) problems.push(text);
  };
  need('cook', 'Please enter your name.');
  need('name', 'Please enter the name of your dish.');
  need('categoryId', 'Please choose a category.');
  if (!editToken && !chosenFile) problems.push('Please add a photo of your dish.');
  need('ingredients', 'Please list the ingredients.');
  if (!form.querySelector('input[name="allergens"]:checked')) {
    problems.push('Please tick the allergens your dish contains, or "None of these".');
  }
  return problems;
}

function photoHelp(msg) {
  if (/image|photo|upload|read/i.test(msg)) {
    return 'Tip: if your phone saves photos as HEIC, take a screenshot of the photo or choose a JPG, then try again.';
  }
  return null;
}

function send(url, data) {
  // XMLHttpRequest rather than fetch so we can show upload progress on slow phones.
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      $('upload-bar').style.width = `${pct}%`;
      $('upload-text').textContent = pct < 100 ? `Uploading… ${pct}%` : 'Saving your dish…';
    };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: null });
    xhr.ontimeout = () => resolve({ status: 0, body: null });
    xhr.send(data);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError(null);
  const problems = checkForm();
  if (problems.length) return formError(problems);

  const data = new FormData();
  for (const id of ['cook', 'name', 'categoryId', 'ingredients', 'recipe']) data.append(id, $(id).value);
  for (const box of form.querySelectorAll('input[name="allergens"]:checked')) data.append('allergens', box.value);
  if (chosenFile) data.append('photo', chosenFile);

  const btn = $('submit-btn');
  btn.disabled = true;
  const slow = chosenFile && (chosenFile.size > BIG_FILE || !OK_TYPES.includes(chosenFile.type));
  $('upload-text').textContent = slow ? 'Uploading a large photo. This can take a minute…' : 'Uploading…';
  $('upload-bar').style.width = '0';
  show($('upload-state'));

  const url = editToken
    ? `/api/contest/submission?token=${encodeURIComponent(editToken)}`
    : '/api/contest/submit';
  const { status, body } = await send(url, data);
  show($('upload-state'), false);
  btn.disabled = false;

  if (status === 200 && body && body.ok) {
    if (editToken) {
      chosenFile = null;
      $('photo').value = '';
      if (body.dish) fill(body.dish);
      message('ok', 'Your changes are saved.', 'You can come back to this link and change your dish until voting opens.');
      $('message').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      showDone(body.editUrl);
    }
    return;
  }

  if (status === 0) return formError('We could not reach the contest. Check your internet connection and try again.');
  const serverMsg = body && body.error ? capitalise(String(body.error)) : `Something went wrong (error ${status}). Please try again.`;
  const lines = [serverMsg];
  const tip = photoHelp(serverMsg);
  if (tip && chosenFile) lines.push(tip);
  if (status === 409 && /closed|no longer/i.test(serverMsg)) lines.push('Please contact the organizer.');
  formError(lines);
});

// ---- after a new entry: the private link -----------------------------------

function showDone(editPath) {
  const full = new URL(editPath, location.origin).href;
  show(form, false);
  show($('message'), false);
  $('page-title').textContent = 'You are entered';
  $('edit-url').textContent = full;
  const note = `My dish contest entry link (to edit until voting opens): ${full}`;
  $('sms-link').href = `sms:?&body=${encodeURIComponent(note)}`;
  $('mail-link').href = `mailto:?subject=${encodeURIComponent('My dish contest entry link')}&body=${encodeURIComponent(note)}`;
  $('open-edit').href = full;
  show($('done'));
  window.scrollTo({ top: 0 });

  $('copy-btn').onclick = async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(full);
      copied = true;
    } catch {
      // Older phones: select the text so a long press can copy it.
      const range = document.createRange();
      range.selectNodeContents($('edit-url'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { copied = document.execCommand('copy'); } catch { copied = false; }
    }
    $('copy-btn').textContent = copied ? 'Copied!' : 'Copy link';
    $('copy-status').textContent = copied
      ? 'The link is copied. Paste it somewhere safe, like a note or a text to yourself.'
      : 'Press and hold the link above to copy it.';
  };
}

// ---- start --------------------------------------------------------------------

async function start() {
  let form_;
  try {
    form_ = await getJson('/api/contest/submission-form');
  } catch {
    show($('loading'), false);
    return message('error', 'We could not load the contest.', 'Check your internet connection and refresh the page.');
  }
  show($('loading'), false);
  const info = form_.body || {};
  if (info.title) {
    $('contest-title').textContent = info.title;
    document.title = `Enter your dish: ${info.title}`;
  }

  if (editToken) {
    let res;
    try { res = await getJson(`/api/contest/submission?token=${encodeURIComponent(editToken)}`); } catch { res = { status: 0 }; }
    if (res.status !== 200 || !res.body || !res.body.dish) {
      $('page-title').textContent = 'Entry not found';
      return message('error', 'We could not find that entry.',
        res.status === 0
          ? 'Check your internet connection and refresh the page.'
          : 'Please check you opened the whole link you were given, or contact the organizer.');
    }
    const dish = res.body.dish;
    $('page-title').textContent = 'Your dish';
    if (!dish.editable) {
      return message('info', 'Voting has started, so your dish can no longer be changed.',
        `Your entry "${dish.name}" is saved. Please contact the organizer if something needs fixing.`);
    }
    buildCategories(info.categories || [], dish.categoryId);
    buildAllergens(info.allergens || {}, dish.allergens);
    $('intro').textContent = 'Change anything you like, then tap "Save changes". Leave the photo alone to keep the one you sent.';
    $('submit-btn').textContent = 'Save changes';
    if (dish.status === 'pending') {
      message('info', 'Waiting for the organizer', 'Your dish is entered. The organizer will look it over before it appears on the voting page.');
    }
    fill(dish);
    show(form);
    return;
  }

  if (!info.submissionsOpen) {
    $('page-title').textContent = 'Enter your dish';
    return message('info', 'Submissions are closed. Please contact the organizer.');
  }
  if (!info.categories || !info.categories.length) {
    return message('info', 'The organizer has not set up the categories yet.', 'Please check back soon or contact the organizer.');
  }
  buildCategories(info.categories, null);
  buildAllergens(info.allergens || {});
  wireCounters();
  show(form);
}

start();

// Clear a field's red outline as soon as the cook starts fixing it.
form.addEventListener('input', (e) => {
  if (e.target.getAttribute && e.target.getAttribute('aria-invalid') === 'true') e.target.setAttribute('aria-invalid', 'false');
});
form.addEventListener('change', (e) => {
  if (e.target.getAttribute && e.target.getAttribute('aria-invalid') === 'true') e.target.setAttribute('aria-invalid', 'false');
});
