# Marketing Tactic Lifecycle — Design

**Date:** 2026-07-27
**Status:** Approved, pending implementation plan
**Extends:** `docs/superpowers/specs/2026-07-27-marketing-learner-design.md`
**Branch:** `feature/marketing-learner` (PR #358) — this work lands on a follow-up branch

## Problem

`marketing-learner` accumulates tactics and never retires them. Two consequences:

**Nothing can be marked wrong.** The stated purpose of the tool is a testable hypothesis
portfolio: run a tactic, and if it fails, write it off. There is no mechanism to do that.
`mergeSkillContent` only adds and revises. A falsified tactic does not merely linger — it
lingers wearing the authority of a curated skill, which is worse than never having captured
it, and the next video on the topic will happily re-add it because nothing records that it
already lost.

**The output is invisible where it is needed.** No agent reads `.claude/skills/` — verified
by grep across `agents/` and `lib/`. Eight agents read `data/context/`. The skills therefore
reach interactive sessions only, while the fleet that produces most marketing output cannot
see them. This matters most precisely where the tactics are meant to be used: the paid-ads
push, where `creative-packager` generates the creative.

## Goal

Close the loop. A tactic can be tried, marked dead, and stay dead. Live tactics reach the
agent that generates ad creative.

## Non-Goals

- **No auto-falsification from outcome data.** Attribution does not work yet (see
  `project_revenue_attribution_unreliable`), so there is nothing trustworthy to read, and a
  wrong auto-kill is worse than a manual one. Falsifying stays a human decision.
- No wiring for `campaign-creator`, `ads-optimizer`, `campaign-ad-fixer`, or the dashboard
  Ad Builder. Those optimize or assemble rather than originate creative, and none reads
  `data/context/` today. They can be pointed at the same file later.
- No UI. `--falsify` is a CLI flag.
- No revival path. Un-falsifying is a hand edit of the skill file; the case is rare enough
  that a command would be scaffolding for its own sake.

## Architecture

**The skill files are the single source of truth. The context file is generated from them
and is never hand-edited.** One place to edit, one derived artifact, no drift.

```
.claude/skills/marketing-*/SKILL.md      ← source of truth (live + falsified)
            │
            │  renderContextMirror()      regenerated after every write
            ▼
data/context/marketing-tactics.md        ← projection, read by creative-packager
```

| File | Change |
|---|---|
| `lib/marketing-learner.js` | add `falsifyTactic`, `renderContextMirror`, `extractFalsifiedClaims`; extend `validateSkillEdit` and the merge prompt |
| `agents/marketing-learner/index.js` | `--falsify` CLI path; `syncContextMirror()` after any skill write |
| `agents/creative-packager/index.js` | load the mirror, inject into the creative brief |

## Part 1 — Falsifying a tactic

### Command

```bash
npm run learn -- --falsify <skill-name> --claim "<substring>" --reason "<what happened>"
```

Example:

```bash
npm run learn -- --falsify marketing-conversion-copy-angles \
  --claim "taboo" \
  --reason "Ran on 3 deodorant variants Aug 2026; CTR 0.4% vs 1.1% control"
```

All three flags required together. `--falsify` is mutually exclusive with URLs and with
`--extract-only` / `--no-pr` / `--refetch` / `--published`; combining them throws rather
than silently ignoring one. **No LLM call and no network** — this is deterministic text
surgery, so it is free and instant.

### Matching

Tactic sections are `## <claim>` headings in the skill body. `falsifyTactic` matches
case-insensitively on substring, considering only headings **above** the `## Falsified`
section.

| Case | Behavior |
|---|---|
| Exactly one match | Move it |
| Zero matches | Throw, listing every live claim heading in that skill |
| Two or more matches | Throw, listing the matched headings so the operator can disambiguate |
| Substring matches only inside `## Falsified` | Throw: "already falsified on `<date>`" |
| Skill does not exist | Throw, listing the available `marketing-*` skills |

Ambiguity is an error, never a guess — the same discipline `--published` uses, and for the
same reason: a wrong-but-confident write is worse than a refusal.

### Output shape

The moved section keeps its body — mechanism, evidence, fit reasoning, and provenance — so
the record says what was tested, not just that something failed. Its heading is demoted from
`##` to `###`, and a stamp line is inserted directly under it:

```markdown
## Falsified

Tried here and did not work. Do not reintroduce these.

### Use taboo or negative framing to stop the scroll
**Falsified 2026-08-14:** Ran on 3 deodorant variants Aug 2026; CTR 0.4% vs 1.1% control

**Why it works:** …preserved from the original entry…

*Source: Dara Denney — "AI Static Ads Masterclass (FULL GUIDE)" (5C5VhqW9HCc)*
```

The `## Falsified` section is created on first use and always sits at the end of the file.
The date comes from an injectable `today` parameter so tests are deterministic.

### Keeping it dead

Three guards, because the merge hands whole files to a model and a prompt can be ignored:

1. **Extraction prompt.** `buildExtractionPrompt` already embeds each skill's full body, so
   the falsified entries are technically in front of the model — but nothing tells it what
   they mean. Add an explicit instruction: these were tested at this business and failed;
   reject any tactic that restates one, and say so in `rejectReason`. This matters because of
   an observed behavior — the second video's `if you…` hook was rejected as duplicating an
   existing tactic, which means the dedup check reasons about *similarity*. The mirror-image
   risk is a **near-variant of a falsified tactic** being waved through as "different enough".
2. **Merge prompt.** `mergeSkillContent` extracts the claims via
   `extractFalsifiedClaims(content)` and states them explicitly: never reintroduce these; if
   this transcript advocates one, leave it in `## Falsified` and do not move it back up.
3. **`validateSkillEdit` guard.** Throws if any claim present in the old file's `## Falsified`
   section is absent from the replacement. This is the only guard that is code rather than
   persuasion. "Quietly dropped the graveyard" is a live failure mode the existing 25%-shrink
   guard will not catch — a merge that adds two tactics while deleting one falsified entry
   grows the file.

## Part 2 — Context mirror

### `data/context/marketing-tactics.md`

Generated by `renderContextMirror(inventory)` from `scanSkillInventory()` output. Structure:

1. A generated-file header naming the source (`.claude/skills/marketing-*/SKILL.md`) and
   saying not to hand-edit it.
2. **Do not propose** — a flat list of every falsified claim across all skills, collected by
   `extractFalsifiedClaims`. A single scannable blocklist is easier for a model to honor than
   the same claims scattered through per-topic subsections.
3. One section per skill: name, trigger description, then the skill body verbatim.

Emitting the body verbatim avoids re-parsing per-tactic structure and guarantees the mirror
cannot disagree with its source.

### When it regenerates

`syncContextMirror()` runs in the agent after **any** write to `.claude/skills/` — create,
merge, or falsify — so the mirror cannot drift. It re-scans rather than tracking deltas: the
scan is a handful of file reads and correctness beats cleverness here.

## Part 3 — `creative-packager` wiring

`creative-packager` already reads `data/context/personas.json` and defaults its messaging
angle to `personas[0].angles[0]`. The mirror is loaded alongside it and injected into the
creative brief as an **angle menu** — the tactics available, plus the do-not-propose list.

**Additive only.** The existing persona-angle default is not touched; the model gains a menu
to draw from instead of a single angle. If `data/context/marketing-tactics.md` does not exist
(true until the first `learn` run), the loader returns empty and the prompt omits the block —
`creative-packager` must keep working unchanged on a checkout that has never run the learner.

## Error handling

| Condition | Behavior |
|---|---|
| `--falsify` without `--claim` or `--reason` | Throw naming the missing flag |
| `--falsify` combined with a URL or a run flag | Throw; the modes are exclusive |
| Skill not found / zero matches / multiple matches / already falsified | Throw per the matching table above |
| `--reason` empty or whitespace | Throw — an unexplained falsification is not a record |
| Malformed frontmatter in a skill during mirror sync | Already warned and skipped by `scanSkillInventory`; the mirror simply omits it |
| Mirror write fails | Throw — a silently stale mirror is the exact failure this design exists to prevent |

## Testing

Pure functions in `lib/marketing-learner.js`, unit-tested with no network:

- `falsifyTactic` — moves the matched section and demotes its heading; leaves other sections
  byte-identical; creates `## Falsified` on first use and appends to it on second; throws on
  zero, multiple, already-falsified, and empty-reason; preserves body and provenance.
- `extractFalsifiedClaims` — returns the claims, returns `[]` when the section is absent, and
  does not pick up live headings.
- `validateSkillEdit` — throws when a falsified claim disappears from the replacement; still
  passes a legitimate merge that preserves them.
- `renderContextMirror` — includes live tactics, the do-not-propose list, and skill
  descriptions; ignores non-`marketing-*` skills; returns a valid document for an empty
  inventory.
- CLI `parseArgs` — accepts the `--falsify` triple; throws on partial flags and on mode mixing.
- `creative-packager` — structural: reads the mirror path, and degrades cleanly when the file
  is absent.

Per repo rule #4, one manual end-to-end check before merge: falsify a real tactic from the
existing skills, confirm the skill and the mirror both update, then run `learn` on a video
that advocates the same tactic and confirm it is **not** resurrected.

## Risks

**The model ignores the falsified list on merge.** Mitigated by the `validateSkillEdit` guard,
which is code rather than persuasion. The prompt can be ignored; the guard cannot.

**Mirror grows unbounded.** Every video adds tactics and the mirror embeds every skill body,
so `creative-packager`'s prompt grows with the corpus. Not a problem at 5 skills; revisit past
roughly 20 by emitting claims and fit scores instead of full bodies. Noted, not pre-solved.

**Falsification is only as good as the test behind it.** A tactic killed on an underpowered
test is a permanently discarded hypothesis. The `--reason` field is required so the evidence
is on the record and a bad call is auditable later.
