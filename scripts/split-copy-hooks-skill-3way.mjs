#!/usr/bin/env node
/**
 * Split marketing-copy-hooks-and-formats a SECOND time — a ONE-OFF, dry by default.
 *
 * WHY. agents/marketing-learner warned on its last run that the file is ~20,169 tokens,
 * 32% of mergeSkillContent's 64,000-token budget (skillSizeWarning warns at 30%). The merge
 * re-emits the WHOLE file before adding anything and shares that budget with thinking, so
 * past roughly half every merge onto this skill fails outright. The standing precedent —
 * marketing-paid-acquisition-scaling (raised 16k → 32k, back at 34% within weeks, then
 * split three ways) and the 2026-09-07 split that produced marketing-copy-body-structure —
 * is to SPLIT, never to raise the budget. (It had grown again by the time this ran: the file
 * on origin/main measures ~21,063 tokens, 33%, carrying 34 sections.)
 *
 * MEASURED AFTER, through the fleet's own skillSizeWarning rather than by eye:
 *   marketing-copy-hook-construction  ~8,131 tok  12.7%
 *   marketing-copy-hook-generation    ~5,451 tok   8.5%
 *   marketing-copy-hooks-and-formats  ~8,177 tok  12.8%
 * and 0 of the 46 marketing-* skills now sit above the 30% line.
 *
 * THE SPLIT AXIS: what the writer is actually doing at that moment.
 *   NEW   marketing-copy-hook-construction — the STANDARD. What a hook line must deliver
 *         (the two-part spec), the pre-ship checklist, the differentiation menu, the four
 *         failure modes and their two named fixes, and the craft constraints on the line
 *         itself (second person, contrast, the two-to-three-line budget, the spoken/overlay
 *         split, the seven interest components).
 *   NEW   marketing-copy-hook-generation — the PRODUCTION PROCESS. Where candidate lines
 *         come from (LLM clarity rewrite, swipe file, emotion wheel, power-phrase cloud,
 *         trigger-word injection) and how candidates get cut before one ships (amplify into
 *         ten, the isolation read, the three kill-tests).
 *   KEEP  marketing-copy-hooks-and-formats — the named opening GAMBITS (mid-action,
 *         product-out, transformation-first, the agreement opener, self-exclusion, the
 *         one-thing hook, curiosity-loop closure) and the FORMAT the piece takes
 *         (understatement register, camouflage, the format screen, long-form native, the
 *         reaction/plan piece), plus the Falsified graveyard, whose one entry is about
 *         disclosure on a dramatized ad and belongs beside the long-form native entry.
 *
 * WHY THE NAME STAYS ON THE THIRD GROUP. Names are stable identifiers, and of the eleven
 * substantive cross-references pointing at this skill from sibling skills, docs and
 * agents/ad-studio/golden-thread.js, nine name a rule that lands in the kept group:
 * understatement (x2), the agreement opener (x2), product-out-of-the-hook (x2),
 * transformation-first, mid-action, camouflage and the long-form native ad (x3). Renaming
 * the kept group would break all of those to fix none.
 *
 * SECTION TEXT IS BYTE-IDENTICAL. Verified by set comparison, never by eye — the same rule
 * the two prior splits followed. Nothing is reworded on the way out; if it were, this would
 * be an unreviewable rewrite wearing a refactor's clothes. The only new prose is each
 * file's frontmatter description and its header note.
 *
 * THE KNOWN COST, stated rather than discovered later. Every section carries directional
 * cross-references ("the rule above", "directly below"), so a split leaves some pointing
 * across a file boundary. That is real and not silently accepted: all three files carry a
 * header note naming their siblings, so a reader who cannot find "the rule above" knows
 * where it went. Resolving them by hand would mean rewriting every section, which destroys
 * the byte-identical property that makes this reviewable at all. The fleet's own projection
 * (renderContextMirror) already concatenates every skill, so those refs were never
 * positional for that consumer.
 *
 *   node scripts/split-copy-hooks-skill-3way.mjs            # plan
 *   node scripts/split-copy-hooks-skill-3way.mjs --apply
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, '.claude', 'skills');
const KEEP_NAME = 'marketing-copy-hooks-and-formats';
const SRC = join(SKILLS, KEEP_NAME, 'SKILL.md');
const CONSTRUCTION = 'marketing-copy-hook-construction';
const GENERATION = 'marketing-copy-hook-generation';
const apply = process.argv.includes('--apply');

/** 1-indexed section numbers per target. Every section must appear in exactly one set. */
const TO_CONSTRUCTION = new Set([1, 2, 3, 4, 5, 6, 7, 15, 16, 17, 18, 19]);
const TO_GENERATION = new Set([8, 9, 10, 11, 12, 13, 14, 20, 21]);
// Everything else (22-34, including the "## Falsified" graveyard) stays put.

const BODY_REF = 'For what happens AFTER the opening — congruence, body skeletons, the close and '
  + 'the drafting process — see marketing-copy-body-structure.';

const CONSTRUCTION_DESC = `Use when building the OPENING LINE of an ad, email, landing page, short-form video script or social caption and deciding what that line has to deliver — opening a loop on a named topic and withholding the resolution, specifying every hook against its two jobs of topic clarity and on-target curiosity, screening every hook against a four-point pre-ship checklist of ideal-customer fit, curiosity, audience size and differentiation, generating the differentiated half from a six-angle menu of speed, sacrifice-removal, price reframe, guarantee, new mechanism and dramatisation, diagnosing an underperforming hook against the four named failure modes of delay, confusion, irrelevance and disinterest, moving the topic-introducing sentence into the first one to two seconds, refusing context-free suspense lines, writing the hook at a sixth-grade reading level in active voice, framing the hook in second person rather than first, manufacturing curiosity from stated or implied contrast against the buyer's current default, budgeting two to three lines for the hook rather than one, treating the spoken hook and the on-screen text hook as two separate deliverables for the same video, and building headlines from the seven components that drive interest. For where candidate hook lines come from and how they are cut before shipping — the LLM prompts, the swipe file, the power-phrase cloud and the kill-tests — see ${GENERATION}. For the named opening gambits and which ad format the piece takes, see ${KEEP_NAME}. ${BODY_REF}`;

const GENERATION_DESC = `Use when you need CANDIDATE hook lines for an ad, email, landing page, short-form video script or social caption, or when cutting the candidates you already have down to the one that ships — running a named LLM clarity-rewrite prompt on it, refusing to prompt an LLM for hooks cold and seeding it with a swipe file of hooks that actually stopped you, prompting off an emotion wheel for a hook that provokes rather than describes, amplifying a winning AI hook into ten variants before hand-polishing, reading the hook in isolation and counting how many ways it can be read, generating hook variants off your own best past phrasing, writing headlines per-image after the visual exists and forcing the line to reference an especially vivid frame, deriving hook vocabulary from a power-phrase cloud of hooks that actually performed, and injecting a trigger word into a structure that already works. For what a finished hook must deliver, and how one is screened and diagnosed when it underperforms, see ${CONSTRUCTION}. For the named opening gambits and which ad format the piece takes, see ${KEEP_NAME}. ${BODY_REF}`;

const KEEP_DESC = `Use when choosing WHICH OPENING GAMBIT an ad, email, landing page, short-form video script or social caption uses, or choosing which ad format the piece takes — opening mid-action rather than setting the scene, keeping the product out of line one so discovery feels accidental, opening by getting the reader to agree, opening on the buyer's own self-exclusion so the ad removes the competence barrier before price, leading with the transformation instead of the problem, promising that one thing resolves it, paying off a curiosity setup on the destination page, escaping the hard-sell stereotype through understatement, camouflaging the piece as the medium it sits in, screening the product against the format before committing to a long native story, and running long-form native story ads or reaction pieces pegged to someone else's real story. For what a hook line must deliver and how it is screened and diagnosed, see ${CONSTRUCTION}; for where candidate lines come from and how they are cut, see ${GENERATION}. ${BODY_REF}`;

const raw = readFileSync(SRC, 'utf8');
const fmEnd = raw.indexOf('\n---\n', 4);
if (!raw.startsWith('---\n') || fmEnd === -1) throw new Error('Frontmatter not found.');
const afterFm = raw.slice(fmEnd + 5);

// Sections are "## " at line start. head = the H1 and any preamble before the first one.
const parts = afterFm.split(/^(?=## )/m);
const sections = parts.slice(1);
if (!sections.length) throw new Error('No sections parsed.');

const heading = (s) => s.split('\n')[0].slice(3).trim();
const construction = [], generation = [], keep = [];
sections.forEach((s, i) => {
  const n = i + 1;
  if (TO_CONSTRUCTION.has(n)) construction.push(s);
  else if (TO_GENERATION.has(n)) generation.push(s);
  else keep.push(s);
});

const NOTE_CONSTRUCTION = `> Split 2026-09-19 out of \`${KEEP_NAME}\`: this skill covers what the hook LINE must deliver, and how one is screened and diagnosed. Where candidate lines come from and how they are cut lives in \`${GENERATION}\`; the named opening gambits and the ad formats stay in \`${KEEP_NAME}\`; congruence, the body skeletons, the close and the drafting process live in \`marketing-copy-body-structure\`. Some "above"/"below" cross-references point across those boundaries.\n\n`;
const NOTE_GENERATION = `> Split 2026-09-19 out of \`${KEEP_NAME}\`: this skill covers where candidate hook lines come from and how they are cut before one ships. What a hook must deliver lives in \`${CONSTRUCTION}\`; the named opening gambits and the ad formats stay in \`${KEEP_NAME}\`; congruence, the body skeletons, the close and the drafting process live in \`marketing-copy-body-structure\`. Some "above"/"below" cross-references point across those boundaries.\n\n`;
const NOTE_KEEP = `> Split 2026-09-07, and again 2026-09-19: this skill now covers the named opening GAMBITS and the ad FORMAT the piece takes. What a hook line must deliver lives in \`${CONSTRUCTION}\`, where candidate lines come from and how they are cut in \`${GENERATION}\`, and congruence, the body skeletons, the close and the drafting process in \`marketing-copy-body-structure\`. Some "above"/"below" cross-references point across those boundaries.\n\n`;

const doc = (name, title, desc, note, secs) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${title}\n\n${note}` + secs.join('').trimEnd() + '\n';

const constructionDoc = doc(CONSTRUCTION, 'Copy Hook Construction', CONSTRUCTION_DESC, NOTE_CONSTRUCTION, construction);
const generationDoc = doc(GENERATION, 'Copy Hook Generation', GENERATION_DESC, NOTE_GENERATION, generation);
const keepDoc = doc(KEEP_NAME, 'Copy Hooks and Formats', KEEP_DESC, NOTE_KEEP, keep);

// ── VERIFY: every section survives, byte-identical, in exactly one file ──
const before = sections.map((s) => s.trimEnd());
const after = [...construction, ...generation, ...keep].map((s) => s.trimEnd());
const bs = new Set(before), as = new Set(after);
const lost = before.filter((s) => !as.has(s));
const gained = after.filter((s) => !bs.has(s));
const dupes = after.filter((s, i) => after.indexOf(s) !== i);

console.log(`source: ${sections.length} sections (~${Math.round(raw.length / 4).toLocaleString()} tokens)`);
console.log(`  → ${CONSTRUCTION}: ${construction.length}`);
console.log(`  → ${GENERATION}: ${generation.length}`);
console.log(`  → ${KEEP_NAME} (kept): ${keep.length}`);
console.log(`\nverification (set comparison, not by eye):`);
console.log(`  sections lost:        ${lost.length}`);
console.log(`  sections invented:    ${gained.length}`);
console.log(`  sections duplicated:  ${dupes.length}`);
if (lost.length || gained.length || dupes.length) {
  for (const s of [...lost, ...gained, ...dupes].slice(0, 5)) console.log(`   ! ${heading(s).slice(0, 80)}`);
  throw new Error('Refusing to write: the split is not text-preserving.');
}

// A Stage marker dropped on the way out is a test failure elsewhere; count both sides.
const stages = (t) => (t.match(/\*\*Stage:\*\*/g) || []).length;
const stageBefore = stages(afterFm);
const stageAfter = stages(constructionDoc) + stages(generationDoc) + stages(keepDoc);
console.log(`  **Stage:** markers:   ${stageBefore} before, ${stageAfter} after`);
if (stageBefore !== stageAfter) throw new Error('Refusing to write: a Stage marker was dropped.');

const grave = [...construction, ...generation, ...keep].filter((s) => /^## Falsified/.test(s));
const graveIn = grave.length
  ? (keep.includes(grave[0]) ? KEEP_NAME : construction.includes(grave[0]) ? CONSTRUCTION : GENERATION)
  : 'ABSENT';
console.log(`  falsified graveyard:  ${grave.length ? 'preserved in ' + graveIn : 'ABSENT'}`);

for (const [name, text] of [[CONSTRUCTION, constructionDoc], [GENERATION, generationDoc], [KEEP_NAME, keepDoc]]) {
  const tok = Math.round(text.length / 4);
  console.log(`  size ${name}: ${text.length.toLocaleString()} chars ≈ ${tok.toLocaleString()} tok `
    + `(${(tok / 64000 * 100).toFixed(1)}% of the 64k merge budget)`);
}

console.log(`\n→ ${CONSTRUCTION}:`);
for (const s of construction) console.log(`  - ${heading(s).slice(0, 88)}`);
console.log(`\n→ ${GENERATION}:`);
for (const s of generation) console.log(`  - ${heading(s).slice(0, 88)}`);
console.log(`\nstaying in ${KEEP_NAME}:`);
for (const s of keep) console.log(`  - ${heading(s).slice(0, 88)}`);

if (!apply) { console.log('\nDry run — pass --apply to write.'); process.exit(0); }

for (const [name, text] of [[CONSTRUCTION, constructionDoc], [GENERATION, generationDoc]]) {
  const dir = join(SKILLS, name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
}
writeFileSync(SRC, keepDoc);
console.log(`\n✓ wrote all three files.`);
