import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePublishedFlags,
  buildConstraintBlock,
  parseFrontmatter,
  scanSkillInventory,
  renderSkillMarkdown,
  validateSkillEdit,
} from '../../lib/marketing-learner.js';

const TODAY = '2026-07-27';

// ── no dates supplied ───────────────────────────────────────────────────────
{
  const out = parsePublishedFlags(['https://youtu.be/aaaaaaaaaaa'], [], { today: TODAY });
  assert.equal(out.length, 1);
  assert.equal(out[0].publishedAt, null, 'absent flag is allowed');
  assert.equal(out[0].warning, null);
}

// ── one url, one date ───────────────────────────────────────────────────────
{
  const out = parsePublishedFlags(['https://youtu.be/aaaaaaaaaaa'], ['2026-03-14'], { today: TODAY });
  assert.equal(out[0].publishedAt, '2026-03-14');
  assert.equal(out[0].warning, null);
}

// ── counts match: pairs positionally ────────────────────────────────────────
{
  const out = parsePublishedFlags(
    ['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'],
    ['2026-03-14', '2025-11-02'],
    { today: TODAY }
  );
  assert.equal(out[0].publishedAt, '2026-03-14');
  assert.equal(out[1].publishedAt, '2025-11-02');
}

// ── one date, many urls: ERROR, not broadcast ───────────────────────────────
// A wrong-but-authoritative date silently skews scoring and nobody re-checks it.
assert.throws(
  () => parsePublishedFlags(['a', 'b'], ['2026-03-14'], { today: TODAY }),
  /one --published date for 2 URLs/,
  'refuses to broadcast a single date across videos'
);

// ── more dates than urls ────────────────────────────────────────────────────
assert.throws(
  () => parsePublishedFlags(['a'], ['2026-03-14', '2025-01-01'], { today: TODAY }),
  /2 --published dates for 1 URL/,
  'refuses surplus dates'
);

// ── malformed dates ─────────────────────────────────────────────────────────
assert.throws(() => parsePublishedFlags(['a'], ['03/14/2026'], { today: TODAY }), /YYYY-MM-DD/, 'wrong format');
assert.throws(() => parsePublishedFlags(['a'], ['2026-13-01'], { today: TODAY }), /not a real calendar date/, 'month 13');
assert.throws(() => parsePublishedFlags(['a'], ['2026-02-30'], { today: TODAY }), /not a real calendar date/, 'Feb 30 rolls over');

// ── future dates ────────────────────────────────────────────────────────────
assert.throws(() => parsePublishedFlags(['a'], ['2026-07-28'], { today: TODAY }), /in the future/, 'tomorrow rejected');

// ── old dates warn but do not throw ─────────────────────────────────────────
{
  const out = parsePublishedFlags(['a'], ['2021-01-01'], { today: TODAY });
  assert.equal(out[0].publishedAt, '2021-01-01', 'still accepted');
  assert.match(out[0].warning, /older than/, 'warns on stale video');
}
{
  const out = parsePublishedFlags(['a'], ['2024-01-01'], { today: TODAY });
  assert.equal(out[0].warning, null, 'inside the 4-year window: no warning');
}

// ── constraint block ────────────────────────────────────────────────────────
{
  const block = buildConstraintBlock();
  assert.match(block, /50\.46/, 'carries the settled AOV, not the stale $19 figure');
  assert.ok(!block.includes('$19'), 'must not cite the all-time AOV');
  assert.match(block, /retention/i, 'names retention as the binding constraint');
  assert.match(block, /solo operator/i, 'states the staffing constraint');
  assert.match(block, /Platform mechanics/, 'includes the decay table');
  assert.match(block, /Durable principle/, 'includes the decay table');
  assert.match(block, /~18 months/, 'states the ~18mo platform-mechanics horizon');
}

// ── parseFrontmatter ────────────────────────────────────────────────────────
{
  const fm = parseFrontmatter('---\nname: marketing-offers\ndescription: Use when building offers\n---\n\nBody here.\n');
  assert.equal(fm.name, 'marketing-offers');
  assert.equal(fm.description, 'Use when building offers');
  assert.match(fm.body, /Body here/);
}
assert.throws(() => parseFrontmatter('no frontmatter at all'), /frontmatter/, 'missing frontmatter throws');

// ── scanSkillInventory ──────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(dir, 'marketing-offers'), { recursive: true });
  writeFileSync(join(dir, 'marketing-offers', 'SKILL.md'),
    '---\nname: marketing-offers\ndescription: Offer construction\n---\n\nStuff.\n');
  mkdirSync(join(dir, 'unrelated-skill'), { recursive: true });
  writeFileSync(join(dir, 'unrelated-skill', 'SKILL.md'),
    '---\nname: unrelated-skill\ndescription: Not marketing\n---\n\nStuff.\n');

  const inv = scanSkillInventory(dir);
  assert.equal(inv.length, 1, 'only marketing-* skills');
  assert.equal(inv[0].name, 'marketing-offers');
  assert.equal(inv[0].description, 'Offer construction');
  assert.match(inv[0].content, /Stuff/);
}
assert.deepEqual(scanSkillInventory(join(tmpdir(), 'definitely-does-not-exist-12345')), [],
  'absent skills dir returns empty, does not throw');

// ── scanSkillInventory with malformed skill ─────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'skills-malformed-'));
  mkdirSync(join(dir, 'marketing-valid'), { recursive: true });
  writeFileSync(join(dir, 'marketing-valid', 'SKILL.md'),
    '---\nname: marketing-valid\ndescription: This one is fine\n---\n\nGood stuff.\n');
  mkdirSync(join(dir, 'marketing-broken'), { recursive: true });
  writeFileSync(join(dir, 'marketing-broken', 'SKILL.md'),
    'no frontmatter at all, just garbage\n');

  const inv = scanSkillInventory(dir);
  assert.equal(inv.length, 1, 'only valid skill returned');
  assert.equal(inv[0].name, 'marketing-valid', 'the broken one is skipped silently');
}

// ── renderSkillMarkdown ─────────────────────────────────────────────────────
{
  const md = renderSkillMarkdown({
    name: 'marketing-retention-flows',
    description: 'Use when building lifecycle email or replenishment flows',
    tactics: [{
      claim: 'Send replenishment at 60% of consumption cycle',
      mechanism: 'Reminds before the jar runs out, when intent is highest',
      evidence: 'Creator cites their own 3-store test',
      rscFit: { score: 8, reasoning: 'Retention is the binding constraint here' },
      source: { creator: 'Some Operator', title: 'Retention Playbook', videoId: 'abc12345678' },
    }],
  });

  assert.match(md, /^---\n/, 'starts with frontmatter');
  assert.match(md, /name: marketing-retention-flows/);
  assert.match(md, /description: Use when building lifecycle/);
  assert.match(md, /Send replenishment at 60%/, 'claim present');
  assert.match(md, /Some Operator/, 'provenance names the creator');
  assert.match(md, /abc12345678/, 'provenance carries the video id');
  const fm = parseFrontmatter(md);
  assert.equal(fm.name, 'marketing-retention-flows', 'output round-trips through the parser');
}

// A newline in a model-authored description would push the rest of the sentence
// onto its own line, where parseFrontmatter's line regex silently drops it — the
// skill would ship with a truncated trigger description and match badly.
{
  const md = renderSkillMarkdown({
    name: 'marketing-retention-flows',
    description: 'Use when building lifecycle email\nor replenishment flows — covers cadence.',
    tactics: [],
  });
  const fm = parseFrontmatter(md);
  assert.equal(
    fm.description,
    'Use when building lifecycle email or replenishment flows — covers cadence.',
    'newlines in the description collapse to a space rather than truncating it'
  );
  assert.ok(!fm.description.includes('\n'), 'no raw newline survives into frontmatter');
}

// ── validateSkillEdit ───────────────────────────────────────────────────────
const OLD = '---\nname: marketing-offers\ndescription: Offer construction\n---\n\n' + 'x'.repeat(1000);

// legitimate expansion
assert.equal(validateSkillEdit(OLD, OLD + '\n\nMore content here.'), true, 'growth is fine');

// frontmatter destroyed
assert.throws(() => validateSkillEdit(OLD, 'no frontmatter'), /frontmatter/, 'damaged frontmatter throws');

// renamed
assert.throws(
  () => validateSkillEdit(OLD, '---\nname: marketing-renamed\ndescription: Offer construction\n---\n\n' + 'x'.repeat(1000)),
  /name changed/,
  'renaming the skill throws'
);

// empty description
assert.throws(
  () => validateSkillEdit(OLD, '---\nname: marketing-offers\ndescription:\n---\n\n' + 'x'.repeat(1000)),
  /description/,
  'empty description throws'
);

// unexplained shrink
assert.throws(
  () => validateSkillEdit(OLD, '---\nname: marketing-offers\ndescription: Offer construction\n---\n\nshort'),
  /shrink/,
  'unexplained >25% shrink throws'
);

// explained shrink is allowed
assert.equal(
  validateSkillEdit(
    OLD,
    '---\nname: marketing-offers\ndescription: Offer construction\n---\n\nshort',
    { supersedes: 'Removed the 2019 Facebook bidding section; that auction no longer exists.' }
  ),
  true,
  'shrink with an explicit supersedes reason is allowed'
);

import { buildExtractionPrompt, validateExtraction, extractTactics } from '../../lib/marketing-learner.js';

const VIDEO = {
  videoId: 'abc12345678',
  title: 'Retention Playbook',
  creator: 'Some Operator',
  durationSeconds: 1800,
  publishedAt: '2026-03-14',
  text: 'Send your replenishment email at sixty percent of the consumption cycle.',
};

// ── buildExtractionPrompt ───────────────────────────────────────────────────
{
  const p = buildExtractionPrompt({ video: VIDEO, inventory: [] });
  assert.match(p, /Retention Playbook/, 'includes the title');
  assert.match(p, /Some Operator/, 'includes the creator');
  assert.match(p, /2026-03-14/, 'includes the publish date');
  assert.match(p, /50\.46/, 'embeds the constraint block');
  assert.match(p, /sixty percent of the consumption cycle/, 'includes the transcript');
  assert.match(p, /recencySignals/, 'asks for the fallback recency field');
}
{
  const p = buildExtractionPrompt({ video: { ...VIDEO, publishedAt: null }, inventory: [] });
  assert.match(p, /publish date is unknown/i, 'says the date is unknown when absent');
}
{
  // The whole fix: the model must author targetSkill.description itself (it just
  // read the transcript), with concrete guidance so it doesn't just restate the
  // skill's title back — that gives Claude Code's skill matcher nothing to match.
  const p = buildExtractionPrompt({ video: VIDEO, inventory: [] });
  assert.match(p, /targetSkill.*description/s, 'requests a description field on targetSkill');
  assert.match(p, /Use when/, 'guidance tells the model descriptions must start with "Use when"');
  assert.match(p, /restates the title, matches nothing/, 'includes the bad-example guidance verbatim');
  assert.match(p, /product page copy, Amazon bullet points, ad copy, or email subject/, 'includes the good-example guidance verbatim');
  assert.match(p, /required.*even when action is "edit"/i, 'states the description requirement is unconditional on action');
}
{
  const p = buildExtractionPrompt({
    video: VIDEO,
    inventory: [{ name: 'marketing-offers', description: 'Offer construction', path: 'x', content: 'BODY_OF_EXISTING_SKILL' }],
  });
  assert.match(p, /marketing-offers/, 'lists the existing skill');
  assert.match(p, /BODY_OF_EXISTING_SKILL/, 'includes existing skill content so it edits rather than duplicates');
}

// ── validateExtraction ──────────────────────────────────────────────────────
const GOOD = {
  videoId: 'abc12345678',
  creator: 'Some Operator',
  title: 'Retention Playbook',
  summary: 'A talk about lifecycle email.',
  recencySignals: null,
  tactics: [
    {
      claim: 'Send replenishment at 60% of cycle',
      mechanism: 'Intent peaks before running out',
      evidence: 'assertion only',
      rscFit: { score: 8, reasoning: 'Retention is the constraint' },
      verdict: 'adopt',
      rejectReason: null,
      targetSkill: {
        name: 'marketing-retention-flows',
        action: 'create',
        description: 'Use when building lifecycle email or replenishment flows and you need timing that matches consumption cycles.',
      },
    },
    {
      claim: 'Hire a media buyer',
      mechanism: 'Specialists beat generalists',
      evidence: 'assertion only',
      rscFit: { score: 1, reasoning: 'Solo operator' },
      verdict: 'reject',
      rejectReason: 'Requires staff',
      targetSkill: null,
    },
  ],
};
assert.equal(validateExtraction(GOOD), GOOD, 'valid payload returns itself');

assert.throws(() => validateExtraction({ ...GOOD, tactics: 'nope' }), /tactics must be an array/);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], verdict: 'maybe' }] }),
  /verdict must be/,
  'unknown verdict rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], rscFit: { score: 42, reasoning: 'x' } }] }),
  /score must be/,
  'out-of-range score rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[1], rejectReason: null }] }),
  /rejectReason is required/,
  'reject without a reason is rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: null }] }),
  /targetSkill is required/,
  'adopt without a target skill is rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'retention', action: 'create' } }] }),
  /must start with "marketing-"/,
  'skill name must be namespaced'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'marketing-../../evil', action: 'create' } }] }),
  /must start with "marketing-"/,
  'path traversal in skill name is rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'marketing-Has Spaces', action: 'create' } }] }),
  /must start with "marketing-"/,
  'non-kebab-case skill name is rejected'
);
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'marketing-x', action: 'delete' } }] }),
  /action must be/,
  'unknown action rejected'
);

// A description-less targetSkill defeats the entire point of the skill: Claude Code
// selects skills by matching description against the task, so a missing one means
// the skill silently never triggers. Required unconditionally — not just on
// action: "create" — because the model routinely proposes "edit" for a skill that
// does not exist yet.
assert.throws(
  () => validateExtraction({
    ...GOOD,
    tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'marketing-retention-flows', action: 'create' } }],
  }),
  /targetSkill\.description is required/,
  'missing description is rejected'
);
assert.throws(
  () => validateExtraction({
    ...GOOD,
    tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'marketing-retention-flows', action: 'create', description: '' } }],
  }),
  /targetSkill\.description is required/,
  'empty-string description is rejected'
);
assert.throws(
  () => validateExtraction({
    ...GOOD,
    tactics: [{ ...GOOD.tactics[0], targetSkill: { name: 'marketing-retention-flows', action: 'edit', description: '   ' } }],
  }),
  /targetSkill\.description is required/,
  'whitespace-only description is rejected even on action: edit'
);
{
  // A reject tactic carries targetSkill: null and must never be required to have
  // a description — the description guard only applies to adopted tactics.
  const rejectOnly = { ...GOOD, tactics: [GOOD.tactics[1]] };
  assert.equal(validateExtraction(rejectOnly), rejectOnly, 'reject tactic with targetSkill: null still passes');
}
// A tactic with no stated mechanism is motivational framing, not actionable — the
// constraint block explicitly tells the model to reject that, so a schema-valid
// payload must not be able to omit it. Without this guard, renderSkillMarkdown and
// renderReport interpolate `${t.mechanism}` with no `??` fallback and write the
// literal string "undefined" into a committed skill file.
assert.throws(
  () => validateExtraction({ ...GOOD, tactics: [{ ...GOOD.tactics[0], mechanism: undefined }] }),
  /mechanism is required/,
  'tactic missing a mechanism is rejected'
);

// ── extractTactics ──────────────────────────────────────────────────────────
function fakeClient(response) {
  return { messages: { create: async () => response } };
}

// max_tokens must throw and never return a partial payload
await assert.rejects(
  () => extractTactics({
    video: VIDEO,
    inventory: [],
    client: fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }),
  }),
  /max_tokens/,
  'truncated output throws rather than saving'
);

// happy path, including fenced JSON
{
  const out = await extractTactics({
    video: VIDEO,
    inventory: [],
    client: fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(GOOD) + '\n```' }],
    }),
  });
  assert.equal(out.tactics.length, 2, 'parses JSON out of a fenced block');
}

// unparseable output
await assert.rejects(
  () => extractTactics({
    video: VIDEO,
    inventory: [],
    client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'I am not JSON' }] }),
  }),
  /Could not parse/,
  'non-JSON output throws'
);

import { renderReport } from '../../lib/marketing-learner.js';

{
  const md = renderReport({
    extraction: GOOD,
    video: { ...VIDEO },
    skillsTouched: [{ name: 'marketing-retention-flows', action: 'create' }],
  });

  assert.match(md, /Retention Playbook/, 'names the video');
  assert.match(md, /abc12345678/, 'links or names the video id');
  assert.match(md, /2026-03-14/, 'shows the publish date');
  assert.match(md, /Send replenishment at 60% of cycle/, 'lists the adopted tactic');
  assert.match(md, /Hire a media buyer/, 'lists the REJECTED tactic too');
  assert.match(md, /Requires staff/, 'shows why it was rejected');
  assert.match(md, /marketing-retention-flows/, 'footer names skills touched');

  // The rejects are half the value — they must be a visible section, not a footnote.
  assert.match(md, /## Rejected/i, 'has a dedicated rejected section');
  assert.match(md, /## Adopted/i, 'has a dedicated adopted section');
}

// A video where nothing survived must still produce a useful report.
{
  const md = renderReport({
    extraction: { ...GOOD, tactics: [GOOD.tactics[1]] },
    video: { ...VIDEO },
    skillsTouched: [],
  });
  assert.match(md, /Hire a media buyer/, 'still lists the reject');
  assert.match(md, /No tactics adopted/i, 'says so plainly when nothing was adopted');
}

import { mergeSkillContent } from '../../lib/marketing-learner.js';

const EXISTING_SKILL = '---\nname: marketing-retention-flows\ndescription: Lifecycle email\n---\n\n'
  + '## Old claim\n\n' + 'y'.repeat(800);

const NEW_TACTICS = [{
  claim: 'Send replenishment at 60% of cycle',
  mechanism: 'Intent peaks before running out',
  evidence: 'assertion only',
  rscFit: { score: 8, reasoning: 'Retention is the constraint' },
  source: { creator: 'Some Operator', title: 'Retention Playbook', videoId: 'abc12345678' },
}];

function mergeClient(payload, stop = 'end_turn') {
  return { messages: { create: async () => ({ stop_reason: stop, content: [{ type: 'text', text: payload }] }) } };
}

// ── happy path ──────────────────────────────────────────────────────────────
{
  const merged = EXISTING_SKILL + '\n\n## Send replenishment at 60% of cycle\n\nBody.\n';
  const out = await mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({ content: merged, supersedes: null })),
  });
  assert.match(out.content, /Send replenishment/, 'new tactic present');
  assert.match(out.content, /Old claim/, 'existing content retained');
  assert.equal(out.supersedes, null);
}

// ── max_tokens must throw ───────────────────────────────────────────────────
await assert.rejects(
  () => mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient('{}', 'max_tokens'),
  }),
  /max_tokens/,
  'truncated merge throws rather than writing a mangled skill'
);

// ── guard fires on unexplained shrink ───────────────────────────────────────
await assert.rejects(
  () => mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({
      content: '---\nname: marketing-retention-flows\ndescription: Lifecycle email\n---\n\ntiny',
      supersedes: null,
    })),
  }),
  /shrink/,
  'gutting a skill without a reason throws'
);

// ── explained shrink is allowed through the guard ───────────────────────────
{
  const out = await mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({
      content: '---\nname: marketing-retention-flows\ndescription: Lifecycle email\n---\n\ntiny',
      supersedes: 'Removed the 2019 bidding section; that auction no longer exists.',
    })),
  });
  assert.match(out.supersedes, /2019 bidding/, 'reason is carried out for the report');
}

// ── rename attempt is blocked by the guard ──────────────────────────────────
await assert.rejects(
  () => mergeSkillContent({
    existingContent: EXISTING_SKILL,
    tactics: NEW_TACTICS,
    client: mergeClient(JSON.stringify({
      content: '---\nname: marketing-renamed\ndescription: Lifecycle email\n---\n\n' + 'y'.repeat(900),
      supersedes: null,
    })),
  }),
  /name changed/,
  'the merge cannot rename the skill'
);

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
  // The message must name WHEN it was falsified, not just that it was — an
  // operator re-running --falsify later needs the date to know if this is the
  // same finding or a new one.
  assert.throws(
    () => falsifyTactic(once, { claim: 'taboo', reason: 'r2', today: '2026-08-20' }),
    /already falsified on 2026-08-14/,
    'the error names the date the tactic was originally falsified'
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

// ── EDGE CASE: already-falsified guard runs too early ──────────────────────
// Skill with falsified "Archived tactic" that contains substring "tactic"
// AND a live heading "Use tactics daily" that also contains "tactic".
// Falsifying by "tactic" should match the live heading cleanly, not throw
// "already falsified" just because a falsified entry happens to contain the substring.
{
  const skillWithFalsified = [
    '---',
    'name: marketing-tactics-test',
    'description: Testing tactics',
    '---',
    '',
    '## Use tactics daily',
    '',
    'Body here.',
    '',
    '## Falsified',
    '',
    'Tried here and did not work. Do not reintroduce these.',
    '',
    '### Archived tactic that mentions tactics',
    '**Falsified 2026-08-01:** Did not work',
    '',
  ].join('\n');

  // Falsifying by "tactic" must match the live "Use tactics daily" heading,
  // not throw "already falsified" because a falsified entry contains "tactic".
  const result = falsifyTactic(skillWithFalsified, {
    claim: 'tactic',
    reason: 'CTR too low',
    today: '2026-08-15',
  });
  assert.match(result, /### Use tactics daily/, 'moved the live tactic, not confused by falsified entry');
  assert.ok(!/^## Use tactics daily$/m.test(result), 'live heading no longer at ## level (as a complete line)');
}

// ── EDGE CASE: falsifiedIndex prefix match on "## Falsified Campaigns" ──────
// Skill with live "## Falsified Campaigns" heading and NO real Falsified section.
// falsifiedIndex must not treat "## Falsified Campaigns" as the boundary.
{
  const skillWithFalsifiedLiveHeading = [
    '---',
    'name: marketing-campaigns',
    'description: Campaign tactics',
    '---',
    '',
    '## Run Paid Campaigns',
    '',
    'Body.',
    '',
    '## Falsified Campaigns',
    '',
    'This is a live tactic, not a Falsified section.',
    '',
  ].join('\n');

  // extractFalsifiedClaims must return empty, not treat "Falsified Campaigns" as the boundary.
  const extracted = extractFalsifiedClaims(skillWithFalsifiedLiveHeading);
  assert.deepEqual(extracted, [], 'does not mistake "## Falsified Campaigns" for the Falsified section');

  // Falsifying a tactic must not silently consume the "Falsified Campaigns" heading.
  const result = falsifyTactic(skillWithFalsifiedLiveHeading, {
    claim: 'Paid',
    reason: 'Bad ROAS',
    today: '2026-08-14',
  });
  assert.match(result, /^## Falsified Campaigns$/m, 'preserves the live "Falsified Campaigns" heading at ## level (not consumed as section boundary)');
  assert.match(result, /This is a live tactic, not a Falsified section/, 'preserves the body of "Falsified Campaigns"');
  assert.match(result, /^### Run Paid Campaigns$/m, 'falsified the correct "Run Paid Campaigns" tactic');
}

// ── EDGE CASE: splitLiveSections treats ## inside fenced blocks as boundaries ─
// Tactic body contains a fenced markdown example with a ## heading inside.
// Must not split the section at that ##.
{
  const skillWithFencedBlock = [
    '---',
    'name: marketing-copywriting',
    'description: Copy tactics',
    '---',
    '',
    '## Use power words',
    '',
    '**Why it works:** Emotional resonance.',
    '',
    'Example markdown:',
    '',
    '```',
    '## This is a fake heading inside the fence',
    'Not a real section.',
    '```',
    '',
    '*Source: Someone — "Video" (abc123)*',
    '',
    '## Another real tactic',
    '',
    'Real body.',
    '',
  ].join('\n');

  // Falsifying "power" must move only the "Use power words" section,
  // leaving "Another real tactic" as a live ## heading.
  const result = falsifyTactic(skillWithFencedBlock, {
    claim: 'power',
    reason: 'Testing',
    today: '2026-08-14',
  });
  assert.match(result, /^## Another real tactic$/m, 'other tactic stays live at ## level');
  assert.match(result, /^### Use power words$/m, 'moved tactic is now ### (complete line)');
  // The fenced block content must survive intact.
  assert.match(result, /## This is a fake heading inside the fence/, 'fenced block content preserved');
  assert.ok(result.includes('```'), 'fence markers survive');
}

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

  // Preserving it passes, wherever it sits in the file — the parser bounds the
  // graveyard at the next "## " heading, so section order is not load-bearing.
  const kept = `${dropped.trimEnd()}\n\n## Falsified\n\n### Dead one\n**Falsified 2026-08-14:** did not work\n`;
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

// ── F10: the extraction prompt's falsified list is deduped ──────────────────
// The same tactic can be falsified in two skills. renderContextMirror already
// deduped; this prompt listed it once per skill, which reads as two separate
// findings rather than one.
{
  const dead = '## Falsified\n\n### Bad tactic\n**Falsified 2026-08-14:** nope\n';
  const inv = [
    { name: 'marketing-a', description: 'a', path: '/tmp/a/SKILL.md', content: `---\nname: marketing-a\ndescription: a\n---\n\n${dead}` },
    { name: 'marketing-b', description: 'b', path: '/tmp/b/SKILL.md', content: `---\nname: marketing-b\ndescription: b\n---\n\n${dead}` },
  ];
  const p = buildExtractionPrompt({ video: VIDEO, inventory: inv });
  assert.equal((p.match(/^- Bad tactic$/gm) || []).length, 1,
    'the shared claim is listed once in the "already tested and failed" block');
}

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

// ── renderContextMirror: heading-level demotion ─────────────────────────────
// Skill bodies have their own ## headings that collide with mirror structure.
// They must be demoted one level (## → ###, ### → ####) so the body nests
// logically under its skill section header. Fenced code blocks exempt.
{
  const inv = [{
    name: 'marketing-copy',
    description: 'Copy tactics',
    path: '/tmp/a/SKILL.md',
    content: `---
name: marketing-copy
description: Copy tactics
---

## Live Tactic

Body text.

### Subsection

More body.

## Falsified

### Dead Tactic
Falsified: reason.
`,
  }];

  const md = renderContextMirror(inv);

  // The skill's own ## headings must become ###
  assert.match(md, /^### Live Tactic$/m, 'live ## demoted to ###');
  assert.match(md, /^#### Dead Tactic$/m, 'falsified ### demoted to ####');
  assert.match(md, /^#### Subsection$/m, 'nested ### demoted to ####');

  // The mirror's own structure must remain at ##
  assert.match(md, /^## Do not propose$/m, 'mirror "Do not propose" stays ##');
  assert.match(md, /^## marketing-copy$/m, 'mirror skill heading stays ##');
}

// Fenced code blocks are not demoted (fence detection via line tracking).
{
  const inv = [{
    name: 'marketing-example',
    description: 'Example tactics',
    path: '/tmp/x/SKILL.md',
    content: `---
name: marketing-example
description: Example
---

## Live Tactic

Example markdown:

\`\`\`
## This is inside a fence

Not a real heading.
\`\`\`

Body.`,
  }];

  const md = renderContextMirror(inv);

  // Outside fence: demoted
  assert.match(md, /^### Live Tactic$/m, 'live tactic demoted');
  // Inside fence: preserved exactly
  assert.match(md, /^## This is inside a fence$/m, 'fence content untouched');
  assert.ok(md.includes('```'), 'fence markers preserved');
}

// ── renderContextMirror: blocklist dedup ────────────────────────────────────
// Same claim falsified in two skills appears only once in the blocklist.
{
  const inv = [
    {
      name: 'marketing-copy',
      description: 'Copy',
      path: '/tmp/a/SKILL.md',
      content: '---\nname: marketing-copy\ndescription: Copy\n---\n\n## Falsified\n\n### Bad tactic\n**Falsified 2026-08-14:** nope\n',
    },
    {
      name: 'marketing-images',
      description: 'Images',
      path: '/tmp/b/SKILL.md',
      content: '---\nname: marketing-images\ndescription: Images\n---\n\n## Falsified\n\n### Bad tactic\n**Falsified 2026-08-15:** nope again\n',
    },
  ];

  const md = renderContextMirror(inv);

  // Count "- Bad tactic" lines in the blocklist (before first skill heading)
  const blocklist = md.split(/^## marketing-/m)[0];
  const count = (blocklist.match(/^- Bad tactic$/gm) || []).length;
  assert.equal(count, 1, 'same claim appears exactly once in blocklist, not duplicated');
}

// ── renderContextMirror: blocklist is hoisted ───────────────────────────────
// The "## Do not propose" section must appear before any skill sections, so
// it is scannable as a top-level authoritative blocklist.
{
  const inv = [
    {
      name: 'marketing-copy',
      description: 'Copy',
      path: '/tmp/a/SKILL.md',
      content: '---\nname: marketing-copy\ndescription: Copy\n---\n\n## Live\n\n## Falsified\n\n### Dead\n',
    },
  ];

  const md = renderContextMirror(inv);

  const proposeIdx = md.indexOf('## Do not propose');
  const firstSkillIdx = md.indexOf('## marketing-copy');

  assert.ok(proposeIdx > -1, 'blocklist section exists');
  assert.ok(firstSkillIdx > -1, 'skill section exists');
  assert.ok(proposeIdx < firstSkillIdx, 'blocklist is hoisted above skills');
}

// ── renderContextMirror: malformed frontmatter is skipped silently ──────────
// One skill with no frontmatter is skipped; good skills still render.
{
  const inv = [
    {
      name: 'marketing-good',
      description: 'Good',
      path: '/tmp/good/SKILL.md',
      content: '---\nname: marketing-good\ndescription: Good\n---\n\n## Tactic\n\nBody.',
    },
    {
      name: 'marketing-broken',
      description: 'Broken',
      path: '/tmp/broken/SKILL.md',
      content: 'no frontmatter at all, just trash\n',
    },
  ];

  const md = renderContextMirror(inv);

  // Good skill is present
  assert.match(md, /## marketing-good/, 'good skill rendered');
  assert.match(md, /## Tactic/, 'good skill body included');

  // Broken skill is NOT present (skipped silently)
  assert.ok(!md.includes('marketing-broken'), 'broken skill skipped');
  assert.ok(!md.includes('no frontmatter'), 'broken skill body not included');

  // Document is still valid (no throw)
  assert.match(md, /Do not edit by hand/i, 'document is valid');
}

// ── renderContextMirror: undefined fallbacks for name and description ──────
// Caller passes undefined or empty values → should default to empty string.
{
  const inv = [
    {
      name: undefined,
      description: 'Good desc',
      path: '/tmp/a/SKILL.md',
      content: '---\nname: marketing-fallback-name\ndescription: Good desc\n---\n\nBody.',
    },
    {
      name: 'marketing-fallback-desc',
      description: undefined,
      path: '/tmp/b/SKILL.md',
      content: '---\nname: marketing-fallback-desc\ndescription: Good desc\n---\n\nBody.',
    },
  ];

  const md = renderContextMirror(inv);

  // Should not contain literal "undefined" in the output
  assert.ok(!md.includes('undefined'), 'no literal "undefined" in output');

  // The names/descriptions from frontmatter are used (fallbacks kick in for inventory fields)
  assert.match(md, /marketing-fallback-name/, 'skill section still rendered');
  assert.match(md, /marketing-fallback-desc/, 'skill section still rendered');
}

// ── F6: renderContextMirror drops the skill's H1 title entirely ─────────────
// Real skill files (see renderSkillMarkdown) start their body with an H1 title,
// then ## tactic sections. Demoting that H1 to ### left an empty heading sitting
// as a SIBLING of the real ### tactic headings, so a model scanning the mirror
// saw one phantom tactic per skill. The `## <skill-name>` wrapper already titles
// the section, so the H1 is pure duplication — drop it.
{
  const inv = [{
    name: 'marketing-copy',
    description: 'Copy tactics',
    path: '/tmp/a/SKILL.md',
    content: '---\nname: marketing-copy\ndescription: Copy tactics\n---\n\n# Conversion Copy Angles\n\n## Live Tactic\n\nBody.\n',
  }];

  const md = renderContextMirror(inv);

  assert.ok(!/Conversion Copy Angles/.test(md), 'the H1 title is dropped, not demoted into a phantom tactic');
  assert.match(md, /^### Live Tactic$/m, 'the real tactic still demotes to ###');
  assert.match(md, /Body\./, 'the body under it survives');

  // Only the mirror's own structural headings remain at level 2.
  const h2Lines = md.split('\n').filter((l) => /^## /.test(l));
  assert.deepEqual(h2Lines, ['## Do not propose', '## marketing-copy'],
    'no skill-authored heading rides at the same level as the mirror\'s own ## structure');

  // Every ### in the skill's own section is a real tactic heading with content
  // under it — no empty siblings.
  const section = md.split('## marketing-copy')[1];
  assert.deepEqual(section.split('\n').filter((l) => /^### /.test(l)), ['### Live Tactic'],
    'exactly one ### per real tactic — no phantom entry from the skill title');
}

// A skill body with NO leading H1 is unaffected (nothing to strip).
{
  const inv = [{
    name: 'marketing-noh1',
    description: 'No title',
    path: '/tmp/a/SKILL.md',
    content: '---\nname: marketing-noh1\ndescription: No title\n---\n\n## First Tactic\n\nBody.\n',
  }];
  const md = renderContextMirror(inv);
  assert.match(md, /^### First Tactic$/m, 'first ## still demotes to ###');
  assert.match(md, /^## marketing-noh1$/m, 'wrapper intact');
}

// ── F3(1): falsifyTactic demotes nested headings inside the moved body ─────
// A tactic body containing its own ### subheadings (e.g. multi-step
// instructions) must not have those subheadings survive as their own ### line
// once moved under ## Falsified — extractFalsifiedClaims reads every "### "
// line after the Falsified heading as a distinct falsified claim, so an
// un-demoted "### Step 1" would show up as a bogus standalone entry in the
// "Do not propose" blocklist.
{
  const skillWithNestedHeading = [
    '---',
    'name: marketing-nested',
    'description: Testing nested headings',
    '---',
    '',
    '## Run a multi-step play',
    '',
    '**Why it works:** Sequence matters.',
    '',
    '### Step 1',
    '',
    'Do the first thing.',
    '',
    '### Step 2',
    '',
    'Do the second thing.',
    '',
  ].join('\n');

  const result = falsifyTactic(skillWithNestedHeading, {
    claim: 'multi-step',
    reason: 'Did not move the needle',
    today: '2026-08-14',
  });

  assert.deepEqual(
    extractFalsifiedClaims(result),
    ['Run a multi-step play'],
    'only the falsified tactic itself is a falsified claim — its nested Step headings must not leak in as separate entries'
  );
  // The nested headings must still be readable in the body, just demoted so
  // they no longer read as top-level falsified claims.
  assert.match(result, /#### Step 1/, 'nested ### heading demoted to #### inside the moved body');
  assert.match(result, /#### Step 2/, 'second nested heading demoted too');
}

// ── F1: the graveyard is bounded by its SECTION, not by end-of-file ─────────
// This replaces the old "## Falsified must be the last section" write guard.
// That guard aborted the whole batch (after a paid Opus merge call) whenever the
// model appended a new "## " section at end-of-file — its default behavior, and
// something the merge prompt never told it not to do. extractFalsifiedClaims now
// stops at the next "## " heading, so a live tactic sitting below the graveyard
// is simply a live tactic: no phantom claims, and nothing to police at write time.
{
  const falsifiedNotLast = [
    '---',
    'name: marketing-order',
    'description: Use when ordering things',
    '---',
    '',
    '## Live one',
    'body',
    '',
    '## Falsified',
    '',
    '### Dead one',
    '**Falsified 2026-08-14:** did not work',
    '',
    '## New tactic after Falsified',
    '',
    '### Step 1',
    'do this',
    '',
    '### Step 2',
    'do that',
    '',
  ].join('\n');

  assert.deepEqual(
    extractFalsifiedClaims(falsifiedNotLast),
    ['Dead one'],
    'a ## section below the graveyard bounds it — its ### subheadings are NOT falsified claims'
  );

  // And the write no longer throws: order is not a correctness constraint anymore.
  const oldContent = [
    '---',
    'name: marketing-order',
    'description: Use when ordering things',
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
  const grown = [
    '---',
    'name: marketing-order',
    'description: Use when ordering things',
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
    '## New tactic after Falsified',
    'body'.repeat(60),
    '',
  ].join('\n');
  assert.equal(
    validateSkillEdit(oldContent, grown), true,
    'appending a section after ## Falsified is allowed — the parser handles it, so the write must not abort a paid merge'
  );

  // The guard that DOES matter still fires: the graveyard entry may not vanish.
  const alsoDropsGraveyard = grown.replace('## Falsified\n\n### Dead one\n**Falsified 2026-08-14:** did not work\n\n', '');
  assert.throws(
    () => validateSkillEdit(oldContent, alsoDropsGraveyard),
    /Dead one/,
    'dropping the graveyard still throws — only the ORDERING guard went away'
  );
}

// ── F1: falsifyTactic normalizes a file whose graveyard is not last ─────────
// Sections below the graveyard are live sections, so they must be falsifiable
// and must be re-emitted above the graveyard rather than swallowed into it.
{
  const graveyardInTheMiddle = [
    '---',
    'name: marketing-order',
    'description: Use when ordering things',
    '---',
    '',
    '## Falsified',
    '',
    '### Dead one',
    '**Falsified 2026-08-14:** did not work',
    '',
    '## A tactic below the graveyard',
    '',
    'Body.',
    '',
  ].join('\n');

  const out = falsifyTactic(graveyardInTheMiddle, {
    claim: 'below the graveyard',
    reason: 'No lift',
    today: '2026-08-20',
  });

  assert.deepEqual(
    extractFalsifiedClaims(out).sort(),
    ['A tactic below the graveyard', 'Dead one'],
    'the newly falsified tactic lands INSIDE the graveyard alongside the existing entry'
  );
  assert.equal((out.match(/^## Falsified$/gm) || []).length, 1, 'still exactly one graveyard');
  assert.ok(!/^## A tactic below the graveyard$/m.test(out), 'the moved tactic is no longer a live ## section');
  assert.ok(out.indexOf('### Dead one') < out.indexOf('### A tactic below the graveyard'),
    'the pre-existing entry is kept and the new one appended after it');
}

// ── F1: a literal "## Falsified" inside a fenced block is not the graveyard ──
// falsifiedIndex used to be a raw regex with no fence awareness while
// splitLiveSections tracked ``` only and demoteHeadings tracked ``` and ~~~ —
// three readers of the same file with three different notions of a fence. All
// three now share one isFence(). A fenced example must be invisible to all.
{
  const fencedHeading = [
    '---',
    'name: marketing-fenced',
    'description: Use when documenting the format',
    '---',
    '',
    '## Document the graveyard format',
    '',
    'A falsified skill looks like this:',
    '',
    '~~~markdown',
    '## Falsified',
    '',
    '### Some dead claim',
    '~~~',
    '',
    'End of example.',
    '',
  ].join('\n');

  assert.deepEqual(
    extractFalsifiedClaims(fencedHeading), [],
    'a "## Falsified" inside a ~~~ fence is an example, not the graveyard'
  );

  const out = falsifyTactic(fencedHeading, { claim: 'Document', reason: 'Nobody read it', today: '2026-08-14' });
  assert.deepEqual(
    extractFalsifiedClaims(out), ['Document the graveyard format'],
    'the fenced example does not leak a second claim once the section is moved'
  );
  assert.match(out, /^## Falsified$/m, 'a real graveyard heading was created');
  assert.match(out, /~~~markdown/, 'the fenced example survives verbatim');
  assert.match(out, /^## Falsified$/m);
}

// ── F3: falsifyTactic must not leave ANY heading in the moved body at ### ───
// Reviewer's counterexample: a body containing "# Rogue H1" demoted by the
// mirror's two-level rule lands at "### Rogue H1", which extractFalsifiedClaims
// reads as a second falsified claim. That phantom claim reaches every
// creative-packager prompt AND becomes a permanent merge tripwire, because
// validateSkillEdit requires every old falsified claim to survive every edit.
{
  const skillWithRogueH1 = [
    '---',
    'name: marketing-rogue',
    'description: Use when testing rogue headings',
    '---',
    '',
    '## A tactic with an H1 in its body',
    '',
    '**Why it works:** Because.',
    '',
    '# Rogue H1',
    '',
    'Body under the rogue heading.',
    '',
  ].join('\n');

  const out = falsifyTactic(skillWithRogueH1, { claim: 'H1 in its body', reason: 'No effect', today: '2026-08-14' });

  assert.deepEqual(
    extractFalsifiedClaims(out),
    ['A tactic with an H1 in its body'],
    'the rogue H1 does not become a phantom falsified claim'
  );
  assert.match(out, /^#### Rogue H1$/m, 'the rogue H1 is demoted past ### so it cannot read as a claim');
  assert.match(out, /Body under the rogue heading/, 'its body survives');
}

// ── F6: falsifiedIndex must tolerate CRLF line endings ──────────────────────
// The regex used to omit \r from its character class. On a CRLF file the line
// is "## Falsified\r" before the \n, and JS's multiline $ only matches right
// before \n (it doesn't skip a trailing \r), so the match failed, returning
// -1 — which made extractFalsifiedClaims return [], which made
// validateSkillEdit's oldDead.length check short-circuit: the only
// non-prompt falsified guard silently disabled itself on CRLF files.
{
  const crlfSkill = LIVE_SKILL.replace(/\n/g, '\r\n')
    + '## Falsified\r\n\r\n### Dead one\r\n**Falsified 2026-08-14:** nope\r\n';
  assert.ok(crlfSkill.includes('## Falsified\r\n'), 'fixture genuinely has CRLF around the heading');

  assert.deepEqual(
    extractFalsifiedClaims(crlfSkill),
    ['Dead one'],
    'extractFalsifiedClaims finds the Falsified heading on a CRLF file'
  );
}
{
  // Stronger regression: the guard that actually matters — validateSkillEdit
  // must still refuse to drop a falsified entry when the file is CRLF.
  const oldCRLF = [
    '---',
    'name: marketing-crlf',
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
  ].join('\r\n');

  const droppedCRLF = [
    '---',
    'name: marketing-crlf',
    'description: Use when doing x',
    '---',
    '',
    '## Live one',
    'body'.repeat(60),
    '',
    '## Another live one',
    'body'.repeat(60),
    '',
  ].join('\r\n');

  assert.throws(
    () => validateSkillEdit(oldCRLF, droppedCRLF),
    /Dead one/,
    'the graveyard guard fires on CRLF files too — it must not silently no-op'
  );
}

// ── F-fence: isFence must track marker TYPE, not treat ``` and ~~~ as one toggle ─
// e45c74a unified fence detection into a single toggle that flipped on EITHER
// ``` or ~~~, so a ~~~ line inside a ```-opened fence (or vice versa) closed
// the fence early. Everything after that point — including a real "##
// Falsified" heading — was then read as still being inside a fence and the
// graveyard vanished. Per CommonMark, a fence is closed only by a line with
// the SAME marker character, at least as long as the opening run.
{
  const skillWithMixedFence = [
    '---',
    'name: marketing-fence-types',
    'description: Use when documenting fenced code examples',
    '---',
    '',
    '## Documenting fences',
    '',
    '```markdown',
    '~~~',
    '```',
    '',
    '## Falsified',
    '',
    '### Dead one',
    '**Falsified 2026-01-01:** no',
    '',
  ].join('\n');

  assert.deepEqual(
    extractFalsifiedClaims(skillWithMixedFence),
    ['Dead one'],
    'finds the graveyard past a ```-fence that contains a ~~~ line'
  );

  const droppedGraveyard = [
    '---',
    'name: marketing-fence-types',
    'description: Use when documenting fenced code examples',
    '---',
    '',
    '## Documenting fences',
    '',
    '```markdown',
    '~~~',
    '```',
    '',
  ].join('\n');

  assert.throws(
    () => validateSkillEdit(skillWithMixedFence, droppedGraveyard),
    /Dead one/,
    'validateSkillEdit still refuses a wholesale graveyard drop when a mixed fence precedes it'
  );
}

// ── F-fence: mirrored case — a ~~~-opened fence containing a ``` line ───────
{
  const skillWithMixedFenceReversed = [
    '---',
    'name: marketing-fence-types-2',
    'description: Use when documenting fenced code examples',
    '---',
    '',
    '## Documenting fences the other way',
    '',
    '~~~markdown',
    '```',
    '~~~',
    '',
    '## Falsified',
    '',
    '### Dead two',
    '**Falsified 2026-01-01:** no',
    '',
  ].join('\n');

  assert.deepEqual(
    extractFalsifiedClaims(skillWithMixedFenceReversed),
    ['Dead two'],
    'finds the graveyard past a ~~~-fence that contains a ``` line'
  );

  const droppedGraveyard2 = [
    '---',
    'name: marketing-fence-types-2',
    'description: Use when documenting fenced code examples',
    '---',
    '',
    '## Documenting fences the other way',
    '',
    '~~~markdown',
    '```',
    '~~~',
    '',
  ].join('\n');

  assert.throws(
    () => validateSkillEdit(skillWithMixedFenceReversed, droppedGraveyard2),
    /Dead two/,
    'validateSkillEdit still refuses a wholesale graveyard drop when the fence types are swapped'
  );
}

// ── F-fence: falsifyTactic must not fork into two ## Falsified sections ────
// when a mixed fence precedes the real graveyard — this was symptom #3 of
// the regression: falsifyTactic couldn't find the existing graveyard, so it
// synthesized a second one and the original entry vanished from
// extractFalsifiedClaims.
{
  const skillWithMixedFence = [
    '---',
    'name: marketing-fence-types-3',
    'description: Use when documenting fenced code examples',
    '---',
    '',
    '## Documenting fences',
    '',
    '```markdown',
    '~~~',
    '```',
    '',
    '## Falsified',
    '',
    '### Dead one',
    '**Falsified 2026-01-01:** no',
    '',
  ].join('\n');

  const out = falsifyTactic(skillWithMixedFence, {
    claim: 'Documenting',
    reason: 'did not work',
    today: '2026-07-27',
  });

  assert.equal((out.match(/^## Falsified$/gm) || []).length, 1, 'only ONE Falsified section');
  assert.deepEqual(
    extractFalsifiedClaims(out).sort(),
    ['Dead one', 'Documenting fences'],
    'both the pre-existing and newly falsified claims are present'
  );
}

console.log('✓ marketing-learner date + constraint tests pass');
