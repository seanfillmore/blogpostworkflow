# SEO Claude Team

A fleet of AI agents that grow **Shopify revenue** for **Real Skin Care** (natural deodorants, body care, oral care, lip balm) on its storefront `realskincare.com`, using SEO as the means. RSC also sells on Amazon, where it shares a seller account with a sister brand, **Culina** (cast iron / Blackstone griddle care). Culina is on a separate website with its own SEO automation; this codebase's Shopify/content/SEO pipelines are RSC-only. The Shopify website is the primary revenue channel. Amazon is complementary and validates commercial intent for keyword/SEO decisions.

## Prime Directive — Revenue

**The purpose of this project is to generate revenue for Real Skin Care's Shopify store. SEO is the means, not the goal.** Every agent, report, and change exists to drive *traffic that converts to sales*. Traffic that doesn't convert, content with no purchase path, and rankings that don't produce revenue are not wins — they are unfinished work at best and wasted effort at worst. Before building or optimizing anything, answer: **how does this convert traffic to sales?** If it can't, it's a waste of time.

This reorders how every agent prioritizes:

- **Commercial pages first, but do not multiply them.** Collections and PDPs convert; informational blog posts mostly don't. **A collection exists only where a category holds 2 or more distinct products — single-product categories are PDP-only, and a collection is never created to chase a keyword.** Chasing rankings with new collections produced 62 live collections for 9 products, which split ranking signal and earned 51 clicks on 93,785 impressions in 90 days. Optimize the pages that exist before creating another.
- **Every page that earns traffic needs a conversion path** — a prominent above-the-fold link/CTA to the relevant collection or PDP, plus a working buy-box. A post with traffic and no buy path is a bug to fix, not a success.
- **Measure in dollars, not clicks.** `agents/seo-impact` attributes Shopify revenue to pages/clusters. A cluster with high clicks and $0 revenue (e.g. toothpaste ≈268 clicks / $0) is a top priority to fix or stop investing in — not a ranking to celebrate.
- **CTR and conversion are first-class.** Impressions without clicks (low CTR) and clicks without purchases (no conversion) are the two revenue leaks. Closing them beats chasing new keywords.

When an agent has the data to make a revenue-improving decision, it makes it and applies it (see Autonomy Principle below).

## Brand Context

| Brand | Products | Status |
|---|---|---|
| Real Skin Care | Coconut-oil deodorants, lotions, body cream, toothpaste, lip balm, hand soap, hair products | Brand Registered on Amazon |
| Culina | Cast iron / Blackstone griddle cleaning soap, restoring scrub, conditioning oil, kits | Acquired separately. Brand Registry pending. Previous owner is liquidating remaining FBA stock through ~early-May 2026 — buy-box anomalies on Culina ASINs are transitional, not a problem to fix. |

Both brands ship from the same Amazon seller account. Until Culina Brand Registry approves, Amazon Brand Analytics + Search Query Performance reports return blended (BA) or zero (SQP) data for Culina. Classify ASINs by keyword in the product title:

- contains `culina` or `cast iron` → **Culina**
- everything else (including `REAL` sub-brand) → **RSC**

## Development Rules (non-negotiable)

1. **Always work on a branch** — never commit directly to `main`. Use `feature/<name>` or `fix/<name>`.
2. **Always merge via pull request.** Open with `gh pr create`. No fast-forward, no squash-merge locally, no pushing to `main` from the feature branch.
3. **Test locally before pushing to the server.**
4. **Test a fix on one post before bulk-applying.** End-to-end (edit → upload → check live site) before writing batch scripts.
5. **These rules apply even for one-line fixes.**
6. **Never work in the main checkout — take a worktree.** Multiple sessions run against this repo at once, and two sessions sharing `/Users/seanfillmore/Code/Claude` fight over HEAD. This has cost real work twice: 2026-07-24 a session switched the shared working dir onto its branch mid-task and a commit landed on the wrong branch; 2026-07-27 two sessions committed to `feature/marketing-tactic-lifecycle` within the same hour, one of them opening a PR whose body was stale inside the hour.

```bash
scripts/new-worktree.sh <name> [branch-name]     # branches from origin/main, symlinks .env + node_modules
cd .claude/worktrees/<name>                       # commit and open the PR from here
git worktree remove .claude/worktrees/<name>      # after the PR merges
```

Branch from `origin/main`, never from wherever the main checkout is sitting — it is 40+ commits stale as often as not. Before committing anywhere, re-check `git branch --show-current`; never assume the branch you left is the branch you are on.

## Autonomy Principle

Agents that have the data to make a decision should make it and apply the change. Surface cases to the user only when genuinely ambiguous (cannibalization-resolver auto-applies HIGH confidence, queues MEDIUM/LOW for review; meta-ab-tracker auto-reverts losing variants). When designing a new agent, default to apply-not-dry-run for production behavior. See `~/.claude/projects/-Users-seanfillmore-Code-Claude/memory/feedback_autonomous_by_default.md` for the full rule.

## Architecture (non-obvious patterns)

**Single-file daily orchestration.** `scheduler.js` at the project root runs every day at 8 AM PT (15 UTC) on the production server via cron. It dispatches the daily pipeline, plus weekly jobs on Sundays and monthly jobs on the 1st. Read `scheduler.js` for the actual order.

**Deferred-notification digest.** Agents call `notify({...})` from `lib/notify.js`. **Every** notification appends to `data/reports/daily-summary/YYYY-MM-DD.jsonl` rather than emailing — `status: 'error'` only changes how the digest renders the row, it does not escalate. The single exception is `immediate: true`, which emails at call time; use it sparingly. The `daily-summary` agent reads the JSONL at 5 AM PT and sends one consolidated HTML digest via Resend. `NOTIFY_DEFERRED=1` is set by `scheduler.js` and by the giveaway cron entry but is **read nowhere** — deferral is unconditional and the variable is vestigial. This paragraph previously claimed errors bypassed deferral; they never have, so anything that must not wait for the 5 AM digest needs `immediate: true`.

**Content pipeline order:** `content-strategist` → `content-researcher` → `blog-post-writer` → `image-generator` → `answer-first-rewriter` → `featured-product-injector` → `schema-injector` → `editor` → `publisher`. Orchestrated by `calendar-runner` (reads `data/calendar.json`).

**Cannibalization auto-publish flow:** the `cannibalization-resolver` runs Sundays. CONSOLIDATE actions merge content via Claude → run editor → if editor finds no blockers (no `meta.needs_rebuild` set), the merge auto-publishes; if blockers, save as Shopify draft and surface in the report's "Drafts needing review" section. Redirects always created. `--publish-pending-drafts [--apply]` clears any backlog of drafts the agent created on prior runs.

**Closed-loop agent feedback.** Agents write reports to `data/reports/<agent>/`. `insight-aggregator` reads them, extracts recurring patterns, writes per-agent guidance to `data/context/feedback.md` under `## <agent-name>` headings. Each agent reads its section at startup and incorporates it into its LLM prompt. The `editor` also reads `data/context/writer-standing-rules.md` so what the editor flags becomes what the writer avoids.

**Dashboard.** `agents/dashboard/` is a Node app (PM2 process `seo-dashboard`, port 4242). Browser HTML/CSS/JS lives in `agents/dashboard/public/` — edited directly, no template literal escaping rules apply.

**Shopify API version — one constant, because a stale pin does not fail, it lies.** `lib/shopify-api-version.js` holds `API_VERSION` for the whole fleet (currently **`2026-07`**, the current stable quarterly). Everything that builds an admin URL imports it: `lib/shopify.js`, `agents/technical-seo`, `agents/apply-optimization`, `agents/meta-ab-tracker`, and the ~20 standalone `scripts/*` that hand-roll their own `fetch`. It is deliberately a **separate module from `lib/shopify.js`** — that file reads `.env` and throws at import time without OAuth credentials, so scripts authenticating differently could not reach the constant through it; this one reads nothing and has no side effects. Requesting a **retired** version does not error: Shopify returns HTTP 200 and silently serves the oldest supported version instead, disclosing the substitution only in the `X-Shopify-API-Version` response header. That is how the fleet spent three quarterly releases believing it was on `2025-01` while actually running `2025-10` — nobody chose that, and nothing said so. Only a version that does not exist *yet* fails loudly (404). So every response through `lib/shopify.js` runs `checkServedApiVersion`, which **warns to stderr and fires one deferred `notify()` per process, and never throws**: fall-forward hands back a newer *supported* version, so the run is degraded rather than broken, and hard-failing would take the unattended 8 AM pipeline — and the collectors that write the only copy of snapshot history — down over a condition the response survived. **Do not pin the next quarter early.** The version one quarter ahead is the release candidate, published *three* months before it stabilises, and it can change without notice — which is the same bug wearing a newer number.

**REST is legacy, but not on a clock.** The Admin REST API has been legacy since 2024-10-01 and is in maintenance mode; the hard rule ("must use GraphQL") binds **new public apps only**, and this is a custom app, so every REST endpoint the fleet uses still works on `2026-07`. Two carry an explicit deprecation notice and return `X-Shopify-API-Deprecated-Reason` on a live 200 — **`/products*`** (deprecated as of REST 2024-04) and **`/products/{id}/images/*`** (2025-01). Those are the endpoints to migrate to GraphQL first if REST ever gets a removal date. `productByHandle` is likewise deprecated-not-removed in `2026-07`; its replacement is **`productByIdentifier`**, not `product(handle:)`.

**Ad creative pipeline — two agents, two jobs.** `agents/ad-studio/` produces the **ad base**: a text-free, icon-free PLATE with the product rendered in-scene at ad scale and position, plus a safe-zone guide SVG and the claim-gated copy as text. The operator sets type and icons onto it in Photoshop. A throwaway **comp** is derived from each Meta plate so a human can see the intent — it is a picture of what the ad could be, never the ad. `agents/creative-packager/` produces **placement crops from an already-approved master**; that job is unchanged.

**Why plate-first.** Ad Studio used to bake finished ads and gate them hard on text. Chasing 100% text accuracy from an image model was a losing game — most expensively on 9:16, where Meta draws UI over the top ~14% and bottom ~20%, every layoutBrief runs a headline to the frame edge, and the model fills the frame whatever the prompt says (measured: 6 of 6 attempts failed at 3 paid attempts each). Moving type to Photoshop dissolved that: a plate has no copy to misplace, so 9:16 renders first-attempt and the safe zone ships as `guide-<ratio>.svg` instead of as three failed renders.

**Where strictness lives now.** **TWO copy gates, different questions, neither substituting for the other.** `claims.js` asks *can this be traced to a source we hold?* — an unsourced factual claim stops the run before anything renders, no override. It holds four sources — `pdp`, `catalog`, `brandKit`, `reviews` — plus a fifth, `giveaway`, that exists ONLY while a giveaway's Entry Period is open. That fifth one is the plain text of the **published** Official Rules and nothing else: `lib/giveaway-claim-source.js` uses `config/giveaway.json` purely to cross-check that the entry-open and entry-close calendar dates literally appear in the rules, and **throws rather than picking one** when they disagree. Folding the config's dates into the searchable body instead would let a writer cite a deadline the published rules contradict *as sourced evidence* — the claim gate defeated through its own front door. Adding a source is never relaxing matching: a giveaway claim absent from the rules is rejected exactly as before, and outside the Entry Period `sourceId: "giveaway"` fails as an unknown source. `health-claims.js` asks *is a COSMETIC allowed to say it at all?* and is equally hard: no disease name, no drug or prescription reference, no heal/cure/treat/prevent, no clinical or FDA backing, in any zone of any format. A **verbatim customer review passes the first and can still fail the second** — that is exactly what happened on 2026-08-16, when a correctly-sourced Judge.me quote ("tried prescription strength lotions, steroids... to no avail. Until Real Skin Care") sailed through sourcing. "It came from a review" is not a defence: the FTC holds an advertiser responsible for claims an endorsement *conveys*, and the FDA treats marketing material including testimonials as evidence of intended use, which is what turns a cosmetic into an unapproved drug. Reviews carrying such language are also withheld from the copy writer up front (`selectQuotableReviews`), because detection without prevention burns retries. **The same withholding now covers `data/context/personas.json`**, which is copy input read by four agents: the generated 2026-07-27 file named steroids, prescriptions and eczema in every copy-facing field of persona `p1` — the top-ranked one, so the *default* angle — which meant the default creative brief was seeded with the language this gate exists to reject. `lib/voice-of-customer.js`'s `sanitizePersonas` removes a violating angle (or the whole persona, when its own name or summary is the violation) at BOTH ends: when `agents/voice-of-customer` writes the file, and again when `creative-packager`, `ad-studio` and `ad-brief` read it, because the file is regenerated monthly and a bad month must not reach a copy prompt. It removes, never rewrites — an LLM rewrite would be the agent inventing research — and `source_quotes` is never screened, because it is the evidence record and no consumer feeds it to a writer. **Product fidelity** (`verify.js`) is still a hard fail: the reference photographs go to the verifier and a bottle that contradicts them on shape, cap, label element order, printed graphics or base colour is rejected, because Photoshop cannot fix a wrong product. Photographic styling — lighting, gloss, shadow, crop — is explicitly never a mismatch; relaxing that rejects good renders at $0.13 a retry. **Stray text on a plate** is a hard fail too: you cannot remove pixels. Everything about the comp is advisory, including its 1-5 quality score, which feeds `run.json`'s `ranking[]` and the rolling baseline in `data/reports/ad-studio/scores.jsonl`. `ok: true` means checked, not good.

**Second generative passes: what the rule actually protects.** The rule was "never feed a render back in", from a probe where a second pass shifted ingredient photos one row against their captions — jojoba captioned as coconut oil. The real hazard is **image/label pairing drift on an artifact that ships**. The comp pass is allowed because it violates neither half: the plate it derives from is already verified and is not modified, the comp is throwaway, and a plate carries no icons or captions for anything to drift against. Do not read this as permission to second-pass a shipping artifact. Note the consequence: **the image/label pairing check is now dormant** — nothing renders paired imagery any more. It is intact and tested, and fires again the moment a format does.

**`--formats` is required.** The default run is one format, one variation, all three Meta placements. Demand Gen plates are opt-in (`--targets all`). **`--flexible` builds one Meta 3-2-2 flexible ad** — 3 plates from 3 distinct formats at ONE ratio, plus 2 primary texts and 2 headlines from a second gated copy call — because twelve combinations sharing a single learning pool is what lets a $30/day campaign exit the learning phase at all (three ad sets ≈ 28 entries/week each, under Meta's ~50; consolidated ≈ 84). It refuses any argument set that would silently yield a different structure, and it writes a manifest only — **nothing in this repo creates, edits or launches anything on Meta.** The fleet's image-generation model IDs in `config/creative-models.js` are the **GA** releases, `gemini-3-pro-image` and `gemini-3.1-flash-image` — verified 2026-08-14. Do not reintroduce the `-preview` suffixes. `data/creatives/` has a **hard disk budget** (`lib/creatives-budget.js`), enforced automatically at the end of every Ad Studio run — "purge as we go", because a budget that waits for someone to remember a script is not a budget and this project has already lost four days of cron to a full disk. The ceiling is 10 GiB locally and **4 GiB on the production server**, set as `CREATIVES_BUDGET_BYTES` because that box has ~9.9 GB free of 24 GB and a ceiling above the free disk can never fire before the disk fills. It is resolved from `process.env` first and then from `.env` (`configuredBudgetBytes()`), so the paths that run unattended — the weekly cron sweep, which never sources `.env`, and a hand-run agent, whose `loadEnv()` deliberately keeps `.env` out of `process.env` — get the server's ceiling rather than the local default. Purge is tiered, cheapest loss first, and stops the moment the total fits: (1) rejected Ad Studio frames past a 7-day grace, (2) Ad Studio images from runs older than 14 days, (3) Creatives-tab session images idle 30+ days. **JSON is never deleted at any tier** — a run stays explicable after its pixels are gone — and the run just written is never eligible. When nothing further can be freed it says so rather than reporting success. `npm run creatives-budget -- --apply` runs the same sweep by hand (dry by default) and is scheduled on the server, because the Creatives tab fills the same directory without ever calling the agent. The older age-only `scripts/prune-ad-studio.mjs` still exists for deep pruning past 90 days. See `agents/ad-studio/README.md`.

## Data Layout Conventions

- `agents/<name>/index.js` — one agent per directory. Read the header docstring for usage.
- `lib/<name>.js` — flat namespace of shared libraries (Shopify, GSC, GA4, notify, posts helpers, retry, etc.). Subdir `lib/amazon/` for the SP-API client.
- `data/posts/<slug>/` — per-post intermediates: `content.html`, `meta.json` (Shopify article IDs, target keyword, `needs_rebuild` flag), `editor-report.md`, `answer-first.md`, `internal-links.md`, `backups/`, `content-refreshed.html` (queued).
- `data/snapshots/{gsc,ga4,clarity,shopify,google-ads}/YYYY-MM-DD.json` — daily metric snapshots. `data/snapshots/bing/` is the one exception to "one file, one day": Bing's API takes no date parameter and returns its whole ~6-month window on every call, so each file is a full history stamped with the day it was **collected**, written **weekly** from the Sunday block of `scheduler.js` (Bing's own data refreshes weekly — `GetQueryStats` returns 26 dates across 177 days, so a daily job would write six duplicate files). Its `coverage` block records that query/page rows are a weekly sample capped at 100 rows per date; those totals are deliberately far below the site totals and must never be reconciled against them. Bing itself is ~28 clicks/month and $0 revenue — the feed is kept because it is the only query-level view of the index **DuckDuckGo** serves from, and DDG converts new customers at 2.88% vs Google organic's 0.60%. The foundation for any outcome-attribution work. **Gitignored — written by cron on the server, never synced to your checkout.** A local checkout will look empty or months out of date; that is normal and is *not* evidence the collector is broken. To judge feed health, check the server (`ssh root@137.184.119.230 'ls -t ~/seo-claude/data/snapshots/<feed> | head'`), never the local tree. A zero-order day in `shopify/` is usually a real zero-order day — the store averages ~0.5 orders/day.
- `data/reports/<agent>/...` — per-agent run output. `latest.json` for dashboard consumption when present.
- `data/context/feedback.md` and `data/context/writer-standing-rules.md` — agent guidance (see closed-loop feedback above).
- `data/context/voice-of-customer.md`, `data/context/personas.md`, `data/context/personas.json` — voice-of-customer research for the skin cluster, written monthly by `agents/voice-of-customer`. Headings are stable so the files stay greppable; every entry carries an evidence count and a verbatim quote. `personas.json` is rank-ordered — `creative-packager` reads `personas[0].angles[0]` as its default angle instead of the competitor reference ad's `messagingAngle`, where "first" means the first entry that survives the health-claim withholding described above (order is never rearranged, only filtered).
- `.claude/skills/marketing-*/SKILL.md` — marketing tactics mined from video by `agents/marketing-learner`, each with provenance and a `## Falsified` section for tactics tested here that failed. **This is the source of truth.** `creative-packager` builds its ad-copy tactic menu and "Do not propose" blocklist by generating a projection from these files in memory at read time (`renderContextMirror(scanSkillInventory(...))`) — it does not read a committed copy. `data/context/marketing-tactics.md` is written locally for human browsing and is **gitignored**: committing a generated file made every pair of concurrent learner PRs conflict on it, and let git 3-way-merge it into content the generator would never emit.
- `data/keyword-index.json` — single source of truth for which queries optimizers should target. Built by `agents/keyword-index-builder` (dispatched daily, self-paces to biweekly via `built_at`), merging GSC commercial intent + Amazon BA + Amazon SQP into `by_validation_source`. **~2,215 keywords across 9 clusters as of 2026-08-10, read by 15 agents.** **Gitignored — built on the server.** A local copy is usually months stale; check the server, not your checkout.
- `config/{site,competitors,ingredients,specificity-flags,ai-citation-prompts}.json` — durable site/business config.
- `data/archive/` — product imagery that cannot be recovered from anywhere else (destroyed originals, replaced PDP frames, non-reproducible AI-generated frames). Committed on purpose; see its README before adding or removing.
- `assets/digital/<slug>/` — source for the bundle PDFs. **Building and publishing are two scripts:** `build-digital-assets.mjs` renders, `upload-digital-assets.mjs --apply` publishes with hand-versioned filenames (Shopify creates a suffixed duplicate rather than overwriting). Images are addressed `image=<filename>`, never by gallery index — positional refs silently re-pointed at a different picture whenever a PDP was reordered.
- **Locally-generated run output must be archived out of a worktree.** `lib/archive-run-output.js` copies a finished run to the same path under the MAIN checkout (resolved via git's common dir), because gitignored output inside a worktree is *untracked* and `git worktree remove --force` deletes it — that is how a set of Ad Studio sample plates was destroyed on 2026-08-15. Wired into `agents/ad-studio` and `agents/creative-packager`, the two agents that run manually and whose local copy is the only copy. **Do NOT archive server-authoritative directories** (`data/snapshots/`, `data/reports/giveaway/`, `data/keyword-index.json`): cron owns those on the production box, a local checkout is *expected* to be empty or stale, and copying one out of a worktree plants a stale file in the canonical path where somebody later reads it as current. The test is not "is it gitignored" but "would this data exist anywhere else if this directory vanished".
- `.env` — credentials (excluded from git). Never commit.

## Code Review Checklist — Blog Post Writer (`agents/blog-post-writer/index.js`)

These checks must throw (not warn) before saving the HTML:

1. **`stop_reason === 'max_tokens'`** — output was cut at the token limit; the post is incomplete. **Throw, do not save.** The file will be truncated mid-tag and produce broken links when published.
2. **Unclosed `href` attribute** — regex `/href="[^"]*$/` on the HTML. Output truncated mid-link. **Throw, do not save.** Shopify auto-closes the broken tag into a malformed URL (e.g. `https://domain.com/blogs/news/best`) that 404s.

Both must be fatal — truncated HTML on Shopify creates broken links that take a manual audit cycle to find.

## Product Imagery — two rules that have already cost real work

**Deleting a Shopify product image destroys the CDN file.** `DELETE /products/{id}/images/{id}.json` removes the underlying file, not just the product association — even for a `/files/` path. On 2026-08-12 three bundle photos were deleted from the foaming soap PDP and are unrecoverable (absent from the Files library, 404 on the CDN, no Wayback capture). **Download full-resolution to `data/archive/` before any destructive image call, and grep the repo first** — product images turn out to be embedded in live blog posts, Klaviyo flow scripts, and `assets/digital/image-map.json`. Prefer reordering or reattaching, which are reversible. A detached image can still return 200 for a while with its original `?v=` param; that is CDN lag, not survival.

**The theme scopes gallery images to variants two mutually exclusive ways.** In `sections/main-product.liquid`:

1. **Variant attachment** — set `hide_variants: true` on the template's `main` section. Attached media renders only for the selected variant; unattached media renders for all (this is how shared marketing frames work).
2. **alt-text `#` "gang" scoping** — images whose `alt` contains `#<token>`. **This path only runs when `hide_variants` is false.**

Before flipping `hide_variants` on any template, check whether that product's images carry `#` in their alt text. If they do it is already gang-scoped and the flag will break it. `scoped-gallery` and `bundle-landing` templates use the gang mechanism; the `landing-page-*` templates use variant attachment.

## Code Review Checklist — Technical SEO Agent (`agents/technical-seo/index.js`)

**Cloudflare `cdn-cgi/l/email-protection` false positives.** The crawler flags `https://www.realskincare.com/cdn-cgi/l/email-protection` as a 404 on every page that has the site footer email. This is Cloudflare's email obfuscation — a raw-HTML crawl sees a 404. **It is not a real broken link.**

Rules:
- Filter `cdn-cgi/l/email-protection` from broken-link counts and listings.
- Filter from `fix-links` processing — the URL lives in the theme template, not `body_html`, so it cannot be fixed by editing article content.
- If the filter removes all broken links for a page, skip that page.
- Add a note in the audit report explaining how many pages were filtered and why.

## Project Conventions

- All agents operate on a single configured Shopify site (config in `config/site.json`).
- When writing content, incorporate internal links informed by `data/sitemap-index.json`, `data/blog-index.json`, and `data/topical-map.json`.
- Keyword/SERP/metrics/backlink data comes live from DataForSEO via `lib/dataforseo.js` (CPC and other monetary values are in USD dollars).
- Amazon: separate apps in Solution Provider Portal for RSC sandbox, RSC production, Culina pending. SP-API requires Brand Registry for SQP/BA reports.
- Agents are composable — outputs of upstream agents (sitemap-index, blog-index, topical-map, keyword-index) are inputs to downstream agents.

## Server Deployment

**Node version:** pinned to **22 LTS** (`.nvmrc`, `engines` in `package.json`). The server runs 22.x and is the production truth; 25 is a non-LTS release and must not be what you validate against. Run `nvm use` in this repo before testing — a mismatch is not cosmetic. Node 25 locally vs 22 on the server hid a dead test for months: `AbortSignal.timeout()` uses an unref'd timer, so a stubbed-fetch test never settled on 22 and `node --test` reported it `cancelled`, which prints alongside `# fail 0` and reads like a pass. **When reading test output, check the cancelled count, not just fail.**

**Server:** `root@137.184.119.230` (DigitalOcean, Ubuntu)
**Project path:** `/root/seo-claude`
**Process manager:** PM2 — process name `seo-dashboard`
**Cron:** `crontab -l` on the server lists every job — it is the production truth and the source `scripts/setup-cron.sh` is meant to reproduce; the script is not currently a full mirror of everything live (see the script's own job list). Main scheduler entry runs at 15 UTC (8 AM PT). Daily-summary email runs at 13 UTC (5 AM PT). The **soap-giveaway jobs** (`DAILY_GIVEAWAY_RECONCILE`, `DAILY_GIVEAWAY_REPORT`, `GIVEAWAY_CLOSE_ENTRY_PERIOD`) are version-controlled in `scripts/setup-cron.sh` — re-running the script re-installs them from source instead of relying on a hand-edited live crontab. `GIVEAWAY_CLOSE_ENTRY_PERIOD` carries `TZ=America/Los_Angeles`: the box's system clock is UTC, and a cron line with no `TZ=` prefix runs on UTC no matter what a comment claims — that gap fired the entry-period close ~2 hours before entries actually closed in Pacific time, drafting the nurture flow while people were still entering and killing the `01-confirm` email's +2-entry rung for last-minute entrants. Fixed by hand on the server 2026-08-20; do not drop the `TZ=` prefix.
**SSH:** Key-based auth — no password from this machine.

### Deploy

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

### Snapshot backups

`data/snapshots/` is the only copy of GSC/Clarity history past those APIs' retention windows (~16 months for GSC, shorter for Clarity) — it cannot be re-fetched once gone.

- **Offsite (authoritative):** `scripts/backup-snapshots-offsite.sh` runs on the **server**, Sundays 17:00 UTC via cron → DigitalOcean Spaces `rsc-backups/snapshots/`, keeps 12 weekly archives. Credentials are `SPACES_*` in `.env`; rclone is configured purely via `RCLONE_CONFIG_*` env vars, so there is no `rclone.conf` holding a second copy of the secret. Verifies the uploaded object's byte size against local before reporting success, then prunes.
- **Local working copy:** `npm run sync-snapshots` (rsync server→local, ~78 MB, ~3s). Direction is hardcoded and `--delete` is deliberately omitted — local accumulates as a superset so a server-side loss can't propagate. A launchd job runs it daily at 09:00.
- **Restore:** download the archive from Spaces and `tar xzf` it over `data/snapshots/`. Verified working 2026-07-26.

### Status check

```bash
ssh root@137.184.119.230 'pm2 status && pm2 logs seo-dashboard --lines 20 --nostream'
```

### Workflow

1. Merge PR to `main` on GitHub
2. Run the deploy command
3. Verify dashboard is `online` in PM2 output

### Deploy hygiene — backfills run AFTER `git pull`, never before

The `data/` tree contains tracked files (e.g. `data/posts/<slug>/meta.json`) that get modified in-place by backfill scripts. If you `git stash push` before pulling, those uncommitted updates land in stash and get forgotten. Run any data backfill **after** the pull — scripts are idempotent so re-running on top of fresh code is safe.

If `git pull` fails because of a dirty working tree:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git stash push -m "pre-deploy <pr-id>" && git pull && git stash pop && pm2 restart seo-dashboard'
```

`git stash pop` is non-negotiable. If the merge can't reconcile, resolve manually. Never leave a stash dangling — `git stash list` should be empty (or near-empty) after a deploy.

**Never** `git stash --include-untracked` on the server — it destroys ALL untracked data files (queued performance items, draft posts, generated reports), not just conflicting ones. Delete specific files instead.
