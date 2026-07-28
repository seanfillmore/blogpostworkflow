import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, writeSkill, syncMirrorIfTouched, runFalsify } from '../../agents/marketing-learner/index.js';

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
// Regression: parseArgs's --falsify rewrite collapsed this into a generic
// "${a} requires a value." ternary, silently dropping the specific
// YYYY-MM-DD guidance. Pin the exact restored wording so a future refactor
// can't lose it again without the test noticing.
assert.throws(() => parseArgs(['--published']), /--published requires a YYYY-MM-DD value\./, 'dangling flag throws, with the specific format hint');
assert.throws(() => parseArgs([]), /at least one YouTube URL/, 'no urls throws');
assert.throws(() => parseArgs(['u1', '--bogus']), /Unknown flag/, 'unknown flag throws');

// ── wiring checks (structure, not behavior — the agent shells out and hits APIs) ──
const src = readFileSync('agents/marketing-learner/index.js', 'utf8');
assert.ok(existsSync('agents/marketing-learner/index.js'), 'agent file exists');
assert.ok(src.includes("from '../../lib/transcript-source.js'"), 'uses the transcript seam');
assert.ok(src.includes("from '../../lib/anthropic.js'"), 'uses the METERED Anthropic wrapper');
assert.ok(!src.includes("from '@anthropic-ai/sdk'"), 'must not import the SDK directly — that bypasses cost metering');

// Regression: a bare `new Anthropic()` reads process.env, which loadEnv() never
// populates — it parses .env into a local object. This threw at request time on
// the first real run, AFTER a paid transcript credit had already been spent.
assert.ok(!/new Anthropic\(\s*\)/.test(src),
  'must not construct Anthropic with no args — loadEnv() does not populate process.env');
assert.ok(/new Anthropic\(\{\s*apiKey:/.test(src),
  'must pass apiKey explicitly, as every other agent in this repo does');
assert.ok(src.includes('ANTHROPIC_API_KEY'),
  'must read ANTHROPIC_API_KEY from the local env loader and fail fast when absent');
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

// ── syncMirrorIfTouched: mirror rides in the SAME collection openPullRequest stages ──
// Regression: processVideo used to call `syncContextMirror();` as a bare statement,
// discarding its return value. The mirror got rewritten on disk but never landed in
// `writtenPaths` — the only array openPullRequest git-adds from — so a merged PR left
// the checked-in projection stale. A plain `src.includes('syncContextMirror')` check
// would still pass with that bug present; this exercises the real function and
// inspects its actual return value.
//
// F4: sandboxed with mkdtempSync overrides (like writeSkill's tests below) rather
// than exercising the default SKILLS_DIR/MIRROR_PATH — those point at the real
// project tree, and `npm test` must never rewrite the tracked mirror file.
{
  const skillsDir = mkdtempSync(join(tmpdir(), 'ml-mirror-skills-'));
  mkdirSync(join(skillsDir, 'marketing-x'), { recursive: true });
  writeFileSync(join(skillsDir, 'marketing-x', 'SKILL.md'),
    '---\nname: marketing-x\ndescription: d\n---\n\n# X\n\n## Tactic\n\nBody.\n');
  const mirrorPath = join(mkdtempSync(join(tmpdir(), 'ml-mirror-out-')), 'marketing-tactics.md');

  const writtenPaths = ['/fake/report.json', '/fake/skill/SKILL.md'];
  const result = syncMirrorIfTouched(
    writtenPaths,
    [{ name: 'marketing-x', action: 'edit', path: '/fake/skill/SKILL.md' }],
    { skillsDir, mirrorPath }
  );

  assert.equal(result, writtenPaths, 'mutates and returns the same array processVideo passes to openPullRequest');
  assert.equal(writtenPaths.length, 3, 'mirror path was pushed on top of the existing entries');
  assert.equal(writtenPaths[2], mirrorPath, 'the exact path syncContextMirror() returned was captured, not discarded');
  assert.ok(writtenPaths.includes(mirrorPath), 'mirror path is in the same collection the PR stages from');
  assert.ok(existsSync(mirrorPath), 'the sandboxed mirror path was actually written to');
  assert.match(readFileSync(mirrorPath, 'utf8'), /marketing-x/, 'sandboxed mirror reflects the sandboxed skills dir');
}
{
  // No skill touched → nothing to re-sync, writtenPaths passes through unchanged.
  // No skillsDir/mirrorPath override needed: skillsTouched is empty, so
  // syncContextMirror is never called and nothing real gets touched either way.
  const writtenPaths = ['/fake/report.json'];
  syncMirrorIfTouched(writtenPaths, []);
  assert.deepEqual(writtenPaths, ['/fake/report.json'], 'mirror sync skipped, and nothing spuriously staged, when no skill changed');
}

// ── F7: repeated syncs must not stack duplicate mirror entries ──────────────
// processVideo calls this once per skill write (deliberately — a mid-loop throw
// must still leave the mirror consistent with what already landed on disk), so
// an unconditional push accumulated one MIRROR_PATH per skill. That was harmless
// only because openPullRequest dedupes with a Set — an accidental load-bearing
// dedupe two functions away. Keep the array clean at source instead.
{
  const skillsDir = mkdtempSync(join(tmpdir(), 'ml-mirror-dupe-'));
  mkdirSync(join(skillsDir, 'marketing-x'), { recursive: true });
  writeFileSync(join(skillsDir, 'marketing-x', 'SKILL.md'),
    '---\nname: marketing-x\ndescription: d\n---\n\n# X\n\n## Tactic\n\nBody.\n');
  const mirrorPath = join(mkdtempSync(join(tmpdir(), 'ml-mirror-dupe-out-')), 'marketing-tactics.md');

  const writtenPaths = ['/fake/report.json'];
  const touched = [{ name: 'marketing-x', action: 'edit', path: '/fake/a/SKILL.md' }];
  syncMirrorIfTouched(writtenPaths, touched, { skillsDir, mirrorPath });
  syncMirrorIfTouched(writtenPaths, [...touched, { name: 'marketing-y', action: 'create', path: '/fake/b/SKILL.md' }], { skillsDir, mirrorPath });
  syncMirrorIfTouched(writtenPaths, touched, { skillsDir, mirrorPath });

  assert.deepEqual(writtenPaths, ['/fake/report.json', mirrorPath],
    'three syncs, one mirror entry — no reliance on openPullRequest deduping');
}

// ── F4: the mirror is regenerated AFTER the PR branch is cut from main ──────
// syncContextMirror projects whatever .claude/skills/ the WORKING TREE holds.
// The in-loop sync runs on the operator's branch, which may carry skills that do
// not exist on main; checking out from main drops those files, so that mirror
// would advertise tactics whose SKILL.md the PR does not contain. Structural
// check (the real thing shells out to git/gh and pushes): the regeneration call
// must sit between the checkout and the `git add`.
{
  const checkoutIdx = src.indexOf("git(['checkout', '-b', branch, 'main'])");
  const regenIdx = src.indexOf('syncContextMirror()', checkoutIdx);
  const addIdx = src.indexOf("git(['add', ...paths])");
  assert.ok(checkoutIdx > -1, 'still branches from main');
  assert.ok(regenIdx > checkoutIdx && regenIdx < addIdx,
    'the mirror is regenerated after the branch is cut from main and before the files are staged');
}

// ── F2: runFalsify — the actual write path, in a sandbox ────────────────────
// falsifyTactic is exhaustively unit-tested as a pure string transform, but the
// function that resolves the skill from the inventory, writes skill.path and
// syncs the mirror had no coverage at all. Sandboxed with mkdtempSync: no
// network, no LLM call, no tracked file touched.
{
  const skillsDir = mkdtempSync(join(tmpdir(), 'ml-falsify-skills-'));
  const skillPath = join(skillsDir, 'marketing-copy', 'SKILL.md');
  mkdirSync(join(skillsDir, 'marketing-copy'), { recursive: true });
  writeFileSync(skillPath, [
    '---',
    'name: marketing-copy',
    'description: Use when writing product page copy',
    '---',
    '',
    '# Conversion Copy Angles',
    '',
    '## Use taboo framing to stop the scroll',
    '',
    '**Why it works:** Pattern interrupt.',
    '',
    '## Lead with a hard number',
    '',
    '**Why it works:** Specifics are falsifiable.',
    '',
  ].join('\n'));
  const mirrorPath = join(mkdtempSync(join(tmpdir(), 'ml-falsify-out-')), 'marketing-tactics.md');

  const result = runFalsify(
    { falsify: 'marketing-copy', claim: 'taboo', reason: 'CTR 0.4% vs 1.1% control' },
    { skillsDir, mirrorPath, today: '2026-08-14' }
  );

  assert.equal(result.skillPath, skillPath, 'writes the path the inventory scan found');

  const written = readFileSync(skillPath, 'utf8');
  assert.match(written, /^## Falsified$/m, 'the skill file on disk grew a graveyard');
  assert.match(written, /^### Use taboo framing to stop the scroll$/m, 'the tactic moved into it');
  assert.match(written, /\*\*Falsified 2026-08-14:\*\* CTR 0\.4% vs 1\.1% control/, 'stamped with the injected date and the reason');
  assert.match(written, /^## Lead with a hard number$/m, 'the untouched tactic is still live');
  assert.ok(!/^## Use taboo framing/m.test(written), 'the falsified tactic is no longer live');

  const mirror = readFileSync(mirrorPath, 'utf8');
  assert.match(mirror, /## Do not propose/, 'the mirror was regenerated');
  assert.match(mirror, /^- Use taboo framing to stop the scroll$/m, 'the blocklist picked the claim up immediately');
  assert.match(mirror, /Lead with a hard number/, 'live tactics still projected');
}

// ── F2: runFalsify refusal paths ────────────────────────────────────────────
// These previously existed only as manual observations. All four must throw
// rather than write something confident and wrong into a curated skill.
{
  const skillsDir = mkdtempSync(join(tmpdir(), 'ml-falsify-refuse-'));
  const skillPath = join(skillsDir, 'marketing-copy', 'SKILL.md');
  mkdirSync(join(skillsDir, 'marketing-copy'), { recursive: true });
  const original = [
    '---',
    'name: marketing-copy',
    'description: Use when writing product page copy',
    '---',
    '',
    '## Use taboo framing to stop the scroll',
    '',
    'Body.',
    '',
    '## Use a hard number in the headline',
    '',
    'Body.',
    '',
  ].join('\n');
  writeFileSync(skillPath, original);
  const mirrorPath = join(mkdtempSync(join(tmpdir(), 'ml-falsify-refuse-out-')), 'marketing-tactics.md');
  const opts = { skillsDir, mirrorPath, today: '2026-08-14' };

  assert.throws(
    () => runFalsify({ falsify: 'marketing-nonexistent', claim: 'x', reason: 'y' }, opts),
    /No skill named "marketing-nonexistent"\. Available: marketing-copy/,
    'unknown skill throws and lists what exists'
  );
  assert.throws(
    () => runFalsify({ falsify: 'marketing-copy', claim: 'nothing like this', reason: 'y' }, opts),
    /No live tactic matching "nothing like this"/,
    'zero matches throws'
  );
  assert.throws(
    () => runFalsify({ falsify: 'marketing-copy', claim: 'Use', reason: 'y' }, opts),
    /matches 2 live tactics/,
    'an ambiguous claim throws instead of guessing'
  );
  assert.equal(readFileSync(skillPath, 'utf8'), original, 'no refusal left a partial write behind');
  assert.ok(!existsSync(mirrorPath), 'and no refusal regenerated the mirror');

  // Already falsified: falsify once (which succeeds), then again.
  runFalsify({ falsify: 'marketing-copy', claim: 'taboo', reason: 'CTR tanked' }, opts);
  assert.throws(
    () => runFalsify({ falsify: 'marketing-copy', claim: 'taboo', reason: 'again' }, { ...opts, today: '2026-09-01' }),
    /already falsified on 2026-08-14/,
    're-falsifying names the date of the original record'
  );
}

console.log('✓ marketing-learner CLI tests pass');
