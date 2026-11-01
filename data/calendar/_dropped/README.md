# Dropped calendar items

Items in here were taken off `data/calendar/calendar.json` by
`scripts/sweep-duplicate-backlog.mjs`. **Nothing here has been deleted.** Each
one was moved, with a record of why.

Each was a *pure idea* at the moment it was dropped — no brief on disk, no
`content.html`, no Shopify article, no `publish_date` — and an existing page
already ranked for its exact keyword. No paid research was destroyed by removing
one, and any of them can be put straight back.

## Why this directory exists

Two incidents.

A calendar re-plan REPLACES the calendar. Between 2026-08-19 and 2026-08-21 that
cleared 12 of the 19 scheduled items and the only trace anywhere was eight
`[SKIP]` lines in an unattended cron log; five of the twelve had no log line at
all. And on 2026-08-19 `scripts/triage-orphan-briefs.mjs --drop-non-earning`
`unlinkSync`'d three paid-for briefs on a verdict that turned out to be wrong.
They are gone. Everything here exists so a wrong verdict costs a `--restore`
instead.

## Layout

    <slug>.json           the calendar item, exactly as it was
    <slug>.drop.json      why it went, when, on what evidence, and by which run
    log.jsonl             append-only history of every drop and every restore
    restored/             archived copies of items that have been put back

A slug dropped more than once becomes `<slug>--2.json`, `<slug>--3.json`, … so an
earlier drop is never overwritten.

## Restoring

    node scripts/sweep-duplicate-backlog.mjs --list-dropped     # what is in here
    node scripts/sweep-duplicate-backlog.mjs --restore <slug>   # newest drop of one item
    node scripts/sweep-duplicate-backlog.mjs --restore --all    # everything in here

A restore puts the item back in `data/calendar/calendar.json` and leaves the
`.drop.json` record here as the audit trail. It refuses to overwrite an item
already on the calendar under the same slug unless you pass `--force`.

## What was dropped, and what deliberately was not

Only the **exact ranked-query** tier of `lib/ranked-coverage.js` — the candidate
*is* a query an existing page already ranks for, above that module's position and
impression floors. That is the one tier measured at a zero false-positive rate
and the only one allowed to act silently.

A `possible_duplicate` (the phrase and semantic tiers) is **never** dropped here.
It is a judgement a human makes: `agents/pipeline-prioritizer` demotes it below
every clean idea and `agents/content-strategist` routes it to the digest's "Needs
your decision" section. Product scope is likewise a different question with its
own mechanism (`data/rejected-keywords.json`), and this sweep never acts on it.

## Nothing sweeps this directory

A calendar item is a few hundred bytes of JSON. There is no retention timer here,
for the same reason there is none in `data/briefs/_dropped/`: a timer that
deleted archived work would reintroduce the bug this directory exists to prevent,
just on a delay.
