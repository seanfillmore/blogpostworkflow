# PDP Foundation Content (Toothpaste Pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan deviates from the standard TDD code-plan template** because it produces brand content (markdown + JSON), not code. Verification is end-to-end smoke testing of the pdp-builder agent (already shipped) against the new foundation, plus Sean's review of the resulting queue items.

**Goal:** Replace the Plan 1 stub content in `data/brand/*` with real brand-voice content sufficient for the toothpaste pilot. Verified by smoke-testing the pdp-builder agent and confirming Sean would publish the resulting queue items with at most light edits.

**Architecture:** Five files, produced in sequence. `voice-and-pov.md` is the spine — informs every other file. `comparison-framework.md` next (provides "we vs them" axes). Then `cluster-povs.md` toothpaste section. Then `ingredient-stories.json` for the 5 toothpaste hero ingredients. Then `founder-narrative.md`. Smoke test the agent end-to-end, iterate on any file producing weak output.

**Tech Stack:** Markdown, JSON. The shipped pdp-builder agent (`agents/pdp-builder/`) consumes these files at generation time via `loadFoundation()`.

**Spec:** [`docs/superpowers/specs/2026-05-02-pdp-builder-design.md`](../specs/2026-05-02-pdp-builder-design.md)

**Out of scope (separate plans):**
- Other 6 clusters' foundation content — Plan 6 (after pilot succeeds)
- Theme refactor for toothpaste cluster — Plan 3 (can run in parallel with this)
- Dashboard `/pdp-review` UI — Plan 4 (can run in parallel)
- Live pilot publish — Plan 5 (depends on this + Plan 3 + Plan 4)

---

## Confirmed parameters (Sean answered 2026-05-02)

1. **Source for real customer voice:** **Judge.me reviews** for the toothpaste product (`coconut-oil-toothpaste`). Pulled via existing `lib/judgeme.js#fetchProductReviews`. These reviews are the primary input for: voice doc's "We say / We don't say" lists (real customer language), FAQ candidates (real concerns customers actually raise), ingredient story emphasis (which mechanism claims customers respond to), positioning angle (which differentiators customers cite).
2. **Founder narrative drafting:** **(b) ~15-min interview + I draft + Sean edits.** Interview question list is embedded in Task 5 below.
3. **Ingredient story rigor:** **Brand-confidence assertions backed by mechanism, no peer-reviewed citations for the pilot.** `citations` field stays `[]`. Populate in a later plan if we want to lean on primary research.
4. **Comparison framework axes — toothpaste:** **SLS, fluoride, hydrated silica, glycerin/sorbitol coating, synthetic sweeteners, synthetic flavors.** No additions. Aluminum / refined-vs-virgin / parabens included as forward-looking other-cluster axes but not pilot-blocking.

---

## File Structure

```
data/brand/                           Replaces existing stubs from Plan 1
├── voice-and-pov.md                  ~1500 words. Spine for every generation.
├── comparison-framework.md           Axes we differentiate on + voice rules.
├── cluster-povs.md                   Toothpaste section complete; others = "TBD Plan 6" stubs.
├── ingredient-stories.json           5 toothpaste-relevant ingredients, full schema.
└── founder-narrative.md              Sean's voice; ~300-400 words + a 60-80 word "From Sean" snippet.
```

No other files modified. The pdp-builder agent code already reads all five files via `agents/pdp-builder/lib/load-foundation.js`.

---

## Task 0: Pre-flight

**Files:** None modified.

- [ ] **Step 1: Create the feature branch + commit this plan**

```bash
git checkout main
git pull
git checkout -b feat/pdp-foundation-toothpaste
git add docs/superpowers/plans/2026-05-02-pdp-foundation-toothpaste.md
git commit -m "plan: pdp foundation content (toothpaste pilot)"
```

- [ ] **Step 2: Verify pre-flight**

```bash
git status   # only the unrelated dirty files we always carry
git log --oneline -5   # confirm plan commit is on top of PR #192 merge
```

---

## Task A: Pull Judge.me reviews for toothpaste product

**Files:** Generates `data/brand/_research/judgeme-toothpaste.md` (gitignored — research artifact, not committed).

**Why first:** Reviews are input for Tasks 1, 4, 5, 6. Pull once, reference everywhere.

- [ ] **Step 1: Add `data/brand/_research/` to `.gitignore` if not already**

```bash
grep -q "_research" .gitignore || echo "data/brand/_research/" >> .gitignore
```

- [ ] **Step 2: Run a one-off script to fetch all toothpaste reviews**

Create `scripts/pull-judgeme-toothpaste.mjs` (commit it — it'll be useful again for other clusters in Plan 6):

```javascript
import { resolveExternalId, fetchProductReviews } from '../lib/judgeme.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

function loadEnv() {
  const lines = readFileSync('.env', 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
const SHOP = 'realskincare.com';
const HANDLE = process.argv[2] || 'coconut-oil-toothpaste';

const externalId = await resolveExternalId(HANDLE, SHOP, env.JUDGEME_API_TOKEN);
if (!externalId) { console.error(`Could not resolve external ID for ${HANDLE}`); process.exit(1); }

const reviews = await fetchProductReviews(externalId, SHOP, env.JUDGEME_API_TOKEN);
console.log(`Fetched ${reviews.length} reviews for ${HANDLE}`);

const outDir = 'data/brand/_research';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const md = [
  `# Judge.me reviews — ${HANDLE}`,
  `Pulled: ${new Date().toISOString()}`,
  `Total: ${reviews.length}`,
  '',
  ...reviews.map((r, i) => [
    `## Review ${i + 1} — ${r.rating}★ — ${r.reviewer?.name || 'Anonymous'}`,
    `Date: ${r.created_at}`,
    `Title: ${r.title || '(no title)'}`,
    '',
    r.body || '(no body)',
    '',
  ].join('\n')),
].join('\n');

writeFileSync(`${outDir}/judgeme-${HANDLE}.md`, md);
console.log(`Saved to ${outDir}/judgeme-${HANDLE}.md`);
```

```bash
node scripts/pull-judgeme-toothpaste.mjs coconut-oil-toothpaste
```

- [ ] **Step 3: Read the reviews end-to-end + extract themes**

Open `data/brand/_research/judgeme-toothpaste.md`. Look for:
- **Recurring concerns** — the things customers worry about (sensitive teeth, fluoride, taste, foam, kids, swallowing, etc.)
- **Recurring praise** — the things customers love (canker-sore relief, gentle on gums, no chemical aftertaste, clean feel)
- **Customer language** — actual phrases customers use (more authentic than spec-language)
- **Pain points with mass-market alternatives** — what they're switching FROM and why
- **Questions in reviews** — sometimes customers ask questions in their review text → these become FAQ candidates

Sean reviews the themes summary before Task 1 (his ear is better than mine for what's signal vs noise).

- [ ] **Step 4: Commit the script (not the reviews dump)**

```bash
git add scripts/pull-judgeme-toothpaste.mjs .gitignore
git commit -m "feat(pdp-foundation): script to pull Judge.me reviews per product

Generic — takes a product handle. Toothpaste pilot uses it for the
coconut-oil-toothpaste reviews. Plan 6 will use it for the other
7 SKUs. Output goes to data/brand/_research/ (gitignored — raw
reviews are research artifacts, not foundation content)."
```

---

## Task 1: Write `data/brand/voice-and-pov.md` (~1500 words)

**Files:**
- Modify: `data/brand/voice-and-pov.md` (currently ~13 lines of stub)

**Source material:**
- Spec voice anchor (lines 38-47): clinical-confident, accessible, mechanism-forward, sensitive-skin authority anchor, ingredient-integrity narrative, reference points (Risewell warmer, Primally Pure with more substance, NOT Tom's of Maine, NOT bro/playful, NOT aspirational fluff).
- The 3 positioning hooks (locked in spec): reactive-skin trigger; ingredient by what it does, not what it costs; science plainly explained.
- **Judge.me reviews** (`data/brand/_research/judgeme-toothpaste.md` from Task A) — primary source for the "We say" / "We don't say" lists. Real customer language beats spec-language.
- Smoke-test sample output (`data/performance-queue/cluster-toothpaste.json`) — what voice the model produced from STUBS, as a baseline for what tightening up the foundation should improve.

**Structure target:**

```markdown
# Real Skin Care — Voice and POV

## Voice
[~200 words: clinical-confident, accessible, mechanism-forward. No jargon, no fluff,
no "miracle." Authority through clarity. Reference points and what to avoid.]

## Sensitive-skin authority
[~250 words: this is the primary positioning. Why it matters. Who it's for.
The reactive-skin customer's experience with mass-market brands. Our promise.]

## Ingredient-integrity narrative
[~250 words: "we paid more for what works." How to talk about ingredient
selection. The "right vs cheap" framing without naming names.]

## We say
[List of 25-40 vocabulary phrases / sentence patterns we use. Concrete, not abstract.]

## We don't say
[List of 25-40 vocabulary phrases / patterns we never use. Including the obvious
("all-natural," "chemical-free," "miracle") plus the subtle ones.]

## Voice tests
[3-5 short examples: same product/situation, voice ON vs voice OFF.
Annotates what makes the difference. This is what the agent will pattern-match against.]
```

**Acceptance criteria:**
- ~1500 words total
- All seven sections present
- Sean reviews and signs off
- The "We say" / "We don't say" lists are at least 25 entries each (these are what the agent uses to pattern-match its own output)

- [ ] **Step 1: Draft from spec voice anchor + Sean's source material**

I produce a first pass (~1500 words). Use the spec's locked voice anchor verbatim where it applies. Lift vocabulary from the smoke test output that hits the right note. Include 3-5 voice-ON-vs-voice-OFF examples (same product hook written two ways).

- [ ] **Step 2: Sean review pass**

Sean reads end-to-end. Flags anything that doesn't sound like him. Adds to "We say" / "We don't say" from his own ear. Iteration until Sean signs off.

- [ ] **Step 3: Save final version**

Write Sean-approved content to `data/brand/voice-and-pov.md`, replacing the stub.

- [ ] **Step 4: Commit**

```bash
git add data/brand/voice-and-pov.md
git commit -m "feat(pdp-foundation): real voice doc for toothpaste pilot

Replaces the Plan 1 stub. ~1500 words. Spine for every other foundation
file and every cluster/product generation by the pdp-builder agent."
```

---

## Task 2: Write `data/brand/comparison-framework.md`

**Files:**
- Modify: `data/brand/comparison-framework.md` (currently ~20 lines of stub)

**Source material:**
- Plan 1 stub (already has 8 axes — toothpaste-relevant ones are mostly there)
- Spec line 357 — initial draft axes
- Sean's confirmed axes from Task 0 Step 1

**Structure target:**

```markdown
# Comparison Framework

## Axes we differentiate on

### Toothpaste-relevant (pilot-blocking)
- **SLS:** [the contrast — why mass-market includes, why we exclude, what the customer notices]
- **Fluoride:** [contrast]
- **Hydrated silica:** [contrast]
- **Glycerin/sorbitol coating:** [contrast]
- **Synthetic sweeteners:** [contrast]
- **Synthetic flavors:** [contrast]

### Other clusters (forward-looking, not pilot-blocking)
- **Aluminum (deodorant):** [contrast]
- **Synthetic fragrance:** [contrast]
- **Refined vs. virgin oils:** [contrast]
- **Parabens:** [contrast]

## Voice rules for comparisons
- Never name a competitor brand directly in product copy.
- Use "mass-market," "conventional," or "the industry standard" as the contrast term.
- State the trade-off plainly: "they pay less, you pay more, here's what the difference does."
- Lean on mechanism, not moralism. ("Hydrated silica is harder than enamel" beats "hydrated silica is bad.")
- Acknowledge the cost: cheap substitutes exist for a reason. We just don't use them.
```

**Acceptance criteria:**
- All 6 toothpaste axes filled in with real contrast text (not placeholders)
- Voice rules section complete
- Sean reviews

**Steps:**

- [ ] **Step 1: Draft each axis**

For each toothpaste-relevant axis: 2-3 sentences explaining the contrast in our voice. Lift from the spec where applicable.

- [ ] **Step 2: Sean review pass**

- [ ] **Step 3: Save + commit**

```bash
git add data/brand/comparison-framework.md
git commit -m "feat(pdp-foundation): real comparison framework for toothpaste pilot

Replaces the Plan 1 stub. Toothpaste-relevant axes (SLS, fluoride,
hydrated silica, glycerin/sorbitol, synthetic sweeteners, synthetic
flavors) all populated with real contrast text. Other-cluster axes
forward-looking, not pilot-blocking."
```

---

## Task 3: Expand `data/brand/cluster-povs.md` toothpaste section (~250-300 words)

**Files:**
- Modify: `data/brand/cluster-povs.md` (currently has ~80-word stub for toothpaste)

**Source material:**
- The current stub (decent skeleton — keep its bones, expand)
- Spec Phase 1 description (line 256) — toothpaste-relevant content prioritized
- Smoke test cluster mode output's `mechanismBlock` — voice/length reference (~90 words is what the agent produces; cluster POV is the prompt input that drives that)
- Sean's voice on toothpaste category (anything he says publicly about why this product exists)

**Structure target:**

```markdown
# Cluster Worldviews

## toothpaste
[~250-300 words covering:
- Why this product exists (what mass-market toothpaste does that we object to)
- Who it's for (sensitive teeth/gums, fluoride-avoiders, canker-sore-prone)
- The mechanism story (lauric acid, baking soda, myrrh, xanthan — what each does)
- The "what's NOT in it" anchor (the things customers will notice are missing)
- The trade-off honestly stated (no foam, doesn't taste sweet, costs more)]

## deodorant
> TBD — Plan 6 (after toothpaste pilot succeeds).

## lotion
> TBD — Plan 6.

## cream
> TBD — Plan 6.

## bar_soap
> TBD — Plan 6.

## liquid_soap
> TBD — Plan 6.

## lip_balm
> TBD — Plan 6.
```

**Acceptance criteria:**
- Toothpaste section ~250-300 words, on-voice
- All 5 covered topics present (why exists, who it's for, mechanism story, what's NOT in it, trade-off)
- Other clusters: stub TBD markers (the agent will throw on cluster lookup if a cluster has no entry; an explicit "TBD Plan 6" marker is enough)
- Sean reviews

**Steps:**

- [ ] **Step 1: Draft expanded toothpaste section**

Expand the existing stub to ~250-300 words covering all 5 topics. Use the smoke test mechanism block as a tone reference.

- [ ] **Step 2: Add TBD markers for other 6 clusters** (keep them parseable by the agent's `extractClusterPOV` regex — `## <cluster-name>` heading is the only requirement)

- [ ] **Step 3: Sean review pass**

- [ ] **Step 4: Save + commit**

```bash
git add data/brand/cluster-povs.md
git commit -m "feat(pdp-foundation): real toothpaste cluster POV (others stubbed)

Toothpaste section expanded to ~250-300 words covering why-this-exists,
who-it's-for, mechanism story, what's-NOT-in-it, and the honest
trade-off. Other 6 cluster sections marked TBD for Plan 6."
```

---

## Task 4: Write `data/brand/ingredient-stories.json` (5 toothpaste ingredients)

**Files:**
- Modify: `data/brand/ingredient-stories.json` (currently 5 stub entries — replace each with real content)

**Source material:**
- `config/ingredients.json` toothpaste `base_ingredients`: organic virgin coconut oil, baking soda, xanthan gum, wildcrafted myrrh powder, stevia. (Purified spring water is in `base_ingredients` too but doesn't merit a hero story — skip it.)
- Existing stub schema (already correct shape — replace content only)
- Mechanism research — brand-confidence assertions backed by mechanism, no peer-reviewed citations for the pilot (per confirmed parameter #3)
- **Judge.me reviews** (`data/brand/_research/judgeme-toothpaste.md`) — which ingredient claims customers respond to, which they're skeptical of, what mechanism explanations stick. Especially valuable for `why_we_chose_it` field.
- Comparison framework (`comparison-framework.md` — same "what cheap alternatives look like" framing)

**Schema (per ingredient — fixed by `relevantIngredientStories` in prompt-builder.js):**

```json
{
  "<key_in_snake_case>": {
    "name": "<title-case display name; bidirectional substring matched against config/ingredients.json>",
    "role": "<5-10 word phrase: what job this ingredient does in the formula>",
    "mechanism": "<50-80 words: the actual biochemistry. Why does it work? Lauric acid disrupts what? Sodium bicarbonate neutralizes what?>",
    "sourcing": "<30-50 words: where we get it, what makes our sourcing distinct (cold-pressed virgin, wildcrafted, food-grade, aluminum-free, etc.)>",
    "why_we_chose_it": "<50-80 words: the cost/benefit reasoning. We paid more for X because... If a cheaper substitute would work, we'd use it. None do, here's why.>",
    "what_cheap_alternatives_look_like": "<50-80 words: the comparable mass-market substitute and what it sacrifices. Specific (hydrated silica, refined coconut oil, sodium saccharin) — not abstract ('cheap junk').>",
    "citations": []
  }
}
```

**Acceptance criteria:**
- 5 entries: `organic_virgin_coconut_oil`, `baking_soda`, `xanthan_gum`, `wildcrafted_myrrh`, `stevia`
- Each entry has all 7 fields populated, on-voice
- `citations` is an empty array (pilot scope)
- Sean confirms the science is correct on each `mechanism` field
- File parses as valid JSON: `node -e "JSON.parse(require('fs').readFileSync('data/brand/ingredient-stories.json','utf8'))"`
- Names match the bidirectional-substring matcher: e.g. `name: "Wildcrafted Myrrh"` matches config's `"wildcrafted myrrh powder"` (verified by validators.js + prompt-builder.js)

**Steps:**

- [ ] **Step 1: Research each ingredient's mechanism**

For each of the 5: what does it actually do biochemically? What does the cheap alternative do worse? This is research time — Claude can help but Sean confirms accuracy.

- [ ] **Step 2: Draft entries one-by-one in the schema above**

- [ ] **Step 3: Validate JSON parses**

```bash
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('data/brand/ingredient-stories.json','utf8'))).length, 'ingredients')"
```
Expected: `5 ingredients`

- [ ] **Step 4: Sean reviews science on each mechanism**

This is the science-correctness gate. Wrong mechanism claims are worse than no claims.

- [ ] **Step 5: Save + commit**

```bash
git add data/brand/ingredient-stories.json
git commit -m "feat(pdp-foundation): real ingredient stories for 5 toothpaste ingredients

Replaces the Plan 1 stubs. Each entry: mechanism (biochemistry, science-
verified), sourcing, why we chose it, what cheap alternatives look like.
Citations empty for pilot — populated in a later plan if we want to
lean on primary research.

Names use the bidirectional-substring-matched form (e.g. 'Wildcrafted
Myrrh' for config's 'wildcrafted myrrh powder')."
```

---

## Task 5: Write `data/brand/founder-narrative.md` (~300-400 words)

**Files:**
- Modify: `data/brand/founder-narrative.md` (currently ~7-line stub)

**Approach (per confirmed parameter #2):** ~15-min interview with Sean → I draft → Sean edits.

**Interview question list** (Sean answers in chat or as a notes file; I draft from answers):

1. What started Real Skin Care? Who or what was the first reactive-skin person you were solving for — yourself, a family member, a customer?
2. What was the breaking-point moment? The product that triggered something or the conversation with a doctor/dermatologist?
3. Why these specific formulas? When you were sourcing ingredients, what did you keep saying no to and why?
4. Why these prices? What's the trade-off you'd want a first-time customer to understand?
5. Who is the customer you've actually built for? Not the persona — the real person whose review or message stuck with you.
6. What do you hope a customer notices in the first week of using the toothpaste specifically?
7. What's the thing about RSC you'd correct if a customer described you wrong?
8. If you only got one sentence on the back of every box, what would it say?

**Source material:**
- Sean's interview answers (primary)
- Spec line 356 — "User to draft 'From Sean' snippet in their own voice during Phase 1; agent uses as exemplar."
- Smoke test's founderBlock — what the agent produces from the stub. Real version should sound MORE like Sean and less like generic-founder.
- Judge.me reviews (`data/brand/_research/judgeme-toothpaste.md`) — what customers actually say back to you. The real "I built this for X" answer is in the reviews.

**Structure target:**

```markdown
# Founder Narrative

## About Real Skin Care
[~200-300 words first-person:
- Why I started this (the personal story — your own reactive skin? a friend? your kid?)
- Why these formulas (the ingredient-integrity narrative in your voice)
- Why these prices (the trade-off honestly stated)
- Who this is for (the customer you've built for)]

## From Sean (cluster template snippet)
[60-80 words. This is the snippet the agent uses as an exemplar for the per-product
"From Sean" block. Should be a tighter, more universal version of the About content
that works across products. First-person, mechanism-forward, ends with a personal note
that reads as authentically yours.]
```

**Acceptance criteria:**
- About section ~200-300 words, first-person, sounds like Sean
- "From Sean" snippet 60-80 words (matches the agent's `founderBlock` length target)
- Sean signs off (this is HIS narrative, his bar — non-negotiable)

**Steps:**

- [ ] **Step 1: Conduct interview**

I post the 8 interview questions; Sean answers in chat (or as a notes file). Aim for ~15 min total — short, direct answers, not essay-length.

- [ ] **Step 2: Draft from interview answers**

I write the About section + 'From Sean' snippet in Sean's voice using his answers + the smoke-test founderBlock as a length/structure reference.

- [ ] **Step 3: Sean edits + signs off on final voice + content**

- [ ] **Step 4: Save + commit**

```bash
git add data/brand/founder-narrative.md
git commit -m "feat(pdp-foundation): real founder narrative

Replaces the Plan 1 stub. About section + 'From Sean' snippet for the
agent to use as exemplar in per-product founder blocks."
```

---

## Task 6: Smoke test the pdp-builder agent against the new foundation

**Files:** None modified. Generates queue items at `data/performance-queue/cluster-toothpaste.json` and `data/performance-queue/coconut-oil-toothpaste.json`.

**Cost:** ~$0.50 in Claude API calls (1 cluster mode + 1 product mode).

- [ ] **Step 1: Run cluster mode**

```bash
node agents/pdp-builder/index.js cluster toothpaste
```

Expected: `Status: pending` (validators pass).

- [ ] **Step 2: Read the cluster queue item end-to-end**

```bash
cat data/performance-queue/cluster-toothpaste.json | jq .proposed
```

Sean reads every section. Voice consistency check: does it sound like Sean? Ingredient stories: does the model use the foundation's framing? FAQ answers: do they answer real customer questions in our voice? Free-from list: the right things? Mechanism block: clear, on-voice?

- [ ] **Step 3: Run product mode**

```bash
node agents/pdp-builder/index.js product coconut-oil-toothpaste
```

Expected: `Status: pending`.

- [ ] **Step 4: Read the product queue item end-to-end**

```bash
cat data/performance-queue/coconut-oil-toothpaste.json | jq .proposed
```

Sean reads SEO title, meta description, body_html, metafield overrides. Same voice/mechanism/free-from check.

- [ ] **Step 5: Decision point — iterate or move forward**

If both queue items are something Sean would publish with at most light edits → foundation is pilot-ready. Move to Task 7.

If ANY foundation file is producing weak output → identify which one, return to its Task (1-5), tighten, re-run smoke test. Common culprits:
- Voice doc too vague → add more "We say / We don't say" entries, more voice-ON-vs-voice-OFF examples
- Cluster POV missing the "trade-off honestly stated" angle → output sounds salesy
- Ingredient stories light on mechanism → output sounds vague
- Founder narrative not tight enough → "From Sean" block in output sounds generic

---

## Task 7: Open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/pdp-foundation-toothpaste
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --head feat/pdp-foundation-toothpaste --title "feat(pdp-foundation): real foundation content for toothpaste pilot" --body "$(cat <<'EOF'
## Summary

Replaces the Plan 1 stub content in \`data/brand/*\` with real brand-voice content sufficient for the toothpaste pilot. Plan: [docs/superpowers/plans/2026-05-02-pdp-foundation-toothpaste.md](docs/superpowers/plans/2026-05-02-pdp-foundation-toothpaste.md).

## What's in
- \`data/brand/voice-and-pov.md\` — ~1500 words, Sean-approved voice doc
- \`data/brand/comparison-framework.md\` — toothpaste axes complete
- \`data/brand/cluster-povs.md\` — toothpaste section ~250-300 words; other clusters TBD Plan 6
- \`data/brand/ingredient-stories.json\` — 5 toothpaste ingredients with verified mechanism
- \`data/brand/founder-narrative.md\` — Sean's voice, About + 'From Sean' snippet

## Smoke test confirmation
- \`node agents/pdp-builder/index.js cluster toothpaste\` → status pending, Sean would publish with light edits
- \`node agents/pdp-builder/index.js product coconut-oil-toothpaste\` → status pending, Sean would publish with light edits

## What's not in (separate plans)
- Other 6 clusters' foundation content — Plan 6
- Theme refactor — Plan 3 (can start now, in parallel)
- Dashboard /pdp-review UI — Plan 4 (can start now, in parallel)
- Live pilot publish — Plan 5

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification before merge

- [ ] All 5 foundation files have real content (no `STUB` markers, no `Plan 2 replaces` notes)
- [ ] `data/brand/ingredient-stories.json` parses as valid JSON (`node -e "JSON.parse(...)"` exits 0)
- [ ] Smoke test in Task 6 produces `status: pending` for both cluster and product modes
- [ ] Sean has signed off on voice consistency across both generated queue items
- [ ] Pilot is ready to begin Plan 3 (theme refactor) and Plan 4 (dashboard) in parallel

---

## Self-review checklist (after all tasks complete)

- [x] Spec Phase 1 deliverables — all 5 foundation files covered
- [x] Toothpaste-only scope per spec
- [x] Open spec questions addressed (founder narrative voicing in Task 5; comparison framework axes in Task 2)
- [x] Pilot is ready for Plan 3-4 to start in parallel
