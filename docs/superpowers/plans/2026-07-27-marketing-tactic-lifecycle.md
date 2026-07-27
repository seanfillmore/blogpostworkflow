# Marketing Tactic Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a marketing tactic be marked dead with evidence and stay dead, and make live tactics readable by the agent that generates ad creative.

**Architecture:** The `.claude/skills/marketing-*/SKILL.md` files stay the single source of truth — a falsified tactic moves into a `## Falsified` section inside its own skill. `data/context/marketing-tactics.md` is *generated* from those skills after every write and never hand-edited; `creative-packager` reads it as an angle menu. Three guards stop a falsified tactic coming back: the extraction prompt, the merge prompt, and a `validateSkillEdit` check — only the last is code rather than persuasion.

**Tech Stack:** Node 20+ ESM, `node --test` with bare `node:assert` assertions (repo convention — no `describe`/`it`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-27-marketing-tactic-lifecycle-design.md`

## Global Constraints

- **ESM only.** `package.json` has `"type": "module"`. Use `import`, never `require`.
- **Test style is bare assertions**, matching `tests/agents/marketing-learner.test.js`: top-level `assert.*` calls, then `console.log('✓ <name> tests pass')` as the last line. Do NOT use `node:test`'s `describe`/`it`.
- **No new npm dependencies.** Node built-ins only.
- **No network in tests.** `falsifyTactic`, `extractFalsifiedClaims`, and `renderContextMirror` are pure — no LLM call, no fetch.
- **Ambiguity is an error, never a guess.** Zero matches and multiple matches both throw with the candidates listed. This mirrors `parsePublishedFlags`, and for the same reason: a confident wrong write is worse than a refusal.
- **`--reason` is required and must be non-empty.** An unexplained falsification is not a record.
- **`creative-packager` must keep working when `data/context/marketing-tactics.md` does not exist** — it will not exist on a fresh checkout. Degrade to current behavior, never throw.
- Do NOT modify: `mergeSkillContent`'s whole-file replacement flow, `writeSkill`'s create/edit path selection, the credential handling, `openPullRequest`'s branch restore, or the free-`/youtube/info`-before-paid-call ordering.
- Existing constants in `lib/marketing-learner.js` you will build on: `SHRINK_FLOOR = 0.75`, `EXTRACTION_MODEL = 'claude-opus-5'`, `parseFrontmatter(content) -> { name, description, body }`, `scanSkillInventory(dir) -> [{ name, description, path, content }]`.
- Tactic sections inside a skill are `## <claim>` headings, written by `renderSkillMarkdown`. Falsified entries are `### <claim>` under a single `## Falsified` heading.

---

### Task 1: `falsifyTactic` and `extractFalsifiedClaims`

**Files:**
- Modify: `lib/marketing-learner.js` (append)
- Modify: `tests/agents/marketing-learner.test.js` (insert above the final `console.log`)

**Interfaces:**
- Consumes: `parseFrontmatter` (already exported from this file).
- Produces: `falsifyTactic(content, { claim, reason, today }) -> string` and `extractFalsifiedClaims(content) -> string[]`. `FALSIFIED_HEADING` is a module-private constant — nothing outside this file needs it, and a dead export is a maintenance liability.

- [ ] **Step 1: Write the failing test**

Insert into `tests/agents/marketing-learner.test.js`, **above** the final `console.log` line:

```js
import { falsifyTactic, extractFalsifiedClaims } from '../../lib/marketing-learner.js';

const LIVE_SKILL = [
  '---',
  'name: marketing-conversion-copy-angles',
  'description: Use when writing product page copy',
  '---',
  '',
  '# Conversion Copy Angles',
  '',
  '## Use taboo or negative framing to stop the scroll',
  '',
  '**Why it works:** Pattern interrupt.',
  '',
  '*Source: Dara Denney — "Static Ads" (5C5VhqW9HCc)*',
  '',
  '## Lead with a hard number',
  '',
  '**Why it works:** Specifics are falsifiable.',
  '',
  '*Source: Dara Denney — "Static Ads" (5C5VhqW9HCc)*',
  '',
].join('\n');

// ── extractFalsifiedClaims ──────────────────────────────────────────────────
assert.deepEqual(extractFalsifiedClaims(LIVE_SKILL), [], 'no Falsified section returns empty');
assert.deepEqual(
  extractFalsifiedClaims(LIVE_SKILL + '\n## Falsified\n\n### Dead one\n**Falsified 2026-08-14:** nope\n'),
  ['Dead one'],
  'reads ### headings under the Falsified section'
);
assert.deepEqual(
  extractFalsifiedClaims('## Falsified\n\n### A\n\n### B\n'),
  ['A', 'B'],
  'reads several'
);

// ── falsifyTactic: happy path ───────────────────────────────────────────────
{
  const out = falsifyTactic(LIVE_SKILL, {
    claim: 'taboo',
    reason: 'CTR 0.4% vs 1.1% control',
    today: '2026-08-14',
  });

  assert.match(out, /## Falsified/, 'creates the Falsified section');
  assert.match(out, /### Use taboo or negative framing to stop the scroll/, 'demotes the heading to ###');
  assert.match(out, /\*\*Falsified 2026-08-14:\*\* CTR 0\.4% vs 1\.1% control/, 'stamps date and reason');
  assert.match(out, /Pattern interrupt/, 'preserves the body');
  assert.match(out, /5C5VhqW9HCc/, 'preserves provenance');

  // The surviving tactic is untouched and still live.
  assert.match(out, /^## Lead with a hard number$/m, 'other tactic stays a live ## heading');
  assert.ok(!/^## Use taboo/m.test(out), 'falsified tactic is no longer a live ## heading');

  // Frontmatter survives and the file still round-trips.
  const fm = parseFrontmatter(out);
  assert.equal(fm.name, 'marketing-conversion-copy-angles');
  assert.deepEqual(extractFalsifiedClaims(out), ['Use taboo or negative framing to stop the scroll']);
}

// ── falsifyTactic: appends to an existing Falsified section ─────────────────
{
  const once = falsifyTactic(LIVE_SKILL, { claim: 'taboo', reason: 'r1', today: '2026-08-14' });
  const twice = falsifyTactic(once, { claim: 'hard number', reason: 'r2', today: '2026-08-20' });
  assert.deepEqual(extractFalsifiedClaims(twice).sort(), [
    'Lead with a hard number',
    'Use taboo or negative framing to stop the scroll',
  ], 'both entries present');
  assert.equal((twice.match(/## Falsified/g) || []).length, 1, 'only ONE Falsified section');
}

// ── falsifyTactic: refuses ambiguity ────────────────────────────────────────
assert.throws(
  () => falsifyTactic(LIVE_SKILL, { claim: 'nonexistent', reason: 'r', today: '2026-08-14' }),
  /No live tactic matching "nonexistent"/,
  'zero matches throws and lists candidates'
);
assert.throws(
  () => falsifyTactic(LIVE_SKILL, { claim: 'nonexistent', reason: 'r', today: '2026-08-14' }),
  /Lead with a hard number/,
  'the zero-match error names the available claims'
);
assert.throws(
  () => falsifyTactic(LIVE_SKILL, { claim: 'e', reason: 'r', today: '2026-08-14' }),
  /matches 2 live tactics/,
  'multiple matches throws'
);

// ── falsifyTactic: already falsified ────────────────────────────────────────
{
  const once = falsifyTactic(LIVE_SKILL, { claim: 'taboo', reason: 'r1', today: '2026-08-14' });
  assert.throws(
    () => falsifyTactic(once, { claim: 'taboo', reason: 'r2', today: '2026-08-20' }),
    /already falsified/,
    'refuses to falsify twice'
  );
}

// ── falsifyTactic: reason is mandatory ──────────────────────────────────────
for (const bad of [undefined, '', '   ']) {
  assert.throws(
    () => falsifyTactic(LIVE_SKILL, { claim: 'taboo', reason: bad, today: '2026-08-14' }),
    /reason is required/,
    `reason ${JSON.stringify(bad)} rejected`
  );
}
assert.throws(
  () => falsifyTactic(LIVE_SKILL, { claim: '  ', reason: 'r', today: '2026-08-14' }),
  /claim is required/,
  'blank claim rejected'
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `falsifyTactic` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/marketing-learner.js`:

```js
const FALSIFIED_HEADING = '## Falsified';
const FALSIFIED_INTRO = 'Tried here and did not work. Do not reintroduce these.';

/** Index of the Falsified heading, or -1. Matches at start-of-file or start-of-line. */
function falsifiedIndex(content) {
  if (content.startsWith(FALSIFIED_HEADING)) return 0;
  const i = content.indexOf(`\n${FALSIFIED_HEADING}`);
  return i === -1 ? -1 : i + 1;
}

/**
 * The claims that were tried here and failed. These are the entries the merge
 * must never resurrect — read by the merge prompt, the extraction prompt, and
 * validateSkillEdit.
 */
export function extractFalsifiedClaims(content) {
  const i = falsifiedIndex(String(content ?? ''));
  if (i === -1) return [];
  return String(content)
    .slice(i)
    .split('\n')
    .filter((l) => l.startsWith('### '))
    .map((l) => l.slice(4).trim())
    .filter(Boolean);
}

/** Split the live half of a skill into its leading matter and its `## ` tactic sections. */
function splitLiveSections(live) {
  const head = [];
  const sections = [];
  let cur = null;
  for (const line of live.split('\n')) {
    if (line.startsWith('## ')) {
      if (cur) sections.push(cur);
      cur = { heading: line.slice(3).trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      head.push(line);
    }
  }
  if (cur) sections.push(cur);
  return { head: head.join('\n'), sections };
}

/**
 * Move one tactic out of the live body and into `## Falsified`, stamped with the
 * date and the reason it failed.
 *
 * Pure text surgery — no LLM call, so this is free and deterministic. The section
 * body is preserved rather than discarded: the record needs to say WHAT was tested,
 * not merely that something failed.
 *
 * Ambiguity throws. A wrong-but-confident write into a curated skill is worse than
 * a refusal, so zero matches and multiple matches both error with the candidates.
 */
export function falsifyTactic(content, { claim, reason, today } = {}) {
  if (!String(claim ?? '').trim()) throw new Error('falsifyTactic: claim is required.');
  if (!String(reason ?? '').trim()) {
    throw new Error('falsifyTactic: reason is required — an unexplained falsification is not a record.');
  }
  parseFrontmatter(content); // throws if the file is not a well-formed skill

  const needle = claim.trim().toLowerCase();
  const already = extractFalsifiedClaims(content).find((c) => c.toLowerCase().includes(needle));
  if (already) throw new Error(`"${already}" is already falsified in this skill.`);

  const cut = falsifiedIndex(content);
  const live = cut === -1 ? content : content.slice(0, cut);
  const dead = cut === -1 ? '' : content.slice(cut);

  const { head, sections } = splitLiveSections(live);
  const matches = sections.filter((s) => s.heading.toLowerCase().includes(needle));

  if (matches.length === 0) {
    const available = sections.map((s) => `  - ${s.heading}`).join('\n');
    throw new Error(
      `No live tactic matching "${claim}" in this skill. Available:\n${available || '  (none)'}`
    );
  }
  if (matches.length > 1) {
    const listed = matches.map((s) => `  - ${s.heading}`).join('\n');
    throw new Error(`"${claim}" matches ${matches.length} live tactics — be more specific:\n${listed}`);
  }

  const target = matches[0];
  const body = target.lines.slice(1).join('\n').trim();
  const entry = [`### ${target.heading}`, `**Falsified ${today}:** ${reason.trim()}`, '', body, ''].join('\n');

  const remaining = sections.filter((s) => s !== target).map((s) => s.lines.join('\n').trim());
  const deadBody = dead
    ? `${dead.trimEnd()}\n\n${entry}`
    : [FALSIFIED_HEADING, '', FALSIFIED_INTRO, '', entry].join('\n');

  return [head.trim(), '', ...remaining.flatMap((s) => [s, '']), deadBody.trim(), ''].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): falsifyTactic and extractFalsifiedClaims

Pure text surgery — no LLM call. Ambiguity throws with candidates listed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Keep it dead — guard plus both prompts

**Files:**
- Modify: `lib/marketing-learner.js` (`validateSkillEdit`, `buildExtractionPrompt`, `mergeSkillContent`)
- Modify: `tests/agents/marketing-learner.test.js` (insert above the final `console.log`)

**Interfaces:**
- Consumes: `extractFalsifiedClaims` (Task 1).
- Produces: no new exports. `validateSkillEdit(oldContent, newContent, { supersedes })` gains a falsified-preservation check.

**Why the code guard exists:** `mergeSkillContent` asks the model for a **complete replacement file**. A prompt instruction can be ignored; a merge that adds two tactics while silently deleting one falsified entry *grows* the file, so the existing 25%-shrink guard will not catch it.

- [ ] **Step 1: Write the failing test**

Insert into `tests/agents/marketing-learner.test.js`, **above** the final `console.log`:

```js
// ── validateSkillEdit preserves the graveyard ───────────────────────────────
{
  const OLD_WITH_DEAD = [
    '---',
    'name: marketing-x',
    'description: Use when doing x',
    '---',
    '',
    '## Live one',
    'body'.repeat(60),
    '',
    '## Falsified',
    '',
    '### Dead one',
    '**Falsified 2026-08-14:** did not work',
    '',
  ].join('\n');

  // Dropping the falsified entry throws even though the file GREW.
  const dropped = [
    '---',
    'name: marketing-x',
    'description: Use when doing x',
    '---',
    '',
    '## Live one',
    'body'.repeat(60),
    '',
    '## Another live one',
    'body'.repeat(60),
    '',
  ].join('\n');
  assert.ok(dropped.length > OLD_WITH_DEAD.length, 'fixture grew — shrink guard cannot catch this');
  assert.throws(
    () => validateSkillEdit(OLD_WITH_DEAD, dropped),
    /Dead one/,
    'dropping a falsified entry throws and names it'
  );

  // Preserving it passes.
  const kept = dropped.replace(
    '## Another live one',
    '## Falsified\n\n### Dead one\n**Falsified 2026-08-14:** did not work\n\n## Another live one'
  );
  assert.equal(validateSkillEdit(OLD_WITH_DEAD, kept), true, 'preserving the entry passes');

  // A skill with no Falsified section is unaffected.
  const plain = '---\nname: marketing-y\ndescription: d\n---\n\n' + 'x'.repeat(400);
  assert.equal(validateSkillEdit(plain, plain + '\nmore'), true, 'no falsified section, no new constraint');
}

// ── both prompts state the falsified list ──────────────────────────────────
{
  const inv = [{
    name: 'marketing-x',
    description: 'Use when doing x',
    path: '/tmp/x/SKILL.md',
    content: '---\nname: marketing-x\ndescription: d\n---\n\n## Live\n\n## Falsified\n\n### Dead tactic\n',
  }];
  const p = buildExtractionPrompt({ video: VIDEO, inventory: inv });
  assert.match(p, /Dead tactic/, 'extraction prompt names the falsified claim');
  assert.match(p, /tested at this business and failed|already been tested here and failed/i,
    'extraction prompt explains what falsified means');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `validateSkillEdit` does not yet check falsified entries.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `lib/marketing-learner.js`, inside `validateSkillEdit`, insert immediately before the existing `if (newContent.length < oldContent.length * SHRINK_FLOOR && !supersedes) {` block:

```js
  // The model returns whole files, so it can silently drop the graveyard while
  // still growing the file — which the shrink guard below would never catch.
  // This is the only falsified guard that is code rather than persuasion.
  const oldDead = extractFalsifiedClaims(oldContent);
  if (oldDead.length) {
    const newDead = extractFalsifiedClaims(newContent);
    const lost = oldDead.filter((c) => !newDead.includes(c));
    if (lost.length) {
      throw new Error(
        `Refusing to edit "${newFm.name}": the replacement drops ${lost.length} falsified ` +
        `entr${lost.length === 1 ? 'y' : 'ies'} — ${lost.map((c) => `"${c}"`).join(', ')}. ` +
        `Falsified tactics were tested here and failed; they must stay on the record.`
      );
    }
  }
```

**3b.** In `buildExtractionPrompt`, immediately after the `inventoryBlock` is built, add:

```js
  const falsified = inventory.flatMap((s) => extractFalsifiedClaims(s.content));
  const falsifiedBlock = falsified.length
    ? `## Already tested here and failed\n\nThese were tried at this business and did not work. Reject any tactic that restates one, and say so in rejectReason. Be alert to near-variants — a reworded version of a failed tactic is still a failed tactic.\n\n${falsified.map((c) => `- ${c}`).join('\n')}`
    : '';
```

Then insert `${falsifiedBlock}` into the returned template string on its own line, directly after the `${inventoryBlock}` line.

**3c.** In `mergeSkillContent`, after `const fm = parseFrontmatter(existingContent);` add:

```js
  const dead = extractFalsifiedClaims(existingContent);
  const deadRule = dead.length
    ? `\n- The "## Falsified" section lists tactics already tested here that failed. Keep that section and every entry in it EXACTLY as-is. Never move an entry back into the live body, and never add a new tactic that restates one — if this transcript advocates one of them, leave it falsified.\n`
    : '\n';
```

Then insert `${deadRule}` into the prompt's `Rules:` block, immediately after the provenance rule line.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): three guards keep a falsified tactic dead

validateSkillEdit throws when a replacement drops a falsified entry — the
shrink guard cannot catch it, because such a merge grows the file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `renderContextMirror`

**Files:**
- Modify: `lib/marketing-learner.js` (append)
- Modify: `tests/agents/marketing-learner.test.js` (insert above the final `console.log`)

**Interfaces:**
- Consumes: `parseFrontmatter`, `extractFalsifiedClaims` (Task 1).
- Produces: `renderContextMirror(inventory) -> string`, where `inventory` is `scanSkillInventory()` output.

- [ ] **Step 1: Write the failing test**

Insert into `tests/agents/marketing-learner.test.js`, **above** the final `console.log`:

```js
import { renderContextMirror } from '../../lib/marketing-learner.js';

{
  const inv = [
    {
      name: 'marketing-copy',
      description: 'Use when writing product page copy or Amazon bullets',
      path: '/tmp/a/SKILL.md',
      content: '---\nname: marketing-copy\ndescription: d\n---\n\n## Lead with a hard number\n\n**Why it works:** Specifics.\n\n## Falsified\n\n### Use taboo framing\n**Falsified 2026-08-14:** CTR tanked\n',
    },
    {
      name: 'marketing-images',
      description: 'Use when designing Amazon listing image slots',
      path: '/tmp/b/SKILL.md',
      content: '---\nname: marketing-images\ndescription: d\n---\n\n## One job per frame\n\n**Why it works:** Clarity.\n',
    },
  ];

  const md = renderContextMirror(inv);

  assert.match(md, /Do not edit by hand/i, 'says it is generated');
  assert.match(md, /\.claude\/skills/, 'names its source');
  assert.match(md, /## Do not propose/, 'has the blocklist section');
  assert.match(md, /- Use taboo framing/, 'blocklist carries the falsified claim');
  assert.match(md, /marketing-copy/, 'names each skill');
  assert.match(md, /Use when designing Amazon listing image slots/, 'carries trigger descriptions');
  assert.match(md, /Lead with a hard number/, 'carries live tactics');
  assert.match(md, /One job per frame/, 'carries tactics from every skill');
}

// Empty inventory still produces a valid document rather than throwing.
{
  const md = renderContextMirror([]);
  assert.match(md, /Do not edit by hand/i);
  assert.match(md, /Nothing falsified yet/i, 'says so plainly when nothing is dead');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: FAIL — `renderContextMirror` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/marketing-learner.js`:

```js
/**
 * Project the skills into one file the agent fleet can read.
 *
 * No agent reads .claude/skills/ — that is a Claude Code harness feature. Eight
 * agents read data/context/. This is the bridge.
 *
 * Skill bodies are emitted verbatim rather than re-parsed per tactic, so the
 * mirror cannot disagree with its source. The blocklist is hoisted to the top
 * because a single scannable "do not propose" list is easier for a model to
 * honor than the same claims scattered through per-topic subsections.
 */
export function renderContextMirror(inventory = []) {
  const dead = inventory.flatMap((s) => extractFalsifiedClaims(s.content));

  const L = [
    '# Marketing Tactics',
    '',
    '_Generated from `.claude/skills/marketing-*/SKILL.md` by `agents/marketing-learner`._',
    '_Do not edit by hand — this file is overwritten on every run._',
    '',
    '## Do not propose',
    '',
    'These were tested at Real Skin Care and failed. Do not suggest them or reworded variants of them.',
    '',
    dead.length ? dead.map((c) => `- ${c}`).join('\n') : '_Nothing falsified yet._',
    '',
  ];

  for (const s of inventory) {
    let body = '';
    try { body = parseFrontmatter(s.content).body.trim(); } catch { continue; }
    L.push(`## ${s.name}`, '', `_${s.description}_`, '', body, '');
  }

  return L.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agents/marketing-learner.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/marketing-learner.js tests/agents/marketing-learner.test.js
git commit -m "feat(marketing-learner): renderContextMirror projects skills for the fleet

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Agent — `--falsify` CLI and mirror sync

**Files:**
- Modify: `agents/marketing-learner/index.js`
- Modify: `tests/agents/marketing-learner-cli.test.js` (insert above the final `console.log`)

**Interfaces:**
- Consumes: `falsifyTactic`, `renderContextMirror` (Tasks 1 and 3); `scanSkillInventory` (existing).
- Produces: `parseArgs` gains `{ falsify, claim, reason }`; internal `syncContextMirror()` and `runFalsify()`.

- [ ] **Step 1: Write the failing test**

Insert into `tests/agents/marketing-learner-cli.test.js`, **above** the final `console.log`:

```js
// ── --falsify parsing ───────────────────────────────────────────────────────
{
  const a = parseArgs(['--falsify', 'marketing-copy', '--claim', 'taboo', '--reason', 'CTR tanked']);
  assert.equal(a.falsify, 'marketing-copy');
  assert.equal(a.claim, 'taboo');
  assert.equal(a.reason, 'CTR tanked');
  assert.deepEqual(a.urls, [], 'no URLs needed in falsify mode');
}

assert.throws(() => parseArgs(['--falsify', 'marketing-copy', '--claim', 'x']),
  /--falsify requires --reason/, 'reason is mandatory');
assert.throws(() => parseArgs(['--falsify', 'marketing-copy', '--reason', 'x']),
  /--falsify requires --claim/, 'claim is mandatory');
assert.throws(() => parseArgs(['--falsify']),
  /--falsify requires a skill name/, 'dangling --falsify throws');

// Modes are exclusive — silently ignoring one would be worse than refusing.
assert.throws(
  () => parseArgs(['https://youtu.be/aaaaaaaaaaa', '--falsify', 'marketing-copy', '--claim', 'x', '--reason', 'y']),
  /cannot be combined with URLs/,
  'falsify + URL throws'
);
assert.throws(
  () => parseArgs(['--falsify', 'marketing-copy', '--claim', 'x', '--reason', 'y', '--no-pr']),
  /cannot be combined with/,
  'falsify + run flag throws'
);

// Normal runs still work unchanged.
{
  const a = parseArgs(['https://youtu.be/aaaaaaaaaaa', '--published', '2026-03-14']);
  assert.equal(a.falsify, null);
  assert.deepEqual(a.published, ['2026-03-14']);
}

// ── wiring ──────────────────────────────────────────────────────────────────
assert.ok(src.includes('falsifyTactic'), 'agent wires falsifyTactic');
assert.ok(src.includes('renderContextMirror'), 'agent wires renderContextMirror');
assert.ok(src.includes("'marketing-tactics.md'") || src.includes('marketing-tactics.md'),
  'agent writes the context mirror');
assert.ok(src.includes('syncContextMirror'), 'agent has a mirror sync step');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/marketing-learner-cli.test.js`
Expected: FAIL — `parseArgs` does not know `--falsify`.

- [ ] **Step 3: Write minimal implementation**

**3a.** Add `falsifyTactic` and `renderContextMirror` to the existing import from `../../lib/marketing-learner.js`.

**3b.** Replace `parseArgs` with:

```js
const VALUE_FLAGS = { '--published': 'published', '--falsify': 'falsify', '--claim': 'claim', '--reason': 'reason' };

export function parseArgs(argv) {
  const out = {
    urls: [], published: [], extractOnly: false, noPr: false, refetch: false,
    falsify: null, claim: null, reason: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS[a]) {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        throw new Error(a === '--falsify' ? '--falsify requires a skill name.' : `${a} requires a value.`);
      }
      if (a === '--published') out.published.push(v);
      else out[VALUE_FLAGS[a]] = v;
    } else if (FLAGS[a]) {
      out[FLAGS[a]] = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      out.urls.push(a);
    }
  }

  if (out.falsify) {
    if (!out.claim) throw new Error('--falsify requires --claim "<substring of the tactic>".');
    if (!out.reason) throw new Error('--falsify requires --reason "<what happened when you tested it>".');
    if (out.urls.length) throw new Error('--falsify cannot be combined with URLs — it is a separate mode.');
    if (out.extractOnly || out.noPr || out.refetch || out.published.length) {
      throw new Error('--falsify cannot be combined with --extract-only, --no-pr, --refetch, or --published.');
    }
    return out;
  }

  if (out.claim || out.reason) throw new Error('--claim and --reason are only valid with --falsify.');
  if (!out.urls.length) throw new Error('Provide at least one YouTube URL.');
  return out;
}
```

**3c.** Add above `processVideo`:

```js
const MIRROR_PATH = join(ROOT, 'data', 'context', 'marketing-tactics.md');

/**
 * Regenerate the fleet-readable projection of the skills. Runs after EVERY write
 * to .claude/skills/ — create, merge, or falsify — so the mirror cannot drift.
 * Re-scans rather than tracking deltas: it is a handful of file reads, and
 * correctness beats cleverness for a file other agents act on.
 */
function syncContextMirror() {
  mkdirSync(dirname(MIRROR_PATH), { recursive: true });
  writeFileSync(MIRROR_PATH, renderContextMirror(scanSkillInventory(SKILLS_DIR)));
  return MIRROR_PATH;
}

/** Mark a tactic dead. No network, no LLM call — pure text surgery. */
function runFalsify({ falsify, claim, reason }) {
  const inventory = scanSkillInventory(SKILLS_DIR);
  const skill = inventory.find((s) => s.name === falsify);
  if (!skill) {
    const names = inventory.map((s) => s.name).join(', ') || '(no marketing skills yet)';
    throw new Error(`No skill named "${falsify}". Available: ${names}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(skill.path, falsifyTactic(skill.content, { claim, reason, today }));
  console.log(`✓ falsified in ${relative(ROOT, skill.path)}`);
  console.log(`✓ mirror updated: ${relative(ROOT, syncContextMirror())}`);
}
```

**3d.** In `main()`, immediately after `const args = parseArgs(process.argv.slice(2));`, add:

```js
  if (args.falsify) {
    runFalsify(args);
    return;
  }
```

This sits **before** the `TRANSCRIPTAPI_KEY` and `ANTHROPIC_API_KEY` checks — falsifying needs neither.

**3e.** In `processVideo`, immediately after the `for (const [name, { tactics }] of bySkill)` loop closes, add:

```js
    if (skillsTouched.length) syncContextMirror();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/marketing-learner-cli.test.js`
Expected: PASS.

Then: `npm test` — expected: no new failures versus the baseline (only `tests/agents/priority-tuner.test.js` may fail).

- [ ] **Step 5: Commit**

```bash
git add agents/marketing-learner/index.js tests/agents/marketing-learner-cli.test.js
git commit -m "feat(marketing-learner): --falsify mode and context mirror sync

Falsify needs no API keys, so it returns before the credential checks.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire the mirror into `creative-packager`

**Files:**
- Modify: `agents/creative-packager/index.js`
- Test: `tests/agents/creative-packager-tactics.test.js` (create)

**Interfaces:**
- Consumes: `data/context/marketing-tactics.md` (Task 4 writes it).
- Produces: `loadTacticMenu(root) -> string|null`; `buildCopyBrief` gains a `tacticMenu` option and passes it through; `buildCopyPrompt` emits it.

**Existing shapes you are extending (do not change their behavior):**
- `loadPersonas(root = ROOT)` returns the parsed object or `null` on any failure — copy that degradation pattern exactly.
- `buildCopyBrief(ad, { personas = null, personaId = null, angleId = null })` returns a brief object.
- `buildCopyPrompt(brief)` pushes lines onto a `lines` array.

- [ ] **Step 1: Write the failing test**

Create `tests/agents/creative-packager-tactics.test.js`:

```js
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTacticMenu, buildCopyBrief, buildCopyPrompt } from '../../agents/creative-packager/index.js';

// ── loadTacticMenu ──────────────────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'cp-'));
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  writeFileSync(join(root, 'data', 'context', 'marketing-tactics.md'), '# Marketing Tactics\n\n## Do not propose\n\n- Use taboo framing\n');
  const menu = loadTacticMenu(root);
  assert.match(menu, /Do not propose/, 'reads the mirror');
  assert.match(menu, /Use taboo framing/, 'carries the blocklist');
}

// Absent file must NOT throw — it does not exist until the first learn run.
assert.equal(loadTacticMenu(join(tmpdir(), 'definitely-not-here-98765')), null,
  'missing mirror returns null instead of throwing');

// ── the menu reaches the prompt ─────────────────────────────────────────────
{
  const ad = { pageName: 'Coconut Lotion', landingUrl: 'https://realskincare.com/x' };
  const brief = buildCopyBrief(ad, { tacticMenu: '## Do not propose\n\n- Use taboo framing' });
  assert.match(brief.tacticMenu, /taboo/, 'brief carries the menu');

  const prompt = buildCopyPrompt(brief);
  assert.match(prompt, /Use taboo framing/, 'prompt includes the menu');
  assert.match(prompt, /tested|do not propose/i, 'prompt frames what the menu is');
}

// ── absent menu leaves the prompt working and unchanged in shape ────────────
{
  const ad = { pageName: 'Coconut Lotion', landingUrl: 'https://realskincare.com/x' };
  const prompt = buildCopyPrompt(buildCopyBrief(ad, {}));
  assert.match(prompt, /Write 3 ad copy variations/, 'still builds a usable prompt with no menu');
  assert.ok(!/do not propose/i.test(prompt), 'no empty menu block leaks in');
}

console.log('✓ creative-packager tactic-menu tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/creative-packager-tactics.test.js`
Expected: FAIL — `loadTacticMenu` is not exported.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `agents/creative-packager/index.js`, add immediately after `loadPersonas`:

```js
/**
 * The fleet-readable projection of the marketing skills, written by
 * agents/marketing-learner. Absent on any checkout that has never run the
 * learner, so a miss degrades to current behavior rather than throwing.
 */
export function loadTacticMenu(root = ROOT) {
  try {
    const raw = readFileSync(join(root, 'data', 'context', 'marketing-tactics.md'), 'utf8');
    return raw.trim() || null;
  } catch { return null; }
}
```

**3b.** Change the `buildCopyBrief` signature to accept and pass through the menu. Replace:

```js
export function buildCopyBrief(ad, { personas = null, personaId = null, angleId = null } = {}) {
  const base = {
    product: ad.pageName || ad.pageSlug || 'Real Skin Care',
    destinationUrl: ad.landingUrl || '',
  };
```

with:

```js
export function buildCopyBrief(ad, { personas = null, personaId = null, angleId = null, tacticMenu = null } = {}) {
  const base = {
    product: ad.pageName || ad.pageSlug || 'Real Skin Care',
    destinationUrl: ad.landingUrl || '',
    ...(tacticMenu ? { tacticMenu } : {}),
  };
```

The `...base` spread already flows into both return paths, so no other change is needed there.

**3c.** In `buildCopyPrompt`, immediately after the `if (brief.copyInsights) lines.push(...)` line, add:

```js
  if (brief.tacticMenu) {
    lines.push(
      '',
      'Tactics learned from marketing research, and tactics already tested here that failed:',
      brief.tacticMenu,
      '',
      'Draw an angle from the live tactics above. Never propose anything under "Do not propose" — those were tested at this business and lost.'
    );
  }
```

**3d.** At the call site that builds the brief for a live job, pass the menu. Find where `buildCopyBrief(` is invoked with `{ personas ... }` and add `tacticMenu: loadTacticMenu()` to that options object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/creative-packager-tactics.test.js`
Expected: PASS.

Then run the existing creative-packager tests so the additive change broke nothing:

Run: `npm test`
Expected: no new failures versus baseline.

- [ ] **Step 5: Commit**

```bash
git add agents/creative-packager/index.js tests/agents/creative-packager-tactics.test.js
git commit -m "feat(creative-packager): read the marketing tactic menu

Additive — the persona-angle default is untouched. A missing mirror
degrades to current behavior rather than throwing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Manual end-to-end verification

Repo rule #4: prove it on real data before trusting it. This task writes no production code.

- [ ] **Step 1: Generate the mirror from the existing skills**

The five skills already on this branch have never produced a mirror. Force one by falsifying a real tactic. First list what is there:

```bash
grep -h '^## ' .claude/skills/marketing-conversion-copy-angles/SKILL.md
```

- [ ] **Step 2: Falsify a real tactic**

Pick one from that list and run:

```bash
node agents/marketing-learner/index.js --falsify marketing-conversion-copy-angles \
  --claim "<distinctive substring from a heading>" \
  --reason "Manual verification run 2026-07-27 — not a real test result"
```

Expected: two `✓` lines, one naming the skill file and one naming the mirror.

- [ ] **Step 3: Confirm both files changed correctly**

```bash
sed -n '/## Falsified/,$p' .claude/skills/marketing-conversion-copy-angles/SKILL.md
sed -n '/## Do not propose/,/^## /p' data/context/marketing-tactics.md
```

Confirm: the tactic moved under `## Falsified` with its body and provenance intact; the same claim appears in the mirror's blocklist.

- [ ] **Step 4: Confirm the ambiguity guards fire**

```bash
node agents/marketing-learner/index.js --falsify marketing-conversion-copy-angles --claim "zzzznotreal" --reason "x"
node agents/marketing-learner/index.js --falsify marketing-conversion-copy-angles --claim "e" --reason "x"
```

Expected: the first lists the available claims; the second reports multiple matches and lists them. Neither writes anything.

- [ ] **Step 5: Confirm no resurrection**

Re-run the video whose tactic you just falsified. The transcript is cached, so this costs **0 TranscriptAPI credits** (it does spend Anthropic tokens).

```bash
node agents/marketing-learner/index.js "https://www.youtube.com/watch?v=5C5VhqW9HCc" --published 2026-06-25 --no-pr
sed -n '/## Falsified/,$p' .claude/skills/marketing-conversion-copy-angles/SKILL.md
```

Confirm the falsified tactic is **still under `## Falsified`** and has not been moved back into the live body. If it was resurrected, the merge prompt needs strengthening — report that rather than papering over it.

- [ ] **Step 6: Commit the verification artifacts**

```bash
git add .claude/skills data/context/marketing-tactics.md data/reports/marketing-learner
git commit -m "test(marketing-learner): e2e verification of falsify + mirror

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Report to Sean**

State plainly: which tactic was falsified, whether both files updated, whether the guards fired, and whether the re-run resurrected anything. If the merge put it back, say so — that is the single most important result in this task.

---

## Notes for the implementer

- Run `npm test` once BEFORE starting to establish the baseline. Only `tests/agents/priority-tuner.test.js` should fail; it is pre-existing and unrelated. That is how you tell your regressions from the inherited one.
- `data/context/` is tracked in git — the mirror gets committed, unlike `data/marketing-corpus/` which is gitignored.
- `--falsify` needs no API keys. If you find yourself adding a credential check to that path, the ordering in Task 4 step 3d is wrong.
- Do not run the agent without `--no-pr` — it pushes branches and opens real pull requests.
