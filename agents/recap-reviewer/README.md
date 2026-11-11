# Recap Reviewer

Runs at 11:05 UTC, before the 13:00 recap, and resolves what the recap would
otherwise ask Sean to act on. Spec: `docs/superpowers/specs/2026-11-11-recap-reviewer-design.md`.

```
node agents/recap-reviewer/index.js           # dry run: routes and report, changes nothing
node agents/recap-reviewer/index.js --apply   # cron
```

## What it reads

`collectDigestInputs()` from `agents/daily-summary/index.js`: the same error
rows (after recovered failures are dropped), health rows, `needs_decision[]`
rows (stamped with the `source` of the report they came from), post-performance
flops and hard-blocked drafts the recap reads. `lib/recap-review.js` turns them
into deduplicated items with one route each.

## What it does, in order

| Unit | Route | Action |
|---|---|---|
| A | heartbeat | `scripts/check-scheduler-heartbeat.mjs --json`. Stuck: SIGTERM the stale scheduler only when its last log line is over 2 h old. Orphaned Chrome: SIGKILL it. Died: recorded, the next run starts fresh. |
| A | collector-rerun / rerun | Allowlisted jobs only (`lib/recap-jobs.js`), the crontab command (else `node <source>`), 20 min timeout, one run per command. Verified by a later success row from the same reporter, or by the health check for a feed. |
| B | refresh | `node agents/refresh-runner/index.js <slug>` |
| B | regenerate | `decisions.js`: one retry, then a close-out. Never deletes, never publishes. |
| B | remediate-draft | `content-remediator --slug` once; still blocked on a later morning: move the post dir to `data/posts/_orphaned/` with a sidecar and the calendar item to `data/calendar/_dropped/`. |
| B | remove | `removal.js`: up to 5 LOW_DEMAND posts, backup, by-number redirect pick, HEAD 200, `killPost`, verify the 301, then `fix-redirect-links --apply` once. |
| C | fix-session | `fix.js`: one session per run (the item with the most rows, under 3 attempts), ship only on `fixed`. |
| D | growth | `lib/growth-recs.js`, after Unit C has finished. |

Nothing starts at or after 14:30 UTC; unstarted work is `deferred to tomorrow`.

## Output

- `data/reports/recap-reviewer/latest.json` — `{ generated_at, date, apply, resolved, unresolved, onlyYou, counts, growth, fixSession, skipped, heartbeat?, crashed? }`. Written on dry runs too, marked `apply: false`.
- `data/reports/recap-reviewer/done.json` — written only by `--apply`; the recap treats a review as real only when it exists for today.
- `data/reports/recap-reviewer/state.json` — `lib/recap-reviewer-state.js`.
- `data/backups/removed-posts/<slug>-<date>.json` — every removed article.

All gitignored. One deferred `notify()` per apply run; a crash notifies with
`immediate: true` and still writes `latest.json` with `crashed: true`.
