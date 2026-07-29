# Marketing Learner — File Source — Design

**Date:** 2026-07-28
**Status:** Approved, pending implementation plan
**Branch:** `feature/marketing-learner-file-source`
**Prerequisite reading:** `docs/superpowers/specs/2026-07-27-marketing-learner-design.md`,
`docs/superpowers/specs/2026-07-27-marketing-tactic-lifecycle-design.md`,
`docs/handoffs/2026-07-28-marketing-learner-file-source.md`

## Problem

`agents/marketing-learner` turns a YouTube video into scored marketing tactics and
project-level Claude Code skills. Five videos have been ingested. Adoption fell
14/20 → 5/12 → 4/16 → 2/7, then rose to 9/14 and 11/19 when the topic changed: the
corpus saturates per-topic, so more videos on the same axis produce mostly rejects.

Higher-signal inputs exist and cannot be fed in. Ranked by signal density, the
inputs available for RSC marketing are roughly:

1. RSC's own outcome data (collected, never learned from — separate project)
2. Voice-of-customer (`data/context/voice-of-customer.md`, already built)
3. **Canonical books** ← this work
4. YouTube videos (what the tool does today)

The first target is Alex Hormozi's *$100M Money Models*: a primary source rather
than a third party summarizing it, ~188 pages of durable offer mechanics with
near-zero platform-mechanics decay, and every chapter already ends in "Important
Notes" and "Summary Points" — pre-structured for extraction.

It demonstrably holds content five videos missed. From the Continuity Discount
chapter, flagged by the author as the highest-value note in the book: bill *weekly*
(weekly, every 2 weeks, 4 weeks…), because a year holds 12 months but **13**
four-week cycles — an 8.3% annual lift at the same number of customers. RSC runs
live Recurpay subscriptions; switching monthly → every-4-weeks is a pricing-page
copy change worth ~8% on subscription revenue with no new work and no traffic.

## Goal

Point the same command at a local text file instead of a URL and get the same
machinery: scored tactics, a rejects-included report, and skills.

The whole extraction/scoring/merge pipeline is already source-agnostic —
`extractTactics` takes a `video` object and does not care where the text came
from. Only the front door is YouTube-shaped. This adds a second front door.

## Non-Goals

- **No PDF parsing.** Node has no good built-in PDF extractor and "no new npm
  dependencies" is a standing constraint. Conversion is a manual, one-time
  operator step with a documented runbook (below). Parsing PDFs is a separate
  problem and is not smuggled into this one.
- No new source types beyond local `.txt` / `.md`. No URL fetching of articles,
  no EPUB, no OCR.
- No changes to scoring, the constraint block's content (beyond one source-type
  sentence), `validateSkillEdit`, `--falsify`, or `renderContextMirror`.
- The two small defects noted in the handoff — `--falsify` stamping UTC dates,
  and the `demoteHeadings` H1/tactic collision — are **out of scope**. They are
  unrelated to this work and fixing them here would widen the diff.

## Operator runbook — converting the PDF

Manual and one-time, per the Non-Goals. On macOS, no npm dependency:

```bash
brew install poppler        # already installed on this machine
pdftotext -layout ~/Downloads/_OceanofPDF.com_00M_Money_Models_How_To_Make_Money_-_Alex_Hormozi.pdf \
  digitalassets/100m-money-models.txt
wc -w digitalassets/100m-money-models.txt
```

`-layout` preserves reading order across two-column pages and callout boxes;
without it, sidebars interleave into body text mid-sentence. After converting,
eyeball the first and last ~40 lines for page-number and running-header noise —
a small amount is harmless (the extractor ignores it), a lot means the PDF needs
a different tool.

**Done, 2026-07-28.** 44,879 words / 264 KB / 220 paragraph blocks. The text
opens on the endorsements page and ends on the last line of *Free Goodies*, so
nothing is truncated. No page numbers and no running headers survived into the
text layer. The only artifact is a `OceanofPDF.com` watermark line, 41
occurrences — left in place deliberately: it is a rounding error against 44,879
words, the extractor ignores it, and stripping it would mean shipping a cleanup
step whose only job is to edit a source text before the model reads it.

Spot-checked that the passage the whole feature was justified on survived intact
(line 4157): *"There are 12 months in a year, but the year has 13 four-week
cycles. That's an 8.3% difference."*

The other two Hormozi books are sitting in the same directory (`$100M Offers`,
`$100M Leads`) and convert with the identical command when this one is done.

### `digitalassets/`

New top-level directory, committed with a `README.md` explaining what belongs
there. **Its contents are gitignored** (`digitalassets/*`, negating the README).

The reasoning matches `data/marketing-corpus/`: source texts are large,
re-derivable from the operator's own copy, and have no review value in a diff.
It also matters here specifically — the book's copyright page reserves "rights
for text and data mining and training of artificial technologies or similar
technologies". Extracting notes from a book Sean owns, into his own private
repo, for his own business decisions, is ordinary reading. Committing the full
text to a git history is not what that reasoning covers, and there is no reason
to. The resulting skills stay internal and are not published anywhere.

## Architecture

| File | Change |
|---|---|
| `lib/text-source.js` | **New.** The file-source seam, sibling to `lib/transcript-source.js`. |
| `lib/marketing-learner.js` | Add `chunkText`, `buildConsolidationPrompt`, `validateConsolidation`, `consolidateTactics`. Generalize `renderSkillMarkdown` provenance, `buildExtractionPrompt`, `buildConstraintBlock`, and `mergeSkillContent`'s prompt. |
| `agents/marketing-learner/index.js` | `--file` mode in `parseArgs`, `loadSource` dispatch, per-chunk extraction loop, chunk/consolidation cache. |

### The seam

`lib/text-source.js` exposes one function and one error class, mirroring
`lib/transcript-source.js`:

```js
loadTextFile(path, { author, title, publishedAt })
  → { sourceId, sourceType: 'file', title, creator, creatorUrl: null,
      publishedAt, language: 'en', text }
```

- `sourceId` — kebab slug of `title`, used for corpus and report paths.
- Throws `TextSourceError` on: missing file, unreadable file, empty file, a file
  whose extension is not `.txt` or `.md`, and a file over **10 MB**. The size
  ceiling guards against passing the PDF by mistake — a 188-page book converts to
  roughly 400 KB of text, while the PDF itself is multiple megabytes of binary
  noise that would otherwise be chunked and sent to Opus at full price.
- Normalization is the same whitespace collapse `normalizeTranscriptText` does,
  **except** blank lines are preserved — paragraph boundaries are load-bearing
  for chunking. This is the one place the two sources deliberately differ.

### Normalizing the source shape

`loadVideo()` today returns `{ videoId, title, creator, ... }` and everything
downstream keys on `video.videoId`. Both loaders now return `sourceId` and
`sourceType`; for videos, `sourceId === videoId` and `videoId` is retained on the
object so nothing that reads it breaks.

Two places name the video explicitly and must be generalized:

1. `buildExtractionPrompt` interpolates `"videoId": "${video.videoId}"` into the
   JSON schema it asks the model to return. This becomes `sourceId`.
   `validateExtraction` does not check this field today and still won't.
2. `mergeSkillContent`'s prompt hardcodes the provenance format as
   `*Source: Creator — "Title" (videoId)*`. Left alone, the merge LLM will
   "correct" book provenance back into video shape on the first edit.

**Checked 2026-07-28 — safe to generalize.** `REPORT_DIR` is constructed only in
`agents/marketing-learner/index.js`, and a repo-wide grep across `.js`/`.json`/`.html`
finds no other reader of `data/reports/marketing-learner/<videoId>.json` — the
dashboard does not touch it. The agent is the sole writer and there is no consumer,
so renaming the path segment breaks nothing. Existing committed report JSONs keep
their `videoId` field; they are audit records, not inputs.

## Flow

### 1. Load and chunk

`chunkText(text, { maxWords = 4500, overlapWords = 200, splitOn = null })` — pure,
network-free, in `lib/marketing-learner.js`.

Default behavior: greedily pack **paragraphs** (blank-line-delimited) into chunks
up to `maxWords`, never splitting mid-paragraph, with a 200-word overlap between
consecutive chunks so a tactic straddling a boundary appears whole in at least one
chunk. Returns `[{ index, total, label, text }]`.

`--split-on <regex>` overrides paragraph packing. Each match **starts** a new
chunk; the matched text is kept at the top of that chunk and becomes its `label`.
For a `.txt` with clean chapter headings this gives real labels instead of
`part N of M`; it is opt-in because it is fragile.

`maxWords` still applies under `--split-on`. A section longer than the budget is
packed into sub-chunks by the same paragraph rule, labelled
`<heading> (part 2 of 3)` — otherwise one long chapter silently becomes a single
oversized call.

At the default 4,500 words, the converted book (44,879 words, 220 paragraph
blocks) yields **11 chunks**, each 3,716–4,477 words.

Not the 10 that 44,879 ÷ 4,500 suggests: the 200-word overlap adds volume, and
packing whole paragraphs leaves every chunk a little under budget rather than
exactly at it. Measured with `chunkText`, not derived.

**Why word-budget packing over chapter detection.** PDF-extracted headings are
inconsistent — inconsistent casing, page numbers glued to titles, running headers
that look like chapter starts. A regex that misfires produces a 3-chunk book or a
200-chunk book with no error and no warning; the operator discovers it from the
bill. Word packing is deterministic, and the single knob that matters
(`--chunk-words`) is the operator's.

**Confirmed against the real file.** The converted `$100M Money Models` text has
no page numbers or running headers, but every chapter repeats the same four
structural headings — `Description` (14×), `Examples` (7×), `Important Notes`
(13×), `Summary Points` (10×), 44 in total. They are indistinguishable by shape
from the actual chapter titles, so a Title-Case heading regex splits this book
into ~65 chunks rather than its ~22 chapters. This is precisely the silent
misfire the design avoids, and it is why `--split-on` stays opt-in: for *this*
book the default word packing is the correct choice.

Word count is a deliberate proxy for tokens. `client.messages.count_tokens` exists
but costs a network round trip per chunk for a chunking heuristic; the flag is
named `--chunk-words` rather than `--chunk-tokens` so it does not claim more
precision than it has. ~188 pages lands at roughly 15–20 chunks.

Chunking applies to file sources only. A video transcript is one chunk, as today.

### 2. Extract, per chunk

`extractTactics` runs unchanged, once per chunk, with `video.text` set to the
chunk text and the chunk's label carried alongside for provenance. The skill
inventory and constraint block are identical across every chunk in a run.

Each chunk's validated extraction is written to
`data/marketing-corpus/<sourceId>/chunks/<index>-<hash>.json` (see Caching).

### 3. Consolidate — the cross-chunk dedup

This is the hardest problem in the feature. Every chapter restates its own tactics
in a "Summary Points" block, and the final chapter ("Ten Years In Ten Minutes")
restates the entire book. The existing dedup only compares candidates against
*already-written skills* — it cannot see duplicates within one run's chunk
sequence. Naive chunking would extract the same tactic three times and write it
into a skill three times.

**One Opus call over the full candidate set, before anything touches a skill.**

`buildConsolidationPrompt({ candidates, source })` asks the model to group
duplicates and near-variants into canonical tactics, keeping the best-stated
claim, mechanism, and evidence, and the union of chunk locators. It returns:

```json
{
  "tactics": [
    {
      "claim": "...", "mechanism": "...", "evidence": "...",
      "rscFit": { "score": 0, "reasoning": "..." },
      "verdict": "adopt | reject", "rejectReason": null,
      "targetSkill": { "name": "marketing-...", "action": "create | edit", "description": "..." },
      "mergedFrom": [{ "chunkIndex": 3, "label": "..." }, ...]
    }
  ]
}
```

The output is validated by the existing `validateExtraction` (same tactic shape)
plus a new guard.

**Rejected alternatives:**

- *Rolling context* — feed chunk N the tactics from chunks 1..N-1. Serial (kills
  resumability and parallelism), context grows unboundedly across ~18 chunks, and
  it produces the wrong outcome on the case that matters: when a later chapter
  states a tactic *better* than an earlier one, the later, richer statement is the
  one that gets rejected as a duplicate.
- *String/lexical similarity* — no LLM, nearly free, and fails exactly where it
  needs to work. "Bill weekly" and "use four-week billing cycles" are the same
  tactic with almost no lexical overlap.

**The guard, in code rather than persuasion.**
`validateConsolidation(candidates, consolidated)` throws unless every input
candidate appears in exactly one output group's `mergedFrom` — no drops, no
double-claims. An LLM asked to merge a 60-item list can silently omit items while
still returning a plausible, well-formed result, and no existing guard would catch
it: `validateSkillEdit`'s shrink floor only sees the final skill file, by which
point the dropped tactic never existed. This mirrors the falsified-claims guard —
the one check that is code because persuasion is not enough.

Cost: one call, roughly $0.25.

### 4. Score, render, report, PR

Unchanged. The consolidated tactic set enters the existing pipeline exactly where
a single video's extraction does: adopted tactics group by `targetSkill.name`,
`writeSkill` creates or merges, `syncMirrorIfTouched` regenerates the mirror, the
report is written, the PR is opened.

## Provenance

`renderSkillMarkdown` takes a **locator** rather than a `videoId`:

| Source | Rendered line |
|---|---|
| video | `*Source: Alex Becker — "How I Scaled to $100k/mo" (dQw4w9WgXcQ)*` |
| book (default) | `*Source: Alex Hormozi — "$100M Money Models" (book, part 7 of 18)*` |
| book (`--split-on`) | `*Source: Alex Hormozi — "$100M Money Models" (book, Continuity Discounts)*` |

The video form is **byte-identical to what is rendered today**, so the eight
existing skills see no diff churn when they are next edited.

`part 7 of 18` rather than an invented `§Attraction Offers`: it is traceable back
to an actual chunk in an actual run. A fabricated section name is the same class
of error the parent spec already rejected for `--published` — confident, wrong,
authoritative-looking metadata that nobody thinks to re-check. When `--split-on`
is used the label is real text matched from the file, so it is used directly.

A consolidated tactic carries every locator it merged from.

`validateExtraction` still does not constrain provenance, because the model never
produces it — the agent injects `source` after extraction, since only the agent
knows which chunk it just sent.

## `--published` for a file source

Optional, as for videos, and for file sources it additionally accepts a bare
`YYYY`. A copyright page carries a year, not a date; requiring `2025-01-01` would
manufacture a false month and day, which is the failure mode the parent spec
rejected when it made a single `--published` across multiple URLs an error.

`buildConstraintBlock({ sourceType })` appends one sentence for file sources:
content is presumed durable principle, and the platform-mechanics decay row
applies only to passages that name a specific platform. The decay table itself is
unchanged, and `rscFit.reasoning` must still name the tactic class when age drove
a score down.

## Caching

The parent spec cached transcripts because re-fetching cost a credit. A local file
needs no such cache — but the economics inverted: **extraction is now the
expensive part**, and an 18-chunk run that dies at chunk 16 must not re-pay for
the 15 that succeeded.

| Path | Keyed on |
|---|---|
| `data/marketing-corpus/<sourceId>/chunks/<index>-<hash>.json` | sha256 of chunk text + skill inventory + constraint block |
| `data/marketing-corpus/<sourceId>/consolidated-<hash>.json` | sha256 of the sorted candidate set |

Hashing via `node:crypto` — no new dependency. `data/marketing-corpus/` is already
gitignored.

**The inventory is in the hash deliberately.** If skills changed between runs, the
extraction prompt changed, so the cache must miss — otherwise run 2 writes skills
from an extraction that never saw the current inventory, and the anti-duplication
mechanism silently stops working.

`--refetch` keeps its name and means "ignore cache" for both source types.

### Consequence: the review gate is nearly free

This is the reason the two-run flow below costs almost nothing extra.

## CLI

```
node agents/marketing-learner/index.js --file <path> --author "<name>" --title "<title>"
    [--published YYYY|YYYY-MM-DD]
    [--chunk-words 4500]
    [--split-on <regex>]
    [--extract-only] [--no-pr] [--refetch]
```

- `--author` and `--title` are **required** with `--file`. There is no metadata
  endpoint for a local file; these two flags *are* the provenance.
- `--file` combined with URLs is an error, not a batch — separate modes, the same
  rule `--falsify` already follows.
- One file per run. A book is a run.
- `--file` combined with `--falsify` is an error.

### The two-run flow

```bash
# Run 1 — read before anything is written.
npm run learn -- --file digitalassets/100m-money-models.txt \
  --author "Alex Hormozi" --title "\$100M Money Models" \
  --published 2025 --extract-only

# → data/reports/marketing-learner/100m-money-models.md
#   Every tactic, adopt and reject, with reasoning. No skills, no branch, no PR.

# Run 2 — identical command, minus --extract-only.
npm run learn -- --file digitalassets/100m-money-models.txt \
  --author "Alex Hormozi" --title "\$100M Money Models" --published 2025
```

Run 2's chunk extractions and consolidation all hit cache; it pays only for the
skill merges.

Cost, against `claude-opus-5` at $5/$25 per MTok. The per-call figures below are
**measured** from the single-chapter rehearsal (2,191 words → 1 chunk, 4 calls,
$1.02 total), not estimated:

| Call type | Measured (chapter) | Full book | Cost |
|---|---|---|---|
| Extraction | 23.8k in / 11.4k out = $0.41 | 11 chunks, ~2× the text each | ~$4.50 |
| Consolidation | 6.4k in / 7.9k out = $0.23 (14 candidates) | ~150 candidates | ~$1 |
| Skill merge | 7.8k in / 9.3k out = $0.27 (edit); $0.11 (create) | 10–15 skills | ~$5–7 |
| **Total** | **$1.02** | | **~$11–13** |

**Skill merges dominate, and an earlier estimate of ~$6–7 was about half the real
figure.** A merge sends the whole existing skill file in and gets the whole
rewritten file back, so its cost scales with how large the skill already is — and
these files grow as they accumulate tactics. Extraction, which is what a chunked
book obviously spends on, is the cheaper half.

> ⚠️ `lib/llm-usage.js` prices Opus at $15/$75 — the legacy Opus 4.x rates. Every
> Opus figure it has logged is exactly 3× high, so this run appears in the cost
> reports as $3.05 rather than $1.02. Unrelated to this feature; flagged for a
> separate one-line fix.

The dominant term is output tokens, not input, which is why the deferred
prefix-caching optimization below moves so little.

Without this gate, a run touching 10–15 skills lands as a single PR whose diff
takes an afternoon to review properly and whose only rejection mechanism is
closing the whole thing. With it, the expensive judgment is reviewed as prose
before any skill is written, and a bad chunking decision is caught before it is
committed.

## Error handling

| Condition | Behavior |
|---|---|
| `--file` path missing / unreadable / empty | `TextSourceError`, exit 1 |
| `--file` extension not `.txt` / `.md` | `TextSourceError` naming the runbook, exit 1 |
| `--file` over the byte ceiling | `TextSourceError` — probable PDF passed by mistake, exit 1 |
| `--file` without `--author` or `--title` | `parseArgs` throws |
| `--file` with URLs, or with `--falsify` | `parseArgs` throws |
| `--published` malformed / future / not `YYYY` or `YYYY-MM-DD` | existing `parsePublishedFlags` validation, extended for bare `YYYY` |
| Chunk extraction `stop_reason === 'max_tokens'` | Throw, do not save. Existing rule — truncated structured output is corrupt, not partial. Completed chunks stay cached; re-running resumes. |
| Chunk extraction schema-invalid | Throw, persisting the offending payload to the corpus dir. Existing behavior. |
| `validateConsolidation` guard trip | Throw. No skill is written. The per-chunk caches survive, so a re-run re-pays only for consolidation. |
| Corrupt cached chunk JSON | Warn and treat as a cache miss (mirrors the existing corrupt-`video.json` handling) |

Completion calls `notify()` per repo convention.

## Testing

`tests/agents/marketing-learner.test.js` and a new `tests/lib/text-source.test.js`,
under `node --test`, bare-assertion style (top-level `assert.*` then
`console.log('✓ … tests pass')` — no `describe`/`it` anywhere in this repo). No
network; the Anthropic client is mocked.

- `chunkText` — respects `maxWords`; never splits a paragraph; applies overlap
  between consecutive chunks; a file shorter than one chunk yields exactly one
  chunk; `splitOn` splits on matches and uses matched text as the label; labels
  and `index`/`total` are correct.
- `validateConsolidation` — passes a legitimate merge; throws when a candidate is
  dropped; throws when a candidate is claimed by two groups.
- `buildConsolidationPrompt` — includes every candidate and the merge instruction.
- `renderSkillMarkdown` — video locator output is byte-identical to today; book
  locator renders in both default and `--split-on` forms.
- `buildConstraintBlock` — the file-source sentence appears for `sourceType:
  'file'` and not for `'video'`; the decay table survives in both.
- `loadTextFile` against a `mkdtempSync` sandbox — normalization preserves blank
  lines; missing / empty / wrong-extension / oversized files each throw the right
  code.
- `parseArgs` — `--file` requires `--author` and `--title`; rejects URL mixing and
  `--falsify` mixing; bare `YYYY` accepted for files and rejected for videos.

Per repo rule #4, one manual end-to-end run against a **single chapter** with
`--no-pr` before the full book. Do not execute the agent without `--no-pr` during
development — a normal run pushes a branch and opens a real PR.

### End-to-end rehearsal, 2026-07-28 — passed

Continuity Discount Offers (lines 4049–4280, 2,191 words → 1 chunk), run three ways.

| Run | Result |
|---|---|
| `--extract-only` | 14 candidates → 13 canonical (one merge), 9 adopted / 4 rejected. **No skill touched, no PR.** |
| Same command again | Both caches hit. **0.8s wall clock, zero API calls.** |
| `--no-pr` | Caches hit again; 2 skills written (1 edit, 1 create), paying only for the merges. |

Verified:

- The weekly-billing tactic — the passage this whole feature was justified on —
  was extracted, with the 8.3% arithmetic and the 13-four-week-cycles mechanism intact.
- Provenance rendered as `*Source: Alex Hormozi — "Money Models Chapter Test" (book, part 1 of 1)*`.
  No `(n/a)`, no `(null)`.
- The report carries a `**Merged from:**` line per adopted tactic.
- Trial artifacts fully reverted; skill count back to 8.

**A gap the revert step missed.** The run *created* a new skill directory
(`marketing-cancellation-save-flow/`), and `git checkout -- .claude/skills/` only
restores tracked files — an untracked new skill survives it untouched. Any future
rehearsal must also `rm -rf` newly created skill dirs and regenerate the mirror,
or a trial skill silently ships.

**The scoring earned its keep on the first real run.** The weekly-billing tactic
was adopted at only 5/10, and the reason is a correction to this spec's own
premise: the mechanic was built for services where nothing physical ships. For a
consumable, 13 shipments against ~12 months of real usage means the customer
accumulates surplus product and cancels — attacking the retention constraint that
is RSC's actual binding constraint. The tactic is usable only where consumption
genuinely runs faster than 30 days, never as a blanket default. The "~8% free
money" framing in the handoff does not survive contact with RSC's situation
unqualified.

## Constraints that bind

Carried from the parent specs and the handoff; every one of these has already
cost a session:

- **ESM only. No new npm dependencies.** Node built-ins only.
- **`new Anthropic()` with no args does not work here.** `loadEnv()` parses `.env`
  into a local object and never touches `process.env`. Pass
  `{ apiKey: env.ANTHROPIC_API_KEY }` explicitly. This shipped broken once and
  only a live run caught it — the structural test asserted the import path, which
  was correct.
- **`max_tokens` must be ≥16000 on `claude-opus-5`.** Thinking is on by default
  and shares the `max_tokens` budget with the response. 8000 truncates and wastes
  a paid call.
- **The agent always branches from `main`** (`git checkout -b <branch> main`),
  regardless of where the operator is standing. Merge open learner PRs before the
  next run or they conflict.
- **`git checkout <path>` will not undo staged work** — it restores from the
  index. Use `git reset` first.

## Risks

**Chunk boundaries split a tactic.** Mitigated by the 200-word overlap and by
consolidation, which merges the two partial statements. Residual risk is a tactic
whose mechanism spans more than 200 words across a boundary; it would be extracted
twice, weakly, and merged into one weak tactic. Visible in the report, which is
why the report comes first.

**Consolidation flattens two genuinely distinct tactics into one.** The guard
catches drops, not over-merging. This is a judgment failure the report surfaces —
`mergedFrom` names every chunk that fed each canonical tactic, so an implausible
merge is visible without re-reading the book.

**A 15-skill PR is still a big PR.** The `--extract-only` gate moves the expensive
judgment earlier but does not shrink the eventual diff. If the first book run
proves unreviewable in one sitting, the fix is to split by section on a subsequent
run — not to add more automation.

**Books saturate too.** The video corpus saturated per-topic after five inputs.
One book will not saturate the offer-construction axis by itself, but the third
book on offers probably will. The rejects report is how that becomes visible
early, as it did for video.

## Deferred

- Prompt caching of the constraint block + inventory prefix across chunks. At the
  current inventory size it saves roughly $1.30 on a $5.60 extraction run — not
  worth restructuring `buildExtractionPrompt` into content blocks with
  `cache_control` for. Revisit if the inventory grows several times over.
- Parallel chunk extraction. The chunks are independent and the cache makes it
  safe, but serial keeps the failure mode simple and a book run is not
  latency-sensitive.
- PDF, EPUB, and URL-article sources.
- Multiple files per run.
