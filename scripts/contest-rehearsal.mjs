#!/usr/bin/env node
// scripts/contest-rehearsal.mjs
// Rehearse the church dish contest end to end against a running dashboard.
//
//   node scripts/contest-rehearsal.mjs --base http://localhost:4343 [--dishes 25] [--voters 100]
//        [--minutes 3] [--no-vote] [--allow-remote]
//
// Archives and resets the contest, creates 3 categories, adds dishes with generated
// placeholder photos, opens voting, posts ballots from random voters spread over the
// window (about 25% change one pick later), then prints the admin standings.
// Admin calls use dashboard basic auth from .env; votes go to the public route with no auth.
// Refuses any non-localhost base unless --allow-remote.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { base: null, dishes: 25, voters: 100, minutes: 3, vote: true, allowRemote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--dishes') o.dishes = Number(argv[++i]);
    else if (a === '--voters') o.voters = Number(argv[++i]);
    else if (a === '--minutes') o.minutes = Number(argv[++i]);
    else if (a === '--no-vote') o.vote = false;
    else if (a === '--allow-remote') o.allowRemote = true;
    else die(`Unknown argument: ${a}`);
  }
  return o;
}

function die(msg) {
  console.error(`contest-rehearsal: ${msg}`);
  process.exit(1);
}

function readEnv() {
  const e = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) e[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* handled by caller */ }
  return e;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.base) die('--base <url> is required, for example --base http://localhost:4343');
let baseUrl;
try { baseUrl = new URL(opts.base); } catch { die(`Not a valid URL: ${opts.base}`); }
if (!['localhost', '127.0.0.1'].includes(baseUrl.hostname) && !opts.allowRemote) {
  die(`Refusing ${baseUrl.hostname}: not localhost. Pass --allow-remote if you really mean it.`);
}
for (const k of ['dishes', 'voters', 'minutes']) {
  if (!Number.isFinite(opts[k]) || opts[k] < 1) die(`--${k} must be a positive number`);
}
if (opts.dishes > 80) die('--dishes cannot exceed 80 (the contest limit)');
if (opts.voters > 1000) die('--voters cannot exceed 1000 (the contest limit)');

const env = readEnv();
if (!env.DASHBOARD_USER || !env.DASHBOARD_PASSWORD) die('DASHBOARD_USER and DASHBOARD_PASSWORD must be set in .env');
const AUTH = 'Basic ' + Buffer.from(`${env.DASHBOARD_USER}:${env.DASHBOARD_PASSWORD}`).toString('base64');
const BASE = baseUrl.origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(action, body) {
  const res = await fetch(`${BASE}/api/contest/admin/${action}`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  if (!res.ok) die(`admin/${action} returned ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).state;
}

const PALETTE = ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#d35400', '#7f8c8d'];

async function photo(n) {
  const color = PALETTE[n % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <rect width="1200" height="900" fill="${color}"/>
    <text x="600" y="520" font-size="360" font-family="Helvetica, Arial, sans-serif" font-weight="700"
      fill="#ffffff" text-anchor="middle">${n}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

async function addDish(n, categoryId) {
  const fd = new FormData();
  fd.set('categoryId', categoryId);
  fd.set('name', `Rehearsal Dish ${n}`);
  fd.set('cook', `Cook ${n}`);
  fd.set('ingredients', 'Flour, butter, sugar, love');
  fd.set('recipe', '');
  fd.append('allergens', n % 3 === 0 ? 'none' : 'wheat');
  if (n % 3 !== 0) fd.append('allergens', 'milk');
  fd.set('photo', new Blob([await photo(n)], { type: 'image/jpeg' }), `dish-${n}.jpg`);
  const res = await fetch(`${BASE}/api/contest/admin/dish-add`, { method: 'POST', headers: { Authorization: AUTH }, body: fd });
  const text = await res.text();
  if (!res.ok) die(`dish-add (dish ${n}) returned ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).state;
}

async function postVote(voterId, categoryId, dishId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BASE}/api/contest/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voterId, categoryId, dishId }),
    });
    if (res.status === 429) {
      const wait = 15_000 * (attempt + 1);
      console.warn(`  429 from the server, backing off ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) die(`vote returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  die('vote kept returning 429 after 6 retries');
}

// ---- setup ---------------------------------------------------------------
console.log(`Resetting contest at ${BASE} (previous state is archived)`);
await admin('reset', {});
await admin('title', { title: 'Rehearsal Dish Contest' });
let state;
for (const name of ['Main Dish', 'Side Dish', 'Dessert']) state = await admin('category-add', { name });
const cats = state.categories;

console.log(`Adding ${opts.dishes} dishes`);
const byCat = new Map(cats.map((c) => [c.id, []]));
for (let n = 1; n <= opts.dishes; n++) {
  const cat = cats[(n - 1) % cats.length];
  state = await addDish(n, cat.id);
}
for (const d of state.dishes) {
  if (d.status !== 'approved') state = await admin('dish-approve', { id: d.id });
}
for (const d of state.dishes) byCat.get(d.categoryId)?.push(d.id);
console.log(`  ${state.dishes.length} dishes in ${cats.length} categories`);

if (!opts.vote) {
  console.log('--no-vote: dishes seeded, voting not opened.');
  process.exit(0);
}

// ---- voting --------------------------------------------------------------
const windowMs = opts.minutes * 60_000;
await admin('open', { minutes: opts.minutes + 1 });
console.log(`Voting open; ${opts.voters} voters over ${opts.minutes} min (deadline ${opts.minutes + 1} min)`);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const events = [];
for (let v = 0; v < opts.voters; v++) {
  const voterId = randomUUID();
  const start = Math.random() * windowMs * 0.8;
  const picks = {};
  for (const c of cats) {
    picks[c.id] = pick(byCat.get(c.id));
    events.push({ t: start + Math.random() * 2000, voterId, categoryId: c.id, dishId: picks[c.id] });
  }
  if (Math.random() < 0.25) {
    const c = pick(cats);
    const options = byCat.get(c.id).filter((id) => id !== picks[c.id]);
    if (options.length) events.push({ t: start + 2000 + Math.random() * (windowMs - start - 2000), voterId, categoryId: c.id, dishId: pick(options) });
  }
}
events.sort((a, b) => a.t - b.t);

// One IP casts every ballot, and the server allows 3000 votes per 10 minutes per IP.
const WINDOW_10 = 600_000;
const cap = 2700 * Math.max(1, windowMs / WINDOW_10); // votes the IP may send inside the schedule
let scale = 1;
if (events.length > cap) {
  scale = events.length / cap;
  console.warn(`WARNING: ${events.length} votes exceed the 3000 per 10 min per-IP limit in ${opts.minutes} min; stretching the schedule ${scale.toFixed(1)}x (the deadline may pass: use more --minutes or fewer --voters).`);
}
const startedAt = Date.now();
let sent = 0;
for (const ev of events) {
  const wait = startedAt + ev.t * scale - Date.now();
  if (wait > 0) await sleep(wait);
  await postVote(ev.voterId, ev.categoryId, ev.dishId);
  sent++;
  if (sent % 50 === 0) console.log(`  ${sent}/${events.length} votes sent`);
}
console.log(`Sent ${sent} votes (${events.length - opts.voters * cats.length} were changes)`);

// ---- standings -----------------------------------------------------------
state = await (await fetch(`${BASE}/api/contest/admin/state`, { headers: { Authorization: AUTH } })).json().then((j) => j.state);
const dishById = new Map(state.dishes.map((d) => [d.id, d]));
console.log(`\nStandings (phase ${state.effectivePhase}, ${Object.keys(state.ballots).length} voters)`);
for (const c of state.categories) {
  console.log(`\n${c.name}`);
  for (const row of (state.tally[c.id] || []).slice(0, 6)) {
    const d = dishById.get(row.dishId);
    console.log(`  ${row.place ? `#${row.place}` : '  '}  ${String(row.votes).padStart(3)} votes  ${d ? d.name : row.dishId}`);
  }
}
console.log('\nNext: close voting and step the reveal in /contest/admin, with /contest/tv open.');
