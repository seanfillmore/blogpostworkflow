import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTacticMenu, buildCopyBrief, buildCopyPrompt, buildSessionCopyBrief } from '../../agents/creative-packager/index.js';

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
