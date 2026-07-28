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

console.log('✓ marketing-learner date + constraint tests pass');
