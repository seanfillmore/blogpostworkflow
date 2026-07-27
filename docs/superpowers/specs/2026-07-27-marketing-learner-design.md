# Marketing Learner — Design

**Date:** 2026-07-27
**Status:** Approved, pending implementation plan
**Branch:** `feature/marketing-learner`

## Problem

Marketing knowledge that would improve this fleet's output lives in YouTube videos from
operators who have run the plays. There is no path from "Sean watched a good video" to
"Claude and the agent fleet are measurably better at marketing." Notes get lost, and
watching does not change behavior in the repo.

Separately, most marketing content is not applicable here. Advice calibrated for a
$5M brand with a media buyer and a $50k/mo budget is actively misleading for a solo
operator at ~$875/mo Shopify revenue. Ingesting uncritically would be worse than not
ingesting at all, because it would encode bad priors into skills that then fire
automatically.

## Goal

Point a command at a YouTube URL. Get back a reviewed pull request that either creates
or sharpens a project-level Claude Code skill, plus a report showing every tactic found,
scored against Real Skin Care's actual constraints — including the ones that were
rejected and why.

The rejects are a first-class output, not a debug artifact. "What is not beneficial" was
half the original ask, and it is invisible in a skill diff.

## Non-Goals

- No channel watchlist, no polling, no scheduler entry, no cron. On-demand only.
- No server deployment. This runs on Sean's Mac (see Bot Detection below).
- No dashboard UI.
- No `data/context/*.md` artifact for the agent fleet. Skills only, for now.
- No audio transcription fallback (Whisper/Deepgram). If a video has no captions,
  it is skipped.

These are deliberate. Revisit only if the tool earns its keep.

## Architecture

Two files, mirroring the `voice-of-customer` split:

| File | Responsibility |
|---|---|
| `agents/marketing-learner/index.js` | CLI, orchestration, `yt-dlp` shell-out, Anthropic calls, git/PR |
| `lib/marketing-learner.js` | Pure functions: VTT parsing, skill inventory, skill rendering, validation guards |

Everything in `lib/` is network-free and unit-testable. Everything that touches the
outside world lives in the agent.

### Data locations

| Path | Committed? | Contents |
|---|---|---|
| `data/marketing-corpus/<videoId>/` | No — gitignored | `raw.en.vtt`, `info.json`, `transcript.txt` |
| `data/reports/marketing-learner/<videoId>.md` | Yes | Human-readable scoring report incl. rejects |
| `data/reports/marketing-learner/<videoId>.json` | Yes | Structured extraction output |
| `.claude/skills/marketing-<topic>/SKILL.md` | Yes | The actual deliverable |

Transcripts are gitignored: they are large, re-fetchable, and of no review value. The
extraction JSON is committed because it is the auditable record of what the model
concluded from a transcript that no longer exists in the repo.

Requires adding `data/marketing-corpus/` to `.gitignore`.

## Flow

### 1. Fetch

Shell out to `yt-dlp`:

```
yt-dlp --write-subs --write-auto-subs --sub-langs "en.*,en" --sub-format vtt \
       --skip-download --write-info-json \
       -o "<corpusDir>/raw" <url>
```

Both manual and auto captions are requested. **Manual captions are preferred when
present** — they are human-written and lack the duplication artifacts described below.
Fall back to auto.

`info.json` supplies title, channel/uploader, upload date, duration, view count, and
description. Channel and view count feed the extraction prompt as weak credibility
signal — not as truth, but a 400-view video from an unknown channel should clear a
higher bar than one from an operator with a track record.

Fetch is cached. Re-running a URL reuses the corpus directory unless `--refetch`.

### 2. Normalize — the part that quietly breaks things

YouTube auto-generated VTT is not clean text. It contains:

- Inline word-level timing spans: `so<00:00:00.719><c> the</c><00:00:00.960><c> first</c>`
- Cue-level positioning cruft: `align:start position:0%`
- **A rolling caption window**: each cue repeats the tail of the previous cue as its
  head, so every phrase appears two to three times.

Naive VTT stripping produces a transcript roughly 2.5× too long that reads as a stutter.
The failure mode is insidious: extraction quality drops, and it presents as the model
being bad at its job rather than as a parsing bug.

`vttToPlainText(vtt)` must:

1. Strip `<c>` tags and `<timestamp>` markers.
2. Strip cue settings and `WEBVTT` / `Kind:` / `Language:` headers.
3. Drop each cue's leading overlap with the accumulated output tail.
4. Collapse whitespace, join into paragraphs.

This function gets a unit test against a real captured VTT fixture. It is the single
highest-risk piece of logic in the design.

### 3. Extract

One Opus call (`claude-opus-5`, consistent with `voice-of-customer`). The prompt carries:

- The normalized transcript
- Video metadata (title, channel, date, duration, views)
- **The current skill inventory** — every `.claude/skills/marketing-*/SKILL.md`'s name,
  description, and full content
- The RSC constraint block (below)

Returns JSON:

```json
{
  "videoId": "…",
  "creator": "…",
  "title": "…",
  "summary": "one paragraph: what this video is actually about",
  "tactics": [
    {
      "claim": "what the creator asserts",
      "mechanism": "why it supposedly works — the causal story",
      "evidence": "what the creator offers as proof, or 'assertion only'",
      "rscFit": { "score": 0, "reasoning": "…" },
      "verdict": "adopt | reject",
      "rejectReason": "required when verdict is reject",
      "targetSkill": { "name": "marketing-…", "action": "create | edit" }
    }
  ]
}
```

`targetSkill` is null when `verdict` is `reject`.

### 4. Score

Fit is judged against real numbers pulled from the repo and CLAUDE.md, assembled into a
constraint block by `buildConstraintBlock()`:

- AOV ~$50.46 trailing 90 days (not the all-time $19 figure — see `project_aov_baseline_settled`)
- Shopify ~$875/mo, Amazon ~$1,800/mo
- Repeat rate 18–22.5%; **retention is the binding constraint**, not traffic
- 12 SKUs, solo operator, no team, no media buyer
- Paid spend gated behind Tracking → CRO → Offer/AOV → Traffic (Sean's sequencing rule)
- Prime Directive: revenue, not rankings

Automatic reject criteria, stated explicitly in the prompt:

| Reject when the tactic… | Because |
|---|---|
| Requires staff, an agency, or a media buyer | Solo operator |
| Requires ad budget materially above current spend | Not available, and gated behind tracking |
| Targets a platform RSC is not on | No path to execution |
| Is motivational framing with no stated mechanism | Not actionable, not testable |
| Restates something an existing skill already covers | Duplication degrades skill triggering |
| Depends on scale RSC does not have (list size, traffic volume, review count) | Won't reproduce |

Scores are 0–10 with written reasoning. Only `adopt` verdicts reach step 5; everything
else still lands in the report.

### 5. Render

Adopted tactics are grouped by `targetSkill.name` and written to
`.claude/skills/marketing-<topic>/SKILL.md`.

Skills are **topic-scoped**, not one catch-all: Claude Code selects skills by matching
the `description` frontmatter, and a single broad `marketing` skill triggers poorly and
carries irrelevant context when it does. Expected shape: `marketing-meta-creative-testing`,
`marketing-retention-flows`, `marketing-offer-construction`.

Skills live in **project** `.claude/skills/`, not `~/.claude/skills/`. They are
RSC-specific and belong under version control. `.claude/` is tracked in this repo.

Every claim carries provenance inline: `— <Creator>, "<video title>" (<videoId>)`. A
claim that later proves wrong must be traceable to its source so the source can be
re-weighted.

#### Editing an existing skill

When `action` is `edit`, the model receives the current `SKILL.md` and returns **complete
replacement content**, not a patch. Applying model-generated diffs is an established
source of silent corruption; whole-file replacement plus validation is safer.

`validateSkillEdit(oldContent, newContent)` throws unless:

- YAML frontmatter parses and is intact
- `name` is unchanged
- `description` is non-empty
- New content is not shorter than 75% of old content, **unless** the model returned an
  explicit `supersedes` note naming what it removed and why

A guard trip throws. It does not warn and write.

### 6. Report

`data/reports/marketing-learner/<videoId>.md` — the video's summary, then every tactic
in score order with verdict and reasoning, adopted and rejected alike, then a footer
listing which skills were touched.

### 7. Pull request

Branch `feature/marketing-skill-<topic>` where `<topic>` is the most-touched skill's
topic slug (repo rule #1: `feature/` or `fix/` prefix). When a run touches more than one
skill, the branch is named `feature/marketing-skills-<n>-topics` to avoid implying it is
scoped to one. Commit the skill(s), report, and extraction JSON. Open with
`gh pr create`, PR body containing the scoring table.

Review is the diff. This repo already mandates branch-and-PR for every change, so the
approval gate Sean asked for already exists — a second bespoke approve/reject queue
would duplicate it and rot. Rejecting a video's output means closing the PR.

## CLI

```
node agents/marketing-learner/index.js <url> [<url>…]

  --extract-only   Fetch, extract, write report. Do not touch skills or open a PR.
  --no-pr          Write skills and report into the working tree. No branch, no PR.
  --refetch        Ignore the transcript cache and re-fetch.
```

Add to `package.json`: `"learn": "node agents/marketing-learner/index.js"`.

Multiple URLs in one invocation produce one PR covering all of them.

## Error handling

| Condition | Behavior |
|---|---|
| `yt-dlp` not on PATH | Message with `brew install yt-dlp`, exit 1 |
| Video has no captions in any English variant | Skip with reason, continue the batch |
| yt-dlp bot-block / HTTP 429 | Surface yt-dlp's actual stderr, suggest `--cookies-from-browser chrome`. **No retry.** |
| Anthropic `stop_reason === 'max_tokens'` | Throw, do not save. Mirrors the blog-post-writer rule — truncated structured output is corrupt, not partial. |
| Extraction JSON fails schema validation | Throw with the offending payload written to the corpus dir for inspection |
| `validateSkillEdit` guard trip | Throw. Leave the existing skill untouched. |

Completion calls `notify()` per repo convention.

### Bot detection

YouTube blocks datacenter IPs — the DigitalOcean server at 137.184.119.230 will
reliably fail with "Sign in to confirm you're not a bot" or HTTP 429. This is the
reason the tool is local-only and has no scheduler entry.

Retrying into a rate limit escalates the block. The tool fails fast and reports rather
than backing off and retrying.

## Token cost

A 60-minute video is roughly 9k words / 12k tokens; a 3-hour podcast around 40k. Both
fit comfortably in a single Opus call — no chunking needed. Cost lands near
**$0.30–0.60 per hour of video**. Opus rather than Sonnet is deliberate: the entire
value of the tool is judgment quality on the scoring step.

## Testing

`tests/agents/marketing-learner.test.js`, run under `node --test`:

- `vttToPlainText` against a real captured auto-caption VTT fixture — asserts dedupe,
  tag stripping, and that output length is plausible against the source
- `vttToPlainText` against a manual-caption VTT (no rolling window) — asserts it is not
  over-deduped
- `scanSkillInventory` — finds `marketing-*` skills, ignores others, tolerates an
  absent `.claude/skills/` directory
- `renderSkillMarkdown` — valid frontmatter, provenance present on every claim
- `validateSkillEdit` — passes a legitimate expansion; throws on frontmatter damage,
  renamed `name`, and unexplained >25% shrink
- `buildConstraintBlock` — includes the AOV and retention figures

`yt-dlp` and the Anthropic client are mocked. No network in tests.

Per repo rule #4, one manual end-to-end run on a single real video before any batch use.

## Risks

**The first few skills will be mediocre.** With no corpus to compare against, a single
confident creator is indistinguishable from a correct one. The rejects report makes this
visible early. Expect to close a PR or two; that is the gate working, not the tool
failing.

**Skill sprawl.** Mitigated by feeding the full existing skill inventory into every
extraction so later videos edit rather than duplicate. If sprawl appears anyway, the fix
is a consolidation pass, not more automation.

**yt-dlp breakage.** YouTube changes internal formats roughly quarterly and yt-dlp
follows. `brew upgrade yt-dlp` is the fix. Not worth engineering around.

## Open questions

None blocking. Deferred by choice: whether adopted tactics should also flow into
`data/context/` for the agent fleet, and whether tactic outcomes should be tracked
against actual RSC results. Both are additive later; neither changes this design.
