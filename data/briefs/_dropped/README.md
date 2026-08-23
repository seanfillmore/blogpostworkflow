# Dropped content briefs

Briefs in here were taken out of circulation by `scripts/triage-orphan-briefs.mjs`.
**Nothing here has been deleted.** Each one was moved, with a record of why.

This directory exists because dropping a brief used to be permanent. Between
2026-08-19 and 2026-08-23 a wrong `soap` cluster verdict (a taxonomy bug, fixed
in PR #624) sent `--drop-non-earning --apply` through `unlinkSync`, and three
paid-for briefs — `vegan-soap`, `oatmeal-soap` and `coconut-oil-soap-benefits` —
were destroyed with no backup, no report and no digest row. They are gone.

## Layout

    <slug>.json           the brief, byte for byte as it was
    <slug>.drop.json      why it went, when, on what evidence, and by which run
    log.jsonl             append-only history of every drop and every restore

A slug dropped more than once becomes `<slug>--2.json`, `<slug>--3.json`, … so an
earlier drop is never overwritten.

## Restoring

    node scripts/triage-orphan-briefs.mjs --list-dropped        # what is in here
    node scripts/triage-orphan-briefs.mjs --restore <slug>      # newest drop of one brief
    node scripts/triage-orphan-briefs.mjs --restore --all       # everything in here

Restore puts the file back in `data/briefs/` and leaves the `.drop.json` record
here as the audit trail. It refuses to overwrite a live `data/briefs/<slug>.json`
unless you pass `--force`.

## Nothing sweeps this directory

A brief is about 25 KB of JSON. The whole orphan backlog that started this was
1.8 MB, and ten thousand drops would be ~250 MB against the production box's
~9.9 GB free. The disk incident this project actually suffered was GB-scale
Amazon dumps. A retention timer here would reintroduce the bug this directory
exists to prevent, just on a delay — so there isn't one. Every apply run
measures this directory and says so in the 5 AM digest if it ever passes 256 MB.

## This is not a live brief directory

Every reader of `data/briefs/` does a non-recursive `readdirSync` filtered on
`.endsWith('.json')`, so `_dropped` — a directory, no `.json` suffix — is
invisible to all of them, and a dropped brief cannot be re-read, re-briefed or
re-counted as coverage. `tests/lib/briefs-dir-readers.test.js` pins that
invariant so a future reader cannot quietly drop the filter.
