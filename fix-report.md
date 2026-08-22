# Fix report — `fix/leaks-query-field`

Worktree: `/Users/seanfillmore/Code/Claude/.claude/worktrees/leaks-query-field`
Branch: `fix/leaks-query-field` (confirmed via `git branch --show-current` before every test run and before committing)

All three fixes were developed test-first: RED evidence was captured by stashing
just the implementation file, running the new test against the pre-fix code, then
popping the stash and re-running to confirm GREEN. That evidence is reproduced below.

---

## Fix 1 — impression-leaks feed was missing the query text (CRITICAL)

**File:** `agents/gsc-query-miner/leaks-feed.js`

### Root cause

`buildImpressionLeaksFeed` destructured `{ query, impressions, clicks, position }`
off each leak row, but rows come from `lib/gsc.js` (`getTopKeywords` /
`findImpressionLeaks`), whose documented and actual shape is
`{ keyword, clicks, impressions, ctr, position }`. `query` was always `undefined`,
and `JSON.stringify` silently drops keys whose value is `undefined`, so the written
feed carried no `query` key at all — confirmed against the real
`data/reports/gsc-query-miner/impression-leaks.json` on the server (288 leaks,
each `{"clicks":0,"impressions":N,"position":N}`).

### Field-name decision

**Emit `query`**, mapped from the input row's `keyword` field:

```js
.map(({ keyword, impressions, clicks, position }) => ({ query: keyword, impressions, clicks, position }))
```

Rationale: `lib/demand-questions.js`'s `deriveSeeds` (`l.query`, line 135) and
`filterLeaksToSkinCluster` (`l?.query`, line 68) already read `.query` — that's
the downstream contract the feed exists to satisfy, and both of those functions
are documented and tested independently. Renaming the *output* field to `keyword`
would have meant also touching `deriveSeeds`, `filterLeaksToSkinCluster`, and every
test that pins their current field name, for no behavioral benefit — the bug was
purely in what `leaks-feed.js` read from its *input*, not in what name the
downstream artifact uses.

### Tests

- `tests/agents/gsc-query-miner-leaks.test.js` — rewritten so its fixture rows use
  the **real** `lib/gsc.js` shape (`keyword`, not `query`). Added:
  - "every emitted leak carries non-empty query text"
  - "only the four fields a consumer needs are carried, and the key is `query` —
    not silently dropped" (also asserts the value, not just the key)
- `tests/lib/demand-questions-leaks-integration.test.js` (new file) — the
  end-to-end check the brief called out as missing: a real-shaped GSC row →
  `buildImpressionLeaksFeed` → `filterLeaksToSkinCluster` → `deriveSeeds`, asserting
  a `gsc_leak`-origin seed comes out carrying the actual query text. A second test
  pins `deriveSeeds`' pre-existing blank-check by reproducing the old bug shape
  directly (a leak with `query: undefined`) and asserting it produces no seed.

### RED evidence

Stashing only `leaks-feed.js` (tests unchanged) and running the new/updated tests
against the pre-fix code:

```
✖ the feed carries the leak query text ... AssertionError
  actual: [ { query: undefined, impressions: 900, ... }, { query: undefined, impressions: 300, ... } ]
✖ every emitted leak carries non-empty query text
  actual: 'undefined', expected: 'string'
✖ only the four fields a consumer needs are carried ...
  actual: undefined, expected: 'q'
```//gsc-query-miner-leaks.test.js

```
✖ a real-shaped GSC leak row survives buildImpressionLeaksFeed -> deriveSeeds ...
  AssertionError: actual 'undefined', expected 'string'
```//demand-questions-leaks-integration.test.js (2 pass / 1 fail — the second test,
which reproduces the bug shape directly rather than going through the buggy
function, was green even pre-fix, as expected)

### GREEN (post-fix)

```
tests/agents/gsc-query-miner-leaks.test.js: 5 pass, 0 fail
tests/lib/demand-questions-leaks-integration.test.js: 2 pass, 0 fail
```

---

## Fix 2 — `cavit` in the toothpaste cluster regex could never match

**File:** `lib/keyword-index/cluster.js`

### Root cause

The toothpaste rule's alternation ends every alternative in a shared trailing `\b`.
Ten of the eleven alternatives are complete words/phrases, so the boundary is
naturally satisfied. `cavit` is not a word on its own — it only ever occurs as a
prefix of "cavity"/"cavities"/"cavitation" — so the character immediately after a
match is always a word character (`y`, `i`, `a`...), `\b` never fires, and the
alternative was dead code. Confirmed before the fix:

```
"is coconut oil good for cavities" -> coconut oil   (should be toothpaste)
"cavities"                          -> unclustered
```

I checked every other alternative in the same rule for the identical defect
(a bare stem with no independent word usage, wrapped in the same trailing `\b`):
`toothpaste`, `fluoride`, `s\.?l\.?s\.?`, `sodium lauryl sulfate`, `hydroxyapatite`,
`whiten(?:ing)? teeth`, `teeth`, `tooth`, `enamel`, `oral care`, `mouthwash` are all
complete words or phrases that occur standalone in real queries (e.g. `tooth` in
"sensitive tooth pain") — none of them share `cavit`'s defect of being a
never-standalone stem. `tooth` does miss compound forms like "toothache" with no
space, but that's a coverage gap on a real, independently-matching word, not the
"can never match" defect `cavit` had — I left it alone rather than broaden scope
beyond what was reported.

### Fix

```js
cavit\w*
```

`\w*` consumes the rest of the word before the shared trailing `\b` is evaluated,
so the boundary lands on the actual word edge. Verified this doesn't introduce
false positives on words that merely *contain* the substring without a boundary in
front of it: `"concavity of a lens"` and `"excavation site"` still classify
`unclustered` (the leading `\b` still requires a non-word character immediately
before `cavit`, and `excavation`/`concavity` don't have one there).

### What existing behaviour shifts

`assignCluster` has three consumers, all affected identically and in the same
direction:

- `lib/keyword-index/merge.js` → `agents/keyword-index-builder`, feeding
  `data/keyword-index.json` (~2,215 keywords, read by 15 agents)
- `lib/bing-keyword-gap.js`
- `lib/demand-questions.js`'s `filterLeaksToSkinCluster` (used by
  `agents/demand-miner`)

**The shift:** any keyword mentioning "cavity"/"cavities"/"cavitation" with **no
other** toothpaste term present (no "toothpaste", "fluoride", "tooth", etc.) —
e.g. "is coconut oil good for cavities", a real GSC-leak-shaped query — now
classifies `toothpaste` instead of falling through to whatever bucket matched
next (typically `coconut oil`, sometimes `lotion`, occasionally `unclustered`).
This is a correction, not a regression: per CLAUDE.md's Prime Directive, the
toothpaste cluster is ≈268 clicks / $0 revenue, so a cavity query mislabeled as
skin was both miscategorized in the keyword index and — via
`filterLeaksToSkinCluster` — would have consumed a paid `demand-miner` DataForSEO
seed mining an oral-care query under a `cluster: "skin"` artifact. Grepped every
test fixture in the repo for `cavit`; none besides the ones I added assert a
cluster outcome for a cavity-bearing query, so nothing else needed updating.

### Tests

`tests/lib/keyword-index/cluster.test.js` — added:
- "cavity/cavities/cavitation match the toothpaste cluster, even with no other
  toothpaste term present" (7 assertions incl. bare `cavity`/`cavities`/
  `cavitation`, and the concrete leak-shaped query from the brief)
- "the cavit fix does not introduce false positives on words that merely contain
  the substring" (`concavity`, `excavation`)

### RED / GREEN

RED (stashed `cluster.js` only):
```
✖ cavity/cavities/cavitation match the toothpaste cluster ...
  actual: 'coconut oil', expected: 'toothpaste'
```
GREEN: `tests/lib/keyword-index/cluster.test.js`: 7 pass, 0 fail. Also re-ran
`tests/lib/keyword-index/merge.test.js`, `tests/lib/bing-keyword-gap.test.js`,
`tests/lib/demand-questions.test.js` (88 tests total) to confirm the three
consumers' own suites still pass unchanged.

---

## Fix 3 — dangling persona id in the operator-angles overlay

**Files:** `lib/operator-angles.js`, `agents/demand-miner/index.js`

Ruling from the brief: **keep the throw** for `applyOperatorOverlay` itself — it's
correct that an authored angle naming a persona id absent from `personas.json`
fails loudly for the four copy-facing readers (`ad-brief`, the dashboard's
ad-brief route, `ad-studio`, `creative-packager`). Two changes only:

### 3a — actionable message (`lib/operator-angles.js`)

The old message named the missing `personaId` and the known set but not *which*
authored angle(s) triggered it, and its "re-point the angle" advice didn't name
the file. New message names the offending angle id(s) (all of them, if more than
one authored angle names the same missing persona), the missing `personaId`, the
file to edit (`data/context/operator-angles.json`), and the two concrete actions
(update `personaId` on that angle, or remove the entry).

Also fixed a latent bug in the loop while I was in there: it iterated
`byPersona.keys()` (just the persona id) and had no way to report which angle(s)
belonged to a given unknown persona id — changed to `byPersona.entries()` so the
angle id list is available to put in the message.

Existing test `tests/lib/operator-angles.test.js` line 114-119 pinned the *old*
message text via regex; updated it to match the new phrasing (kept the substring
`not in personas.json` intact, since a second, unrelated test at
`tests/lib/operator-angles.test.js:262`, in `creative-packager`'s own suite,
regex-matches that literal substring — verified it still passes). Added two new
tests: one asserting all four required pieces of information are present, one
asserting multiple offending angle ids are all listed.

### 3b — demand-miner degrades instead of dying (`agents/demand-miner/index.js`)

`runDemandMiner` now wraps its `applyPersonaOverlay(...)` call in try/catch. On
catch: logs a warning, sends one `notify()` (`status: 'error'`, no `immediate` —
deferred to the 5 AM digest, matching how the agent's other degradation paths
already notify) naming `operator-angles.json` as the cause and telling the
operator what to do, sets `personasFile = null` and an explicit `overlayFailed`
flag, and continues. `partial` is set to `seedPartial || overlayFailed` — belt
and suspenders, since `deriveSeeds` already treats `personas: null` as a partial
run on its own, but the explicit OR makes the run unambiguously partial even if
`deriveSeeds`' own logic changes later. Nothing else in the function changed: with
`personasFile` null, the existing leaks-only code path (already exercised by the
"missing personas" test) runs unmodified.

Only `agents/demand-miner/index.js` was touched. `lib/operator-angles.js`'s
`applyOperatorOverlay`/`overlayPersonas` still throw exactly as before for
`ad-brief`, the dashboard's ad-brief route, `ad-studio`, and `creative-packager` —
verified by re-running their existing test suites unchanged.

### Tests (`tests/agents/demand-miner.test.js`)

- "a throwing persona overlay degrades the run to leaks-only, sets partial, and
  notifies naming operator-angles.json" — full leak+persona fixture, overlay
  throws, asserts: run completes and writes, `partial === true`, every question's
  `seed_origin` is `gsc_leak` (no persona seeds survived), exactly one `notify()`
  call with `status: 'error'`, no `immediate`, and the subject/body containing
  `operator-angles.json`.
- "a throwing persona overlay still lets a zero-leak-seed run report cleanly" —
  both sources absent AND the overlay throws: confirms the pre-existing
  "nothing to do" path (no seeds → return early, no artifact write) still fires
  correctly and doesn't double-notify.

### RED / GREEN

RED (stashed `agents/demand-miner/index.js` only): both new tests **threw** out
of `runDemandMiner` (the overlay's `Error` propagated uncaught), exactly the
failure mode being fixed.

GREEN: `tests/agents/demand-miner.test.js`: 27 pass, 0 fail (25 pre-existing + 2
new). `tests/lib/operator-angles.test.js`: 19 pass, 0 fail (17 pre-existing + 2
new).

---

## Full suite

Measured `npm test` (Node 22.23.1 via `nvm use`) before touching anything, and
again after all three fixes:

| | tests | pass | fail | cancelled |
|---|---|---|---|---|
| Baseline (pre-fix, stashed) | 2219 | 2219 | 0 | 0 |
| Final (all fixes + new tests) | 2228 | 2228 | 0 | 0 |

Net +9 tests, all passing, 0 cancelled both times (checked explicitly per
CLAUDE.md's Node-version note — a cancelled test prints beside `# fail 0` and
reads like a pass).

`git status --short data/` — empty, both before and after.

Confirmed `agents/demand-miner/index.js` does not run on import: `node -e
"import('./agents/demand-miner/index.js')..."` printed "IMPORTED OK, no run
triggered" with no network/LLM activity — the `process.argv[1].endsWith(...)`
guard at the bottom of the file is unchanged.

Did not run `agents/gsc-query-miner/index.js` or `agents/demand-miner/index.js`'s
live path at any point.

## Corrections to the brief

Nothing in the brief turned out to be wrong. One thing worth flagging as a
judgment call rather than a correction: the brief's fix-2 instruction to "check
every alternative in that regex for the same word-boundary mistake" surfaced one
near-miss (`tooth` doesn't match compound forms like "toothache") that is a
different, narrower kind of gap than `cavit`'s — `tooth` matches every case where
it appears as an actual word, `cavit` matched *no* real query at all. I left
`tooth` alone as out of scope for this fix rather than silently expanding it,
since broadening it (e.g. to `tooth\w*`) risks new false positives (e.g.
"toothy grin" outside oral care) that would need their own review.
