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
  assert.match(block, /18/, 'states the ~18mo platform-mechanics horizon');
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
      targetSkill: { name: 'marketing-retention-flows', action: 'create' },
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

console.log('✓ marketing-learner date + constraint tests pass');
