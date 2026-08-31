# `data/posts/_orphaned/` — post directories taken out of circulation, never deleted

Written only by `scripts/rehome-orphan-refreshes.mjs` (dry by default). Every
entry has a `<slug>.orphan.json` sidecar recording when it was archived, why,
the target it resolved to, and **the exact `mv` that restores it**.

## Why these exist

The `content-refresher` slug mismatch fixed in PR #679 wrote its output to
`data/posts/<shopify handle>/` when the post already lived under a shorter local
slug — creating a SECOND directory holding a paid `content-refreshed.html`, an
editor report, and nothing else. 34 such directories existed on production, 31
of them with a refresh.

Exactly one carried a `meta.json`, and that one actively broke things:
`resolvePostSlug('best-soap-for-tattoos-what-to-use-for-safe-healing')` matched
it at step 1 (exact dir) and **shadowed** `data/posts/best-soap-for-tattoos`,
the real directory for that article. The other 33 were inert.

## Why it is invisible to the pipeline

`listAllSlugs()` requires a `meta.json` in the directory it scans and **does not
recurse**, so nothing here can be re-read, re-published or re-counted as
coverage. That is the same property that keeps `data/briefs/_dropped/` invisible
to every reader of `data/briefs/`, and it is pinned by
`tests/lib/briefs-dir-readers.test.js` for that sibling.

## Why it is TRACKED IN GIT and not gitignored

The same reason `data/briefs/_dropped/` is tracked: **an untracked archive is
the condition that made the 2026-08-19 brief loss unrecoverable.** Three
paid-for briefs were destroyed by `unlinkSync` and were absent from the server,
from both checkouts and from git — they had never been committed, so version
control was no safety net for them.

These 34 directories are the output of paid `content-refresher` runs. Until
2026-08-31 they existed **only on the production box**, one `rm -rf` or one
rebuilt server away from being gone. 3.2 MB is not a reason to keep that risk.

## Why a re-homed refresh is never named `content-refreshed.html`

`agents/refresh-runner` moves `content-refreshed.html` over `content.html` and
PUBLISHES it once the editor gate passes. These refreshes are one to four months
old and were generated against article bodies that have since changed — several
of those mirrors have since been reconciled against live — so writing one under
the consumed name would queue stale content for publication over a live ranking
page. They are written as `orphaned-refresh-<date>.html` instead, which every
reader ignores because they all use the exact filename via `getRefreshedPath`.

## Restoring

Each sidecar carries its own command. In general:

```bash
mv data/posts/_orphaned/<slug> data/posts/<slug>
```

Nothing prunes this directory, deliberately — the same reasoning that keeps
`data/briefs/_dropped/` un-swept: a timer that deleted archived work would
reintroduce the exact bug the archive exists to prevent, on a delay.
