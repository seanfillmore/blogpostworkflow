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
