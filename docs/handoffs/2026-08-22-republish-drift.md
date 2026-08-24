# Republish drift fix — best-boka-alternatives-2025

Date: 2026-08-22
Branch: chore/republish-drift (merged as PR #606, commit `dddd0e74`)

> **Provenance.** This was written as an untracked file inside the
> `chore/republish-drift` worktree and committed nowhere. It was the only copy
> anywhere — not in git, not in the main checkout — and removing that worktree
> would have destroyed it, which is the failure mode CLAUDE.md records for the
> Ad Studio plates lost on 2026-08-15. Rescued verbatim on 2026-08-24; only this
> note and the branch line above were added.
>
> It is the investigation record behind the commit that introduced
> `republished_at` / `republish_reason` — the two fields PR #646 could not find a
> code writer for, because the stamp was hand-written in `dddd0e74` and there is
> no writer. See `lib/post-meta-reconcile.js`'s `FIELD_OWNERS`.

## Article ID correction (found before doing anything else)

The task brief named article id `562322047146`. Fetching that id live returned
a **different** article entirely: "SLS Free Toothpaste: The Gentle Switch
Worth Making". The correct id — verified against `meta.json`, the live
handle (`best-boka-alternatives-2025`), and the live title ("Boka Toothpaste
Alternative With Cleaner Ingredients") — is **562322571434**. All work below
used the verified id, not the one in the brief.

## Pre-checks (all passed — proceeded to republish)

1. **No live post already covers this topic.**
   Scanned all 218 articles on blog 48998449187 (`published_status: any`) for
   "boka" in title or handle. Exactly one match: this article itself. No
   decoy under a different handle.

2. **No redirect points away from this handle.**
   Scanned all 229 Shopify redirects. None target
   `/blogs/news/best-boka-alternatives-2025`. (One unrelated redirect exists
   from an old `/collections/boka-toothpaste-alternative` path to the
   toothpaste PDP — a different, retired collection path, not this article.)

3. **No kill or rebuild marker.**
   `data/posts/best-boka-alternatives-2025/meta.json` carries no
   `needs_rebuild` flag and no unpublish reason. Cross-checked
   `data/reports/technical-seo/technical-seo-delta-report.md`,
   `data/reports/meta-optimizer/meta-optimizer-report.md`, and
   `data/reports/meta-ab/meta-ab-tracker.json` — all three reference this
   URL as a live, actively-optimized page (broken-link crawl target, applied
   meta title A/B test). None suggest a deliberate kill.

4. **Content is intact and publishable.**
   Live `body_html` (9,293 chars) ends on a complete, properly closed
   paragraph ("...the most stripped-down natural toothpaste available.</p>").
   All 18 `href="` attributes have matching closing quotes; the
   `/href="[^"]*$/` truncation regex does not match. Not truncated.

## Before-state

| field | value |
|---|---|
| handle | best-boka-alternatives-2025 |
| article id | 562322571434 |
| blog id | 48998449187 |
| published_at (before) | null |
| published_at (after) | 2026-08-22T22:07:54-06:00 |

Script: `scripts/republish-boka-alternatives-2026-08-22.mjs` (dry-run by
default, `--apply` to mutate). Ran dry-run first (handle match confirmed),
then `--apply`.

## Live verification

```
curl -s -o /tmp/boka-live.html -w "HTTP_STATUS:%{http_code}\n" \
  "https://www.realskincare.com/blogs/news/best-boka-alternatives-2025"
HTTP_STATUS:200
```

Page body contains "Boka Toothpaste Alternative With Cleaner Ingredients" —
confirmed serving the correct article, not a redirect or 404 page.

## meta.json update

Added `shopify_status: "published"`, `republished_at`, and
`republish_reason` fields. `git status --short data/` shows only this one
file changed.

## /llms.txt regeneration (server)

Ran `node agents/llms-txt-generator/index.js --dry-run` on the server first —
131 blog posts qualified (>=100 GSC impressions/90d + published), and
`best-boka-alternatives-2025` appeared in the generated file even before
deploy. Ran without `--dry-run` to deploy: wrote `templates/llms.txt.liquid`
to the live theme (id 147480051882), backed up the prior template, no
legacy page/redirect to clean up.

Live verification:
```
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "https://www.realskincare.com/llms.txt"
HTTP_STATUS:200
```
Contains: `- [Boka Toothpaste Alternative With Cleaner Ingredients](https://www.realskincare.com/blogs/news/best-boka-alternatives-2025): ...`

Confirmed: the agent picked up the newly-republished post automatically, no
manual override needed.

## Tests

`npm test` (Node 22.23.1, confirmed via `.nvmrc`/`nvm use`):

```
# tests 2323
# suites 0
# pass 2323
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Clean baseline — no regressions from this change (only `meta.json` and one
new one-shot script touched).

## Scope discipline

Only `best-boka-alternatives-2025` (id 562322571434) was touched. No other
article was read, updated, or deleted. `deleteArticle` was never called.
