# Handoff — Add a file source to `marketing-learner`

**Written:** 2026-07-28
**Status:** Approved in principle by Sean, not started. Needs spec → plan → SDD.
**Prerequisite reading:** `docs/superpowers/specs/2026-07-27-marketing-learner-design.md` and
`docs/superpowers/specs/2026-07-27-marketing-tactic-lifecycle-design.md`

## The ask

`agents/marketing-learner` turns a YouTube video into scored marketing tactics and
project-level Claude Code skills. Sean wants to feed it **books and other long-form text** —
specifically Alex Hormozi's *$100M Money Models*, which he has as a PDF.

The whole extraction/scoring/merge pipeline is source-agnostic. Only the front door is
YouTube-shaped. Add a second source so the same machinery works on text.

## Why this is worth building

Ranked by signal density, the inputs available for RSC marketing are roughly:

1. RSC's own outcome data (collected, never learned from — separate project)
2. Voice-of-customer (`data/context/voice-of-customer.md`, already built)
3. **Canonical books** ← this work
4. YouTube videos (what the tool does today)

Five videos have been ingested. Adoption fell 14/20 → 5/12 → 4/16 → 2/7, then rose to 9/14
and 11/19 when the topic changed — the corpus saturates per-topic, so more videos on the same
axis produce mostly rejects.

The book is strictly better than the videos already ingested: it is the primary source rather
than a third party summarizing it, it is ~188 pages of durable offer mechanics with near-zero
platform-mechanics decay, and every chapter already ends in "Important Notes" and "Summary
Points" — pre-structured for extraction.

**Concrete evidence it holds content the videos missed.** From the Continuity Discount chapter,
flagged by the author as the highest-value note in the book:

> Bill *weekly* (weekly, every 2 weeks, 4 weeks…). There are 12 months in a year, but the year
> has **13** four-week cycles. That's an 8.3% difference… the same number of people buy. But I
> make 8.3% more annually.

RSC runs live Recurpay subscriptions. Switching monthly → every-4-weeks is a pricing-page copy
change worth ~8% on subscription revenue with no new work and no traffic. Nothing in five
videos surfaced it.

## ⚠️ The PDF is not in the repo

Sean attached it to a chat session; it is **not** on disk anywhere in this project. Before any
end-to-end run, ask him to save it (or a text extraction of it) to a path and give you that
path. Do not assume it exists.

## What already exists (do not rebuild)

| File | Role |
|---|---|
| `lib/transcript-source.js` | **The seam.** The only file that knows TranscriptAPI exists. Exports `TranscriptError`, `extractVideoId`, `pickLanguage`, `normalizeTranscriptText`, `fetchTranscript`. A file source is a sibling here. |
| `lib/marketing-learner.js` | Pure, network-free logic: `parsePublishedFlags`, `buildConstraintBlock`, `parseFrontmatter`, `scanSkillInventory`, `renderSkillMarkdown`, `validateSkillEdit`, `buildExtractionPrompt`, `validateExtraction`, `extractTactics`, `renderReport`, `mergeSkillContent`, `falsifyTactic`, `extractFalsifiedClaims`, `renderContextMirror` |
| `agents/marketing-learner/index.js` | CLI, orchestration, PR automation, `--falsify` mode |
| `agents/creative-packager/index.js` | Reads the tactic menu — generates it in memory via `renderContextMirror(scanSkillInventory(...))`, no committed file |

**Everything after `loadVideo()` is source-agnostic.** `extractTactics` takes a `video` object;
it does not care where the text came from. That is the whole reason this is a small change.

Current state on `main`: **8 skills**, 5 videos ingested, `npm test` = **1007 pass, 0 fail**.
5 of 100 TranscriptAPI credits used.

## Design questions to settle in the spec

These are genuinely open. Do not guess — brainstorm them with Sean.

1. **PDF parsing, or text only?** Recommend **text only** (`.txt` / `.md`). Node has no good
   built-in PDF extractor, and "no new npm dependencies" is a standing constraint on this
   codebase. Have Sean convert once and pass the `.txt`. Parsing PDFs is a separate problem
   that should not be smuggled into this one.

2. **Chunking.** 188 pages will not fit one extraction call, and a single call over that much
   text produces shallow output. The book has six sections and ~25 chapters. Chunk by chapter?
   By section? What is the token ceiling per chunk? How does the operator control it?

3. **Cross-chunk dedup.** Every chapter restates its own tactics in a "Summary Points" block,
   and the final chapter ("Ten Years In Ten Minutes") restates the entire book. Naive chunking
   will extract the same tactic three times. The existing dedup only compares against
   *already-written skills* — it will not catch duplicates inside one run's chunk sequence.
   This is the hardest problem in the feature.

4. **Provenance format.** Today: `*Source: <creator> — "<title>" (<videoId>)*`. A book needs
   something like `*Source: Alex Hormozi — "$100M Money Models" (book, §Attraction Offers)*`.
   `renderSkillMarkdown` builds this line; `validateExtraction` does not currently constrain it.

5. **`--published` for a book.** The flag exists to drive the platform-mechanics decay table.
   A book has a copyright year, not an upload date, and its content is nearly all durable
   principle. Should `--published` be optional for files? Should the constraint block say
   "this is a book, weight durability higher"?

6. **Caching.** `data/marketing-corpus/<videoId>/` caches transcripts so re-runs cost 0 credits.
   A local file needs no cache (it is already on disk) — but the *extraction* is the expensive
   part now, not the fetch. Consider caching extraction output per chunk so a failed run
   mid-book does not re-pay for completed chunks.

## Constraints that bind (learned the hard way this session)

- **ESM only. No new npm dependencies.** Node built-ins only.
- **Bare-assertion test style** — top-level `assert.*` then `console.log('✓ … tests pass')`.
  No `describe`/`it` anywhere in this repo.
- **`new Anthropic()` with no args does not work here.** `loadEnv()` parses `.env` into a local
  object and never touches `process.env`. Pass `{ apiKey: env.ANTHROPIC_API_KEY }` explicitly.
  This shipped broken once and only a live run caught it — the structural test asserted the
  import path, which was correct.
- **`max_tokens` must be ≥16000 on `claude-opus-5`.** Thinking is on by default and shares the
  `max_tokens` budget with the response. 8000 truncates and wastes a paid call.
- **The agent always branches from `main`** (`git checkout -b <branch> main`), regardless of
  where the operator is standing. Merge open learner PRs before the next run or they conflict.
- **`git checkout <path>` will not undo staged work** — it restores from the index. Hit this
  reverting test artifacts. Use `git reset` first.
- **Do not execute the agent without `--no-pr`** during development. A normal run pushes a
  branch and opens a real PR.

## Known open defects (small, unrelated to this work)

- **`--falsify` stamps UTC dates.** Uses `new Date().toISOString()`. At 17:57 PDT it wrote
  `2026-07-28` while the operator's calendar said the 27th. `creative-packager` already uses
  `America/Los_Angeles`, so there is a repo convention to follow.
- **`demoteHeadings` H1/tactic collision.** In `renderContextMirror`, a skill's H1 and its `##`
  tactics both land at `###`. Cosmetic; nothing reads heading depth. A correct fix needs a
  `shiftBy` parameter because `falsifyTactic` wants +1 while `renderContextMirror` wants +2.

## Copyright note

The book's copyright page explicitly reserves "rights for text and data mining and training of
artificial technologies or similar technologies." Extracting notes from a book Sean owns, into
his own private repo, for his own business decisions, is ordinary reading — that is what this
is. But it is a reason to keep the resulting skills internal and not publish them anywhere.

## Suggested first move

Invoke `superpowers:brainstorming`, work the six design questions above with Sean (chunking and
cross-chunk dedup are the substantive ones), write the spec to
`docs/superpowers/specs/`, then plan and execute with `superpowers:subagent-driven-development`.
The lifecycle branch is a good size reference: 6 tasks, ~20 commits.

Before the end-to-end run, get the book's file path from Sean.
