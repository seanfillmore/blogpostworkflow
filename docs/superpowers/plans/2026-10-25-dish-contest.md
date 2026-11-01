# Dish Contest Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A church dish-contest app inside the existing dashboard: competitor submissions, phone voting via QR, a TV photo wall, and an admin-driven podium reveal.

**Architecture:** A pure core (`lib/contest.js`) owns every rule and the only public projection; a small store (`lib/contest-store.js`) persists one JSON state file atomically and serialises writes; one route module serves public and admin APIs; four static pages (vote, enter, tv, admin) poll JSON. No new process.

**Tech Stack:** Node 22 ESM, `node:test`, existing dashboard router, `multer` (already in ctx), `sharp` (installed), `qrcode` (new dependency), vanilla HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-24-dish-contest-design.md`

## Global Constraints

- Categories: 1 to 5, admin-named. Each dish belongs to exactly one category.
- Allergen enum, exactly: `milk, eggs, fish, shellfish, tree-nuts, peanuts, wheat, soy, sesame, citrus`, plus `none` (mutually exclusive with the others). Labels: Milk, Eggs, Fish, Shellfish, Tree nuts, Peanuts, Wheat, Soy, Sesame, Citrus, None of these.
- Text caps: cook name 80, dish name 80, ingredients 2,000 (required, non-empty), recipe 8,000 (optional), category name 40, contest title 80. All user text is rendered with `textContent`, never `innerHTML`.
- Phases: `setup` → `open` → `closed` → `revealing` → `done`. Deadline enforced on server time on every read and write.
- Reveal per category: step 0 nothing, 1 = 3rd, 2 = 2nd, 3 = 1st. Competition ranking; ties share a place; zero-vote dishes never place; places no dish holds are skipped.
- Public responses carry NO per-dish vote data until that place is revealed, NO pending dishes, NO edit tokens or hashes. Dishes always in admin order.
- `voterId` must match a v4 UUID regex; anything else → 400.
- Limits: vote posts 600 / 10 min per IP and 60 / 10 min per voterId; submissions 20 / hour per IP; max 80 dishes; max 1,000 distinct voters; vote body cap 1 KB; JSON admin bodies 64 KB; photos via `ctx.upload` (20 MB), resized with `sharp` to 1200 px wide WebP, quality 80.
- Data lives in `data/contest/` (gitignored): `state.json`, `photos/<dishId>.webp`, `archive/<ISO-stamp>.json`.
- Every handler `return`s its promise. Multer is wrapped in a promise inside the handler (never do work in its callback). JSON bodies via `readJsonBody(req, { maxBytes })`.
- Public URL base: `https://vote.realskincare.com`. Vote page `/contest/vote`, competitor page `/contest/enter`, TV `/contest/tv`, admin `/contest/admin` (auth only).
- Pages state the allergen info is entered by the cook and not verified.
- No em dashes in any user-facing copy.

## Review Focus

1. A voter changes a pick after the deadline passed but before any poll noticed: server must reject with 409 and the phone must show "Voting is closed" with their final picks.
2. An admin deletes a dish or category that already has votes: ballots pointing at it are dropped from tallies, and the voter's page shows that pick as empty (not a crash).
3. Two requests write state at the same moment (100 phones voting at once): no lost ballot, file never half-written.
4. A competitor uploads a HEIC/huge/non-image file: 400 with a plain message, nothing stored, no temp file left in `data/.uploads-tmp`.
5. Server restarts mid-event (PM2): state reloads, phase/deadline/ballots/reveal step intact, TV resumes on next poll.

---

### Task 1: Core model, phases and voting (`lib/contest.js`)

**Files:**
- Create: `lib/contest.js`
- Test: `tests/lib/contest.test.js`

**Interfaces:**
- Produces (all pure, return a NEW state or throw `ContestError` with `.status` (400/404/409) and `.message`):
  - `ALLOWED_ALLERGENS: string[]`, `ALLERGEN_LABELS: Record<string,string>`, `LIMITS` (the numeric caps above)
  - `emptyContest(now: Date): State` — phase `setup`, title `"Dish Contest"`, no categories/dishes/ballots, `voteEvents: 0`, `submissionsOpen: false`, `reveal: { categoryIndex: 0, step: 0 }`
  - `effectivePhase(state, now): Phase` — `open` past `deadline` reads as `closed`
  - `setTitle(state, title)`, `addCategory(state, name) -> {state, category}`, `renameCategory(state, id, name)`, `reorderCategories(state, ids[])`, `deleteCategory(state, id)` (refuses if dishes remain: 409)
  - `openVoting(state, now, deadline: Date)` (from `setup` or `closed` with `reveal.step===0` and categoryIndex 0; needs ≥1 approved dish; deadline must be in the future), `extendDeadline(state, now, deadline)` (only while effectively open), `closeVoting(state, now)` (sets phase `closed`, `closedAt`, `deadline=now` if later)
  - `castVote(state, now, { voterId, categoryId, dishId }) -> { state, ballot }` — 409 unless effectively open; 400 bad UUID; 404 unknown/unapproved dish or dish not in category; 409 when a NEW voterId would exceed 1,000; increments `voteEvents` only when the pick actually changes
  - `ballotFor(state, voterId) -> Record<categoryId, dishId>` — drops picks whose dish no longer exists or is unapproved
  - `isUuidV4(s): boolean`

- [ ] **Step 1: Write failing tests** in `tests/lib/contest.test.js`:
  - `castVote` while `setup` → throws status 409; after `openVoting` succeeds and returns ballot `{ [catId]: dishId }`.
  - changing a pick replaces it; `voteEvents` goes 1 → 2; re-casting the same pick leaves `voteEvents` at 2.
  - `effectivePhase(state, deadline + 1ms)` is `closed`; `castVote` at that instant throws 409.
  - dish from category A posted under category B → 404; pending dish → 404; `voterId: 'abc'` → 400.
  - 1,000 voters accepted, the 1,001st new voterId → 409, an existing voter can still change.
  - `addCategory` a 6th → 400; `deleteCategory` with a dish in it → 409.
  - `openVoting` with deadline in the past → 400; with zero approved dishes → 409.
  - Review Focus 2: after deleting a dish (via Task 3's `deleteDish`, so add this test in Task 3), `ballotFor` omits that category.
- [ ] **Step 2: Run** `node --test tests/lib/contest.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the functions above. Ids: `crypto.randomUUID()`. Never mutate the input (structuredClone at entry).
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(contest): core model, phases and voting`.

### Task 2: Ranking, reveal and the public projection (`lib/contest.js`)

**Files:**
- Modify: `lib/contest.js`
- Test: `tests/lib/contest-ranking.test.js`

**Interfaces:**
- Consumes: Task 1 state and functions.
- Produces:
  - `tally(state) -> Record<categoryId, Array<{ dishId, votes, place: number|null }>>` — competition ranking, `place` null for 0 votes or place > 3
  - `revealSteps(state, categoryId) -> Array<{ step: 1|2|3, place: 3|2|1, dishIds: string[] }>` — only steps whose place is held
  - `startReveal(state, now)` (from effectively `closed`; persists phase `closed` first if deadline passed), `revealNext(state, now)` (advances step through the category's available steps, then to the next category; after the last step of the last category phase → `done`), `revealBack(state, now)` (inverse, never below category 0 step 0)
  - `publicView(state, now) -> object` with exactly: `title, phase (effective), deadline, serverNow, submissionsOpen, categories:[{id,name}], dishes:[{id,categoryId,name,cook,ingredients,allergens,recipe,photoUrl}] (approved only, admin order), voterCount, voteCount, voteEvents, reveal: { categoryIndex, categoryId, revealed: [{ place, dishIds, votes }] } | null`. `reveal` is null unless phase is `revealing`/`done`; `revealed` holds only steps already shown, for the current category, and for every earlier category when `done`. `photoUrl` = `/contest/photos/<id>.webp?v=<photoVersion>` or null.
  - `adminView(state, now)` — full state minus `editTokenHash`, plus `tally`.

- [ ] **Step 1: Write failing tests:**
  - votes A=5, B=5, C=3, D=0 → places A1, B1, C3, D null; `revealSteps` → `[{step:1,place:3,dishIds:[C]}, {step:3,place:1,dishIds:[A,B]}]` (no 2nd).
  - **Leak tests:** for phases setup/open/closed, `JSON.stringify(publicView(...))` contains none of `"votes"`, `"tally"`, `"place"`, `"editTokenHash"`, `"ballots"`; dish order equals admin order even when the last dish has the most votes; pending dish ids absent.
  - after `startReveal` + one `revealNext`: `reveal.revealed` has only the 3rd-place entry; 1st-place dish votes absent from the JSON.
  - `revealNext` past the last category → phase `done`; `revealBack` from `done` returns to the last step.
  - category with one voted dish reveals only its 1st place step.
- [ ] **Step 2: Run** `node --test tests/lib/contest-ranking.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(contest): ranking, reveal and public projection`.

### Task 3: Dishes and competitor submissions (`lib/contest.js`)

**Files:**
- Modify: `lib/contest.js`
- Test: `tests/lib/contest-dishes.test.js`

**Interfaces:**
- Produces:
  - `validateDishFields(input, state) -> { ok:true, value } | { ok:false, error }` — trims, enforces caps, category must exist, allergens ⊆ enum, `none` alone, ingredients required, at least one allergen choice required
  - `submitDish(state, now, fields) -> { state, dish, editToken }` — 409 unless `submissionsOpen` and phase `setup`; 409 at 80 dishes; dish `status:'pending'`, `source:'competitor'`, stores `editTokenHash = sha256(editToken)`; `editToken` = 32 random bytes base64url
  - `findByToken(state, token) -> dish|null` (constant-time compare of hashes)
  - `updateOwnDish(state, now, token, fields)` — only in `setup`; if dish was approved sets `editedSinceApproval: true`
  - `adminAddDish(state, fields)` (status `approved`, source `admin`, allowed in any phase before `revealing`), `adminUpdateDish(state, id, fields)` (clears `editedSinceApproval`), `approveDish(state, id)`, `unapproveDish(state, id)`, `deleteDish(state, id)`, `setDishPhoto(state, id) ` (bumps `photoVersion`), `setSubmissionsOpen(state, bool)`, `reorderDishes(state, ids[])`
- [ ] **Step 1: Write failing tests:** over-length ingredients → error naming the field; `['none','milk']` → error; `'citrus'` accepted; submit while closed → 409; submitted dish absent from `publicView` until `approveDish`; `findByToken` with the returned token finds it, a wrong token returns null; owner edit of an approved dish sets `editedSinceApproval`; owner edit after `openVoting` → 409; Task 1's Review Focus 2 test (delete voted dish → `ballotFor` omits it, tally excludes it).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** all three contest test files — PASS.
- [ ] **Step 5: Commit** `feat(contest): dishes and competitor submissions`.

### Task 4: Store (`lib/contest-store.js`)

**Files:**
- Create: `lib/contest-store.js`
- Modify: `.gitignore` (add `data/contest/`)
- Test: `tests/lib/contest-store.test.js`

**Interfaces:**
- Produces: `createContestStore({ dir, now = () => new Date() })` returning:
  - `read() -> State` (loads `state.json`, or `emptyContest` if absent; a corrupt file throws, it is never silently replaced)
  - `update(fn: (state) => State | { state, ...extra }) -> Promise<result>` — a promise-chain mutex; writes temp file + `rename`; returns whatever `fn` returned
  - `photoPath(dishId)`, `savePhoto(dishId, buffer)` (sharp → 1200 px wide WebP q80, atomic), `deletePhoto(dishId)`
  - `archiveAndReset({ keepDishes: boolean })` — copies state to `archive/<stamp>.json`, returns fresh `emptyContest` (keeping categories+dishes reset to approved/no ballots when `keepDishes`)
- [ ] **Step 1: Write failing tests** using a temp dir: 200 concurrent `update` calls each casting a distinct voter → all 200 ballots present after (Review Focus 3); a new store instance on the same dir reads identical state (Review Focus 5); corrupt `state.json` → `read()` throws; `savePhoto` on a 3000 px PNG yields a WebP 1200 px wide (check with `sharp(...).metadata()`); `savePhoto` on non-image bytes rejects.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(contest): atomic store with serialised writes`.

### Task 5: Routes, public allowlist and QR (`agents/dashboard/routes/contest.js`)

**Files:**
- Create: `agents/dashboard/routes/contest.js`
- Modify: `agents/dashboard/index.js` (import + spread routes; public allowlist), `package.json` (add `qrcode`)
- Test: `tests/dashboard/contest-routes.test.js`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `createContestRoutes({ store, publicBase = 'https://vote.realskincare.com', now })` returning the routes array (default export = routes built with the real store at `join(ROOT,'data','contest')`), and `isPublicContestPath(urlPath): boolean`, true exactly for: `/contest/vote`, `/contest/enter`, `/contest/tv`, `/contest/qr.svg`, `/contest/assets/*`, `/contest/photos/*`, `/api/contest/public`, `/api/contest/vote`, `/api/contest/my-ballot`, `/api/contest/submission-form`, `/api/contest/submit`, `/api/contest/submission`. Never true for anything containing `/admin`.
- Public routes: `GET /contest/{vote,enter,tv}` serve `public/contest/{vote,enter,tv}.html`; `GET /contest/assets/<file>` serves from `public/contest/assets/` (path-traversal safe, reuse `serveStatic` logic or `safeResolve` pattern); `GET /contest/photos/<uuid>.webp`; `GET /contest/qr.svg` (QR of `${publicBase}/contest/vote`, `qrcode.toString(url,{type:'svg',margin:1})`, cached in memory); `GET /api/contest/public`; `POST /api/contest/vote` `{voterId,categoryId,dishId}` (1 KB cap) → `{ ok, ballot }`; `GET /api/contest/my-ballot?voterId=`; `GET /api/contest/submission-form` → `{ title, submissionsOpen, categories, allergens: ALLERGEN_LABELS }`; `POST /api/contest/submit` multipart (`photo` optional on submit? NO: required) → `{ ok, editUrl: '/contest/enter?edit=<token>' }`; `GET /api/contest/submission?token=` → own dish fields; `POST /api/contest/submission?token=` multipart (photo optional).
- Admin routes (auth via the normal path): `GET /contest/admin` (serves `admin.html`), `GET /api/contest/admin/state` → `adminView`, `POST /api/contest/admin/<action>` for: `title, category-add, category-rename, category-delete, category-reorder, dish-add (multipart), dish-update (multipart), dish-approve, dish-unapprove, dish-delete, dish-reorder, submissions, open, extend, close, reveal-start, reveal-next, reveal-back, reset`. Each maps 1:1 to a core function through `store.update`.
- `ContestError` → its status with `{ ok:false, error: message }`; any other error falls through to the router's 500.
- In `index.js`, extend the existing allowlist line: `if (urlPath === '/api/rum' || urlPath.startsWith('/api/giveaway/') || isPublicContestPath(urlPath))`.

- [ ] **Step 1: Write failing tests** (fake req/res like `giveaway-routes.test.js`, store on a temp dir): `isPublicContestPath('/api/contest/admin/state')` false and `'/contest/admin'` false, `'/api/contest/vote'` true; vote POST over 1 KB → 413; 61st vote from one voterId inside the window → 429; 601st from one IP → 429 while a different voterId on another IP succeeds; submit with a text file as `photo` → 400 and the multer temp file is deleted (Review Focus 4); `GET /api/contest/public` body never contains `editTokenHash`.
- [ ] **Step 2: Run** `node --test tests/dashboard/contest-routes.test.js` — FAIL.
- [ ] **Step 3: Implement.** `npm i qrcode`.
- [ ] **Step 4: Run** the file and the full dashboard suite `node --test 'tests/dashboard/*.test.js'` — PASS, 0 cancelled.
- [ ] **Step 5: Commit** `feat(contest): public and admin routes`.

### Task 6: Competitor page and voting page

**Files:**
- Create: `agents/dashboard/public/contest/enter.html`, `vote.html`, `assets/contest.css`, `assets/enter.js`, `assets/vote.js`

**Interfaces:**
- Consumes: Task 5 public API.

Behaviour (phone-first, large tap targets, light theme, church-friendly):
- **enter:** loads `/api/contest/submission-form`; if closed shows "Submissions are closed. Please contact the organizer." Form fields per Global Constraints, photo with preview, allergen checkboxes (`none` unticks others and vice versa), char counters. On success shows the private edit link with a Copy button and "Save this link to edit your dish until voting opens." With `?edit=<token>` it loads and edits the existing dish. Allergen disclaimer under the checkboxes.
- **vote:** `voterId` from `localStorage` (`contestVoterId`), created with `crypto.randomUUID()` if absent, mirrored to a cookie. Polls `/api/contest/public` every 10 s and `/api/contest/my-ballot` on load. Tabs or sections per category with progress ("2 of 3 categories voted"). Dish cards: photo, name, cook, allergen badges, a "Details" button opening a sheet with photo, ingredients, allergens, recipe and the disclaimer. Tapping "Vote" posts and marks the card selected. Countdown corrected by `serverNow`. At zero or on 409: banner "Voting is closed" and cards locked, picks still highlighted (Review Focus 1). In `setup`: dishes browseable, vote buttons hidden, "Voting opens soon".

- [ ] **Step 1:** Build both pages.
- [ ] **Step 2: Verify locally:** `node agents/dashboard/index.js --port 4343` with `SEO_CLAUDE_ROOT` unset is fine (data goes to the worktree's gitignored `data/contest/`). Using curl on admin routes (basic auth from `.env`), create 2 categories, open submissions; submit one dish through `/contest/enter` in a browser at 390 px width; approve it; open voting with a 5-minute deadline; vote from two browser profiles; change a vote; let the deadline pass and confirm the closed banner. Screenshot each state.
- [ ] **Step 3: Commit** `feat(contest): competitor and voting pages`.

### Task 7: TV page

**Files:**
- Create: `agents/dashboard/public/contest/tv.html`, `assets/tv.js`, `assets/tv.css`

Behaviour (16:9, dark, readable across a room, no interaction, no scrollbars):
- Polls `/api/contest/public` every 2 s; survives fetch errors silently and retries (Review Focus 5).
- `setup`: title, "Voting opens soon", photo wall, QR.
- `open`: header "Vote for your favorites", countdown (big, turns amber under 5 minutes), photo wall grid sized to fit every approved dish (up to 80), QR code (`/contest/qr.svg`) with the short URL `vote.realskincare.com/contest/vote`. For each new `voteEvents` since last poll (max 5 per poll, staggered) a uniformly random tile sparkles. Never use any per-dish signal.
- `closed`: animated "Voting is closed", turnout "{voterCount} guests cast {voteCount} votes", "Results coming up".
- `revealing`: current category name; podium with 2nd (left), 1st (centre, tallest), 3rd (right). Places not yet revealed show "?"; a newly revealed place animates in with photo, dish name, cook and vote count; ties show every tied dish on that step. Confetti on 1st.
- `done`: summary of every category's winners.
- [ ] **Step 1:** Build. **Step 2: Verify** at 1920×1080 in a browser through every phase, using admin curl calls; screenshot each phase. **Step 3: Commit** `feat(contest): TV page`.

### Task 8: Admin page

**Files:**
- Create: `agents/dashboard/public/contest/admin.html`, `assets/admin.js`

Behaviour (desktop and phone; served behind basic auth):
- Sections: Contest title. Categories (add, rename, reorder, delete). Submissions toggle + share links for `/contest/enter`, `/contest/vote`, `/contest/tv` and a printable QR card (opens a print view with title, QR and URL). Dishes: pending list first (photo, all fields, Approve / Edit / Delete, an "Edited since approval" badge), then approved by category with reorder; "Add dish" form for walk-ins. Voting: deadline as minutes-from-now or clock time, Open / Extend / Close. Live standings (from `adminView`, auto-refresh 5 s, clearly labelled "Private: do not show on the TV"). Reveal: current category and step, "Reveal next" (big), "Back". Reset (confirm dialog, choose keep or clear dishes).
- [ ] **Step 1:** Build. **Step 2: Verify** the full flow end to end through the UI only. **Step 3: Commit** `feat(contest): admin page`.

### Task 9: Rehearsal script and docs

**Files:**
- Create: `scripts/contest-rehearsal.mjs`
- Modify: `CLAUDE.md` (one short paragraph under Architecture: what it is, where data lives, the public allowlist, `vote.realskincare.com`, that it is unrelated to RSC revenue)

**Interfaces:**
- `node scripts/contest-rehearsal.mjs --base http://localhost:4343 [--dishes 25] [--voters 100] [--minutes 3]` — reads dashboard basic auth from `.env`; refuses a non-localhost base unless `--allow-remote`; resets (archive), creates 3 categories, adds dishes with generated placeholder photos (sharp solid colours with the dish number), opens voting, posts ballots from N random voterIds spread over the window with some vote changes, then prints admin standings. Dry by default is NOT needed; it only targets an explicit base.
- [ ] **Step 1:** Write it. **Step 2: Run** it locally with the TV page open; then step the reveal through all categories; confirm standings match the reveal. **Step 3:** run `npm test` — 0 fail, 0 cancelled. **Step 4: Commit** `chore(contest): rehearsal script and docs`.

### Task 10 (operator, done by the session, not a subagent): hosting

- Merge PR, deploy (`git pull && npm ci --omit=dev` if `qrcode` is new on the box, `pm2 restart seo-dashboard`).
- Cloudflare API: create `vote.realskincare.com` A record → `137.184.119.230`, **proxied: false**.
- nginx `/etc/nginx/sites-available/vote` modelled on `entries`: port 80 for ACME + redirect; 443 proxying `location ^~ /contest/` and `location ^~ /api/contest/` to `127.0.0.1:4242`, with `location ^~ /contest/admin { return 404; }` and `location ^~ /api/contest/admin { return 404; }` (longest `^~` prefix wins and stops regex evaluation, so a regex admin block would never be consulted); `client_max_body_size 25m`; everything else 404. `certbot --nginx -d vote.realskincare.com`.
- Verify from outside: vote/enter/tv load over HTTPS; `/contest/admin` and `/api/contest/admin/state` 404 on that host; `free -m` unchanged; then run the rehearsal against production with `--allow-remote`, reset, leave it in `setup`.
