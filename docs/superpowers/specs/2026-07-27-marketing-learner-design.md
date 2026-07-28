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

- No channel watchlist, no polling, no scheduler entry, no cron. On-demand only —
  Sean wants to inject videos he encounters, not subscribe to firehoses. This is a
  preference, not a technical limit; see Deferred below.
- No dashboard UI.
- No `data/context/*.md` artifact for the agent fleet. Skills only, for now.
- No audio transcription fallback (Whisper/Deepgram). If a video has no captions,
  it is skipped.

## Architecture

Three files:

| File | Responsibility |
|---|---|
| `agents/marketing-learner/index.js` | CLI, orchestration, Anthropic calls, git/PR |
| `lib/transcript-source.js` | Transcript + metadata retrieval. The only file that knows about TranscriptAPI. |
| `lib/marketing-learner.js` | Pure functions: skill inventory, skill rendering, constraint block, validation guards |

`lib/marketing-learner.js` is network-free and unit-testable. `lib/transcript-source.js`
exists as a seam: it exposes one function, `fetchTranscript(videoUrl)`, returning a
normalized `{ videoId, title, creator, creatorUrl, durationSeconds, language, text }`. If the
vendor disappears or prices badly, a yt-dlp implementation drops in behind the same
signature without touching the agent.

### Transcript provider

[TranscriptAPI](https://transcriptapi.com/docs/api/), base `https://transcriptapi.com/api/v2`,
auth `Authorization: Bearer $TRANSCRIPTAPI_KEY`.

Chosen over local `yt-dlp` for three reasons:

1. **Clean segments.** Returns non-overlapping `{text, start, duration}` or `format=text`
   plain prose. YouTube's auto-caption VTT uses a rolling window that repeats each phrase
   two to three times; parsing it correctly is subtle, and getting it wrong yields a
   transcript ~2.5× too long that reads as a stutter and silently degrades extraction
   quality. Using the API removes that failure mode rather than testing against it.
2. **No datacenter-IP blocking.** YouTube blocks cloud IPs; yt-dlp from the DigitalOcean
   box would fail with "confirm you're not a bot" / HTTP 429. The vendor absorbs this,
   which is what makes a future server-side run possible at all.
3. **No local binary, no quarterly breakage.** YouTube changes internal formats roughly
   every quarter. That becomes the vendor's maintenance burden, not ours.

Cost: 1 credit per successful transcript; **failed requests are not charged**. Free tier
is 100 credits with no card; paid is $54/yr for 1,000 credits/month. At on-demand volume
this is free-tier territory for months, and negligible against the ~$0.30–0.60 in Opus
tokens each video costs to *analyze*. The transcript was never the expensive part.

New `.env` key: `TRANSCRIPTAPI_KEY`.

### Data locations

| Path | Committed? | Contents |
|---|---|---|
| `data/marketing-corpus/<videoId>/` | No — gitignored | `transcript.txt`, `meta.json` |
| `data/reports/marketing-learner/<videoId>.md` | Yes | Human-readable scoring report incl. rejects |
| `data/reports/marketing-learner/<videoId>.json` | Yes | Structured extraction output |
| `.claude/skills/marketing-<topic>/SKILL.md` | Yes | The actual deliverable |

Transcripts are gitignored: large, re-fetchable, and of no review value. The extraction
JSON is committed because it is the auditable record of what the model concluded from a
transcript that no longer exists in the repo.

Requires adding `data/marketing-corpus/` to `.gitignore`.

## Flow

### 1. Fetch

`lib/transcript-source.js`:

1. `GET /youtube/info?video_url=<url>` — **costs 0 credits**. Confirms the video exists
   and returns `available_languages`. If no English variant is listed, skip the video
   without spending anything.
2. `GET /youtube/transcript?video_url=<url>&format=text&include_timestamp=false&send_metadata=true&language=<list>`
   — 1 credit.

Both responses are cached to `data/marketing-corpus/<videoId>/`; re-running a URL reuses
the cache unless `--refetch`. This matters more than it did with yt-dlp, because re-runs
now cost money rather than bandwidth.

#### Verified response shapes (probed live 2026-07-27)

`/youtube/info` → `{ video_id, metadata, available_languages }`. Language codes
distinguish manual from auto-generated: `en` is human-written, **`asr-en` is
auto-generated**. Build the `language` priority list from this — manual first, ASR as
fallback — rather than guessing variant names.

`/youtube/transcript` → `{ video_id, language, transcript, metadata, length_seconds, lengthText }`
where `metadata` is `{ title, author_name, author_url, thumbnail_url }`.

**`include_timestamp=false` is required.** It defaults to `true` and applies even when
`format=text`, producing `[1.36s] ` prefixes on every line. This is not in the docs'
parameter description and is easy to miss.

Residual normalization is one regex: caption line wrapping leaves newlines mid-sentence
(`"You know the rules\nand so do I"`), so collapse `\n` and runs of whitespace to single
spaces. That is the whole of it — three lines in `lib/transcript-source.js`, not a module.
There is no rolling-window duplication in the API output.

`404` error body is `{ "detail": "Video <id> not found or unavailable" }`. No
credit-remaining headers are returned on any response.

#### Publish date: supplied by the operator

Neither endpoint returns one. `metadata` carries only title, author, and thumbnail. Recency
is **not** scraped from a second source; it is passed in.

Since videos are hand-picked, the operator is already looking at the upload date on the
YouTube page. `--published YYYY-MM-DD` carries it in. Optional; when absent, the extractor
falls back to a `recencySignals` string — era cues found in the transcript itself ("since
the iOS 14 update", "the new Reels placement") — which is **inferred and labeled as such**,
never presented as authoritative.

Validation, in `lib/marketing-learner.js`:

- Must parse as a real calendar date in `YYYY-MM-DD` form
- Must not be in the future
- Warn (do not fail) when older than ~4 years

**A single `--published` with multiple URLs is an error, not a broadcast.** Stamping one
date across several videos produces confident, wrong, authoritative-looking metadata that
silently skews scoring and that nobody will think to re-check. Repeatable `--published`
flags pair positionally with URLs when the counts match; otherwise run once per video.

#### Why an authoritative date is worth the manual step

Staleness is not uniform, and this is the distinction `recencySignals` could not support:

| Tactic class | Decay | Example |
|---|---|---|
| Platform mechanics | Fast — treat >18mo with suspicion | Ad account structure, algorithm behavior, placement names, attribution windows |
| Durable principle | Slow — age is nearly irrelevant | Offer construction, positioning, retention psychology, pricing logic |

A 2022 Meta campaign structure describes a system that no longer exists. A 2019 offer
principle is fine. Without a real date the model must treat "old" as one undifferentiated
signal; with one it can apply the table above. This rule goes in the constraint block, and
`rscFit.reasoning` must name the tactic class when age is what drove the score down.

### 2. Extract

One Opus call (`claude-opus-5`, consistent with `voice-of-customer`). The prompt carries:

- The transcript
- Video metadata (title, channel, duration, and publish date when `--published` was given)
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
  "recencySignals": "inferred era cues found in the transcript, or null",
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

### 3. Score

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

Scores are 0–10 with written reasoning. Only `adopt` verdicts reach step 4; everything
else still lands in the report.

### 4. Render

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

### 5. Report

`data/reports/marketing-learner/<videoId>.md` — the video's summary, then every tactic
in score order with verdict and reasoning, adopted and rejected alike, then a footer
listing which skills were touched.

### 6. Pull request

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

  --published <YYYY-MM-DD>  Upload date of the video. Optional but recommended — the API
                            does not provide it. Repeatable, pairing positionally with
                            URLs. Supplying one date for multiple URLs is an error.
  --extract-only   Fetch, extract, write report. Do not touch skills or open a PR.
  --no-pr          Write skills and report into the working tree. No branch, no PR.
  --refetch        Ignore the transcript cache and re-fetch (costs a credit).
```

Add to `package.json`: `"learn": "node agents/marketing-learner/index.js"`.

Multiple URLs in one invocation produce one PR covering all of them.

## Error handling

| Condition | Behavior |
|---|---|
| `TRANSCRIPTAPI_KEY` missing | Message pointing at `.env`, exit 1 |
| `401` invalid key | Fail fast, do not retry |
| `402` out of credits | Clear message with the billing URL from the response body, exit 1 |
| `404` no transcript / no English caption | Skip with reason from the body's `detail` field, continue the batch |
| `408`, `429`, `503` | Retry with backoff via `lib/retry.js`, capped; then skip the video |
| Anthropic `stop_reason === 'max_tokens'` | Throw, do not save. Mirrors the blog-post-writer rule — truncated structured output is corrupt, not partial. |
| Extraction JSON fails schema validation | Throw, writing the offending payload to the corpus dir for inspection |
| `validateSkillEdit` guard trip | Throw. Leave the existing skill untouched. |

Completion calls `notify()` per repo convention.

Note the pre-flight `/youtube/info` check is free, so the common "no captions" case
costs nothing and never consumes a credit.

## Token cost

A 60-minute video is roughly 9k words / 12k tokens; a 3-hour podcast around 40k. Both
fit comfortably in a single Opus call — no chunking needed. Cost lands near
**$0.30–0.60 per hour of video**. Opus rather than Sonnet is deliberate: the entire
value of the tool is judgment quality on the scoring step.

## Testing

`tests/agents/marketing-learner.test.js`, run under `node --test`:

- `scanSkillInventory` — finds `marketing-*` skills, ignores others, tolerates an
  absent `.claude/skills/` directory
- `renderSkillMarkdown` — valid frontmatter, provenance present on every claim
- `validateSkillEdit` — passes a legitimate expansion; throws on frontmatter damage,
  renamed `name`, and unexplained >25% shrink
- `buildConstraintBlock` — includes the AOV and retention figures, and the tactic-decay table
- `parsePublishedFlags` — pairs dates to URLs positionally; throws on one-date-many-URLs,
  on a malformed or non-calendar date, and on a future date; warns beyond ~4 years
- `lib/transcript-source.js` against recorded fixture responses (captured from the live
  probe) — normalization of a successful payload including newline collapse, correct
  language-priority selection from `available_languages` (manual `en` chosen over
  `asr-en`), and correct classification of `402` / `404` / `429`

The HTTP client and the Anthropic client are mocked. No network in tests.

Per repo rule #4, one manual end-to-end run on a single real video before any batch use.

## Risks

**The first few skills will be mediocre.** With no corpus to compare against, a single
confident creator is indistinguishable from a correct one. The rejects report makes this
visible early. Expect to close a PR or two; that is the gate working, not the tool
failing.

**Skill sprawl.** Mitigated by feeding the full existing skill inventory into every
extraction so later videos edit rather than duplicate. If sprawl appears anyway, the fix
is a consolidation pass, not more automation.

**Vendor dependency.** TranscriptAPI is a small provider. If it folds, prices badly, or
degrades, the blast radius is one file — `lib/transcript-source.js` — behind a
single-function interface. yt-dlp remains the documented fallback implementation. This
is the reason for the seam; without it the risk would not be acceptable.

**Thinner metadata than yt-dlp.** Confirmed by live probe: no view count, no description,
and no publish date. View count was only ever weak credibility signal and is not worth a
second provider. Publish date is solved by `--published`, which is better than what
yt-dlp would have given us anyway — operator-supplied and authoritative rather than parsed.

The residual risk is that `--published` is *optional*, so the fallback path (inferred
`recencySignals`) will get used whenever it is forgotten. That is acceptable for on-demand
use. If this ever becomes bulk ingest, make the flag required — an unattended pipeline with
no reliable date cannot apply the platform-mechanics-vs-principle decay rule at all.

## Deferred

Not in scope, and none of these change the design:

- **Channel watchlist.** Now cheap: `GET /youtube/channel/latest` is free (RSS, 15 newest)
  and `GET /youtube/channel/videos` is 1 credit per ~100 items. Sean chose on-demand
  input; noting only that this door is inexpensive to open later.
- **Server-side / scheduled runs.** The datacenter-IP blocking that ruled this out under
  yt-dlp no longer applies. Still out of scope by choice, not by constraint.
- Flowing adopted tactics into `data/context/` for the agent fleet.
- Tracking tactic outcomes against actual RSC results.
