# Handoff — Ingest `$100M Offers` and `$100M Leads`

**Written:** 2026-07-29
**Status: DONE for Money Models and Offers (PR #389). Leads deliberately not run — see below.**
No further book ingestion is planned. Read this only if that changes.
**Prerequisite reading:** `docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md`
(especially *Testing → End-to-end rehearsal* and the cost table)

## Outcome (2026-07-29, PR #389)

| Book | Words | Candidates | Canonical | Agent adopted | **Shipped** | Skills |
|---|---|---|---|---|---|---|
| Money Models | 44,879 | 172 | 100 | 61 | **16** | 9 → 11 |
| Offers | 45,101 | 119 | 97 | 44 | **9** | 11 → 13 |
| Leads | 67,684 | — | — | — | not run | — |

**Leads was not run, and saturation is the wrong reason to cite.** Offers cleared the ~5-tactic
bar set below (9 sections), so the bar did not trip. The reason is the phase gate: Leads is
lead-generation and advertising material, and the growth plan gates traffic behind
Tracking → CRO → Offer/AOV, so the constraint block would reject most of it as premature.
Revisit only after the offer/AOV work these 25 tactics describe has shipped and converted.

**Four defects surfaced that the single-chapter rehearsal could not.** All fixed in #389:
extraction overflowed 16k on a dense chunk (now 32k, streamed); no retry, so one
`overloaded_error` in an 11-call run discarded everything after it (now `withRetry`, transport
only); consolidation overflowed 32k at 172 candidates (now 128k, **the model's ceiling — a
bigger book needs batching, not a bigger number**); and a parse failure persisted no evidence
and reported the source as `null`.

**Curation is not optional, and it is the bulk of the work.** Both runs proposed far more
skills than they should: Money Models wanted 6 new ones (9 → 15, seven of them about offers).
The learner enforces anti-duplication per *tactic* but never per *skill creation*. Its
`(create)`/`(edit)` labels are also unreliable — it treats skills it invented in one chunk as
pre-existing in later chunks, and consolidation merges the contradictory guesses. Expect to
ship roughly a quarter of what it adopts, and expect to reconcile tactics that contradict each
other (both books produced a guarantee conflict; see the commits).

## What already happened

PR #379 (merged, `058bb65`) gave `agents/marketing-learner` a file source. A book now runs
through the same extraction → scoring → consolidation → skill-merge pipeline as a YouTube
transcript. It has been proven end-to-end on one chapter of *$100M Money Models*.

**The full-book run has NOT been done for any of the three.** Only a single 2,191-word
chapter, whose trial skill edits were reverted.

## The three books, converted and on disk

All under `digitalassets/`, **gitignored** — they exist in the main checkout only. If you
take a worktree, they will not be in it; either work from the main checkout for the run
itself or copy the file across.

| File | Words | Chunks | Status |
|---|---|---|---|
| `digitalassets/100m-money-models.txt` | 44,879 | 11 | Chapter rehearsal only |
| `digitalassets/100m-offers.txt` | 45,101 | 11 | Untouched |
| `digitalassets/100m-leads.txt` | 67,684 | 16 | Untouched |

All three converted with `pdftotext -layout` from `~/Downloads/_OceanofPDF.com_*.pdf`, verified
non-truncated (each opens on its title page and ends on its real last line), and confirmed to
chunk into 3,245–4,496-word blocks. The only artifact is an `OceanofPDF.com` watermark line,
deliberately left in — it is a rounding error against 45k words and the extractor ignores it.

## Run it — the two-run flow

**Run 1 writes nothing.** Read the report before letting anything touch a skill.

```bash
cd /Users/seanfillmore/Code/Claude

npm run learn -- --file digitalassets/100m-offers.txt \
  --author "Alex Hormozi" --title "\$100M Offers" \
  --published 2021 --extract-only
```

Then read `data/reports/marketing-learner/100m-offers.md` — every tactic, adopted and
rejected, with scores and reasoning, plus a `**Merged from:**` line showing which excerpts
fed each canonical tactic.

**Run 2 is the same command minus `--extract-only`.** Every chunk extraction and the
consolidation replay from cache, so it pays only for skill merges. On the rehearsal this
took 0.8 seconds and zero API calls to reach the merge step.

`--published`: `$100M Offers` is 2021, `$100M Leads` is 2023. A bare `YYYY` is correct and
accepted for file sources — do not invent a month and day.

## Cost — not the deciding factor

**Do not use run cost as a reason to skip a book.** Sean is on a Claude subscription, and
he has said plainly he is not paying per book. An earlier version of this handoff argued
against running `$100M Leads` partly on a ~$13 price tag; that argument was wrong and has
been removed.

The one nuance to keep straight: the agent authenticates with `ANTHROPIC_API_KEY` from
`.env`, a real Console key that is metered independently of the Claude Code subscription.
So a run *is* measured even though it is not a constraint Sean is managing. Confirm the
state of that Console account before ever quoting a dollar figure as an argument.

Measured per-call figures from the rehearsal, for sizing runs rather than gating them:
extraction ~$0.41/chunk, consolidation ~$0.23, skill merge ~$0.27 for an edit — about $1.02
for the 4 calls on a 2,191-word chapter. **Skill merges dominate**, because a merge sends
the whole existing skill file in and gets the whole rewritten file back, and those files
grow with every ingest.

> ⚠️ `lib/llm-usage.js:21` prices Opus at `$15/$75`, the legacy Opus 4.x rates.
> `claude-opus-5` is `$5/$25`, so **every Opus figure in the cost reports is exactly 3×
> high**. Known, unfixed one-line bug — do not read those reports as accurate.

## Which book first, and what to watch

**Run `$100M Offers` first, then `$100M Leads`. Run both.**

Offers goes first because it is on-phase: the growth plan sequences
Tracking → CRO → **Offer/AOV** → Traffic, and offer construction is the live constraint.

`$100M Leads` is advertising and lead generation, which the constraint block will reject
much of as premature — paid spend is explicitly gated behind the earlier phases. That is the
scoring working correctly, and with cost off the table it is worth running anyway for two
reasons: the rejects report is itself the useful artifact (it tells you what is waiting on
the Traffic phase), and whatever *does* adopt is banked for when that phase opens.

**The real cost of these runs is skill quality and review time, not money.** Two things to
watch:

1. **Saturation.** The video corpus saturated per-topic after five inputs (adoption fell
   14/20 → 5/12 → 4/16 → 2/7). Money Models and Offers cover adjacent ground, so much of
   Offers will restate what `marketing-offer-construction` already holds. Consolidation
   merges duplicates *within* a run; the skill-inventory dedup handles duplicates *against*
   what is already written. **If Offers adopts fewer than ~5 tactics, say so plainly** —
   that is the signal this axis is done, and it should change how much weight the Leads
   report gets.
2. **Dilution.** Premature Leads tactics written into skills will surface to
   `creative-packager` and anything else reading `.claude/skills/marketing-*`. Read the
   Leads report critically before run 2, and be willing to run only `--extract-only` on it
   and never write the skills at all. That is a legitimate outcome.

## Things that will bite you

1. **`git checkout -- .claude/skills/` does not undo a newly created skill.** It restores
   tracked files only; a brand-new skill directory is untracked and survives the revert.
   If you rehearse and then revert, also `rm -rf` any new skill dirs and regenerate the
   mirror. This already happened once —
   `marketing-cancellation-save-flow/` nearly shipped from a trial run.
2. **The agent branches from `main` and opens a real PR** unless you pass `--no-pr` or
   `--extract-only`. Merge any open learner PR before the next run or they conflict.
3. **The chunk cache hashes the skill inventory.** That is deliberate — if skills changed
   between run 1 and run 2, the cache correctly misses and re-extracts, because the prompt
   changed. Do not "fix" a surprising cache miss by removing the inventory from the hash.
4. **Do not use `--split-on` on these books.** Every chapter repeats
   `Description` / `Examples` / `Important Notes` / `Summary Points` — 44 such headings in
   Money Models — which are indistinguishable by shape from real chapter titles. A heading
   regex splits the book into ~65 chunks instead of ~22 chapters, with no error and no
   warning. The word-budget default is correct here.
5. **The working directory drifts.** Use `git -C <path>` for every git command rather than
   relying on `cd` persisting. A commit landed on `main` this way during the last session.

## Open question worth putting to Sean

The rehearsal surfaced that the tactic this whole feature was justified on — bill every four
weeks for 8.3% more annual revenue — scored only **5/10** for RSC, because it was designed
for services where nothing physical ships. For a consumable, 13 shipments against ~12 months
of usage means customers accumulate surplus and cancel, which attacks the retention
constraint that binds here.

Before acting on any pricing-cadence tactic from these books, check
`reference_sku_consumption_rates.md` for the measured reorder gap per SKU. The tactic is
usable only where real consumption runs faster than 30 days.
