// Dish contest admin page. Served behind the dashboard's basic auth; every fetch
// to /api/contest/admin/* is same-origin, so the browser carries the login.
//
// Rules this file keeps:
// - All user text goes into the page with textContent, never innerHTML.
// - Every action shows the server's error message verbatim on failure and
//   re-renders from the returned `state` on success.
// - Polls the admin state every 5 s, but never clobbers what the admin is typing:
//   a section is only rebuilt when its data changed, a poll skips sections that
//   hold the focused input, and unsaved text in a keyed input survives a rebuild.

const PUBLIC_BASE = 'https://vote.realskincare.com';
const POLL_MS = 5000;
const PLACE_FOR_STEP = { 1: 3, 2: 2, 3: 1 };
const PHASE_LABEL = {
  setup: 'Setup', open: 'Voting open', closed: 'Voting closed', revealing: 'Revealing', done: 'Done',
};

const $ = (id) => document.getElementById(id);

let state = null;            // last adminView from the server
let clockOffset = 0;         // server time minus local time, ms
let allergenLabels = null;   // { key: label } from /api/contest/submission-form
let deadlineMode = 'minutes';
let busy = false;
let flashTimer = null;
let refreshedAtZero = false;
let reopenOpen = false;
const sigs = {};             // section -> signature of the data it was last built from
const drafts = new Map();    // data-key -> unsaved text

// ---- small helpers --------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick, attrs = {}) {
  const b = el('button', `btn ${className || ''}`.trim(), label);
  b.type = 'button';
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

function ordinal(n) { return { 1: '1st', 2: '2nd', 3: '3rd' }[n] || `${n}th`; }

function phase() { return state ? state.effectivePhase : 'setup'; }

function locked() { return phase() === 'revealing' || phase() === 'done'; }

function catName(id) {
  const c = state.categories.find((x) => x.id === id);
  return c ? c.name : 'No category';
}

function photoUrl(dish) {
  return dish.photoVersion > 0 ? `/contest/photos/${dish.id}-${dish.photoVersion}.webp` : null;
}

function photoNode(dish, className) {
  const url = photoUrl(dish);
  if (url) {
    const img = el('img', className);
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }
  const ph = el('div', `${className} dish-photo-empty`, 'No photo');
  return ph;
}

function badgesFor(dish) {
  const ul = el('ul', 'badges');
  for (const a of dish.allergens || []) {
    const label = (allergenLabels && allergenLabels[a]) || a;
    ul.append(el('li', a === 'none' ? 'badge badge-none' : 'badge', label));
  }
  return ul;
}

function voteCount() {
  if (!state) return 0;
  let n = 0;
  for (const rows of Object.values(state.tally || {})) for (const r of rows) n += r.votes;
  return n;
}

function serverNow() { return Date.now() + clockOffset; }

function formatLeft(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---- flash messages -------------------------------------------------------

function flash(kind, text) {
  const box = $('flash');
  clearTimeout(flashTimer);
  if (!text) { box.hidden = true; return; }
  box.className = `flash flash-${kind}`;
  box.textContent = text;
  box.hidden = false;
  flashTimer = setTimeout(() => { box.hidden = true; }, kind === 'error' ? 12000 : 3500);
}

// ---- confirm dialog -------------------------------------------------------

function confirmAction(title, text, yesLabel = 'Delete') {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = yesLabel;
  return new Promise((resolve) => {
    const done = (answer) => {
      $('confirm-yes').removeEventListener('click', yes);
      $('confirm-no').removeEventListener('click', no);
      dlg.removeEventListener('cancel', no);
      if (dlg.open) dlg.close();
      resolve(answer);
    };
    const yes = () => done(true);
    const no = (e) => { if (e) e.preventDefault(); done(false); };
    $('confirm-yes').addEventListener('click', yes);
    $('confirm-no').addEventListener('click', no);
    dlg.addEventListener('cancel', no);
    dlg.showModal();
    $('confirm-no').focus();
  });
}

// ---- server calls ---------------------------------------------------------

async function readResponse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401) throw new Error('Your login has expired. Reload the page and sign in again.');
  if (!res.ok || !body || body.ok === false) {
    throw new Error((body && body.error) || `The server answered ${res.status}.`);
  }
  return body;
}

/** POST a JSON admin action. Returns true on success (state re-rendered), false on failure (error shown). */
async function act(action, body = {}, okText) {
  if (busy) return false;
  busy = true;
  document.body.style.cursor = 'progress';
  try {
    const res = await fetch(`/api/contest/admin/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readResponse(res);
    applyState(data.state);
    if (okText) flash('ok', okText);
    return true;
  } catch (err) {
    flash('error', err.message || 'That did not work.');
    return false;
  } finally {
    busy = false;
    document.body.style.cursor = '';
  }
}

async function loadState({ fromPoll = false } = {}) {
  try {
    const res = await fetch('/api/contest/admin/state', { cache: 'no-store' });
    const data = await readResponse(res);
    applyState(data.state, { fromPoll });
  } catch (err) {
    if (!fromPoll || !state) flash('error', err.message || 'Could not load the contest.');
  }
}

function applyState(next, { fromPoll = false } = {}) {
  if (!next) return;
  // Standings fold away on every phase change, so they are never left open on a shared screen.
  if (state && state.effectivePhase !== next.effectivePhase) $('standings').open = false;
  state = next;
  clockOffset = new Date(state.serverNow).getTime() - Date.now();
  if (state.effectivePhase !== 'open') refreshedAtZero = false;
  render({ fromPoll });
}

// ---- rendering ------------------------------------------------------------

/** Rebuild `section` only when `data` changed, and on a poll never under the admin's cursor. */
function section(name, rootId, data, build, { fromPoll }) {
  const sig = JSON.stringify(data);
  if (sigs[name] === sig) return;
  const root = $(rootId);
  const active = document.activeElement;
  const typing = active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
  if (fromPoll && typing) return;
  sigs[name] = sig;
  const focusKey = active && root.contains(active) ? active.dataset.key : null;
  build();
  for (const input of root.querySelectorAll('[data-key]')) {
    if (drafts.has(input.dataset.key)) input.value = drafts.get(input.dataset.key);
  }
  if (focusKey) {
    const again = root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (again) again.focus();
  }
}

function render(opts = {}) {
  if (!state) return;
  const fromPoll = Boolean(opts.fromPoll);
  document.title = `Admin: ${state.title}`;
  renderControls(fromPoll);
  renderReview(fromPoll);
  renderContest(fromPoll);
  renderCategories(fromPoll);
  renderDishes(fromPoll);
  renderStandings(fromPoll);
  renderShare(fromPoll);
  tick();
}

// ---- sticky control panel -------------------------------------------------

function stepsFor(categoryId) {
  const rows = (state.tally && state.tally[categoryId]) || [];
  const out = [];
  for (const step of [1, 2, 3]) {
    const place = PLACE_FOR_STEP[step];
    if (rows.some((r) => r.place === place)) out.push({ step, place });
  }
  return out;
}

function nextRevealLabel() {
  const { categoryIndex, step } = state.reveal;
  const cat = state.categories[categoryIndex];
  if (!cat) return { main: 'Reveal next', sub: '' };
  const next = stepsFor(cat.id).find((s) => s.step > step);
  if (next) return { main: `Reveal ${ordinal(next.place)} place`, sub: cat.name };
  const after = state.categories[categoryIndex + 1];
  if (after) return { main: 'Next category', sub: after.name };
  return { main: 'Finish', sub: 'Show all the winners' };
}

function tvLine() {
  const p = phase();
  if (p === 'setup') return 'Photo wall, "Voting opens soon"';
  if (p === 'open') return 'Photo wall, countdown and QR code';
  if (p === 'closed') return '"Voting is closed" with turnout only';
  if (p === 'done') return 'All winners, every category';
  const { categoryIndex, step } = state.reveal;
  const cat = state.categories[categoryIndex];
  if (!cat) return 'Reveal';
  const where = `${cat.name} (category ${categoryIndex + 1} of ${state.categories.length})`;
  if (step === 0) {
    return stepsFor(cat.id).length ? `${where}, nothing revealed yet` : `${where}, no votes in this category`;
  }
  return `${where}, ${ordinal(PLACE_FOR_STEP[step])} place revealed`;
}

function renderControls(fromPoll) {
  const p = phase();
  const pill = $('phase-pill');
  pill.textContent = PHASE_LABEL[p] || p;
  pill.className = `pill pill-${p}`;
  $('ctl-title').textContent = state.title;
  $('ctl-stats').textContent = `${plural(Object.keys(state.ballots || {}).length, 'voter', 'voters')} · ${plural(voteCount(), 'vote', 'votes')}`;
  const tv = $('tv-line');
  tv.replaceChildren(el('strong', null, 'TV shows: '), document.createTextNode(tvLine()));

  const reveal = p === 'revealing' || p === 'done' ? nextRevealLabel() : null;
  section('controls', 'ctl-actions', { p, deadlineMode, reveal, step: state.reveal, deadline: state.deadline }, () => {
    const box = $('ctl-actions');
    box.replaceChildren();
    if (p === 'setup') box.append(...deadlineInputs('Open voting', false));
    if (p === 'closed') {
      const row = el('div', 'reveal-row');
      row.append(button('Start the reveal', 'btn-reveal', () => act('reveal-start', {}, 'The reveal has started.'), { id: 'reveal-start' }));
      box.append(row);
      const more = el('details', 'reopen');
      more.open = reopenOpen;
      more.addEventListener('toggle', () => { reopenOpen = more.open; });
      more.append(el('summary', null, 'Reopen voting instead'));
      const inner = el('div', 'ctl-actions');
      inner.append(...deadlineInputs('Reopen voting', true));
      more.append(inner);
      box.append(more);
    }
    if (p === 'open') {
      box.append(button('Close voting now', 'btn-big btn-stop', async () => {
        const left = state.deadline ? formatLeft(new Date(state.deadline).getTime() - serverNow()) : '';
        const ok = await confirmAction('Close voting now?', `There ${left ? `is ${left} left on the clock` : 'is time left'}. Phones and the TV switch to "Voting is closed" right away. You can reopen before the reveal.`, 'Close voting');
        if (ok) act('close', {}, 'Voting is closed.');
      }));
      const ext = el('div', 'extend');
      ext.append(el('span', null, 'Extend'));
      box.append(ext);
      for (const m of [5, 10]) {
        ext.append(button(`+${m} min`, 'btn-quiet btn-sm', () => {
          const base = Math.max(new Date(state.deadline).getTime(), serverNow());
          act('extend', { deadline: new Date(base + m * 60_000).toISOString() }, `Extended by ${m} minutes.`);
        }));
      }
    }
    if (p === 'revealing') {
      const row = el('div', 'reveal-row');
      const big = button('', 'btn-reveal', () => act('reveal-next'));
      big.append(el('span', null, reveal.main));
      if (reveal.sub) big.append(el('span', 'sub', reveal.sub));
      big.id = 'reveal-next';
      row.append(big, button('Back', 'btn-quiet btn-back', () => act('reveal-back'), { id: 'reveal-back' }));
      box.append(row);
    }
    if (p === 'done') {
      box.append(el('span', null, 'Every winner is on the TV.'));
      box.append(button('Back', 'btn-quiet btn-sm', () => act('reveal-back'), { id: 'reveal-back' }));
    }
  }, { fromPoll });
}

/** Minutes-from-now or clock-time input plus the Open button. */
function deadlineInputs(label, small) {
  const nodes = [];
  if (deadlineMode === 'minutes') {
    const lab = el('label', null, 'Voting time');
    lab.htmlFor = 'dl-minutes';
    const input = el('input', 'input');
    input.id = 'dl-minutes';
    input.type = 'number';
    input.min = '1';
    input.max = '1440';
    input.inputMode = 'numeric';
    input.value = '20';
    input.dataset.key = 'dl-minutes';
    nodes.push(lab, input, el('span', null, 'min'));
  } else {
    const lab = el('label', null, 'Voting ends at');
    lab.htmlFor = 'dl-time';
    const input = el('input', 'input');
    input.id = 'dl-time';
    input.type = 'time';
    input.dataset.key = 'dl-time';
    nodes.push(lab, input);
  }
  const go = button(label, small ? 'btn-quiet btn-sm' : 'btn-big btn-go', openVoting, { id: 'open-btn' });
  const swap = button(deadlineMode === 'minutes' ? 'Set an end time instead' : 'Use minutes instead', 'linkish', () => {
    deadlineMode = deadlineMode === 'minutes' ? 'time' : 'minutes';
    renderControls(false);
  });
  swap.className = 'linkish';
  nodes.push(go, swap);
  return nodes;
}

function openVoting() {
  if (deadlineMode === 'minutes') {
    const raw = $('dl-minutes').value.trim();
    drafts.delete('dl-minutes');
    return act('open', { minutes: Number(raw) }, 'Voting is open.');
  }
  const value = $('dl-time').value;
  if (!value) return flash('error', 'Choose the time voting should end.');
  const [h, m] = value.split(':').map(Number);
  const end = new Date();
  end.setHours(h, m, 0, 0);
  drafts.delete('dl-time');
  return act('open', { deadline: end.toISOString() }, `Voting is open until ${clockTime(end.toISOString())}.`);
}

/** Runs every second: the countdown, and a refresh the moment the deadline passes. */
function tick() {
  const clock = $('ctl-clock');
  if (!state || phase() !== 'open' || !state.deadline) {
    clock.hidden = true;
    return;
  }
  const left = new Date(state.deadline).getTime() - serverNow();
  clock.hidden = false;
  clock.textContent = left > 0 ? `${formatLeft(left)} left` : '0:00';
  clock.classList.toggle('urgent', left < 2 * 60_000);
  if (left <= 0 && !refreshedAtZero) {
    refreshedAtZero = true;
    setTimeout(() => loadState(), 600);
  }
}

// ---- review queue -----------------------------------------------------------

function renderReview(fromPoll) {
  const items = state.dishes.filter((d) => d.status === 'pending' || d.editedSinceApproval);
  $('sec-review').hidden = items.length === 0;
  $('review-count').textContent = String(items.length);
  section('review', 'review-list', { items, cats: state.categories, locked: locked(), labels: Boolean(allergenLabels) }, () => {
    const list = $('review-list');
    list.replaceChildren();
    for (const dish of items) list.append(reviewCard(dish));
  }, { fromPoll });
}

function reviewCard(dish) {
  const li = el('li', 'panel review-card');
  li.dataset.dishId = dish.id;
  li.append(photoNode(dish, 'thumb'));
  const body = el('div');
  const tags = el('div', 'row');
  if (dish.status === 'pending') tags.append(el('span', 'tag tag-new', 'New entry'));
  if (dish.editedSinceApproval) tags.append(el('span', 'tag tag-warn', 'Edited since approval'));
  tags.append(el('span', 'tag', catName(dish.categoryId)));
  body.append(tags);
  const h = el('h3', null, dish.name);
  h.style.marginTop = '8px';
  body.append(h, el('p', 'meta', `by ${dish.cook}`));
  body.append(el('h4', null, 'Allergens (from the cook)'), badgesFor(dish));
  body.append(el('h4', null, 'Ingredients'), el('p', 'prose', dish.ingredients));
  body.append(el('h4', null, 'Recipe'), el('p', 'prose', dish.recipe || 'No recipe given.'));
  const actions = el('div', 'review-actions');
  actions.append(button(dish.status === 'pending' ? 'Approve' : 'Looks good', 'btn-go', () => act('dish-approve', { id: dish.id }, `Approved "${dish.name}".`), { 'data-action': 'approve' }));
  actions.append(button('Edit', 'btn-quiet btn-sm', () => openDishForm(dish)));
  actions.append(button('Delete', 'btn-danger btn-sm', () => deleteDish(dish)));
  for (const b of actions.querySelectorAll('button')) b.disabled = locked();
  body.append(actions);
  li.append(body);
  return li;
}

async function deleteDish(dish) {
  const ok = await confirmAction(`Delete "${dish.name}"?`, `This removes ${dish.cook}'s dish and its photo. Any votes for it are dropped. This cannot be undone.`);
  if (ok) act('dish-delete', { id: dish.id }, `Deleted "${dish.name}".`);
}

// ---- title and submissions --------------------------------------------------

function renderContest(fromPoll) {
  section('contest', 'sec-contest', { title: state.title, open: state.submissionsOpen, p: phase() }, () => {
    $('title-input').value = state.title;
    const open = state.submissionsOpen && state.phase === 'setup';
    $('subs-status').textContent = state.phase !== 'setup'
      ? 'Online entries are closed: voting has started.'
      : open ? 'Online entries are OPEN. Cooks can use the enter link below.' : 'Online entries are closed.';
    const btn = $('subs-btn');
    btn.textContent = state.submissionsOpen ? 'Close entries' : 'Open entries';
    btn.className = state.submissionsOpen ? 'btn btn-sm btn-quiet' : 'btn btn-sm';
    btn.disabled = state.phase !== 'setup';
  }, { fromPoll });
}

// ---- categories -------------------------------------------------------------

function renderCategories(fromPoll) {
  const counts = {};
  for (const d of state.dishes) counts[d.categoryId] = (counts[d.categoryId] || 0) + 1;
  $('cat-count').textContent = `${state.categories.length} of 5`;
  section('categories', 'sec-categories', { cats: state.categories, counts, locked: locked() }, () => {
    const list = $('cat-list');
    list.replaceChildren();
    if (!state.categories.length) list.append(el('p', 'empty', 'No categories yet. Add 1 to 5 below, for example Mains, Sides and Desserts.'));
    state.categories.forEach((cat, i) => {
      const row = el('form', 'cat-row');
      row.append(el('span', 'num', String(i + 1)));
      const input = el('input', 'input');
      input.maxLength = 40;
      input.value = cat.name;
      input.dataset.key = `cat-${cat.id}`;
      input.setAttribute('aria-label', `Name of category ${i + 1}`);
      row.append(input);
      const ctrls = el('div', 'ctrls');
      const save = button('Rename', 'btn-quiet btn-xs');
      save.type = 'submit';
      ctrls.append(save);
      const up = button('↑', 'btn-quiet btn-xs', () => moveCategory(i, -1), { 'aria-label': `Move ${cat.name} up` });
      const down = button('↓', 'btn-quiet btn-xs', () => moveCategory(i, 1), { 'aria-label': `Move ${cat.name} down` });
      up.disabled = i === 0 || locked();
      down.disabled = i === state.categories.length - 1 || locked();
      const n = counts[cat.id] || 0;
      const del = button('Delete', 'btn-danger btn-xs', async () => {
        const ok = await confirmAction(`Delete the category "${cat.name}"?`, n
          ? `It still has ${plural(n, 'dish', 'dishes')}. The server will refuse until you move or delete them.`
          : 'It has no dishes. This cannot be undone.');
        if (ok) act('category-delete', { id: cat.id }, `Deleted "${cat.name}".`);
      });
      del.disabled = locked();
      ctrls.append(up, down, del);
      row.append(ctrls);
      row.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (await act('category-rename', { id: cat.id, name: input.value }, 'Category renamed.')) {
          drafts.delete(input.dataset.key);
        }
      });
      list.append(row);
    });
    const full = state.categories.length >= 5;
    $('cat-add-btn').disabled = full || locked();
    $('cat-add-input').disabled = full || locked();
    const note = $('cat-note');
    note.hidden = !(full || locked());
    note.textContent = locked() ? 'Categories are locked once the reveal starts.' : 'That is the maximum of 5 categories.';
  }, { fromPoll });
}

function moveCategory(i, delta) {
  const ids = state.categories.map((c) => c.id);
  const j = i + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  act('category-reorder', { ids });
}

// ---- dishes -----------------------------------------------------------------

function renderDishes(fromPoll) {
  const approved = state.dishes.filter((d) => d.status === 'approved');
  const pending = state.dishes.length - approved.length;
  $('dish-count').textContent = `${approved.length} approved${pending ? `, ${pending} waiting` : ''}`;
  $('add-dish-btn').disabled = !state.categories.length || locked();
  section('dishes', 'dish-groups', { dishes: state.dishes, cats: state.categories, locked: locked(), labels: Boolean(allergenLabels) }, () => {
    const box = $('dish-groups');
    box.replaceChildren();
    if (!state.categories.length) {
      box.append(el('p', 'empty', 'Add a category first.'));
      return;
    }
    for (const cat of state.categories) {
      const group = el('div', 'dish-group');
      const inCat = approved.filter((d) => d.categoryId === cat.id);
      const h = el('h3', null, cat.name);
      h.append(el('span', 'small', plural(inCat.length, 'dish', 'dishes')));
      group.append(h);
      if (!inCat.length) group.append(el('p', 'empty', 'No approved dishes yet.'));
      const ul = el('ul', 'card-list');
      inCat.forEach((dish, i) => ul.append(dishRow(dish, i, inCat)));
      group.append(ul);
      box.append(group);
    }
  }, { fromPoll });
}

function dishRow(dish, i, inCat) {
  const li = el('li', 'dish-row');
  li.dataset.dishId = dish.id;
  li.append(photoNode(dish, 'mini'));
  const body = el('div');
  body.append(el('div', 'nm', dish.name), el('div', 'meta', `by ${dish.cook}`));
  if (dish.editedSinceApproval) body.append(el('span', 'tag tag-warn', 'Edited since approval'));
  body.append(badgesFor(dish));
  const ctrls = el('div', 'ctrls');
  const up = button('↑', 'btn-quiet btn-xs', () => moveDish(dish, inCat[i - 1]), { 'aria-label': `Move ${dish.name} up` });
  const down = button('↓', 'btn-quiet btn-xs', () => moveDish(dish, inCat[i + 1]), { 'aria-label': `Move ${dish.name} down` });
  up.disabled = i === 0;
  down.disabled = i === inCat.length - 1;
  ctrls.append(up, down,
    button('Edit', 'btn-quiet btn-xs', () => openDishForm(dish)),
    button('Unapprove', 'btn-quiet btn-xs', () => act('dish-unapprove', { id: dish.id }, `"${dish.name}" is back in the review list.`)),
    button('Delete', 'btn-danger btn-xs', () => deleteDish(dish)));
  if (locked()) for (const b of ctrls.querySelectorAll('button')) b.disabled = true;
  body.append(ctrls);
  li.append(body);
  return li;
}

/** Swap two dishes' positions in the full admin order (pending dishes keep their slots). */
function moveDish(dish, other) {
  if (!other) return;
  const ids = state.dishes.map((d) => d.id);
  const a = ids.indexOf(dish.id);
  const b = ids.indexOf(other.id);
  [ids[a], ids[b]] = [ids[b], ids[a]];
  act('dish-reorder', { ids });
}

// ---- add / edit dish form ---------------------------------------------------

let editing = null;   // dish being edited, or null when adding
let chosenFile = null;
let previewUrl = null;

function setPreview(src) {
  const img = $('f-photo-preview');
  const pick = $('f-photo-pick');
  if (src) {
    img.src = src;
    img.hidden = false;
    $('f-photo-empty').hidden = true;
    pick.classList.add('has-photo');
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    $('f-photo-empty').hidden = false;
    pick.classList.remove('has-photo');
  }
}

function buildAllergenChecks(selected) {
  const box = $('f-allergens');
  box.replaceChildren();
  const labels = allergenLabels || {};
  for (const [key, label] of Object.entries(labels)) {
    const lab = el('label', key === 'none' ? 'check check-none' : 'check');
    const input = el('input');
    input.type = 'checkbox';
    input.value = key;
    input.checked = selected.includes(key);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      for (const other of box.querySelectorAll('input')) {
        if (key === 'none' ? other.value !== 'none' : other.value === 'none') other.checked = false;
      }
    });
    lab.append(input, document.createTextNode(label));
    box.append(lab);
  }
}

function openDishForm(dish) {
  editing = dish || null;
  chosenFile = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('dish-dialog-title').textContent = dish ? `Edit "${dish.name}"` : 'Add a dish';
  $('f-cook').value = dish ? dish.cook : '';
  $('f-name').value = dish ? dish.name : '';
  $('f-ingredients').value = dish ? dish.ingredients : '';
  $('f-recipe').value = dish ? dish.recipe || '' : '';
  const sel = $('f-category');
  sel.replaceChildren();
  if (!dish) {
    const ph = el('option', null, 'Choose a category');
    ph.value = '';
    sel.append(ph);
  }
  for (const c of state.categories) {
    const opt = el('option', null, c.name);
    opt.value = c.id;
    sel.append(opt);
  }
  sel.value = dish ? dish.categoryId : '';
  buildAllergenChecks(dish ? dish.allergens : []);
  $('f-photo').value = '';
  setPreview(dish ? photoUrl(dish) : null);
  $('f-photo-hint').textContent = dish ? 'Leave it to keep the current photo, or tap to replace it.' : 'Optional. Add a picture of the dish if you have one.';
  $('dish-error').hidden = true;
  $('dish-save').textContent = dish ? 'Save changes' : 'Add dish';
  $('dish-save').disabled = false;
  $('dish-dialog').showModal();
}

function dishError(text) {
  const box = $('dish-error');
  box.textContent = text;
  box.hidden = !text;
  if (text) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveDish(e) {
  e.preventDefault();
  const allergens = [...$('f-allergens').querySelectorAll('input:checked')].map((i) => i.value);
  const fd = new FormData();
  if (editing) fd.append('id', editing.id);
  fd.append('categoryId', $('f-category').value);
  fd.append('cook', $('f-cook').value);
  fd.append('name', $('f-name').value);
  fd.append('ingredients', $('f-ingredients').value);
  fd.append('recipe', $('f-recipe').value);
  fd.append('allergens', JSON.stringify(allergens));
  if (chosenFile) fd.append('photo', chosenFile);
  const save = $('dish-save');
  save.disabled = true;
  save.textContent = chosenFile ? 'Uploading…' : 'Saving…';
  try {
    const res = await fetch(`/api/contest/admin/${editing ? 'dish-update' : 'dish-add'}`, { method: 'POST', body: fd });
    const data = await readResponse(res);
    const name = $('f-name').value.trim();
    $('dish-dialog').close();
    applyState(data.state);
    flash('ok', editing ? `Saved "${name}".` : `Added "${name}".`);
  } catch (err) {
    dishError(err.message || 'That did not save.');
  } finally {
    save.disabled = false;
    save.textContent = editing ? 'Save changes' : 'Add dish';
  }
}

// ---- private standings ------------------------------------------------------

function renderStandings(fromPoll) {
  section('standings', 'standings-body', { tally: state.tally, cats: state.categories, dishes: state.dishes.map((d) => [d.id, d.name, d.cook]) }, () => {
    const box = $('standings-body');
    box.replaceChildren();
    box.append(el('p', 'small', `${plural(Object.keys(state.ballots || {}).length, 'voter', 'voters')}, ${plural(voteCount(), 'vote', 'votes')}. Updates every 5 seconds.`));
    if (!state.categories.length) box.append(el('p', 'empty', 'No categories yet.'));
    for (const cat of state.categories) {
      const table = el('table');
      table.append(el('caption', null, cat.name));
      const head = el('tr');
      head.append(el('th', null, 'Place'), el('th', null, 'Dish'), el('th', 'n', 'Votes'));
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      const rows = (state.tally && state.tally[cat.id]) || [];
      if (!rows.length) {
        const tr = el('tr');
        const td = el('td', null, 'No approved dishes.');
        td.colSpan = 3;
        tr.append(td);
        tbody.append(tr);
      }
      for (const r of rows) {
        const dish = state.dishes.find((d) => d.id === r.dishId);
        const tr = el('tr');
        tr.append(el('td', null, r.place ? ordinal(r.place) : ''),
          el('td', 'dname', dish ? `${dish.name} (${dish.cook})` : 'Unknown dish'),
          el('td', 'n', String(r.votes)));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      box.append(table);
    }
  }, { fromPoll });
}

// ---- share links and table cards -------------------------------------------

const SHARE = [
  { label: 'Voting page (diners)', path: '/contest/vote' },
  { label: 'Enter a dish (cooks)', path: '/contest/enter' },
  { label: 'TV screen', path: '/contest/tv' },
];

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

function renderShare(fromPoll) {
  section('share', 'share-list', SHARE, () => {
    const list = $('share-list');
    list.replaceChildren();
    for (const s of SHARE) {
      const url = PUBLIC_BASE + s.path;
      const row = el('div', 'share-row');
      const lab = el('label', 'label', s.label);
      const id = `share-${s.path.split('/').pop()}`;
      lab.htmlFor = id;
      const line = el('div', 'row');
      const input = el('input', 'input');
      input.id = id;
      input.readOnly = true;
      input.value = url;
      input.addEventListener('focus', () => input.select());
      const copy = button('Copy', 'btn-quiet btn-sm', async () => {
        const ok = await copyText(url, input);
        flash(ok ? 'ok' : 'error', ok ? `Copied ${url}` : 'Could not copy. Select the link and copy it by hand.');
      });
      line.append(input, copy);
      row.append(lab, line);
      list.append(row);
    }
  }, { fromPoll });
}

const CARD_CSS = `
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #1f2a22; font-family: "Atkinson Hyperlegible", system-ui, sans-serif; }
  .tools { padding: 16px; font-size: 16px; display: flex; gap: 12px; align-items: center; }
  .tools button { font: 700 16px system-ui, sans-serif; padding: 10px 18px; border-radius: 999px; border: 2px solid #2b4c9b; background: #2b4c9b; color: #fff; cursor: pointer; }
  .sheet { width: 8.5in; height: 11in; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; margin: 0 auto; }
  .card { border: 1px dashed #9aa59c; display: flex; flex-direction: column; align-items: center; text-align: center; overflow: hidden; }
  .band { width: 100%; height: 0.32in; flex: none; background-color: #fff;
    background-image: linear-gradient(90deg, rgba(43,76,155,.55) 50%, transparent 50%), linear-gradient(rgba(43,76,155,.55) 50%, transparent 50%);
    background-size: 0.32in 0.32in; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .inner { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0.25in 0.3in; gap: 0.12in; }
  .title { font: 800 22pt/1.1 "Bricolage Grotesque", system-ui, sans-serif; margin: 0; overflow-wrap: anywhere; }
  .ask { font: 700 15pt/1.25 system-ui, sans-serif; margin: 0; }
  .qr { width: 2.6in; height: 2.6in; }
  .url { font: 700 11.5pt/1.2 ui-monospace, Menlo, monospace; margin: 0; overflow-wrap: anywhere; }
  @media screen { body { background: #e9ece8; } .sheet { background: #fff; box-shadow: 0 4px 20px rgba(0,0,0,.2); margin-bottom: 24px; } }
  @media print { .tools { display: none; } }
`;

function printCards() {
  const w = window.open('', 'contest-table-cards');
  if (!w) {
    flash('error', 'The browser blocked the print window. Allow pop-ups for this page and try again.');
    return;
  }
  const d = w.document;
  d.open();
  d.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Table cards</title></head><body></body></html>');
  d.close();
  const style = d.createElement('style');
  style.textContent = CARD_CSS;
  d.head.append(style);
  const mk = (tag, cls, text) => {
    const n = d.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const tools = mk('div', 'tools');
  const printBtn = mk('button', null, 'Print');
  printBtn.type = 'button';
  printBtn.addEventListener('click', () => w.print());
  tools.append(printBtn, mk('span', null, 'Letter paper, 4 cards per page. Cut along the dashed lines.'));
  const sheet = mk('div', 'sheet');
  const voteUrl = `${PUBLIC_BASE}/contest/vote`;
  const imgs = [];
  for (let i = 0; i < 4; i += 1) {
    const card = mk('div', 'card');
    const inner = mk('div', 'inner');
    const img = mk('img', 'qr');
    img.alt = `QR code for ${voteUrl}`;
    img.src = `${location.origin}/contest/qr.svg`;
    imgs.push(img);
    inner.append(mk('p', 'title', state.title), mk('p', 'ask', 'Scan to vote for your favorite dishes'), img, mk('p', 'url', voteUrl.replace(/^https:\/\//, '')));
    card.append(mk('div', 'band'), inner);
    sheet.append(card);
  }
  d.body.append(tools, sheet);
  Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))))
    .then(() => { w.focus(); w.print(); });
}

// ---- reset ------------------------------------------------------------------

async function resetContest() {
  const keep = document.querySelector('input[name="reset-mode"]:checked').value === 'keep';
  const pending = state.dishes.filter((d) => d.status === 'pending').length;
  let text = `Every vote in "${state.title}" will be cleared and the contest goes back to setup. The current results are saved to the archive first.`;
  if (keep) {
    text += ` The ${plural(state.dishes.length, 'dish', 'dishes')} and ${plural(state.categories.length, 'category', 'categories')} stay.`;
    if (pending) text += ` Note: ${plural(pending, 'entry that is still waiting for review', 'entries that are still waiting for review')} will become approved.`;
  } else {
    text += ` All ${plural(state.dishes.length, 'dish', 'dishes')}, their photos and all categories will be deleted.`;
  }
  const ok = await confirmAction(`Reset "${state.title}"?`, text, 'Reset contest');
  if (ok) act('reset', { keepDishes: keep }, 'The contest has been reset.');
}

// ---- wiring -----------------------------------------------------------------

document.addEventListener('input', (e) => {
  const key = e.target && e.target.dataset ? e.target.dataset.key : null;
  if (key) drafts.set(key, e.target.value);
});

$('title-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await act('title', { title: $('title-input').value }, 'Title saved.')) drafts.delete('title');
});

$('subs-btn').addEventListener('click', () => {
  const open = !state.submissionsOpen;
  act('submissions', { open }, open ? 'Online entries are open.' : 'Online entries are closed.');
});

$('cat-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('cat-add-input');
  if (await act('category-add', { name: input.value }, 'Category added.')) {
    drafts.delete('cat-add');
    input.value = '';
    input.focus();
  }
});

$('add-dish-btn').addEventListener('click', () => openDishForm(null));
$('dish-cancel').addEventListener('click', () => $('dish-dialog').close());
$('dish-form').addEventListener('submit', saveDish);
$('f-photo').addEventListener('change', () => {
  const file = $('f-photo').files[0] || null;
  chosenFile = file;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = file ? URL.createObjectURL(file) : null;
  setPreview(previewUrl || (editing ? photoUrl(editing) : null));
});
$('print-btn').addEventListener('click', printCards);
$('reset-btn').addEventListener('click', resetContest);

async function loadAllergenLabels() {
  try {
    const res = await fetch('/api/contest/submission-form', { cache: 'no-store' });
    const body = await res.json();
    if (body && body.allergens) allergenLabels = body.allergens;
  } catch { /* badges fall back to the raw keys */ }
  if (state) render();
}

setInterval(tick, 1000);
setInterval(() => {
  if (document.hidden || busy || $('dish-dialog').open || $('confirm-dialog').open) return;
  loadState({ fromPoll: true });
}, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadState({ fromPoll: true }); });

loadState();
loadAllergenLabels();
