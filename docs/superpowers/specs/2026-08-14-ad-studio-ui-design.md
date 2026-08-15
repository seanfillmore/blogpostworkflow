# Ad Studio UI — design

**Date:** 2026-08-14
**Branch:** `docs/ad-studio-ui`
**Status:** spec only — not scheduled, not built

## Why

`agents/ad-studio` shipped in PR #473 and works, but it is CLI-only. Running a batch
means remembering flags, and reviewing the output means opening a timestamped folder and
inspecting JPEGs by hand against a `proof.json` you have to read separately. The judging
step is where the operator's time actually goes, and right now the tool gives it no help.

This is a separate project from the agent. The agent's contract does not change.

## What already exists (build on this, do not rebuild it)

`agents/dashboard/` is a Node app on PM2 (`seo-dashboard`, port 4242).

- `agents/dashboard/routes/creatives.js` — API routes for the Creatives tab
- `agents/dashboard/lib/creatives-store.js` — session persistence, `GEMINI_MODELS`
- `agents/dashboard/public/js/dashboard.js` — browser JS. `creativesState` at ~line 2825
  already holds `{ mode: 'studio', adBuilder: {...} }`, and `switchCreativesMode(mode)`
  at ~line 2859 already toggles between **Studio** and **Ad Builder** over one shared
  image canvas.

**Ad Studio is a third mode on that existing toggle.** Not a new tab, not new
infrastructure. Session storage, the image canvas, and the model list are already there.

Browser HTML/CSS/JS lives in `agents/dashboard/public/` and is edited directly — no
template-literal escaping rules apply there. (The escaping rule applies only to browser JS
embedded inside a server-side template literal; check before assuming.)

## The one thing this UI is for

**Judging a batch quickly, and keeping what survives.**

Generation is already solved and takes ~27s per render with no human input. What the
operator does is decide which frames ship. Every screen below serves that, and anything
that does not serve it is out of scope for v1.

## Screens

### 1. Set up a run

One form, mapping to the CLI flags that already exist:

| Control | Flag | Notes |
|---|---|---|
| Product | `--product` | select, from `data/product-images/manifest.json`; exclude Culina entries |
| Variant | `--variant` | select, populated from the product's subdirectories |
| Formats | `--formats` | multi-select from `FORMATS` in `agents/ad-studio/formats.js`; all six default on |
| Variations | `--variations` | number, 1–10 (the agent rejects above 10) |
| Render ceiling | `--max-renders` | number, default 120 |

**Show the cost before the button.** Renders are ~$0.13 and a default run is 108 of them
(~$14). Compute `formats × variations × 6 targets` live as the form changes and display
both the expected and the worst-case-with-retries figure. The CLI's absence of this is
the single most expensive thing about using it today.

**Dry run is a first-class button, not a checkbox.** `--dry-run` costs nothing, runs the
claim gate, and prints the copy with each claim's source. Given the gate hard-stops a
concept, seeing the copy before paying for pixels is the natural first action. Show the
resulting copy and per-claim sources inline, then offer "Render this" from that screen.

### 2. Watch it run

Runs take minutes. Stream progress per target — the agent already logs one line per
artifact with attempt count. Show concept → variation → target as a tree with live state
(rendering / verifying / accepted / rejected / skipped-for-budget), and surface the
budget stop prominently if it fires.

### 3. Judge the batch — the screen that matters

A contact sheet of every artifact in the run, with the verdict attached to each frame.

Requirements:

- **Verdict on the frame, not in a file.** Accepted and rejected frames currently sit in
  the same directory and look identical; only `proof.json` distinguishes them. Put the
  state on the tile.
- **Say why it failed, in words, next to the image.** `proof.json` already carries
  `missing[]`, `mismatchedPairs[]` and the full `transcript`. Render them as "the ad was
  supposed to say X, the render says Y" — the operator should never open JSON.
- **Show the copy that was requested** beside the frame, so a rejection can be judged in
  one glance.
- **Keep / discard per frame**, and an export of everything kept.
- **Group by concept**, since the format rotation is the unit of creative variety and
  comparing across formats is the actual decision.

A rejected frame is often still useful — the gate rejects for a missing string, not for
being ugly. Let the operator override a rejection deliberately, and record that the
override happened. Do not let an override silently rewrite `proof.json`.

### 4. History

List past runs from `data/creatives/ad-studio/<run-id>/run.json`. Each run already
records totals, per-variation proofs, render count and estimated cost. Link back into
screen 3 for any past run.

## Explicitly out of scope for v1

- Editing copy in the browser and re-rendering. The claim gate exists precisely because
  hand-edited ad copy is how invented claims get onto live ads; a UI that lets someone
  type a headline and render it bypasses the gate. If this is ever built, edited copy must
  re-enter through the claim gate, not around it.
- Uploading to Meta or Google. Export is a download.
- Veo video (deferred at the agent level too).
- Amazon listing images — different compliance rules entirely.

## Implementation notes

- **Do not shell out to the CLI.** `agents/ad-studio/index.js` exports its pure functions
  and its stage helpers; the route should drive those directly, the way
  `routes/creatives.js` drives `creative-packager`. Shelling out loses structured progress
  and makes errors unparseable.
- **Long-running work needs a job, not a request.** A run outlives an HTTP request. Follow
  the existing pattern in `agents/creative-packager` (job file + status polling) rather
  than inventing a queue.
- **Never render the raw `.env` or API keys into any response.** The agent reads `.env`
  directly; the route must not echo it.
- **The 24 GB server disk is a real constraint.** One variation is ~7.6 MB and a default
  run ~137 MB. `data/creatives/ad-studio/` is gitignored but not pruned. A UI that makes
  runs easy to launch makes this urgent — v1 should include a retention policy, or at
  minimum surface total disk used and offer deletion of old runs.

## Known agent-side issues this UI will expose

Both are worth fixing in the agent, not papering over in the UI:

1. **Copy density.** Per-zone capacity hints landed, but three formats — `manifesto`,
   `problem-aware`, `top-x-review` — had still never rendered live as of this writing.
2. **Claim-gate granularity.** A single unsourced claim in one concept aborted an entire
   four-concept run in real use (fix in `fix/ad-studio-claim-isolation`). The UI should
   show a gate-rejected concept as a first-class outcome, not an error page.
