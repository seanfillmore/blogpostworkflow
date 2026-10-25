// Voting page: one pick per category, changeable until the deadline.
// All dish text is cook-entered, so it only ever reaches the page via textContent.

const $ = (id) => document.getElementById(id);
const POLL_MS = 10_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLERGEN_LABELS = {
  milk: 'Milk', eggs: 'Eggs', fish: 'Fish', shellfish: 'Shellfish', 'tree-nuts': 'Tree nuts',
  peanuts: 'Peanuts', wheat: 'Wheat', soy: 'Soy', sesame: 'Sesame', citrus: 'Citrus', none: 'None of these',
};

// ---- voter id: localStorage, mirrored to a cookie ---------------------------

function readCookie(name) {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function newUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function getVoterId() {
  let id = null;
  try { id = localStorage.getItem('contestVoterId'); } catch { /* storage blocked */ }
  if (!id || !UUID_V4.test(id)) {
    try { id = readCookie('contestVoterId'); } catch { id = null; }
  }
  if (!id || !UUID_V4.test(id)) id = newUuid();
  try { localStorage.setItem('contestVoterId', id); } catch { /* storage blocked */ }
  try {
    document.cookie = `contestVoterId=${encodeURIComponent(id)}; path=/contest; max-age=${7 * 86400}; SameSite=Lax`;
  } catch { /* cookies blocked */ }
  return id;
}

const voterId = getVoterId();

// ---- state ------------------------------------------------------------------

let data = null;          // last /api/contest/public
let ballot = {};          // categoryId -> dishId
let offsetMs = 0;         // serverNow - local clock
let closedLocally = false; // countdown hit zero, or a vote came back 409
let renderedSig = '';
const pending = new Set(); // categoryIds with a vote in flight
let sheetDishId = null;

const dishById = (id) => (data ? data.dishes.find((d) => d.id === id) : null);

/** 'setup' | 'open' | 'closed' (closed covers revealing and done). */
function mode() {
  if (!data) return 'setup';
  if (data.phase === 'setup') return 'setup';
  return data.phase === 'open' && !closedLocally && !deadlinePassed() ? 'open' : 'closed';
}

function deadlinePassed() {
  if (!data || !data.deadline) return false;
  return new Date(data.deadline).getTime() <= Date.now() + offsetMs;
}

/** A pick only counts if its dish is still on the list in that category. */
function pickFor(categoryId) {
  const dish = dishById(ballot[categoryId]);
  return dish && dish.categoryId === categoryId ? dish : null;
}

// ---- network ----------------------------------------------------------------

async function fetchJson(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

async function poll() {
  const t0 = Date.now();
  try {
    const { status, body } = await fetchJson('/api/contest/public');
    const t1 = Date.now();
    if (status !== 200 || !body || !body.ok) throw new Error('bad response');
    offsetMs = new Date(body.serverNow).getTime() - (t0 + t1) / 2;
    // A reopened contest (closed -> open with a new deadline) clears our local lock.
    if (body.phase === 'open' && (!data || data.phase !== 'open' || data.deadline !== body.deadline)) closedLocally = false;
    data = body;
    $('loading').hidden = true;
    render();
  } catch {
    if (!data) $('loading').textContent = 'We could not load the dishes. Check your internet connection. Trying again…';
  }
}

async function loadBallot() {
  try {
    const { status, body } = await fetchJson(`/api/contest/my-ballot?voterId=${encodeURIComponent(voterId)}`);
    if (status === 200 && body && body.ballot) {
      ballot = { ...body.ballot };
      updatePicks();
    }
  } catch { /* the next vote will return the ballot anyway */ }
}

function showError(text) {
  const box = $('vote-error');
  box.textContent = text || '';
  box.hidden = !text;
}

async function vote(categoryId, dishId) {
  if (mode() !== 'open' || pending.has(categoryId)) return;
  showError('');
  pending.add(categoryId);
  updatePicks();
  let res;
  try {
    res = await fetchJson('/api/contest/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voterId, categoryId, dishId }),
    });
  } catch {
    res = { status: 0, body: null };
  }
  pending.delete(categoryId);
  const { status, body } = res;
  if (status === 200 && body && body.ballot) {
    ballot = { ...body.ballot };
  } else if (status === 409 && body && body.phase === 'open') {
    // Still open, refused for another reason (the contest's voter limit).
    if (body.ballot) ballot = { ...body.ballot };
    showError(body.error || 'Your vote could not be counted.');
  } else if (status === 409) {
    // The deadline passed before our poll noticed. Lock and show the final picks.
    closedLocally = true;
    if (body && body.ballot) ballot = { ...body.ballot };
    if (body && body.phase && data) data.phase = body.phase;
  } else if (status === 404) {
    showError('That dish is no longer on the list. The page has been refreshed.');
    await poll();
  } else if (status === 429) {
    showError((body && body.error) || 'Too many changes. Please wait a few minutes.');
  } else if (status === 0) {
    showError('Your vote did not go through. Check your internet connection and tap again.');
  } else {
    showError((body && body.error) || 'Your vote did not go through. Please tap again.');
  }
  render();
}

// ---- rendering --------------------------------------------------------------

function badgeList(allergens, ul) {
  ul.replaceChildren();
  for (const key of allergens || []) {
    const li = document.createElement('li');
    li.className = key === 'none' ? 'badge badge-none' : 'badge';
    li.textContent = key === 'none' ? 'No listed allergens' : (ALLERGEN_LABELS[key] || key);
    ul.append(li);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function photoNode(dish, className) {
  if (dish.photoUrl) {
    const img = el('img', className);
    img.src = dish.photoUrl;
    img.alt = dish.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    return img;
  }
  return el('div', `${className} dish-photo-empty`, 'No photo');
}

function dishCard(dish) {
  const li = el('li', 'dish');
  li.dataset.dishId = dish.id;
  li.dataset.categoryId = dish.categoryId;
  li.append(photoNode(dish, 'dish-photo'));
  const ribbon = el('span', 'ribbon', 'Your vote');
  ribbon.hidden = true;
  li.append(ribbon);
  const body = el('div', 'dish-body');
  body.append(el('h3', 'dish-name', dish.name), el('p', 'dish-cook', `by ${dish.cook}`));
  const badges = el('ul', 'badges');
  badgeList(dish.allergens, badges);
  body.append(badges);
  const actions = el('div', 'dish-actions');
  const details = el('button', 'btn btn-quiet', 'Details');
  details.type = 'button';
  details.addEventListener('click', () => openSheet(dish.id));
  const voteBtn = el('button', 'btn vote-btn', 'Vote');
  voteBtn.type = 'button';
  voteBtn.addEventListener('click', () => vote(dish.categoryId, dish.id));
  actions.append(details, voteBtn);
  body.append(actions);
  li.append(body);
  return li;
}

function signature() {
  return JSON.stringify([
    mode() === 'setup',
    data.categories,
    data.dishes.map((d) => [d.id, d.categoryId, d.name, d.cook, d.photoUrl, d.allergens]),
  ]);
}

function render() {
  if (!data) return;
  if (data.title) {
    $('title').textContent = data.title;
    document.title = `Vote: ${data.title}`;
  }
  const sig = signature();
  if (sig !== renderedSig) {
    renderedSig = sig;
    buildLists();
  }
  updatePicks();
  tick();
}

function buildLists() {
  const root = $('categories');
  root.replaceChildren();
  const nav = $('cat-nav');
  nav.replaceChildren();
  if (!data.categories.length || !data.dishes.length) {
    root.append(el('p', 'empty', 'The dishes will appear here soon. Please check back in a little while.'));
  }
  for (const cat of data.categories) {
    const dishes = data.dishes.filter((d) => d.categoryId === cat.id);
    if (!data.dishes.length) break;
    const section = el('section', 'cat-section');
    section.id = `cat-${cat.id}`;
    section.dataset.categoryId = cat.id;
    const head = el('div', 'cat-head');
    head.append(el('h2', null, cat.name));
    section.append(head);
    const pick = el('p', 'cat-pick');
    pick.dataset.role = 'pick';
    section.append(pick);
    if (!dishes.length) {
      section.append(el('p', 'empty', 'No dishes in this category yet.'));
    } else {
      const list = el('ul', 'dish-list');
      for (const d of dishes) list.append(dishCard(d));
      section.append(list);
    }
    root.append(section);

    const chip = el('a', 'cat-chip');
    chip.href = `#cat-${cat.id}`;
    chip.dataset.categoryId = cat.id;
    chip.textContent = cat.name;
    nav.append(chip);
  }
  $('footer-note').hidden = !data.dishes.length;
}

function updatePicks() {
  if (!data) return;
  const m = mode();
  const cats = data.categories.filter((c) => data.dishes.some((d) => d.categoryId === c.id));
  const voted = cats.filter((c) => pickFor(c.id)).length;

  // Banner
  const banner = $('banner');
  banner.replaceChildren();
  if (m === 'setup') {
    banner.className = 'notice notice-info';
    banner.append(el('strong', null, 'Voting opens soon'),
      el('p', null, 'You can look through the dishes and check ingredients now. The vote buttons appear when voting opens.'));
    banner.hidden = false;
  } else if (m === 'closed') {
    banner.className = 'notice notice-closed';
    banner.append(el('strong', null, 'Voting is closed'),
      el('p', null, voted ? 'Thank you for voting. Your final picks are marked below. Watch the TV for the winners!' : 'Thank you for coming. Watch the TV for the winners!'));
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  // Sticky bar
  $('vote-bar').hidden = !data.dishes.length;
  $('lede').hidden = m !== 'open';
  if (m === 'setup') $('progress-text').textContent = 'Voting opens soon';
  else if (m === 'closed') $('progress-text').textContent = `Voting is closed. You voted in ${voted} of ${cats.length}.`;
  else $('progress-text').textContent = `${voted} of ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'} voted`;
  $('progress').hidden = m === 'setup';
  $('progress-bar').style.width = cats.length ? `${(voted / cats.length) * 100}%` : '0';

  for (const chip of $('cat-nav').children) {
    const done = Boolean(pickFor(chip.dataset.categoryId));
    chip.classList.toggle('done', done);
    const name = data.categories.find((c) => c.id === chip.dataset.categoryId)?.name || '';
    chip.textContent = done ? `✓ ${name}` : name;
  }

  for (const section of document.querySelectorAll('.cat-section')) {
    const catId = section.dataset.categoryId;
    const picked = pickFor(catId);
    const line = section.querySelector('[data-role="pick"]');
    line.replaceChildren();
    if (picked) {
      line.append(m === 'closed' ? 'Your final pick: ' : 'Your pick: ', el('strong', null, picked.name));
    } else if (m === 'open') {
      line.textContent = 'You have not picked a dish here yet.';
    } else if (m === 'closed') {
      line.textContent = 'You did not pick a dish here.';
    } else {
      line.textContent = '';
    }
  }

  for (const card of document.querySelectorAll('.dish')) {
    const catId = card.dataset.categoryId;
    const isPick = ballot[catId] === card.dataset.dishId && Boolean(pickFor(catId));
    card.classList.toggle('picked', isPick);
    card.querySelector('.ribbon').hidden = !isPick;
    const actions = card.querySelector('.dish-actions');
    const btn = card.querySelector('.vote-btn');
    styleVoteButton(btn, catId, isPick, m);
    actions.classList.toggle('no-vote', btn.hidden);
  }

  if (sheetDishId) fillSheetVote();
}

function styleVoteButton(btn, catId, isPick, m) {
  const name = dishById(btn.closest?.('.dish')?.dataset.dishId)?.name || '';
  btn.hidden = m === 'setup' || (m === 'closed' && !isPick);
  btn.disabled = m !== 'open' || pending.has(catId);
  btn.classList.toggle('btn-voted', isPick);
  if (pending.has(catId) && m === 'open') btn.textContent = 'Saving…';
  else if (isPick) btn.textContent = '✓ Your vote';
  else btn.textContent = ballot[catId] && pickFor(catId) ? 'Change to this' : 'Vote';
  btn.setAttribute('aria-label', isPick ? `Your vote: ${name}` : `Vote for ${name}`);
}

// ---- details sheet ----------------------------------------------------------

function openSheet(dishId) {
  const dish = dishById(dishId);
  if (!dish) return;
  sheetDishId = dishId;
  const img = $('sheet-photo');
  if (dish.photoUrl) {
    img.src = dish.photoUrl;
    img.alt = dish.name;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
  $('sheet-name').textContent = dish.name;
  $('sheet-cook').textContent = `by ${dish.cook}`;
  badgeList(dish.allergens, $('sheet-badges'));
  $('sheet-ingredients').textContent = dish.ingredients || '';
  $('sheet-recipe').textContent = dish.recipe || '';
  $('sheet-recipe-wrap').hidden = !dish.recipe;
  fillSheetVote();
  const sheet = $('sheet');
  if (typeof sheet.showModal === 'function') sheet.showModal();
  else sheet.setAttribute('open', '');
  sheet.scrollTop = 0;
}

function fillSheetVote() {
  const box = $('sheet-vote');
  box.replaceChildren();
  const dish = dishById(sheetDishId);
  if (!dish) return;
  const m = mode();
  const isPick = ballot[dish.categoryId] === dish.id && Boolean(pickFor(dish.categoryId));
  const btn = el('button', 'btn btn-big btn-block');
  btn.type = 'button';
  btn.hidden = m === 'setup' || (m === 'closed' && !isPick);
  btn.disabled = m !== 'open' || pending.has(dish.categoryId);
  btn.classList.toggle('btn-voted', isPick);
  btn.textContent = pending.has(dish.categoryId) ? 'Saving…' : isPick ? '✓ Your vote' : `Vote for ${dish.name}`;
  btn.addEventListener('click', () => vote(dish.categoryId, dish.id));
  box.append(btn);
}

function closeSheet() {
  const sheet = $('sheet');
  if (typeof sheet.close === 'function') sheet.close();
  else sheet.removeAttribute('open');
}

$('sheet-close').addEventListener('click', closeSheet);
$('sheet').addEventListener('close', () => { sheetDishId = null; });
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

// ---- countdown --------------------------------------------------------------

function fmt(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

let wasOpen = false;
function tick() {
  const clock = $('clock');
  const m = mode();
  if (m === 'open' && data.deadline) {
    const left = new Date(data.deadline).getTime() - (Date.now() + offsetMs);
    clock.hidden = false;
    clock.textContent = `${fmt(left)} left`;
    clock.classList.toggle('urgent', left < 60_000);
    clock.setAttribute('aria-label', `Time left to vote: ${fmt(left)}`);
  } else {
    clock.hidden = true;
  }
  // The deadline passed between polls: flip to closed now, keep the picks.
  if (wasOpen && m !== 'open') updatePicks();
  wasOpen = m === 'open';
}

setInterval(tick, 1000);
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { poll(); loadBallot(); }
});

poll().then(loadBallot);
