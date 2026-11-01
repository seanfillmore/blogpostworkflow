#!/usr/bin/env node
/**
 * Split marketing-copy-hooks-and-formats — a ONE-OFF, dry by default.
 *
 * WHY. The file reached 36% of mergeSkillContent's 64k budget (23,060 tokens, 43 live
 * sections). The merge re-emits the WHOLE file before adding anything and shares that
 * budget with thinking, so past roughly half, every merge onto this skill fails outright.
 * Two consecutive video ingestions grew it. The precedent (PR #569, the
 * marketing-paid-acquisition-scaling split) is to SPLIT, never to raise the budget.
 *
 * THE SPLIT LINE: the opening versus everything after it.
 *   KEEP  marketing-copy-hooks-and-formats — the hook itself, headline construction, the
 *         opening gambits, and which ad FORMAT the piece takes. Name is unchanged because
 *         three sibling skills, agents/ad-studio/golden-thread.js, a test and the docs all
 *         reference it by name; "names are stable identifiers".
 *   NEW   marketing-copy-body-structure — congruence and the golden thread, the body
 *         skeletons and beats, the close, and the process for drafting a long piece.
 *
 * SECTION TEXT IS BYTE-IDENTICAL. Verified by set comparison, never by eye — same rule the
 * #569 split followed. Nothing is reworded on the way out; if it were, this would be an
 * unreviewable rewrite wearing a refactor's clothes.
 *
 * THE KNOWN COST, stated rather than discovered later. All 43 sections carry directional
 * cross-references — 143 "the rule above" / "directly below" phrases — so a split leaves
 * some pointing across the file boundary. That is real and it is not silently accepted:
 * both files gain a header line naming the sibling, so a reader who cannot find "the rule
 * above" knows where it went. Resolving all 143 by hand would mean rewriting every section,
 * which destroys the byte-identical property that makes this reviewable at all. The
 * fleet's own projection (renderContextMirror) already concatenates every skill, so those
 * refs were never positional for that consumer.
 *
 *   node scripts/split-copy-hooks-skill.mjs            # plan
 *   node scripts/split-copy-hooks-skill.mjs --apply
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, '.claude', 'skills');
const SRC = join(SKILLS, 'marketing-copy-hooks-and-formats', 'SKILL.md');
const NEW_NAME = 'marketing-copy-body-structure';
const apply = process.argv.includes('--apply');

/** 1-indexed section numbers that MOVE to the new skill. Everything else stays. */
const MOVE = new Set([13, 14, 15, 16, 17, 18, 19, 20, 25, 26, 27, 32, 33, 34, 36, 39]);

const KEEP_DESC = `Use when writing the OPENING of an ad, email, landing page, short-form video script or social caption, or choosing which ad format the piece takes — opening a loop on a named topic and withholding the resolution, specifying every hook against its two jobs of topic clarity and on-target curiosity, diagnosing an underperforming hook against the four named failure modes of delay, confusion, irrelevance and disinterest, moving the topic-introducing sentence into the first one to two seconds, refusing context-free suspense lines, writing the hook at a sixth-grade reading level in active voice, running a named LLM clarity-rewrite prompt on it, reading the hook in isolation and counting how many ways it can be read, generating hook variants off your own best past phrasing, deriving hook vocabulary from a power-phrase cloud of hooks that actually performed, framing the hook in second person rather than first, manufacturing curiosity from stated or implied contrast against the buyer's current default, budgeting two to three lines for the hook rather than one, treating the spoken hook and the on-screen text hook as two separate deliverables for the same video, building headlines from the seven components that drive interest, injecting a trigger word into a structure that already works, opening mid-action rather than setting the scene, keeping the product out of line one so discovery feels accidental, opening by getting the reader to agree, opening on the buyer's own self-exclusion so the ad removes the competence barrier before price, leading with the transformation instead of the problem, promising that one thing resolves it, paying off a curiosity setup on the destination page, escaping the hard-sell stereotype through understatement, camouflaging the piece as the medium it sits in, screening the product against the format before committing to a long native story, and running long-form native story ads or reaction pieces pegged to someone else's real story. For what happens AFTER the opening — congruence, body skeletons, the close and the drafting process — see marketing-copy-body-structure.`;

const NEW_DESC = `Use when writing or auditing everything AFTER the opening line of an ad, email or short-form script — refusing to let the hook's premise become the piece's theme and pivoting the body onto the reasons the market actually buys, paying that premise back once late as a small bonus, auditing every LLM-drafted piece against a fixed checklist for the golden-thread defect before it ships, locking awareness level, tension and opening before a line is written and approving a long draft section by section, voice-dictating a raw brain dump of what you know before generating anything, drafting against the canonical published structure for the format rather than briefing a model cold, reading the full transcript of the best-performing piece on the topic before scripting, building a generation engine on a corpus of deep-analyzed top performers rather than a web search, sequencing the body through seven ordered beats from micro-situation to mechanism, running the whole piece on the six-step skeleton from problem through mechanism superiority, result and objection bridge to the close, holding attention with numbered lists, ordered steps and stories, carrying a single dominant idea through the piece and making that idea the market's buying motive, inserting momentum phrases into transitions, adapting a piece to a shorter placement by cutting angles rather than the hook or the ask, concentrating effort on concept and hook rather than body copy, and closing with an unhedged imperative. For the opening line itself and format selection, see marketing-copy-hooks-and-formats.`;

const raw = readFileSync(SRC, 'utf8');
const fmEnd = raw.indexOf('\n---\n', 4);
if (!raw.startsWith('---\n') || fmEnd === -1) throw new Error('Frontmatter not found.');
const afterFm = raw.slice(fmEnd + 5);

// Sections are "## " at line start. head = the H1 and any preamble before the first one.
const parts = afterFm.split(/^(?=## )/m);
const head = parts[0];
const sections = parts.slice(1);
if (!sections.length) throw new Error('No sections parsed.');

const heading = (s) => s.split('\n')[0].slice(3).trim();
const keep = [], move = [];
sections.forEach((s, i) => (MOVE.has(i + 1) ? move : keep).push(s));

const SIBLING_KEEP = `> Split 2026-09-07: this skill covers the OPENING and the format. Congruence, the body skeletons, the close and the drafting process live in \`${NEW_NAME}\`. Some "above"/"below" cross-references point across that boundary.\n\n`;
const SIBLING_NEW = `> Split 2026-09-07 out of \`marketing-copy-hooks-and-formats\`, which still covers the opening line itself and format selection. Some "above"/"below" cross-references point back across that boundary.\n\n`;

const keepDoc = `---\nname: marketing-copy-hooks-and-formats\ndescription: ${KEEP_DESC}\n---\n\n`
  + `# Copy Hooks and Formats\n\n${SIBLING_KEEP}` + keep.join('').trimEnd() + '\n';
const newDoc = `---\nname: ${NEW_NAME}\ndescription: ${NEW_DESC}\n---\n\n`
  + `# Copy Body and Structure\n\n${SIBLING_NEW}` + move.join('').trimEnd() + '\n';

// ── VERIFY: every section survives, byte-identical, in exactly one file ──
const before = sections.map((s) => s.trimEnd());
const after = [...keep, ...move].map((s) => s.trimEnd());
const bs = new Set(before), as = new Set(after);
const lost = before.filter((s) => !as.has(s));
const gained = after.filter((s) => !bs.has(s));
const dupes = after.filter((s, i) => after.indexOf(s) !== i);

console.log(`source: ${sections.length} sections`);
console.log(`  keep → marketing-copy-hooks-and-formats: ${keep.length}`);
console.log(`  move → ${NEW_NAME}: ${move.length}`);
console.log(`\nverification (set comparison, not by eye):`);
console.log(`  sections lost:        ${lost.length}`);
console.log(`  sections invented:    ${gained.length}`);
console.log(`  sections duplicated:  ${dupes.length}`);
if (lost.length || gained.length || dupes.length) {
  for (const s of [...lost, ...gained, ...dupes].slice(0, 5)) console.log(`   ! ${heading(s).slice(0, 80)}`);
  throw new Error('Refusing to write: the split is not text-preserving.');
}
const grave = [...keep, ...move].filter((s) => /^## Falsified/.test(s));
console.log(`  falsified graveyard:  ${grave.length ? 'preserved in ' + (keep.includes(grave[0]) ? 'hooks-and-formats' : NEW_NAME) : 'ABSENT'}`);

console.log(`\nmoving to ${NEW_NAME}:`);
for (const s of move) console.log(`  - ${heading(s).slice(0, 88)}`);

if (!apply) { console.log('\nDry run — pass --apply to write.'); process.exit(0); }

const dir = join(SKILLS, NEW_NAME);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'SKILL.md'), newDoc);
writeFileSync(SRC, keepDoc);
console.log(`\n✓ wrote both files.`);
