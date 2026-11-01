// Dish contest TV page. Polls /api/contest/public every 2 s and shows one of
// five screens: setup / open (photo wall), closed, revealing (podium), done.
//
// Leak rules this file keeps:
// - The sparkle is driven ONLY by how many new voteEvents arrived since the last
//   poll. Which tile sparkles is Math.random() over every tile. The API carries no
//   per-dish vote signal before a reveal and this page never tries to infer one.
// - The podium shows only what reveal.revealed lists.
// All user text goes through textContent.

const POLL_MS = 2000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_SPARKLES_PER_POLL = 5;
const SPARKLE_STAGGER_MS = 320;
const WARN_UNDER_MS = 5 * 60_000;

const $ = (id) => document.getElementById(id);

let data = null;          // last good public view
let clockOffset = 0;      // server time minus local time, in ms
let lastVoteEvents = null;
let lastWallKey = null;
let lastRevealKey = '';
let lastDoneKey = '';
let shownPlaces = null;   // Set of "categoryId:place" already on screen (null = first render)
let currentScreen = '';
let lastVoteCount = null;

// ---- helpers -----------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function dishById(id) {
  return data.dishes.find((d) => d.id === id) || null;
}

function photoNode(dish, className) {
  if (dish && dish.photoUrl) {
    const img = el('img', className);
    img.src = dish.photoUrl;
    img.alt = '';
    img.decoding = 'async';
    return img;
  }
  const ph = el('div', `tile-placeholder ${className || ''}`.trim());
  ph.textContent = dish && dish.name ? dish.name.trim().charAt(0).toUpperCase() : '?';
  return ph;
}

function remainingMs() {
  if (!data || !data.deadline) return null;
  return Date.parse(data.deadline) - (Date.now() + clockOffset);
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The phase to show: 'open' flips to 'closed' locally the moment the clock hits zero. */
function displayPhase() {
  if (!data) return 'loading';
  if (data.phase === 'open') {
    const left = remainingMs();
    if (left != null && left <= 0) return 'closed';
  }
  return data.phase;
}

function showScreen(name) {
  if (currentScreen === name) return;
  currentScreen = name;
  for (const id of ['screen-loading', 'screen-wall', 'screen-closed', 'screen-reveal', 'screen-done']) {
    $(id).hidden = id !== `screen-${name}`;
  }
}

// ---- polling -----------------------------------------------------------

async function poll() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/contest/public', { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body || body.ok !== true || !Array.isArray(body.dishes)) throw new Error('bad body');
    const serverNow = Date.parse(body.serverNow);
    if (Number.isFinite(serverNow)) clockOffset = serverNow - Date.now();
    const prev = data;
    data = body;
    $('net-dot').hidden = true;
    onData(prev);
  } catch {
    // Keep the last good screen; a small dot tells the operator the link is flaky.
    $('net-dot').hidden = false;
  } finally {
    clearTimeout(timer);
    setTimeout(poll, POLL_MS);
  }
}

function onData(prev) {
  // Sparkle count comes from voteEvents and nothing else.
  const events = Number(data.voteEvents) || 0;
  if (lastVoteEvents != null && events > lastVoteEvents && displayPhase() === 'open') {
    queueSparkles(Math.min(MAX_SPARKLES_PER_POLL, events - lastVoteEvents));
  }
  lastVoteEvents = events;
  if (prev && prev.title !== data.title) document.title = data.title || 'Dish contest';
  if (!prev) document.title = data.title || 'Dish contest';
  render();
}

// ---- render ------------------------------------------------------------

function render() {
  const phase = displayPhase();
  if (phase === 'loading') return showScreen('loading');
  if (phase === 'setup' || phase === 'open') return renderWall(phase);
  if (phase === 'closed') return renderClosed();
  if (phase === 'revealing') return renderReveal();
  if (phase === 'done') return renderDone();
  return undefined;
}

// ---- setup + open ------------------------------------------------------

function renderWall(phase) {
  showScreen('wall');
  $('screen-wall').dataset.phase = phase;
  $('wall-title').textContent = data.title || '';
  $('wall-heading').textContent = phase === 'open' ? 'Vote for your favorites' : 'Meet tonight’s dishes';
  $('clock-label').hidden = phase !== 'open';
  $('qr-caption').textContent = phase === 'open' ? 'Scan to vote' : 'Scan to see the dishes';
  const key = data.dishes.map((d) => `${d.id}|${d.name}|${d.photoUrl}`).join('\n');
  if (key !== lastWallKey) {
    lastWallKey = key;
    buildWall();
  }
  const tally = $('tally-line');
  if (phase === 'open') {
    const text = data.voteCount > 0 ? `${plural(data.voteCount, 'vote', 'votes')} cast so far` : 'Be the first to vote';
    if (tally.textContent !== text) {
      tally.textContent = text;
      if (lastVoteCount != null && data.voteCount > lastVoteCount) {
        tally.classList.remove('bump');
        void tally.offsetWidth;
        tally.classList.add('bump');
      }
    }
    lastVoteCount = data.voteCount;
  } else {
    tally.textContent = 'Check ingredients and allergens before you eat';
  }
  tickClock();
}

function buildWall() {
  const wall = $('wall');
  wall.replaceChildren();
  if (!data.dishes.length) {
    wall.append(el('p', 'wall-empty', 'Dish photos will appear here'));
    return;
  }
  for (const dish of data.dishes) {
    const tile = el('div', 'tile');
    tile.append(photoNode(dish));
    tile.append(el('p', 'tile-name', dish.name));
    wall.append(tile);
  }
  layoutWall();
}

/** Pick the column count that gives the biggest tiles for this box and dish count. */
function layoutWall() {
  const wall = $('wall');
  const tiles = wall.querySelectorAll('.tile');
  const n = tiles.length;
  if (!n) return;
  const w = wall.clientWidth;
  const h = wall.clientHeight;
  if (!w || !h) return;
  const unit = Math.min(window.innerHeight / 100, window.innerWidth / 177.78);
  const gap = Math.max(4, Math.round(unit * 1.2));
  // Tiles may run from 1:1 to 16:10 so the wall fills the height as well as the width.
  let best = { cols: 1, tw: 0, th: 0, area: 0 };
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    let tw = (w - (cols - 1) * gap) / cols;
    let th = (h - (rows - 1) * gap) / rows;
    if (th > tw) th = tw;
    if (tw > th * 1.6) tw = th * 1.6;
    tw = Math.floor(tw);
    th = Math.floor(th);
    const area = tw * th;
    if (area > best.area) best = { cols, tw, th, area };
  }
  wall.style.gridTemplateColumns = `repeat(${best.cols}, ${best.tw}px)`;
  wall.style.gridAutoRows = `${best.th}px`;
  wall.style.gap = `${gap}px`;
  // Names only when the tile is wide enough to carry minimum-size text.
  wall.classList.toggle('no-names', best.tw < unit * 17);
}

function queueSparkles(count) {
  for (let i = 0; i < count; i += 1) {
    setTimeout(sparkleRandomTile, i * SPARKLE_STAGGER_MS + Math.random() * 120);
  }
}

const STAR_COLORS = ['#f6d86b', '#fbf6e6', '#ffe9a3', '#ef6a7f', '#9fc1ff'];

function sparkleRandomTile() {
  if (currentScreen !== 'wall') return;
  const tiles = $('wall').querySelectorAll('.tile');
  if (!tiles.length) return;
  const tile = tiles[Math.floor(Math.random() * tiles.length)];
  tile.classList.remove('sparkle');
  void tile.offsetWidth;
  tile.classList.add('sparkle');
  setTimeout(() => tile.classList.remove('sparkle'), 1700);

  const wall = $('wall');
  const burst = el('div', 'burst');
  burst.style.left = `${tile.offsetLeft + tile.offsetWidth / 2}px`;
  burst.style.top = `${tile.offsetTop + tile.offsetHeight / 2}px`;
  const reach = Math.max(tile.offsetWidth, tile.offsetHeight) * 0.9;
  const stars = 12;
  for (let i = 0; i < stars; i += 1) {
    const star = el('i');
    const angle = (i / stars) * Math.PI * 2 + Math.random() * 0.4;
    const dist = reach * (0.55 + Math.random() * 0.5);
    star.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    star.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    star.style.setProperty('--rot', `${Math.round(Math.random() * 360)}deg`);
    star.style.setProperty('--size', `${Math.round(reach * (0.2 + Math.random() * 0.16))}px`);
    star.style.setProperty('--color', STAR_COLORS[i % STAR_COLORS.length]);
    star.style.animationDelay = `${Math.random() * 120}ms`;
    burst.append(star);
  }
  wall.append(burst);
  setTimeout(() => burst.remove(), 2000);
}

function tickClock() {
  if (currentScreen !== 'wall' || !data) return;
  const clock = $('clock');
  if (data.phase !== 'open') {
    clock.textContent = 'Voting opens soon';
    clock.className = 'clock soon';
    return;
  }
  const left = remainingMs();
  if (left == null) {
    clock.textContent = '';
    clock.className = 'clock';
    return;
  }
  clock.textContent = formatClock(left);
  clock.className = left < WARN_UNDER_MS ? 'clock warn' : 'clock';
}

// ---- closed ------------------------------------------------------------

function renderClosed() {
  const first = currentScreen !== 'closed';
  showScreen('closed');
  $('closed-title').textContent = data.title || '';
  if (first) {
    const heading = $('closed-heading');
    const words = ['Voting', 'is', 'closed'].map((w) => el('span', 'word', w));
    heading.replaceChildren(words[0], ' ', words[1], ' ', words[2]);
  }
  $('turnout').textContent = `${plural(data.voterCount, 'guest', 'guests')} cast ${plural(data.voteCount, 'vote', 'votes')}`;
}

// ---- revealing ---------------------------------------------------------

function placeState(place, revealedInCat) {
  const hit = revealedInCat.find((r) => r.place === place);
  if (hit) return { kind: 'shown', entry: hit };
  // Reveal goes 3rd → 2nd → 1st. A better place already shown means this one was skipped.
  if (revealedInCat.some((r) => r.place < place)) return { kind: 'skipped' };
  return { kind: 'pending' };
}

function renderReveal() {
  showScreen('reveal');
  const reveal = data.reveal || { categoryIndex: 0, categoryId: null, revealed: [] };
  const cat = data.categories.find((c) => c.id === reveal.categoryId);
  const revealedInCat = (reveal.revealed || []).filter((r) => r.categoryId === reveal.categoryId);
  const key = JSON.stringify([reveal, data.dishes.map((d) => `${d.id}|${d.name}|${d.cook}|${d.photoUrl}`)]);
  if (key === lastRevealKey) return;
  lastRevealKey = key;

  const firstRender = shownPlaces == null;
  const before = shownPlaces || new Set();
  const now = new Set(revealedInCat.map((r) => `${r.categoryId}:${r.place}`));

  const screen = $('screen-reveal');
  const catChanged = screen.dataset.cat !== String(reveal.categoryId);
  screen.dataset.cat = String(reveal.categoryId);
  screen.classList.toggle('drumroll', revealedInCat.length === 0);
  const catHeading = $('reveal-cat');
  catHeading.textContent = cat ? cat.name : '';
  if (catChanged) {
    // restart the heading animation for the new category
    catHeading.style.animation = 'none';
    void catHeading.offsetWidth;
    catHeading.style.animation = '';
  }
  $('reveal-progress').textContent = data.categories.length > 1
    ? `Category ${reveal.categoryIndex + 1} of ${data.categories.length}`
    : (data.title || '');

  const podium = $('podium');
  podium.replaceChildren();
  let confetti = false;
  for (const place of [2, 1, 3]) {
    const step = el('div', `step step-${place}`);
    const dishes = el('div', 'step-dishes');
    const state = placeState(place, revealedInCat);
    if (state.kind === 'pending') {
      dishes.append(el('div', 'mystery', '?'));
    } else if (state.kind === 'skipped') {
      step.classList.add('skipped');
    } else {
      const k = `${state.entry.categoryId}:${place}`;
      const fresh = !firstRender && !before.has(k);
      if (fresh) {
        step.classList.add('fresh-step');
        if (place === 1) confetti = true;
      }
      const ids = state.entry.dishIds.filter((id) => dishById(id));
      const n = ids.length;
      dishes.classList.add(n >= 7 ? 'lots' : n >= 5 ? 'many' : `n${n}`);
      ids.forEach((id, i) => {
        const dish = dishById(id);
        const card = el('div', `winner${fresh ? ' fresh' : ''}`);
        if (fresh) card.style.animationDelay = `${i * 180}ms`;
        card.append(photoNode(dish));
        card.append(el('p', 'winner-name', dish.name));
        card.append(el('p', 'winner-cook', `by ${dish.cook}`));
        card.append(el('p', 'winner-votes', plural(state.entry.votes, 'vote', 'votes')));
        dishes.append(card);
      });
    }
    const block = el('div', 'step-block');
    block.append(el('span', null, String(place)));
    block.setAttribute('aria-label', ['', 'First place', 'Second place', 'Third place'][place]);
    step.append(dishes, block);
    podium.append(step);
  }
  shownPlaces = now;
  if (confetti) launchConfetti(1);
}

// ---- done --------------------------------------------------------------

function renderDone() {
  const first = currentScreen !== 'done';
  showScreen('done');
  $('done-title').textContent = data.title || '';
  const revealed = (data.reveal && data.reveal.revealed) || [];
  const key = JSON.stringify([revealed, data.categories, data.dishes.map((d) => `${d.id}|${d.name}|${d.cook}|${d.photoUrl}`)]);
  if (key !== lastDoneKey) {
    lastDoneKey = key;
    const grid = $('done-grid');
    grid.replaceChildren();
    data.categories.forEach((cat, i) => {
      const card = el('section', 'cat-card');
      card.style.animationDelay = `${i * 150}ms`;
      card.append(el('h2', 'cat-card-name', cat.name));
      const mine = revealed.filter((r) => r.categoryId === cat.id);
      const firstPlace = mine.find((r) => r.place === 1);
      const body = el('div', 'cat-card-body');
      card.append(body);
      if (!firstPlace) {
        body.append(el('p', 'cat-card-none', 'No votes in this category'));
        grid.append(card);
        return;
      }
      const winners = firstPlace.dishIds.map(dishById).filter(Boolean);
      const photos = el('div', 'cat-card-photos');
      for (const d of winners) photos.append(photoNode(d));
      body.append(photos);
      const join = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
      if (winners.length > 2) body.append(el('p', 'cat-card-cook', `A ${winners.length}-way tie`));
      body.append(el('p', 'cat-card-first', join(winners.map((d) => d.name))));
      if (winners.length <= 2) body.append(el('p', 'cat-card-cook', `by ${join(winners.map((d) => d.cook))}`));
      const rest = el('ul', 'cat-card-rest');
      for (const place of [2, 3]) {
        const entry = mine.find((r) => r.place === place);
        if (!entry) continue;
        const names = entry.dishIds.map(dishById).filter(Boolean).map((d) => d.name).join(' and ');
        const li = el('li');
        li.append(el('b', null, place === 2 ? '2nd ' : '3rd '), document.createTextNode(names));
        rest.append(li);
      }
      if (rest.childNodes.length) body.append(rest);
      grid.append(card);
    });
  }
  if (first && shownPlaces != null) launchConfetti(1.4);
}

// ---- confetti (canvas, no library) -------------------------------------

const CONFETTI_COLORS = ['#f6d86b', '#fbf6e6', '#ef6a7f', '#6f9cff', '#5fc489', '#f5a524'];
let confettiParts = [];
let confettiRunning = false;

function launchConfetti(strength) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('confetti');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  const W = canvas.width;
  const H = canvas.height;
  const count = Math.round(220 * strength);
  for (let i = 0; i < count; i += 1) {
    const fromLeft = i % 2 === 0;
    confettiParts.push({
      x: fromLeft ? W * 0.05 : W * 0.95,
      y: H * 0.85,
      vx: (fromLeft ? 1 : -1) * (W * (0.004 + Math.random() * 0.012)),
      vy: -H * (0.018 + Math.random() * 0.016),
      size: (6 + Math.random() * 10) * dpr * (window.innerHeight / 1080),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      life: 0,
    });
  }
  // a shower from the top as well
  for (let i = 0; i < count / 2; i += 1) {
    confettiParts.push({
      x: Math.random() * W,
      y: -Math.random() * H * 0.3,
      vx: (Math.random() - 0.5) * W * 0.002,
      vy: H * (0.002 + Math.random() * 0.004),
      size: (6 + Math.random() * 10) * dpr * (window.innerHeight / 1080),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      life: 0,
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    requestAnimationFrame(confettiFrame);
  }
}

function confettiFrame() {
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const g = H * 0.00045;
  confettiParts = confettiParts.filter((p) => p.y < H + 40 && p.life < 600);
  for (const p of confettiParts) {
    p.life += 1;
    p.vy += g;
    p.vx *= 0.99;
    p.vy = Math.min(p.vy, H * 0.006);
    p.x += p.vx + Math.sin(p.life / 12) * 0.6;
    p.y += p.vy;
    p.rot += p.vr;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.4 + Math.abs(Math.sin(p.life / 8))));
    ctx.restore();
  }
  if (confettiParts.length) {
    requestAnimationFrame(confettiFrame);
  } else {
    ctx.clearRect(0, 0, W, H);
    confettiRunning = false;
  }
}

// ---- full screen + wake lock -------------------------------------------

let wakeLock = null;

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {
    wakeLock = null; // not allowed here; the screen saver setting will have to do
  }
}

function hideHint() {
  $('fs-hint').hidden = true;
}

document.addEventListener('click', async () => {
  hideHint();
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch { /* fullscreen refused; the page still works windowed */ }
  keepAwake();
});

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) hideHint();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

// ---- boot --------------------------------------------------------------

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (currentScreen === 'wall') layoutWall(); }, 150);
});

setInterval(() => {
  if (!data) return;
  // At zero the open screen flips to closed without waiting for the next poll.
  if (data.phase === 'open' && displayPhase() === 'closed' && currentScreen === 'wall') render();
  tickClock();
}, 250);

if (document.fullscreenElement) hideHint();
// Nobody may ever click: do not leave the hint on the church TV all night.
setTimeout(hideHint, 30_000);
keepAwake();
poll();
