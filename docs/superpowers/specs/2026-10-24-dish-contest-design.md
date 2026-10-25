# Dish Contest Voting — Design

Date: 2026-10-24 · Owner: Sean · Status: draft for approval

## Intent

A one-night dish competition at a church event, held at a restaurant: 20-30 dishes, about 100 diners, up to 5 categories. Diners scan a QR code, vote for their favourite dish in each category from their phone, and watch a TV that makes the voting feel alive **without revealing who is winning**. When the admin's timer runs out, voting closes and the admin reveals each category's podium live on the TV, 3rd place first.

It is hosted on the existing dashboard server (`seo-dashboard`, PM2, DigitalOcean) instead of Firebase, so there is no new account, no config snippet and no setup hour. It is unrelated to RSC revenue and must not put the dashboard or its cron work at risk.

## Goals

1. **Admin page** (behind the dashboard's existing basic auth): create and name 1-5 categories; open and close competitor submissions; review submissions and approve, edit or delete them; add dishes directly for anyone who did not submit (same fields as the competitor page); set a deadline (a countdown in minutes, or an end time); open voting; close early or extend; see the live standings privately; step through the reveal; reset for the next event.
2. **Competitor page** (public, no login, reached by a link the admin shares ahead of the event): a contestant enters their name, dish name, category (from the admin's list), a photo, the ingredient list (required), allergens (checkboxes for the nine major allergens: milk, eggs, fish, shellfish, tree nuts, peanuts, wheat, soy, sesame, plus "none of these"), and the recipe (optional). After submitting they get a private edit link so they can fix it until voting opens.
3. **Voting page** (public, phone-first, no login): one pick per category, shown as a photo list per category. Each dish card shows allergen badges, and tapping it opens the full details: photo, ingredients, allergens and recipe. Dish details are viewable as soon as dishes are approved, before voting opens, so diners can check for allergies before eating. A diner can change any pick as often as they like until the deadline. The page shows which picks they have made and the time left. After the deadline it says voting is closed and shows their final picks.
4. **TV page** (public, 16:9, full screen, no interaction needed):
   - **Voting open:** a photo wall of every dish, the countdown, and the voting QR code. On every vote cast or changed, a **random** tile sparkles — never the tile that received the vote.
   - **Voting closed:** an animated "Voting is closed" screen with turnout only ("87 guests cast 241 votes").
   - **Reveal:** one category at a time, a podium. Each admin click reveals the next step: 3rd, then 2nd, then 1st, each with the dish photo, name and cook. Then the admin moves to the next category.
5. One vote per phone per category, recognised by a device id.

## Non-goals

- Accounts or logins for diners or cooks. A cook's only credential is the private edit link from their own submission.
- Airtight fraud prevention. A diner who clears browser data can vote again; that is accepted for a friendly event.
- More than one contest running at once.
- Native apps, SMS, email, or anything sent to diners.

## Anti-goals (a failure even if it "works")

- **Leaking the standings before the reveal**, by any route: per-dish counts, dish ordering, the sparkle position, response sizes, or a public endpoint that includes results the TV has not revealed yet. The public API must carry no per-dish vote data until a place is revealed, and then only for revealed places.
- **Taking the dashboard down.** The box has 961 MB RAM and has crash-looped on OOM before. No new process, no headless browser, nothing heavy at request time.
- **Losing votes** to a crash or a half-written file.
- **An unreviewed upload appearing on the church TV or voting page.** The competitor form is public; nothing it submits is shown to diners until the admin approves it.
- **Presenting allergen info as verified.** It is the cook's own entry, and the pages say so.
- **Locking out real diners.** Everyone in the restaurant shares one Wi-Fi IP, so a per-IP limit sized for the giveaway (5/hour) would block the room.

## Constraints and facts about the existing system

- Router: `agents/dashboard/lib/router.js`; route modules export `[{ method, match, handler }]` and must `return` their promise. Bodies go through `readJsonBody` (per-call cap). Photo upload uses the shared multer instance (`ctx.upload`, 20 MB cap) and its own error argument, like the three routes in `routes/creatives.js`.
- Auth: `index.js` lets a short allowlist of public paths (`/api/rum`, `/api/giveaway/*`) dispatch before `checkAuth`. The contest's public paths join that allowlist; admin paths stay behind auth.
- Rate limiter: `lib/rate-limit.js` (`createRateLimiter`, `getClientIp`, which reads `X-Real-IP` from nginx).
- `sharp` is already a dependency (photo resize). There is no QR library yet.
- Public hostnames: each public surface has its own first-party subdomain, an A record straight to the origin (not proxied by Cloudflare), a Let's Encrypt cert, and an nginx server block that proxies **only** that surface's paths (`rum.realskincare.com` → `/api/rum`, `entries.realskincare.com` → `/api/giveaway/`). The ngrok URL must not be used for diners: free ngrok shows an interstitial warning page.
- Node 22. Tests use `node --test`; see `tests/dashboard/giveaway-routes.test.js` for route-test style.

## Decided

- **Host:** inside the existing `seo-dashboard` process (Sean).
- **Categories:** admin-named, 1 to 5 (Sean).
- **Votes:** one per phone per category; changeable until the deadline (Sean).
- **TV while open:** photo wall with random sparkle (Sean).
- **Closing:** admin sets a timer; a "voting closed" graphic when it ends (Sean).
- **Reveal:** per category, admin-driven, podium: 3rd, then 2nd, then 1st (Sean, confirmed).
- **Dish entry:** competitors submit their own dish, recipe and ingredient list on a competitor page; the admin enters any missing dishes on the day (Sean).
- **Dishes:** each dish competes in exactly one category (Sean).
- **Ties:** OK, including for 1st (Sean).
- **Address:** `vote.realskincare.com` is fine; it is a church event (Sean).
- **Timeline:** a couple of weeks to test (Sean), so the full build plus a rehearsal on the real address.
- **My calls (check these):** submissions need admin approval before they appear; allergen checkboxes in addition to the free-text ingredient list; a private edit link per submission, editable until voting opens; one shared submission link rather than one per cook.

## Design

### Pieces

- `lib/contest.js` — **pure**, no I/O: state transitions, vote validation, tallying, ranking, and `publicView(state, now)`, the only function that shapes what the public sees. Everything risky (leaks, ranking, ties, deadline) is unit-tested here.
- `lib/contest-store.js` — reads/writes `data/contest/state.json` with temp file + rename; photos in `data/contest/photos/<dishId>.webp`. A reset moves the state file to `data/contest/archive/<timestamp>.json`. `data/contest/` is gitignored.
- `agents/dashboard/routes/contest.js` — the HTTP routes.
- `agents/dashboard/public/contest/vote.html`, `tv.html`, `admin.html` (+ small JS/CSS files). `vote.html` and `tv.html` are served on the public allowlist; `admin.html` only behind auth.

### State (one contest)

```
{ id, title, phase: 'setup'|'open'|'closed'|'revealing'|'done',
  deadline: ISO|null, openedAt, closedAt,
  categories: [{ id, name, order }],              // 1..5
  submissionsOpen: boolean,
  dishes: [{ id, categoryId, name, cook, photo, ingredients, allergens: [..], recipe,
            status: 'pending'|'approved', source: 'competitor'|'admin', editTokenHash, submittedAt }],
  ballots: { [voterId]: { [categoryId]: dishId } },
  voteEvents: number,                              // increments on every accepted cast/change; drives the sparkle
  reveal: { categoryIndex, step }                  // step 0..3 = nothing / 3rd / 2nd / 1st shown
}
```

Ballots hold only the current pick, so a changed vote replaces the old one. Tallies are computed from ballots on read, never stored.

### Phases

`setup` → admin opens with a deadline → `open` → deadline passes (checked on every request against server time) or admin closes → `closed` → admin starts the reveal → `revealing` → last step of last category → `done`. The admin can extend the deadline while `open`, and reopen from `closed` with a new deadline (before any reveal). Reset returns to `setup` with an empty ballot box, keeping or clearing dishes (admin's choice).

### Public API (no auth)

- `GET /api/contest/public` → `publicView`: title, phase, `deadline`, `serverNow` (for clock skew), categories, **approved** dishes only (in admin order, never sorted by votes; ingredients, allergens and recipe included; never the edit token), `voterCount`, `voteCount`, `voteEvents`, and **only revealed** podium entries. Polled every 2 s by the TV and every 10 s by the vote page.
- `POST /api/contest/vote` `{ voterId, categoryId, dishId }` → accepts only while `open` and before the deadline; validates that the dish belongs to the category; returns that voter's ballot. Body capped at 1 KB.
- `GET /api/contest/my-ballot?voterId=` → that voter's picks (so a refreshed phone restores its state).
- `GET /contest/photos/<dishId>.webp` and `GET /contest/qr.svg` (the voting URL as a QR code).
- `GET /api/contest/submission-form` → categories and whether submissions are open.
- `POST /api/contest/submit` (multipart: photo + fields) → creates a `pending` dish and returns a one-time edit URL `/contest/enter?edit=<token>`. Only the token's SHA-256 hash is stored. Text fields are length-capped (name 80, ingredients 2,000, recipe 8,000 chars) and rendered as text, never HTML.
- `GET/POST /api/contest/submission?token=` → read or update your own submission while `phase` is `setup`. Editing an approved dish keeps it approved but flags it "edited since approval" on the admin page.
- `voterId`: a random UUID the vote page creates and keeps in `localStorage` plus a cookie. The server rejects anything that is not a v4 UUID.

### Admin API (basic auth)

Open/close submissions; approve, edit, delete submissions (a pending list with photo previews); CRUD for categories and dishes (photo upload via multer → `sharp` resize to 1200 px wide WebP, the original discarded), open/close/extend/reopen, reveal-next, reveal-back (undo a misclick), reset, and `GET /api/contest/admin/standings` (full tallies; admin only).

### Ranking and ties

Votes per dish within a category. Competition ranking: a dish's place = 1 + the number of dishes in its category with strictly more votes. Each reveal step shows **every** dish holding that place, so two dishes tied for 2nd appear together. A place no dish holds (two tied for 1st leaves no 2nd) is skipped automatically. Dishes with zero votes never place. A category with fewer than 3 placing dishes reveals only the steps it has.

### Live feel

The TV compares `voteEvents` between polls; for each new event (capped at, say, 5 per poll) it sparkles a uniformly random tile. The countdown runs off `deadline` corrected by `serverNow`, so TV and phones agree. At zero the TV and phones flip to closed without waiting for the next poll, and the server enforces it regardless.

### Abuse limits

- Per IP: loose (e.g. 600 vote posts / 10 min), because the whole room shares one IP. Per voterId: e.g. 60 vote posts / 10 min. Both via `createRateLimiter`.
- Submissions: per IP, e.g. 20 / hour (a church hall may share Wi-Fi too); a cap of e.g. 80 dishes in total; photo upload via the shared multer 20 MB cap, resized by `sharp` before storage. Rejected uploads (not an image) answer 400 and store nothing.
- Max distinct voterIds per contest, e.g. 1,000, so a script cannot grow `state.json` without bound. The admin sees the voter count live and can judge it against the ~100 people in the room.

### Hosting

- New subdomain `vote.realskincare.com`: DNS-only A record → `137.184.119.230` (Cloudflare API), certbot cert, nginx server block proxying **only** `/contest/` (minus `/contest/admin*`; including `/contest/enter`) and `/api/contest/` (minus `/api/contest/admin*`), same pattern as `rum` and `entries`. The admin page is used through the existing dashboard URL with basic auth.
- The QR code and printed table cards point at `https://vote.realskincare.com/contest/vote`. The competitor link is `https://vote.realskincare.com/contest/enter`.

### Testing

- Unit tests for `lib/contest.js`: phase transitions and deadline enforcement, vote validation, vote changes, submission validation, pending dishes never in `publicView`, edit tokens never in any public response, tallying, ranking and ties, and **leak tests** asserting `publicView` carries no per-dish data in every phase before a reveal, and only revealed places after.
- Route tests in the giveaway style: auth boundary (admin routes 401 without auth, public routes work without it), body caps, rate limits, closed-phase rejection.
- A local end-to-end rehearsal with ~25 fake dishes and a script posting ~100 ballots, watching the TV page, then the full reveal.
- On the server: one full rehearsal on the real subdomain from a phone before the event, then reset.

## Left to the builder

File and function names, exact visual styling and animations (big and readable from across a room; dark background), the exact rate-limit numbers within the stated intent, the admin page layout, and whether the QR SVG is generated with the `qrcode` npm package or a vendored minimal encoder.

## Open for Sean

Nothing outstanding. My calls are listed under Decided.
