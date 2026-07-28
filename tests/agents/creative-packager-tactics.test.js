import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTacticMenu, buildCopyBrief, buildCopyPrompt, buildSessionCopyBrief } from '../../agents/creative-packager/index.js';

// ── loadTacticMenu: generated from the skills, not read from a committed file ──
// It used to read data/context/marketing-tactics.md. That made a GENERATED file a
// version-controlled artifact: every concurrent learner run regenerated it, so any
// two PRs conflicted on it, and git could 3-way-merge it into content the generator
// would never emit. Reading .claude/skills/ directly removes the copy, and with it
// the conflict and the whole class of staleness bug.
{
  const root = mkdtempSync(join(tmpdir(), 'cp-'));
  const skills = join(root, '.claude', 'skills');
  mkdirSync(join(skills, 'marketing-copy'), { recursive: true });
  writeFileSync(join(skills, 'marketing-copy', 'SKILL.md'),
    '---\nname: marketing-copy\ndescription: Use when writing product page copy\n---\n\n' +
    '## Lead with a hard number\n\n**Why it works:** Specifics are falsifiable.\n\n' +
    '## Falsified\n\n### Use taboo framing\n**Falsified 2026-08-14:** CTR tanked\n');

  const menu = loadTacticMenu(root);
  assert.match(menu, /Do not propose/, 'generates the blocklist section');
  assert.match(menu, /Use taboo framing/, 'carries the falsified claim');
  assert.match(menu, /Lead with a hard number/, 'carries live tactics');
  assert.match(menu, /Use when writing product page copy/, 'carries the trigger description');
}

// A stale committed mirror must NOT be preferred over the live skills — that file
// is exactly what this change removes, so its presence should change nothing.
{
  const root = mkdtempSync(join(tmpdir(), 'cp-stale-'));
  const skills = join(root, '.claude', 'skills');
  mkdirSync(join(skills, 'marketing-copy'), { recursive: true });
  writeFileSync(join(skills, 'marketing-copy', 'SKILL.md'),
    '---\nname: marketing-copy\ndescription: d\n---\n\n## FRESH TACTIC FROM SKILLS\n\n**Why it works:** x.\n');
  mkdirSync(join(root, 'data', 'context'), { recursive: true });
  writeFileSync(join(root, 'data', 'context', 'marketing-tactics.md'), '# STALE COMMITTED COPY\n');

  const menu = loadTacticMenu(root);
  assert.match(menu, /FRESH TACTIC FROM SKILLS/, 'reads the skills, the source of truth');
  assert.ok(!menu.includes('STALE COMMITTED COPY'), 'never reads the old committed mirror');
}

// No skills at all (fresh checkout before any learn run) must NOT throw.
assert.equal(loadTacticMenu(join(tmpdir(), 'definitely-not-here-98765')), null,
  'missing skills dir returns null instead of throwing');

// A skills dir with no marketing-* skills is also null, not an empty shell document.
{
  const root = mkdtempSync(join(tmpdir(), 'cp-empty-'));
  mkdirSync(join(root, '.claude', 'skills', 'unrelated-skill'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'unrelated-skill', 'SKILL.md'),
    '---\nname: unrelated-skill\ndescription: d\n---\n\nBody.\n');
  assert.equal(loadTacticMenu(root), null, 'no marketing skills means no menu, not a header-only doc');
}

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
// F9: both brief builders set `tacticMenu` unconditionally (buildCopyBrief used
// to spread it in only when truthy, buildSessionCopyBrief always set it), so the
// two briefs have the same shape whether or not a mirror file exists.
{
  const ad = { pageName: 'Coconut Lotion', landingUrl: 'https://realskincare.com/x' };
  const brief = buildCopyBrief(ad, {});
  assert.ok('tacticMenu' in brief, 'the key is always present, matching buildSessionCopyBrief');
  assert.equal(brief.tacticMenu, null, 'and is null when there is no menu');
  assert.equal(buildSessionCopyBrief({ product: 'x' }).tacticMenu, null, 'same shape on the session path');

  const prompt = buildCopyPrompt(brief);
  assert.match(prompt, /Write 3 ad copy variations/, 'still builds a usable prompt with no menu');
  assert.ok(!/do not propose/i.test(prompt), 'no empty menu block leaks in');
}

// ── F1: the session path's brief also carries the tactic menu ──────────────
// The dashboard-driven session path (data/creative-sessions/) used to take
// job.copyBrief verbatim, straight into the shared buildCopyPrompt, with no
// tacticMenu — meanwhile the ad path (data/meta-ads-insights/, which has no
// data locally or on the server) was the only one wired to loadTacticMenu().
// That meant the entire tactic-menu feature landed on a dead code path.
{
  const copyBrief = { product: 'Coconut Body Lotion', angle: 'moisture that lasts', destinationUrl: 'https://realskincare.com/lotion' };
  const brief = buildSessionCopyBrief(copyBrief, '## Do not propose\n\n- Use taboo framing');

  // Every field job.copyBrief already carried survives untouched.
  assert.equal(brief.product, 'Coconut Body Lotion', 'preserves existing product field');
  assert.equal(brief.angle, 'moisture that lasts', 'preserves existing angle field');
  assert.equal(brief.destinationUrl, 'https://realskincare.com/lotion', 'preserves existing destinationUrl field');
  // ...with the menu merged in.
  assert.match(brief.tacticMenu, /Use taboo framing/, 'session brief carries the tactic menu');

  const prompt = buildCopyPrompt(brief);
  assert.match(prompt, /Use taboo framing/, 'the menu reaches the shared prompt builder from the session path too');
}

// Absent copyBrief still gets a usable default (matches the prior fallback
// behavior) with the menu merged in.
{
  const brief = buildSessionCopyBrief(undefined, 'the menu');
  assert.equal(brief.product, 'Real Skin Care', 'falls back to the prior default product');
  assert.equal(brief.tacticMenu, 'the menu', 'menu still merged in on the fallback path');
}

// A null tacticMenu (mirror file absent) must not corrupt the brief or break
// buildCopyPrompt — same degrade-cleanly contract as the ad path.
{
  const brief = buildSessionCopyBrief({ product: 'Lip Balm' }, null);
  assert.equal(brief.product, 'Lip Balm');
  const prompt = buildCopyPrompt(brief);
  assert.match(prompt, /Write 3 ad copy variations/, 'still builds a usable prompt with a null menu');
  assert.ok(!/do not propose/i.test(prompt), 'no empty menu block leaks in');
}

console.log('✓ creative-packager tactic-menu tests pass');
