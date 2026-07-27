import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, writeSkill } from '../../agents/marketing-learner/index.js';

// ── parseArgs ───────────────────────────────────────────────────────────────
{
  const a = parseArgs(['https://youtu.be/aaaaaaaaaaa']);
  assert.deepEqual(a.urls, ['https://youtu.be/aaaaaaaaaaa']);
  assert.deepEqual(a.published, []);
  assert.equal(a.extractOnly, false);
  assert.equal(a.noPr, false);
  assert.equal(a.refetch, false);
}
{
  const a = parseArgs(['https://youtu.be/aaaaaaaaaaa', '--published', '2026-03-14', '--no-pr']);
  assert.deepEqual(a.published, ['2026-03-14']);
  assert.equal(a.noPr, true);
}
{
  const a = parseArgs(['u1', '--published', '2026-03-14', 'u2', '--published', '2025-01-02']);
  assert.deepEqual(a.urls, ['u1', 'u2'], 'urls collected regardless of flag interleaving');
  assert.deepEqual(a.published, ['2026-03-14', '2025-01-02'], 'repeatable --published');
}
{
  const a = parseArgs(['u1', '--extract-only', '--refetch']);
  assert.equal(a.extractOnly, true);
  assert.equal(a.refetch, true);
}
assert.throws(() => parseArgs(['--published']), /--published requires/, 'dangling flag throws');
assert.throws(() => parseArgs([]), /at least one YouTube URL/, 'no urls throws');
assert.throws(() => parseArgs(['u1', '--bogus']), /Unknown flag/, 'unknown flag throws');

// ── wiring checks (structure, not behavior — the agent shells out and hits APIs) ──
const src = readFileSync('agents/marketing-learner/index.js', 'utf8');
assert.ok(existsSync('agents/marketing-learner/index.js'), 'agent file exists');
assert.ok(src.includes("from '../../lib/transcript-source.js'"), 'uses the transcript seam');
assert.ok(src.includes("from '../../lib/anthropic.js'"), 'uses the METERED Anthropic wrapper');
assert.ok(!src.includes("from '@anthropic-ai/sdk'"), 'must not import the SDK directly — that bypasses cost metering');
assert.ok(src.includes('mergeSkillContent'), 'merges into existing skills rather than appending');
assert.ok(src.includes('extractVideoId'), 'derives the cache key without spending a credit');
assert.ok(src.includes('notify'), 'notifies on completion');
assert.ok(src.includes('.claude/skills') || src.includes("'.claude'"), 'writes into the project skills dir');
assert.ok(!/TRANSCRIPTAPI_KEY[^\n]*console\.log/.test(src), 'never logs the api key');

// package.json script
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts.learn, 'node agents/marketing-learner/index.js', 'npm run learn is wired');

// ── writeSkill: EDIT writes to the inventory's path, never a name-derived one ──────
// Regression for the data-loss bug: writeSkill used to recompute join(skillsDir, name)
// from the model's targetSkill.name instead of using the path scanSkillInventory
// actually found. When a skill's on-disk directory name doesn't match its frontmatter
// `name` (or when scanSkillInventory skipped a malformed sibling and only the caller
// carries the real path), that recomputation either writes to the wrong place or
// ENOENTs. existing.path is the only path this function may write to on the edit path.
{
  const dir = mkdtempSync(join(tmpdir(), 'ml-skills-'));
  const actualDir = join(dir, 'marketing-actual-dir'); // directory name deliberately != frontmatter name
  mkdirSync(actualDir, { recursive: true });
  const existingContent = '---\nname: marketing-different-name\ndescription: Existing skill\n---\n\n' + 'x'.repeat(500);
  const existingPath = join(actualDir, 'SKILL.md');
  writeFileSync(existingPath, existingContent);

  const mergedContent = existingContent + '\n\n## New tactic\n\nMore body.\n';
  const fakeClient = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ content: mergedContent, supersedes: null }) }],
      }),
    },
  };

  const existing = { name: 'marketing-different-name', description: 'Existing skill', path: existingPath, content: existingContent };
  const result = await writeSkill({
    name: 'marketing-different-name',
    description: 'Existing skill',
    tactics: [{
      claim: 'X', mechanism: 'Y', evidence: 'assertion only',
      rscFit: { score: 5, reasoning: 'z' },
      source: { creator: 'C', title: 'T', videoId: 'v' },
    }],
    existing,
    client: fakeClient,
    skillsDir: dir,
  });

  assert.equal(result.path, existingPath, 'writes to the inventory path, not join(skillsDir, name)');
  assert.notEqual(result.path, join(dir, 'marketing-different-name', 'SKILL.md'), 'never recomputes the path from the model name');
  assert.equal(readFileSync(existingPath, 'utf8'), mergedContent, 'the actual file on disk was updated');
  assert.ok(!existsSync(join(dir, 'marketing-different-name')), 'no directory created at the name-derived (nonexistent) path');
}

// ── writeSkill: CREATE refuses to clobber a file the inventory scan missed ─────────
// Malformed frontmatter (or a symlinked skill dir) makes scanSkillInventory skip a
// real skill, so `existing` comes back undefined even though SKILL.md is sitting
// right there. Silently taking the CREATE path would wipe out accumulated content
// with no validateSkillEdit guard in the way. Refusing is the correct behavior.
await assert.rejects(
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-skills-orphan-'));
    const orphanDir = join(dir, 'marketing-orphan');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'SKILL.md'), 'garbage, no frontmatter\n');

    await writeSkill({
      name: 'marketing-orphan',
      description: 'New description',
      tactics: [],
      existing: undefined,
      client: undefined,
      skillsDir: dir,
    });
  },
  /already exists but was not found/,
  'create path throws instead of silently overwriting a file the inventory scan missed'
);

console.log('✓ marketing-learner CLI tests pass');
