# SEO Claude Team

A fleet of AI agents that grow the SEO performance of two brands sold under one Shopify storefront (`realskincare.com`) and one Amazon seller account: **Real Skin Care** (natural deodorants, body care, oral care, lip balm) and **Culina** (cast iron / Blackstone griddle care). The Shopify website is the primary revenue channel. Amazon is complementary and validates commercial intent for keyword/SEO decisions.

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

## Autonomy Principle

Agents that have the data to make a decision should make it and apply the change. Surface cases to the user only when genuinely ambiguous (cannibalization-resolver auto-applies HIGH confidence, queues MEDIUM/LOW for review; meta-ab-tracker auto-reverts losing variants). When designing a new agent, default to apply-not-dry-run for production behavior. See `~/.claude/projects/-Users-seanfillmore-Code-Claude/memory/feedback_autonomous_by_default.md` for the full rule.

## Architecture (non-obvious patterns)

**Single-file daily orchestration.** `scheduler.js` at the project root runs every day at 8 AM PT (15 UTC) on the production server via cron. It dispatches the daily pipeline, plus weekly jobs on Sundays and monthly jobs on the 1st. Read `scheduler.js` for the actual order.

**Deferred-notification digest.** Agents call `notify({...})` from `lib/notify.js`. With `NOTIFY_DEFERRED=1` set (scheduler.js sets this), non-error notifications append to `data/reports/daily-summary/YYYY-MM-DD.jsonl` instead of emailing immediately. The `daily-summary` agent reads the JSONL at 5 AM PT and sends one consolidated HTML digest via Resend. Errors bypass deferral and email immediately.

**Content pipeline order:** `content-strategist` → `content-researcher` → `blog-post-writer` → `image-generator` → `answer-first-rewriter` → `featured-product-injector` → `schema-injector` → `editor` → `publisher`. Orchestrated by `calendar-runner` (reads `data/calendar.json`).

**Cannibalization auto-publish flow:** the `cannibalization-resolver` runs Sundays. CONSOLIDATE actions merge content via Claude → run editor → if editor finds no blockers (no `meta.needs_rebuild` set), the merge auto-publishes; if blockers, save as Shopify draft and surface in the report's "Drafts needing review" section. Redirects always created. `--publish-pending-drafts [--apply]` clears any backlog of drafts the agent created on prior runs.

**Closed-loop agent feedback.** Agents write reports to `data/reports/<agent>/`. `insight-aggregator` reads them, extracts recurring patterns, writes per-agent guidance to `data/context/feedback.md` under `## <agent-name>` headings. Each agent reads its section at startup and incorporates it into its LLM prompt. The `editor` also reads `data/context/writer-standing-rules.md` so what the editor flags becomes what the writer avoids.

**Dashboard.** `agents/dashboard/` is a Node app (PM2 process `seo-dashboard`, port 4242). Browser HTML/CSS/JS lives in `agents/dashboard/public/` — edited directly, no template literal escaping rules apply.

## Data Layout Conventions

- `agents/<name>/index.js` — one agent per directory. Read the header docstring for usage.
- `lib/<name>.js` — flat namespace of shared libraries (Shopify, GSC, GA4, notify, posts helpers, retry, etc.). Subdir `lib/amazon/` for the SP-API client.
- `data/posts/<slug>/` — per-post intermediates: `content.html`, `meta.json` (Shopify article IDs, target keyword, `needs_rebuild` flag), `editor-report.md`, `answer-first.md`, `internal-links.md`, `backups/`, `content-refreshed.html` (queued).
- `data/snapshots/{gsc,ga4,clarity,shopify,google-ads}/YYYY-MM-DD.json` — daily metric snapshots. The foundation for any outcome-attribution work.
- `data/reports/<agent>/...` — per-agent run output. `latest.json` for dashboard consumption when present.
- `data/context/feedback.md` and `data/context/writer-standing-rules.md` — agent guidance (see closed-loop feedback above).
- `data/keyword-index.json` — intended single source of truth for which queries optimizers should target. **Currently anemic (~30 keywords) and not yet consumed by most optimizer agents — extending it to merge GSC commercial intent + Amazon BA + Amazon SQP and wiring optimizers to read from it is the next architectural priority.**
- `config/{site,competitors,ingredients,specificity-flags,ai-citation-prompts}.json` — durable site/business config.
- `.env` — credentials (excluded from git). Never commit.

## Code Review Checklist — Blog Post Writer (`agents/blog-post-writer/index.js`)

These checks must throw (not warn) before saving the HTML:

1. **`stop_reason === 'max_tokens'`** — output was cut at the token limit; the post is incomplete. **Throw, do not save.** The file will be truncated mid-tag and produce broken links when published.
2. **Unclosed `href` attribute** — regex `/href="[^"]*$/` on the HTML. Output truncated mid-link. **Throw, do not save.** Shopify auto-closes the broken tag into a malformed URL (e.g. `https://domain.com/blogs/news/best`) that 404s.

Both must be fatal — truncated HTML on Shopify creates broken links that take a manual audit cycle to find.

## Code Review Checklist — Technical SEO Agent (`agents/technical-seo/index.js`)

**Cloudflare `cdn-cgi/l/email-protection` false positives.** Ahrefs flags `https://www.realskincare.com/cdn-cgi/l/email-protection` as a 404 on every page that has the site footer email. This is Cloudflare's email obfuscation — Ahrefs crawls the raw HTML and sees a 404. **It is not a real broken link.**

Rules:
- Filter `cdn-cgi/l/email-protection` from broken-link counts and listings.
- Filter from `fix-links` processing — the URL lives in the theme template, not `body_html`, so it cannot be fixed by editing article content.
- If the filter removes all broken links for a page, skip that page.
- Add a note in the audit report explaining how many pages were filtered and why.

## Project Conventions

- All agents operate on a single configured Shopify site (config in `config/site.json`).
- When writing content, incorporate internal links informed by `data/sitemap-index.json`, `data/blog-index.json`, and `data/topical-map.json`.
- Ahrefs monetary values come back in USD cents — divide by 100 before displaying.
- Amazon: separate apps in Solution Provider Portal for RSC sandbox, RSC production, Culina pending. SP-API requires Brand Registry for SQP/BA reports.
- Agents are composable — outputs of upstream agents (sitemap-index, blog-index, topical-map, keyword-index) are inputs to downstream agents.

## Server Deployment

**Server:** `root@137.184.119.230` (DigitalOcean, Ubuntu)
**Project path:** `/root/seo-claude`
**Process manager:** PM2 — process name `seo-dashboard`
**Cron:** `crontab -l` on the server lists every job. Main scheduler entry runs at 15 UTC (8 AM PT). Daily-summary email runs at 13 UTC (5 AM PT).
**SSH:** Key-based auth — no password from this machine.

### Deploy

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

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
