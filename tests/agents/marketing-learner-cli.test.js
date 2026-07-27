import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from '../../agents/marketing-learner/index.js';

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

console.log('✓ marketing-learner CLI tests pass');
