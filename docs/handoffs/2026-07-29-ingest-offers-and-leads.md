# Handoff — Ingest `$100M Offers` and `$100M Leads`

**Written:** 2026-07-29
**Status:** Tooling shipped and proven. Both books converted and sitting on disk. Nothing run yet.
**Prerequisite reading:** `docs/superpowers/specs/2026-07-28-marketing-learner-file-source-design.md`
(especially *Testing → End-to-end rehearsal* and the cost table)

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

## Cost — measured, not estimated

From the rehearsal (4 calls, $1.02 real): extraction ~$0.41/chunk, consolidation ~$0.23,
skill merge ~$0.27 for an edit.

| Book | Run 1 | Run 2 | Total |
|---|---|---|---|
| `$100M Offers` (11 chunks) | ~$5 | ~$5–7 | **~$10–12** |
| `$100M Leads` (16 chunks) | ~$7 | ~$5–7 | **~$12–14** |

**Skill merges dominate**, because a merge sends the whole existing skill file in and gets
the whole rewritten file back — and those files grow with every ingest. Expect book 3 to
cost more per merge than book 2 did.

> ⚠️ `lib/llm-usage.js:21` prices Opus at `$15/$75`, the legacy Opus 4.x rates.
> `claude-opus-5` is `$5/$25`, so **every Opus figure in the cost reports is exactly 3×
> high**. A $10 run will show as $30. This is a known, unfixed one-line bug — do not
> re-derive budgets from those reports until it is fixed.

## Which book, and whether to run both

**Recommendation: run `$100M Offers` next. Hold `$100M Leads`.**

Offer construction is the current phase. The growth plan sequences
Tracking → CRO → **Offer/AOV** → Traffic, and `$100M Offers` sits squarely on the active
phase. `$100M Leads` is advertising and lead generation — the constraint block will reject
most of it as premature, because paid spend is explicitly gated behind the earlier phases.
That is the scoring working correctly, but it means paying ~$13 to be told "not yet."

**Expect a high reject rate on Offers too, and treat that as information.** The video corpus
saturated per-topic after five inputs (adoption fell 14/20 → 5/12 → 4/16 → 2/7). Money Models
and Offers cover adjacent ground, so a large fraction of Offers will restate what
`marketing-offer-construction` already holds. The consolidation step will merge duplicates
*within* the run; the existing skill-inventory dedup handles duplicates *against* what is
already written. If Offers adopts fewer than ~5 tactics, that is the signal that this axis is
saturated and the third book is not worth running at all.

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
