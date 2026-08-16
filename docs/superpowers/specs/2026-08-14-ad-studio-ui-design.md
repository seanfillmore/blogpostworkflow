# Ad Studio UI — design

**Date:** 2026-08-14
**Branch:** `docs/ad-studio-ui`
**Status:** **IN BUILD from 2026-08-16.** Covers run setup, watching a run, judging a
batch, history, and **format learning** (growing the rotation from reference material
instead of by hand).

## Reconciliation, 2026-08-16 — read this before the body

The spec was written on 2026-08-14 and the agent changed underneath it (PRs #490–#498).
The design intent below all still holds; these specifics do not. Where they conflict, this
section wins.

| Spec says | Reality now |
|---|---|
| six formats | **nine** — `testimonial`, `stat-stack`, `state-contrast` added 2026-08-15 |
| `formats × variations × 6 targets` | **× 3.** `DEFAULT_TARGETS` is `meta` (1:1, 4:5, 9:16); the three Demand Gen plates are opt-in via `--targets all`. A default run is 3 plates + 3 comps = **6 renders ≈ $0.78**, not 108 ≈ $14 — see the addendum, a Meta target bills twice |
| judging shows `missing[]`, `mismatchedPairs[]`, `transcript` | proof.json now also carries `volume`, `fidelity`, `inventory` (`units`/`strays`/`unresolved`), `defects` and `comp`. The judging screen must render all of them, not the three the spec knew about |
| Known issue: claim-gate aborts a whole run | **Fixed.** `buildConcepts` isolates a rejected concept; the run continues |
| Known issue: three formats never rendered live | **Fixed.** All nine have rendered; `productProminent` is correct on all of them |
| one gate on copy (`claims.js`) | **two.** `health-claims.js` runs first and rejects disease/drug/therapeutic/substantiation language in any zone. A health-gate rejection is a first-class outcome the UI must show exactly like a claim-gate one |
| totals are accepted/rejected variations | `totals.artifacts` now counts **plates**, splitting `errored` (API was down) from `rejected` (gate said no). The judging screen must not conflate them — they call for opposite responses |

**Two additions the spec has no concept of, and the first one changes what the judging
screen is for:**

1. **The COMP is the artifact the operator works from.** Sean, 2026-08-16: *"I just need
   the comp to look the way it needs to be so I can then recreate it with text."* The plate
   is the compositing base; the comp shows the intended layout and is what gets rebuilt in
   Photoshop. **The judging screen must show plate and comp together for each target** — a
   contact sheet of plates alone judges the wrong artifact. The comp's own product is
   NOT trustworthy (a second generative pass drifts the label — a verified 236ml plate
   produced a 230ml comp), so the pairing must make clear which one is the base.
2. **`plateSetting` and `plateBrief` are part of a format.** Format learning must extract
   both — a learned format with no `plateBrief` throws at load, and `plateSetting`
   (`studio` | `scene`) has no default because either default silently does the wrong
   thing. Add both to the extraction field table below. `unitCount` is **per-product**
   (`data/product-images/manifest.json`), never per-format.

**Build order departs from the screen numbering below, deliberately.** Screens 3 and 4
(judge + history) come first and read runs already on disk. Runs work fine from the CLI
today; *judging* exists nowhere but a folder of JPEGs, which is why the current workflow is
copying images to a Desktop folder and building contact sheets by hand. Setup and live
progress (screens 1–2) follow, then format learning.

## Addendum, 2026-08-16 — running on the server (screens 1–2)

Approved by Sean 2026-08-16. **Where this conflicts with the screen 1–2 bodies below, this
wins**, the same way the Reconciliation section wins over the rest.

Scope of this build: screens 1 and 2 only. Not creative steering (choosing the angle, the
persona, the review to quote) and not format learning — each is its own project.

### The problem it solves

`/api/ad-studio/runs` returns `{"runs":[]}` on the server, because Ad Studio has never run
there: `data/creatives/ad-studio/` does not exist on the box. The judging screen shipped in
PR #499 is only useful where the runs are. Rather than sync run output up from a laptop,
**the server becomes where runs happen**, which is also the only way a run survives closing
the lid.

The box is ready for it and was verified before this was designed: `data/product-images/`
is present (233 MB, all 12 product directories), `GEMINI_API_KEY` is in `.env`, Node
22.22.1.

### A Meta target costs TWO renders, not one

`index.js`'s comp pass calls `budget.take()`. So a Meta plate that passes bills the plate
**and** its derived comp. Three documents were wrong about this, including this spec — and
the estimator is the whole reason screen 1 exists, so it has to use the real model:

- **Expected** — `F × V × (2m + d)`; every plate passes first attempt, every Meta plate
  gets a comp. `m` = selected Meta ratios, `d` = selected Demand Gen ratios.
- **Worst case** — `F × V × (3(m+d) + m)`; every plate burns all three attempts. A
  *rejected* plate never gets a comp, which is why the comp term stays at `m`.

At $0.13/render: the default form state (1 format, 1 variation, Meta) is **$0.78 expected,
$1.56 worst**. A full sweep (9 formats × 3 variations × `--targets all`) is **$31.59 /
$77.22**.

The README's cost table and its "default target set" line are stale for the same reason and
are corrected in the implementation PR.

### Execution: a spawned child, not the dashboard's own process

**This overrides the implementation note below that says to drive the exported functions
in-process.** The reason is the box: 1 vCPU, 961 MB RAM, ~305 MB free. In-process puts 2K
PNG buffers and base64 payloads in the same heap as the dashboard, so an OOM takes down
`seo-dashboard` rather than one run; and every `pm2 restart` — i.e. every deploy — would
kill a paid run in flight.

Instead, the pattern `agents/creative-packager` already uses here: the route writes a job
file and spawns `node agents/ad-studio/index.js --job-id <id>` detached, and **the agent
writes structured progress into that job file itself**. That honours what the original note
was protecting — it objected to scraping stdout and losing structured errors, and nothing
here scrapes stdout. One code path serves both CLI and UI runs.

### The job protocol

`data/reports/ad-studio/jobs/<jobId>.json`, written atomically (temp file + rename) because
the route polls it while the agent writes it:

```json
{ "jobId": "...", "status": "pending|running|complete|error",
  "args": { "product": "...", "variant": null, "formats": [...], "variations": 1,
            "targets": "meta", "maxRenders": 120, "dryRun": false },
  "runId": null, "startedAt": "...", "finishedAt": null, "error": null,
  "plan": { "targets": [...], "expectedRenders": 6, "worstCaseRenders": 12 },
  "events": [ { "at": "...", "stage": "copy|render|verify|done", "concept": "...",
                "variation": 1, "artifact": "plate-1x1.png", "state": "accepted",
                "attempts": 1, "reasons": [] } ],
  "totals": { "artifacts": {}, "renders": 3 } }
```

Agent side: `--job-id` joins `parseArgs`, and a `reportProgress()` writer hangs off the
`onProgress` hook `renderVariationTargets` already exposes, plus the stage boundaries that
have no hook yet — copy generated per concept, health/claim-gate rejection, run finalized.
**With no `--job-id` every write is a no-op**, so the CLI behaves exactly as it does today.

`data/reports/ad-studio/` is already gitignored, so job files need no ignore rule. They are
a few KB each and are pruned at 3 days on dashboard start, the same as `run-jobs/` —
the run's own `run.json` is the permanent record, not the job file.

Routes: `POST /api/ad-studio/launch`, `GET /api/ad-studio/job/:id`, and
`POST /api/ad-studio/job/:id/cancel` (SIGTERM — the agent's existing signal handler
archives run output before exiting).

### Screen 1, as built

The controls in the table below, plus `--targets` (Meta · All), which that table omits.
Products come from `manifest.json` with Culina filtered out, variants from the product's
subdirectories on disk, formats from `FORMATS` — all read server-side and served to the
browser, so a tenth format needs no UI edit.

`--dry-run` is a first-class button as specified, and the health-claim gate's rejections
render alongside the sourcing gate's.

### Screen 2, as built

Poll the job every 2s. Concept → variation → target tree with live state, the budget stop
surfaced when it fires, and a gate-rejected concept shown as a first-class outcome rather
than an error page. On completion, link straight into the judging screen for that `runId`.

### Guardrails — new, and the reason is that this button spends money

The dashboard is reachable over a public ngrok URL behind basic auth. A launch endpoint is
categorically different from every other route on it, so:

1. **One run at a time.** A lock file; a second launch gets 409 naming the active run. On
   1 vCPU, two concurrent runs would also only slow each other down.
2. **Server-side validation, never client-trusted.** The route builds argv and lets the
   agent's own `parseArgs` throw — it already rejects unknown formats and >10 variations.
   The browser's copy of the format list is a convenience, never the authority.
3. **A launch ceiling.** Reject a launch whose *expected* renders exceed `--max-renders`,
   and clamp `--max-renders` to 120 server-side. Show today's render count in the form:
   Gemini's project quota is a hard 250/day and a full sweep is ~95.

### The disk budget has to come down on this box

`data/creatives/` has a 10 GiB ceiling (PR #500) and the server has **9.9 GB free of 24 GB**.
Those numbers are incompatible: the budget can never fire before the disk fills, and a full
disk has already cost this project four days of cron. Nothing is wrong today — the directory
is at 252 MB — but making runs one click away is exactly what changes that.

So `enforceBudget`'s ceiling becomes env-overridable (`CREATIVES_BUDGET_BYTES`), the server
is set to **4 GiB**, and the 10 GiB default stays for local. The purge policy itself is
unchanged.

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
| Formats | `--formats` | multi-select from `FORMATS` in `agents/ad-studio/formats.js`; **nothing selected by default** — see below |
| Variations | `--variations` | number, 1–10 (the agent rejects above 10) |
| Render ceiling | `--max-renders` | number, default 120 |

**No format is selected when the form loads, and the run button is disabled until one
is.** The operator picks. This is a deliberate departure from the CLI, where omitting
`--formats` means the full rotation.

The argument is arithmetic. Six formats × 3 variations × 6 platform targets is 108
renders ≈ $14, and that is what every batch run so far has actually cost, because the
empty control was read as "leave it alone" and the CLI treats empty as everything. The
operator almost always wants one or two styles — the rotation exists so that a *batch*
does not collapse into six variants of one idea, not because six styles are wanted every
time. **A default that spends $14 when the operator touched nothing is a bad default:**
the cheapest action must be the one you get by accident, the same reasoning that makes
dry-run the default on `scripts/prune-ad-studio.mjs`. Defaulting to empty makes the
expensive path require six deliberate clicks and costs nothing but those clicks;
defaulting to all six makes the cheap path require five deliberate *un*-clicks and
charges $14 for forgetting. "Select all" stays one click away for the rare full sweep.

**Show the cost before the button, and update it as formats are ticked.** Renders are
~$0.13. Compute the estimate live as the form changes (the formula is in the addendum —
a Meta target bills a plate *and* a comp, so it is not one render per target) and display
both the expected and the worst-case-with-retries figure, **inline next to the run
button** — not in a panel elsewhere on the page, and not in a confirmation dialog that
appears after the decision is made. The number has to move while the operator is
ticking boxes, so the cost of the sixth format is visible at the moment it is being
added. With nothing selected the estimate reads $0.00 and the button is disabled, which
is the whole point: the form starts at zero and the operator watches it climb. The CLI's
absence of this is the single most expensive thing about using it today.

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

## Growing the rotation — learning a format from a reference ad

The six formats in `agents/ad-studio/formats.js` were written by hand from six reference
ads (see the source table in `2026-08-14-ad-studio-design.md`). That is the only way to
add a seventh today, and it is why there is still no seventh. The rotation was always
meant to grow; this is the path.

Follow the shape `agents/marketing-learner` already uses for this fleet's other
"learn from source material" job — **extract into a proposal, score it, put a human in
front of it, and land it as reviewable data**. Do not invent a second pattern.

### Where a style comes from

The operator supplies a reference ad: one image, or several of the same layout. Nothing
is scraped and no competitor library is crawled — the operator brings the thing they
want to steal the *shape* of.

**The reference image is used for STYLE EXTRACTION ONLY and is never passed to the image
generator.** This is the hardest-won constraint in the creative stack and it is not
negotiable here. Ad Builder learned it the expensive way: feeding the reference into the
generator alongside our product makes the model copy the reference's *subject* and
reinvent ours — a kiwi in the reference put a kiwi in our ad, and our bottle came back as
something that was not our bottle. `agents/creative-packager` therefore sends the
generator only our product photographs plus a **text** style brief, and
`routes/creatives.js`'s `analyze-reference` prompt goes further: it forbids the vision
model from naming the reference's product, brand, ingredient, text or logos at all.

The same wall applies here, with an extra reason. Ad Studio's render is a **single
generative pass** conditioned on real product photography; adding a reference image to
that call is adding a second subject to a pass that already has one. Extraction produces
**text**. The text is what enters the rotation. `render.js` never sees the reference, and
the learned format carries no image path that it could.

Archive the reference for provenance, not for rendering: the file lands under
`data/creatives/ad-studio/format-refs/<key>.<ext>` (gitignored, prunable like everything
else there) and the learned format records its SHA-256, the extraction model, and the
date. Same policy as run output — **the JSON is the permanent record and outlives the
pixels.**

### What has to be extracted

A `FORMATS` entry is not prose with a name on it. Downstream stages key off its fields,
and a wrong field does not produce a worse ad — it produces a gate that silently stops
working, or one that cannot be satisfied at $0.13 a retry. The extraction prompt must
target each field specifically, and the review screen must show each one with what it
costs to get wrong.

| Field | What it means | What goes wrong |
|---|---|---|
| `key` | kebab-case identifier. It is the `--formats` token **and** the concept-slug directory name in run output. | Must be unique across hand-written and learned formats. A collision either shadows a real format or writes two concepts into one output directory. Reject at load, do not resolve. |
| `name` | Human label in the multi-select and the reports. | Nothing downstream reads it. The cheapest field to get wrong; do not let the review screen spend the operator's attention here. |
| `awareness` | `problem` \| `solution` \| `product`. | Free text must be rejected against the enum. Angle selection uses it to re-enter one angle at a different awareness level; a rotation that drifts to all-`solution` collapses into the sameness the rotation exists to prevent. |
| `zones` | The named copy slots the layout carries. | `copy.js` emits one value per zone and the verify gate then expects every one of those strings on the frame. **A zone listed but not described in the brief is copy the frame never carries** — the gate hunts for a string that was never rendered and burns three paid attempts on every target of every variation. The inverse — a region described in the brief with no zone — is an empty area the model fills with invented lettering, which on a Demand Gen plate is the expensive defect class the copy layer cannot remove. |
| `layoutBrief` | The prose the renderer is given. | Must physically place every zone, must not name the reference's brand/product/props, and inherits the health-and-beauty restrictions already in `problem-aware` and `top-x-review`: no before/after split, no depiction of a skin condition, no invented third-party logos, badges or award marks. |
| `pairsImagesWithLabels` | **TRUE only when the layout sits a picture beside a word.** | Drives the semantic pairing check. False when it should be true and the check silently never runs — which is exactly the failure it exists for: every word spelled correctly and jojoba oil captioned as coconut oil, shipped with `ok: true`. True when it should be false and the check is asked to pair labels with pictures the layout does not have, so frames fail on a defect they cannot possibly not have. That second shape has already bitten once, when pairing was demanded of text-free plates and made every plate of a pairing format an unavoidable hard fail. |
| `productProminent` | Whether the product is rendered large enough that its **non-volume** label text is legible to a vision model. | A legibility declaration, nothing more. True on a signature-sized product and the gate demands a 6pt brand mark it cannot read — three failed attempts per target, guaranteed. False on a hero-sized product and a wrong brand mark goes un-demanded. **Do not let extraction treat this as an off switch for the label check.** The volume marking is verified on *every* format regardless of this flag (`verify.js`'s `volumeVerdict`), tolerant of illegibility and intolerant of falsehood — that is how `4 FL oz / 118ml` shipped on an 8 fl. oz. bottle, and it is not being re-opened for a learned format. |
| `zoneCapacity` | Max items per list-shaped zone, keyed to the brief's own physical description of that zone. | Caps what `copy.js` may ask for. Set too high and the copy stage requests more strings than the layout can physically carry; the image model then silently drops or rewrites the overflow (a 6-item ask rendered 4) and the gate fails on strings that were never renderable. Set too low and the frame is merely emptier than it could be — the cheap direction to err. Omit the key entirely for formats with no list-shaped zone. |

Note what extraction *cannot* know. `pairsImagesWithLabels`, `productProminent` and
`zoneCapacity` are not properties of the reference ad — they are declarations about **our**
render, which does not exist yet. A vision model reading a competitor's frame can propose
them from its composition, and that proposal is worth having, but it is a hypothesis. That
is the entire reason for the validation pass below.

### Human approval before anything renders

**A learned format is a proposal, never an addition.** Extraction ends at a review screen;
nothing is written and nothing is rendered until the operator says so.

The screen shows every extracted field, editable in place — `layoutBrief` as a textarea,
`awareness` as a three-way, the two booleans as toggles carrying their failure mode in one
line of help text, `zoneCapacity` as a row per list-shaped zone. It shows the reference
image beside them, so the operator can check the brief against what it was read from. It
does **not** offer an "accept all" that skips the read.

Before the write, run one **copy-only dry pass** against the proposed zones and capacities
— one Opus call, no pixels. It is the cheapest way to find out that a zone name is
nonsense or a capacity is impossible, and it exercises the claim gate on the new format's
copy. Only then does the button write the format.

Never auto-add. This is the one place the fleet's apply-by-default Autonomy Principle does
not hold, for the same reason `prune-ad-studio` inverts it: the mistake is expensive and
silent. A bad `pairsImagesWithLabels` does not fail loudly on the next run — it turns a
verification check off and keeps rendering.

Editing a format's fields is not the copy-editing that is out of scope below. Copy still
comes from `copy.js` and still passes through `claims.js`; a learned format changes the
*layout* the claim-gated copy is set into, and adds no route around the gate.

### How it lands

**Learned formats do not get appended to `formats.js`.** They land as one JSON file per
format in `agents/ad-studio/formats.learned/<key>.json`, which `formats.js` reads and
concatenates onto the hand-written `FORMATS` array at import — hand-written first, learned
after, key collision throwing at load rather than shadowing.

Three reasons, in order of how much they have already cost this repo:

1. **`formats.js` is worth keeping hand-written.** Most of that file is not the table, it
   is the comment block explaining why `productProminent` was narrowed and why
   `zoneCapacity` exists — the accumulated cost of five fix rounds. Machine-editing a JS
   module means round-tripping a literal through an AST or splicing it with a regex; the
   first drops the comments and the second is how you get a syntax error in a module fifteen
   agents import. A JSON sibling cannot break the parse of the file that documents the
   contract.
2. **One file per format, so concurrent work cannot conflict.** This is the
   `data/context/marketing-tactics.md` lesson, applied rather than copied. That file was a
   single shared artifact rewritten wholesale on every run, so every pair of concurrent
   learner PRs conflicted on it, and git happily 3-way-merged it into content the generator
   would never emit. Two operators learning two formats in the same week here touch two
   disjoint paths and there is no text to merge.
3. **But these are committed, and `marketing-tactics.md` is not** — the precedent stops at
   the conflict lesson and must not be carried further. That file is a *projection*:
   deleting it loses nothing, because `renderContextMirror(scanSkillInventory(...))`
   rebuilds it from the skills. A learned format is a projection of nothing. It is the
   source of truth for that format, derivable from no other file in the repo, and if it is
   gitignored then the seventh format exists on one laptop and the production box renders
   six. It is **input, not output** — that distinction, not the file's origin, is what
   decides whether a generated-looking file gets committed.

Committed also means the format arrives through a pull request, which is the last human
read before it can spend money on the server. A learned format's diff is one small JSON
file with a prose brief in it — the most reviewable artifact this pipeline produces.

### Proving a learned format works

**A learned format has never rendered.** Until it has, it is `status: "unproven"`:
`selectFormats` refuses it for a normal batch and the multi-select shows it disabled with
its reason.

Promotion requires one **validation pass** — one product, one concept, `--variations 1`.
Six renders, ≈$0.78. All six targets, not just the cheap one: the finished frames and the
Demand Gen plates run different verification paths (defect question inverted, pairing check
applied to one and not the other), so validating only the Meta frames leaves half the
format untested. The operator inspects the six frames on the judging screen — the same
screen, no separate viewer — and either promotes the format to `status: "proven"` or goes
back and edits the fields.

This step is not caution for its own sake. Four of the six hand-written formats had never
rendered live until they were run for the first time; **all four worked, but two of them —
`manifesto` and `problem-aware` — would not pass the gate until `productProminent` was set
to `false`**, because both render the product deliberately small and the gate was demanding
a brand mark no vision model could read off a signature-sized bottle. Nothing about either
layout brief revealed that. It was discovered by rendering them, and finding it cost three
paid retries per target until the flag was corrected. A field that can only be confirmed by
rendering has to be confirmed by rendering — for $0.78, once, rather than inside a $14
batch.

## Explicitly out of scope for v1

- Editing copy in the browser and re-rendering. The claim gate exists precisely because
  hand-edited ad copy is how invented claims get onto live ads; a UI that lets someone
  type a headline and render it bypasses the gate. If this is ever built, edited copy must
  re-enter through the claim gate, not around it.
- Uploading to Meta or Google. Export is a download.
- Veo video (deferred at the agent level too).
- Amazon listing images — different compliance rules entirely.

## Implementation notes

- ~~**Do not shell out to the CLI.**~~ **Superseded by the addendum 2026-08-16.** The
  concern was real — stdout scraping loses structured progress and makes errors
  unparseable — but running in-process on a 1 vCPU / 961 MB box means an OOM kills the
  dashboard and every `pm2 restart` kills a paid run. The agent is spawned as a detached
  child that writes structured progress into its own job file, which scrapes nothing.
- **Long-running work needs a job, not a request.** A run outlives an HTTP request. Follow
  the existing pattern in `agents/creative-packager` (job file + status polling) rather
  than inventing a queue.
- **Never render the raw `.env` or API keys into any response.** The agent reads `.env`
  directly; the route must not echo it.
- **The 24 GB server disk is a real constraint.** One variation is ~7.6 MB and a default
  run ~137 MB. A UI that makes runs easy to launch makes this urgent. **Half-done:** the
  retention policy shipped in PR #500 (`lib/creatives-budget.js`, swept at the end of every
  run), but its 10 GiB ceiling exceeds the server's free disk — see the addendum.

## Known agent-side issues this UI will expose

Both are worth fixing in the agent, not papering over in the UI:

1. **Copy density.** Per-zone capacity hints landed, but three formats — `manifesto`,
   `problem-aware`, `top-x-review` — had still never rendered live as of this writing.
   They have since, along with `offer-focused`; two of them needed `productProminent`
   corrected before the gate would pass them. That is the precedent behind the validation
   pass in "Proving a learned format works" above, and the reason an unrendered format —
   hand-written or learned — is not a format you can trust in a batch.
2. **Claim-gate granularity.** A single unsourced claim in one concept aborted an entire
   four-concept run in real use (fix in `fix/ad-studio-claim-isolation`). The UI should
   show a gate-rejected concept as a first-class outcome, not an error page.
