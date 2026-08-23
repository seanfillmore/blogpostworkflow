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

// ── the durability nudge belongs to books, not to every file ────────────────
// A book is undated and mostly principle, so telling the model to treat it as
// durable is right. A social post pasted into a .md file is as platform-era as
// any video — handing it the same nudge would tell the model to discount the
// very era cues it should be scoring against.
{
  const book = buildConstraintBlock({ sourceType: 'file', sourceKind: 'book' });
  assert.match(book, /This source is a book/, 'a book still gets the durability nudge');
  assert.match(book, /durable principle/, 'and the instruction that goes with it');

  const post = buildConstraintBlock({ sourceType: 'file', sourceKind: 'social post' });
  assert.ok(!/durable principle/.test(post), 'a social post is judged on its own era cues');
  assert.equal(post, buildConstraintBlock(), 'and is scored exactly like a video');

  assert.match(buildConstraintBlock({ sourceType: 'file' }), /This source is a book/,
    'sourceKind defaults to book, preserving the behaviour the file source shipped with');
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
      source: { creator: 'Some Operator', title: 'Retention Playbook', locator: 'abc12345678' },
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
  // The extractor is shown each skill's CLAIMS, not its body — enough to edit rather than
  // duplicate, without shipping 94% of the prompt as skill text. See
  // renderInventoryForExtraction for why headings are the right cut.
  const p = buildExtractionPrompt({
    video: VIDEO,
    inventory: [{
      name: 'marketing-offers', description: 'Offer construction', path: 'x',
      content: '---\nname: marketing-offers\ndescription: Offer construction\n---\n\n'
        + '## AN_EXISTING_CLAIM.\n\n**Why it works:** BODY_OF_EXISTING_SKILL\n',
    }],
  });
  assert.match(p, /marketing-offers/, 'lists the existing skill');
  assert.match(p, /Offer construction/, 'lists its description — what triggering matches on');
  assert.match(p, /AN_EXISTING_CLAIM/, 'lists its claims so the model edits rather than duplicates');
  assert.ok(!p.includes('BODY_OF_EXISTING_SKILL'), 'but not the body behind each claim');
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

// ── renderInventoryForExtraction ────────────────────────────────────────────
// The extractor is shown claim HEADINGS, not full skill bodies. Bodies were 94% of the
// prompt (144k of 153k tokens on a 25-skill fleet) and, because the chunk cache keys on
// what the prompt contains, any successful merge invalidated every cached chunk of every
// source. Headings are the right cut: the heading IS the claim, and duplication is judged
// against claims.
{
  const { renderInventoryForExtraction, liveTacticHeadings } =
    await import('../../lib/marketing-learner.js');

  const skill = [
    '---', 'name: marketing-thing', 'description: does a thing', '---', '',
    '# Thing', '',
    '## First live claim.', '', '**Why it works:** a long body that must NOT be shipped.', '',
    '*Source: X — "Y" (book, part 1 of 2)*', '',
    '## Second live claim.', '', '**Why it works:** another long body.', '',
    '## Falsified', '', 'Tried here and did not work.', '',
    '### A dead claim.', '**Falsified 2026-01-01:** it did not work.', '',
  ].join('\n');

  const heads = liveTacticHeadings(skill);
  assert.deepEqual(heads, ['First live claim.', 'Second live claim.'],
    'live headings are the ## claims');
  assert.ok(!heads.includes('Falsified'), 'the graveyard heading is not a claim');
  assert.ok(!heads.some((h) => /dead claim/i.test(h)),
    'a falsified claim is not offered as live — listing it would invite an edit to a dead tactic');

  const block = renderInventoryForExtraction([
    { name: 'marketing-thing', description: 'does a thing', content: skill },
  ]);
  assert.match(block, /marketing-thing/, 'names the skill');
  assert.match(block, /does a thing/, 'carries the description, which is what triggering matches on');
  assert.match(block, /- First live claim\./, 'lists each claim');
  assert.ok(!block.includes('must NOT be shipped'), 'bodies are excluded');
  assert.ok(block.length < skill.length, 'the projection is smaller than the source skill');

  // A skill with no tactics yet must still appear — otherwise the extractor cannot see
  // that the name is taken and proposes a near-duplicate skill.
  const empty = renderInventoryForExtraction([
    { name: 'marketing-empty', description: 'nothing yet', content: '---\nname: marketing-empty\ndescription: nothing yet\n---\n\n# Empty\n' },
  ]);
  assert.match(empty, /marketing-empty/, 'an empty skill is still listed');
  assert.match(empty, /no tactics recorded yet/, 'and says so explicitly');

  assert.match(renderInventoryForExtraction([]), /no marketing skills exist yet/,
    'an empty fleet keeps its original wording');
}

// The prompt and the cache fingerprint must read the SAME projection. Deriving them
// separately is how a cache starts keying on something the prompt does not contain.
{
  const { renderInventoryForExtraction, buildExtractionPrompt } =
    await import('../../lib/marketing-learner.js');
  const inv = [{
    name: 'marketing-x', description: 'd',
    content: '---\nname: marketing-x\ndescription: d\n---\n\n## A claim here.\n\n**Why it works:** body text ONLYINBODY.\n',
  }];
  const prompt = buildExtractionPrompt({ video: VIDEO, inventory: inv });
  assert.ok(prompt.includes(renderInventoryForExtraction(inv)),
    'the prompt embeds the projection verbatim, so hashing it keys on what was actually sent');
  assert.ok(!prompt.includes('ONLYINBODY'), 'skill bodies do not reach the extraction prompt');
}

// ── the stage field must exist in the schemas that emit tactics ─────────────
// The extraction prompt spends ~30 lines on "Timing is a stage, never a reject" — the six
// gates, "adopt with the stage that unblocks it" — while the JSON schema it told the model
// to fill in had NO stage field. First-pass ingestion therefore could not park anything,
// whatever the prose said; every staged marker in the fleet came from --readjudicate,
// whose schema did have one. That is why all 71 tactics in the nine skills created by
// "$100M Leads" landed unparked, including seven about hiring agencies and three about
// training a team, for a solo operator on $30/day.
{
  const { buildExtractionPrompt, buildConsolidationPrompt, STAGES, validateExtraction } =
    await import('../../lib/marketing-learner.js');

  const ext = buildExtractionPrompt({ video: VIDEO, inventory: [] });
  assert.match(ext, /"stage":/, 'the extraction schema has a stage field');
  for (const g of STAGES) {
    assert.ok(ext.includes(`"${g}"`), `the extraction schema offers the "${g}" gate`);
  }
  assert.match(ext, /null is a claim that it is runnable NOW/,
    'and says null is an assertion, not a default');

  const con = buildConsolidationPrompt({
    candidates: [{ claim: 'c', mechanism: 'm', evidence: 'e', rscFit: { score: 5, reasoning: 'r' }, verdict: 'adopt' }],
    source: { title: 't', creator: 'c', sourceId: 's' },
  });
  assert.match(con, /"stage":/, 'the consolidation schema has one too');
  assert.match(con, /Carry `stage` through/,
    'and tells the model to preserve a stage across a merge — dropping it would silently unpark');

  // The validator already accepted the field; pin that it still does, and still rejects a
  // gate that is not real.
  const staged = {
    videoId: 'abc12345678', creator: 'C', title: 'T', summary: 'S', recencySignals: null,
    tactics: [{
      claim: 'Hire an agency to run ads.', mechanism: 'they know the platform',
      evidence: 'assertion only', rscFit: { score: 7, reasoning: 'needs budget and people' },
      verdict: 'adopt', stage: 'team', rejectReason: null,
      targetSkill: { name: 'marketing-agency-buying', action: 'create', description: 'Use when...' },
    }],
  };
  assert.doesNotThrow(() => validateExtraction(staged), 'a staged adopt validates');
  assert.throws(
    () => validateExtraction({ ...staged, tactics: [{ ...staged.tactics[0], stage: 'someday' }] }),
    /stage must be one of/,
    'an invented gate is refused',
  );
}

// ── assertNewSkillGating ────────────────────────────────────────────────────
// The structural backstop for the schema gap above. A schema the model CAN fill is not one
// it always fills correctly, and "$100M Leads" merged nine skills / 71 unparked tactics
// clean — nothing failed, it was caught by reading the result.
{
  const { assertNewSkillGating } = await import('../../lib/marketing-learner.js');
  const t = (stage = null) => ({ claim: 'c', mechanism: 'm', stage });

  assert.throws(
    () => assertNewSkillGating({
      name: 'marketing-agency-and-expert-buying',
      description: 'Use when deciding whether to hire an agency.',
      tactics: [t(), t(), t()],
    }),
    /not one of its 3 tactics carries a stage/,
    'an agency-shaped skill with nothing staged is refused',
  );
  assert.throws(
    () => assertNewSkillGating({
      name: 'marketing-task-delegation-training',
      description: 'Use when training the first person who takes work off your hands.',
      tactics: [t()],
    }),
    /delegation-shaped work/i,
    'a delegation-shaped skill is refused too',
  );

  // One staged tactic proves the question was weighed. A skill can legitimately mix a solo
  // scale-down ("pay a practitioner by the hour to teach you") with gated work.
  assert.doesNotThrow(
    () => assertNewSkillGating({
      name: 'marketing-agency-and-expert-buying',
      description: 'Use when deciding whether to hire an agency.',
      tactics: [t(), t('team'), t()],
    }),
    'one staged tactic is enough to pass',
  );

  // Narrow by construction — it must not fire on ordinary solo skills.
  for (const name of ['marketing-warm-outreach-sequence', 'marketing-lead-capture-landing-pages',
    'marketing-customer-referral-program', 'marketing-copy-hooks-and-formats']) {
    assert.doesNotThrow(
      () => assertNewSkillGating({ name, description: 'Use when writing copy for a page.', tactics: [t(), t()] }),
      `${name} is solo-runnable and must not trip the guard`,
    );
  }
  assert.doesNotThrow(() => assertNewSkillGating({ name: 'marketing-agency-x', description: '', tactics: [] }),
    'a skill with no tactics is not judged');
}

// ── extractTactics ──────────────────────────────────────────────────────────
// Extraction streams, for the same reason consolidation does: the budget it needs
// is large enough that the SDK rejects a non-streaming call outright. The stub
// therefore exposes stream().finalMessage(), not create() — a client offering only
// create() would fail here, which is the point.
function fakeClient(response) {
  return { messages: { stream: () => ({ finalMessage: async () => response }) } };
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

// A `chunk` must reach the prompt. Without this, chunking is a silent no-op:
// every chunk re-sends the whole transcript, so N chunks cost N identical calls
// and the max_tokens overflow chunking exists to prevent still happens.
{
  let sent = null;
  const capturing = {
    messages: {
      stream: (req) => {
        sent = req;
        return {
          finalMessage: async () => ({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(GOOD) }],
          }),
        };
      },
    },
  };
  const longVideo = { ...VIDEO, text: 'FULL TRANSCRIPT BODY that must not be sent verbatim.' };
  await extractTactics({
    video: longVideo,
    inventory: [],
    client: capturing,
    chunk: { index: 1, total: 3, label: 'part 2 of 3', text: 'ONLY THIS EXCERPT' },
  });
  const prompt = sent.messages[0].content;
  assert.match(prompt, /ONLY THIS EXCERPT/, 'chunk text reaches the prompt');
  assert.ok(!prompt.includes('FULL TRANSCRIPT BODY'), 'full source text is not sent alongside the chunk');
  assert.match(prompt, /EXCERPT of a longer work/, 'chunk framing tells the model it is seeing a part');

  // A 4,500-word chunk of a BOOK yields far more tactics than 4,500 words of
  // speech: $100M Money Models overflowed 16k on part 3 of 11 and refused to save.
  // The budget is shared with adaptive thinking, so it has to clear both.
  assert.ok(sent.max_tokens >= 32000, 'extraction budgets for a dense book chunk, not a sparse transcript');
}

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

// A transient overload must not kill an 11-chunk book run. Three separate runs of
// $100M Money Models died on `overloaded_error` at parts 6 and 7, each time
// discarding the whole remaining run.
{
  let calls = 0;
  const flaky = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error('Overloaded');
            err.status = 529;
            throw err;
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(GOOD) }] };
        },
      }),
    },
  };
  const out = await extractTactics({
    video: VIDEO,
    inventory: [],
    client: flaky,
    retryOptions: { delayMs: 1 },
  });
  assert.equal(calls, 2, 'a 529 is retried rather than aborting the run');
  assert.equal(out.tactics.length, 2, 'the retry’s payload is what gets returned');
}

// Retry wraps the TRANSPORT, not the guards. A truncated response is deterministic —
// retrying it would burn four expensive calls and three minutes of backoff to arrive
// at the same failure.
{
  let calls = 0;
  const truncating = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          return { stop_reason: 'max_tokens', content: [] };
        },
      }),
    },
  };
  await assert.rejects(
    () => extractTactics({ video: VIDEO, inventory: [], client: truncating, retryOptions: { delayMs: 1 } }),
    /max_tokens/,
    'truncation still throws'
  );
  assert.equal(calls, 1, 'truncation is not retried — it is deterministic, not transient');
}

// An unparseable response must carry its raw text out for inspection. The caller
// persists err.offendingPayload; without it a parse failure discards a response
// that was already paid for and leaves nothing to diagnose — which is exactly what
// happened on part 3 of $100M Offers.
{
  const err = await extractTactics({
    video: { ...VIDEO, videoId: null, sourceType: 'file', sourceId: '100m-offers' },
    inventory: [],
    client: fakeClient({ stop_reason: 'refusal', content: [] }),
    chunk: { index: 2, total: 11, label: 'part 3 of 11', text: 'excerpt' },
  }).then(() => null, (e) => e);

  assert.ok(err, 'an empty response throws');
  assert.equal(err.offendingPayload?.stop_reason, 'refusal', 'stop_reason is carried out for inspection');
  assert.equal(typeof err.offendingPayload?.rawText, 'string', 'the raw text is carried out');
  // "for null" is what this said before, on every file-source failure.
  assert.match(err.message, /100m-offers/, 'the error names the source, not null');
  assert.match(err.message, /part 3 of 11/, 'the error names the chunk that failed');
}

// A schema-invalid body gets exactly ONE re-sample. The Entrepreneurial Emergency
// died on chunk 4 of 6 because the model wrote a `rejectReason` for the last tactic
// and omitted its `verdict` — one dropped key out of seven objects. The JSON parsed;
// only the schema failed, and re-running the identical prompt produced valid output.
// That is sampling variance, not a deterministic property of the prompt, and
// refusing to re-sample discarded five good chunks and a consolidation pass with it.
{
  let calls = 0;
  const missingVerdict = {
    tactics: [
      { ...GOOD.tactics[0] },
      { ...GOOD.tactics[1], verdict: undefined },
    ],
  };
  const slipsOnce = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          return {
            stop_reason: 'end_turn',
            content: [{
              type: 'text',
              text: JSON.stringify(calls === 1 ? missingVerdict : GOOD),
            }],
          };
        },
      }),
    },
  };
  const out = await extractTactics({
    video: VIDEO, inventory: [], client: slipsOnce, retryOptions: { delayMs: 1 },
  });
  assert.equal(calls, 2, 'a schema-invalid body is re-sampled exactly once');
  assert.equal(out.tactics.length, 2, 'the second, valid sample is what gets returned');
}

// ...and only once. Repeated failure means the prompt or the ceiling is the problem,
// not the sample, so it must not spend a third call to confirm that.
{
  let calls = 0;
  const alwaysInvalid = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({ tactics: [{ claim: 'no verdict' }] }) }],
          };
        },
      }),
    },
  };
  const err = await extractTactics({
    video: VIDEO, inventory: [], client: alwaysInvalid, retryOptions: { delayMs: 1 },
  }).then(() => null, (e) => e);

  assert.ok(err, 'a body that fails twice still throws');
  assert.equal(calls, 2, 'stops at two attempts — it does not keep re-sampling');
  assert.ok(err.offendingPayload?.tactics, 'the schema failure still carries the parsed payload out');
}

// A refusal is not re-sampled either. The safety classifiers declined this prompt;
// re-sending it unchanged reaches the same decision, so grouping it with a malformed
// body would just buy a second identical refusal.
{
  let calls = 0;
  const refusing = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          return { stop_reason: 'refusal', content: [] };
        },
      }),
    },
  };
  const err = await extractTactics({
    video: VIDEO, inventory: [], client: refusing, retryOptions: { delayMs: 1 },
  }).then(() => null, (e) => e);

  assert.ok(err, 'a refusal throws');
  assert.equal(calls, 1, 'a refusal is not re-sampled');
  assert.equal(err.offendingPayload?.stop_reason, 'refusal', 'stop_reason is still carried out');
}

// Truncation is NOT re-sampled even though it now shares the retry loop: max_tokens
// says the output did not fit the ceiling, and a second attempt against that same
// ceiling cannot fix it.
{
  let calls = 0;
  const truncating = {
    messages: {
      stream: () => ({
        finalMessage: async () => {
          calls += 1;
          return { stop_reason: 'max_tokens', content: [] };
        },
      }),
    },
  };
  await assert.rejects(
    () => extractTactics({ video: VIDEO, inventory: [], client: truncating, retryOptions: { delayMs: 1 } }),
    /max_tokens/,
    'truncation still throws'
  );
  assert.equal(calls, 1, 'truncation is not re-sampled — the ceiling, not the sample, is the problem');
}

// A trailing comma before } or ] is the single most common way the model's JSON
// comes back invalid — the Dara Denney statics video failed twice in a row on it
// (17 of them in part 1, 4 in part 2), each failure discarding a paid extraction.
// The repair must not touch commas that live inside string values.
{
  const withTrailingCommas = JSON.stringify(GOOD, null, 2)
    .replace(/"rscFit": \{/g, '"note": "a, b, c ] } trap,", "rscFit": {')
    .replace(/\n(\s*)\}/g, ',\n$1}')
    .replace(/\n(\s*)\]/g, ',\n$1]');
  assert.throws(() => JSON.parse(withTrailingCommas), 'the fixture really is invalid JSON');

  const out = await extractTactics({
    video: VIDEO,
    inventory: [],
    client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: withTrailingCommas }] }),
  });
  assert.equal(out.tactics.length, 2, 'trailing commas are repaired rather than discarding the response');
  assert.equal(out.tactics[0].claim, GOOD.tactics[0].claim, 'string values survive the repair intact');
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

// A file source is named by whatever it actually is. Calling a pasted essay a
// "book" is not a cosmetic slip: these lines are the provenance the whole skill
// library rests on.
{
  const fileVideo = { ...VIDEO, sourceType: 'file', sourceId: 'secret-of-the-dtc-universe', videoId: null };
  const asPost = renderReport({
    extraction: GOOD,
    video: { ...fileVideo, sourceKind: 'social post' },
    skillsTouched: [],
  });
  assert.match(asPost, /\*\*Source:\*\* social post — `secret-of-the-dtc-universe`/);
  assert.ok(!/\*\*Source:\*\* book/.test(asPost), 'nothing calls it a book');

  const asBook = renderReport({ extraction: GOOD, video: fileVideo, skillsTouched: [] });
  assert.match(asBook, /\*\*Source:\*\* book — `secret-of-the-dtc-universe`/, 'unspecified stays book');
}

import { mergeSkillContent } from '../../lib/marketing-learner.js';

const EXISTING_SKILL = '---\nname: marketing-retention-flows\ndescription: Lifecycle email\n---\n\n'
  + '## Old claim\n\n' + 'y'.repeat(800);

const NEW_TACTICS = [{
  claim: 'Send replenishment at 60% of cycle',
  mechanism: 'Intent peaks before running out',
  evidence: 'assertion only',
  rscFit: { score: 8, reasoning: 'Retention is the constraint' },
  source: { creator: 'Some Operator', title: 'Retention Playbook', locator: 'abc12345678' },
}];

// stream().finalMessage(), not create() — the merge budget (32k) is past the point
// where the SDK accepts a non-streaming request. A stub still shaped like create()
// would pass by throwing "not a function" into whatever assert.rejects() expected.
function mergeClient(payload, stop = 'end_turn') {
  return {
    messages: {
      stream: () => ({
        finalMessage: async () => ({ stop_reason: stop, content: [{ type: 'text', text: payload }] }),
      }),
    },
  };
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

// ── a Stage marker on an OPEN gate is live content, not a parked one ─────────
// The merge prompt used to list every Stage-marked section as "currently parked",
// and separately forbid mentioning a parked tactic in the frontmatter description.
// So on 2026-08-19, with the traffic gate open, a merge obediently stripped four
// LIVE sections (breakeven CAC, campaign objectives, the edit freeze, breakthrough-ad
// dissection) out of the description — the trigger text — because it had been told
// no reader would find them. stripParkedSections keeps open-gate sections; the prompt
// has to agree with it. Assert on the prompt itself: nothing downstream can see this.
{
  const STAGED_SKILL = [
    '---',
    'name: marketing-staged-example',
    'description: Existing skill',
    '---',
    '',
    '## Open-gate tactic',
    '',
    '**Stage:** traffic — gate OPEN as of 2026-08-17. Live; no longer parked.',
    '',
    'x'.repeat(400),
    '',
    '## Closed-gate tactic',
    '',
    '**Stage:** offer-aov — parked until the offer-aov phase opens.',
    '',
    'y'.repeat(400),
  ].join('\n');

  function capturingClient(payload) {
    const seen = {};
    return {
      seen,
      messages: {
        stream: (params) => {
          seen.prompt = params.messages[0].content;
          return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: payload }] }) };
        },
      },
    };
  }

  // currentStage: 'cro' — traffic and offer-aov are both still ahead, so BOTH are parked.
  const closed = capturingClient(JSON.stringify({ content: STAGED_SKILL, supersedes: null }));
  await mergeSkillContent({
    existingContent: STAGED_SKILL, tactics: NEW_TACTICS, client: closed, currentStage: 'cro',
  });
  assert.match(closed.seen.prompt, /Currently PARKED \(gate still closed\):[^\n]*Open-gate tactic/,
    'a gate the business has not reached is named as parked');
  assert.doesNotMatch(closed.seen.prompt, /their gate is already OPEN/,
    'no open-gate clause when nothing is open');

  // currentStage: 'traffic' — the real one today. traffic is open, offer-aov is earlier
  // so it is open too; nothing is parked and the description must promise both.
  const open = capturingClient(JSON.stringify({ content: STAGED_SKILL, supersedes: null }));
  await mergeSkillContent({
    existingContent: STAGED_SKILL, tactics: NEW_TACTICS, client: open, currentStage: 'traffic',
  });
  assert.match(open.seen.prompt, /Nothing here is currently parked\./,
    'an open gate is never reported as parked');
  assert.match(open.seen.prompt, /their gate is already OPEN, so they are LIVE:[^\n]*Open-gate tactic/,
    'the open-gate section is named as live so it stays in the description');
  assert.doesNotMatch(open.seen.prompt, /Currently PARKED/,
    'nothing is listed as parked once every gate is open');
}

// ── the size warning fires before the budget does, not after ────────────────
{
  const { skillSizeWarning } = await import('../../lib/marketing-learner.js');

  assert.equal(skillSizeWarning({ content: 'x'.repeat(4000), maxTokens: 32000 }), null,
    'a small skill says nothing');

  // The empirical anchor: the file that broke a 16k budget was ~29,000 chars. Against the
  // current 32k budget that is ~23% — still quiet, which is the point of the raise.
  assert.equal(skillSizeWarning({ content: 'x'.repeat(29000), maxTokens: 32000 }), null,
    'the file that broke 16k is comfortably inside 32k');
  assert.match(skillSizeWarning({ content: 'x'.repeat(29000), maxTokens: 16000 }), /45% of the 16,000-token/,
    'against the OLD budget the same file would have been flagged well before it failed');

  const warn = skillSizeWarning({ content: 'x'.repeat(40000), maxTokens: 32000, name: 'marketing-big' });
  assert.match(warn, /^marketing-big is ~10,000 tokens, 31%/);
  assert.match(warn, /re-emits the WHOLE file/, 'says why size matters here specifically');
}

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

// ── provenance locator: video form is byte-identical to what shipped ────────
{
  const md = renderSkillMarkdown({
    name: 'marketing-x',
    description: 'd',
    tactics: [{
      claim: 'c', mechanism: 'm', evidence: 'e', rscFit: { score: 8, reasoning: 'r' },
      source: { creator: 'Alex Becker', title: 'How I Scaled', locator: 'dQw4w9WgXcQ' },
    }],
  });
  assert.ok(md.includes('*Source: Alex Becker — "How I Scaled" (dQw4w9WgXcQ)*'),
    'video provenance line is unchanged');
}

// ── book form renders the book locator ──────────────────────────────────────
{
  const md = renderSkillMarkdown({
    name: 'marketing-x',
    description: 'd',
    tactics: [{
      claim: 'c', mechanism: 'm', rscFit: { score: 8, reasoning: 'r' },
      source: { creator: 'Alex Hormozi', title: '$100M Money Models', locator: 'book, part 7 of 11' },
    }],
  });
  assert.ok(md.includes('*Source: Alex Hormozi — "$100M Money Models" (book, part 7 of 11)*'));
}

// ── missing source degrades, never throws ───────────────────────────────────
{
  const md = renderSkillMarkdown({
    name: 'marketing-x',
    description: 'd',
    tactics: [{ claim: 'c', mechanism: 'm', rscFit: { score: 1, reasoning: 'r' } }],
  });
  assert.ok(md.includes('*Source: unknown — "untitled" (n/a)*'));
}

// ── constraint block gains a durability note for files only ─────────────────
{
  const video = buildConstraintBlock({ sourceType: 'video' });
  const file = buildConstraintBlock({ sourceType: 'file' });
  assert.equal(buildConstraintBlock(), video, 'default is the video form');
  assert.ok(!/durable principle rather than platform mechanics/.test(video));
  assert.ok(/durable principle rather than platform mechanics/.test(file));
  for (const b of [video, file]) {
    assert.ok(/\$50\.46/.test(b), 'AOV survives in both');
    assert.ok(/Platform mechanics/.test(b), 'decay table survives in both');
  }
}

// ── bare YYYY: allowed for files, rejected for videos ───────────────────────
{
  const ok = parsePublishedFlags(['book.txt'], ['2025'], { today: '2026-07-28', allowYearOnly: true });
  assert.equal(ok[0].publishedAt, '2025', 'a copyright page carries a year, not a date');

  assert.throws(
    () => parsePublishedFlags(['https://youtu.be/aaaaaaaaaaa'], ['2025'], { today: '2026-07-28' }),
    /YYYY-MM-DD/,
    'a video has a real upload date; a bare year there would be invented precision',
  );

  assert.throws(
    () => parsePublishedFlags(['book.txt'], ['2099'], { today: '2026-07-28', allowYearOnly: true }),
    /in the future/,
  );

  const stale = parsePublishedFlags(['book.txt'], ['2015'], { today: '2026-07-28', allowYearOnly: true });
  assert.ok(/older than 4 years/.test(stale[0].warning), 'staleness warning still fires on a year');
}

console.log('✓ marketing-learner date + constraint tests pass');

// ── staged tactics ──────────────────────────────────────────────────────────
// A tactic that is right for this business but blocked by the operating sequence
// (Tracking -> CRO -> Offer/AOV -> Traffic) used to be rejected outright, which
// left it in a per-video JSON report nothing ever reads again. It is now adopted
// into the skill with a stage tag, so the knowledge is on the record and
// discoverable, while the fleet-facing projection hides it until that gate opens.
import {
  STAGES,
  CURRENT_STAGE,
  extractStagedTactics,
  isStageActive,
  isTimingReject,
} from '../../lib/marketing-learner.js';

// The enum is written into reports, so it is a compatibility surface.
{
  assert.deepEqual(
    [...STAGES],
    ['tracking', 'cro', 'offer-aov', 'traffic', 'scale', 'team'],
    'stage names are the operating sequence, in order',
  );
}

// ── parking must actually park something ────────────────────────────────────
// When CURRENT_STAGE is the LAST entry in STAGES, isStageActive returns true for
// every value and a stage marker is decoration. That is what happened between
// 2026-08-17 and 2026-08-20: the traffic gate opened, traffic was last, and the
// extractor was told to stop setting `stage` at all — so a tactic that was sound
// but premature had nowhere to go except a reject, and the corpus accumulated 41
// of them. At least one gate must always sit ahead of the current one.
{
  const ahead = STAGES.slice(STAGES.indexOf(CURRENT_STAGE) + 1);
  assert.ok(ahead.length > 0,
    'a gate must exist beyond CURRENT_STAGE, or parking is a no-op and premature tactics get rejected instead');
  for (const gate of ahead) {
    assert.equal(isStageActive(gate), false, `${gate} parks while the business is at ${CURRENT_STAGE}`);
  }
  assert.equal(isStageActive('traffic'), true, 'the gate already reached stays live');
  assert.equal(isStageActive('cro'), true, 'an earlier gate stays live');
}

// ── the extractor is told to park, not to reject, on timing ─────────────────
{
  const block = buildConstraintBlock();
  assert.ok(!/Do not set a stage/i.test(block), 'the do-not-park instruction is gone');
  assert.match(block, /\bscale\b/, 'names the scale gate');
  assert.match(block, /\bteam\b/, 'names the team gate');
  assert.match(block, /never a reject|not a reject/i,
    'says plainly that a timing blocker is a park, not a rejection');
}

// ── isTimingReject: which old rejections are worth paying to re-read ────────
{
  const reject = (why) => ({ verdict: 'reject', rejectReason: why, rscFit: { reasoning: '' } });

  // Timing — the tactic is sound, the business just is not there yet.
  assert.equal(isTimingReject(reject('Requires a media buyer and an agency.')), true);
  assert.equal(isTimingReject(reject('Needs volume to reach statistical significance.')), true);
  assert.equal(isTimingReject(reject('Assumes a $100/day floor and a 20-creative test cell.')), true);
  assert.equal(isTimingReject(reject('This business does not produce video and has no creator roster.')), true);

  // Merit — stays rejected however big the business gets.
  assert.equal(isTimingReject(reject('Duplicates an existing entry in marketing-offer-construction.')), false);
  assert.equal(isTimingReject(reject('Motivational framing with no stated mechanism.')), false);

  // Merit wins ties. A duplicate is a duplicate even when the reasoning also
  // mentions the budget — otherwise every re-adjudication pass re-proposes the
  // same duplicates and the skills accumulate near-copies.
  assert.equal(
    isTimingReject(reject('Duplicates the existing rule, and also needs volume this business lacks.')),
    false,
    'a rejection naming duplication is never re-read as a timing rejection');

  // Only rejections are candidates at all.
  assert.equal(isTimingReject({ verdict: 'adopt', rscFit: { reasoning: 'needs volume' } }), false);
  assert.equal(isTimingReject(null), false);
  assert.equal(isTimingReject(reject('')), false, 'no recorded reason is not evidence of timing');
}

// validateExtraction: stage is optional, constrained, and adopt-only.
{
  const withStage = structuredClone(GOOD);
  withStage.tactics[0].stage = 'traffic';
  assert.doesNotThrow(() => validateExtraction(withStage), 'a valid stage on an adopted tactic passes');

  const bogus = structuredClone(GOOD);
  bogus.tactics[0].stage = 'someday';
  assert.throws(() => validateExtraction(bogus), /stage/, 'an unknown stage is rejected');

  // A rejected tactic is dead, not parked. Allowing stage there would create a
  // second, invisible parking lot with no skill entry behind it — the exact
  // failure this feature exists to remove.
  const onReject = structuredClone(GOOD);
  onReject.tactics[1].stage = 'traffic';
  assert.throws(() => validateExtraction(onReject), /stage/, 'stage on a rejected tactic is rejected');
}

// renderSkillMarkdown emits a parseable marker, and only for staged tactics.
{
  const md = renderSkillMarkdown({
    name: 'marketing-paid-media',
    description: 'Paid media economics.',
    tactics: [
      {
        claim: 'Break even on the first purchase from paid',
        mechanism: 'LTV pays for the second order',
        evidence: 'assertion',
        rscFit: { score: 4, reasoning: 'Right idea, no ad account yet' },
        stage: 'traffic',
        source: { creator: 'X', title: 'Y', locator: 'z' },
      },
      {
        claim: 'Answer the unasked why',
        mechanism: 'Removes the silent objection',
        evidence: 'assertion',
        rscFit: { score: 7, reasoning: 'Free and editorial' },
        source: { creator: 'X', title: 'Y', locator: 'z' },
      },
    ],
  });

  assert.match(md, /\*\*Stage:\*\* traffic\b/, 'the staged tactic carries its gate in the file');
  assert.equal((md.match(/\*\*Stage:\*\*/g) || []).length, 1, 'an active tactic carries no stage marker');
}

// extractStagedTactics reads the markers back out — this is what answers
// "what does the Traffic phase unlock?" without an LLM call.
{
  const content = [
    '---', 'name: marketing-paid-media', 'description: Paid.', '---', '',
    '# Paid Media', '',
    '## Break even on the first purchase', '',
    '**Stage:** traffic — activates when the Traffic phase opens.', '',
    '**Why it works:** LTV pays for the second order.', '',
    '## Answer the unasked why', '',
    '**Why it works:** Removes the silent objection.', '',
    '## Falsified', '',
    '### Some dead thing', '',
    '**Falsified 2026-08-01:** did not work.', '',
  ].join('\n');

  const staged = extractStagedTactics(content);
  assert.equal(staged.length, 1, 'only the marked section is staged');
  assert.equal(staged[0].stage, 'traffic');
  assert.match(staged[0].claim, /Break even/);

  // A staged tactic is live knowledge, not a failed experiment. If it leaked into
  // the graveyard parser it would land on the "Do not propose" blocklist and be
  // permanently unusable — the opposite of parking it.
  assert.deepEqual(extractFalsifiedClaims(content), ['Some dead thing'], 'staging does not falsify');
}

// isStageActive is the single place the current phase is decided.
{
  assert.equal(isStageActive(null, 'cro'), true, 'an untagged tactic is always active');
  assert.equal(isStageActive('tracking', 'cro'), true, 'a gate already passed is active');
  assert.equal(isStageActive('cro', 'cro'), true, 'the current gate is active');
  assert.equal(isStageActive('traffic', 'cro'), false, 'a gate not yet reached is parked');
}

// renderContextMirror hides parked tactics from the fleet. This is the whole
// point of the split: creative-packager is told "draw an angle from the live
// tactics above", so a parked tactic in the mirror becomes ad copy for an offer
// this business does not run.
{
  const content = [
    '---', 'name: marketing-paid-media', 'description: Paid media economics.', '---', '',
    '# Paid Media', '',
    '## Run a giveaway as a front-end attraction offer', '',
    '**Stage:** traffic — activates when the Traffic phase opens.', '',
    '**Why it works:** Cheap list growth.', '',
    '## Answer the unasked why', '',
    '**Why it works:** Removes the silent objection.', '',
  ].join('\n');

  const md = renderContextMirror([
    { name: 'marketing-paid-media', description: 'Paid media economics.', path: '/tmp/a/SKILL.md', content },
  ], { stage: 'cro' });

  assert.ok(!md.includes('Run a giveaway'), 'a parked tactic is absent from the fleet projection');
  assert.ok(md.includes('Answer the unasked why'), 'active tactics still project');
  assert.ok(md.includes('marketing-paid-media'), 'the skill itself still appears');

  const later = renderContextMirror([
    { name: 'marketing-paid-media', description: 'Paid media economics.', path: '/tmp/a/SKILL.md', content },
  ], { stage: 'traffic' });
  assert.ok(later.includes('Run a giveaway'), 'the same tactic projects once its gate opens');
}

// A skill whose every tactic is parked must not project as an empty shell — an
// empty "## marketing-x" block with a description invites the model to invent
// content under a heading that promises tactics.
{
  const content = [
    '---', 'name: marketing-paid-media', 'description: Paid media economics.', '---', '',
    '# Paid Media', '',
    '## Run a giveaway', '',
    '**Stage:** traffic — later.', '',
    '**Why it works:** Cheap list growth.', '',
  ].join('\n');

  const md = renderContextMirror([
    { name: 'marketing-paid-media', description: 'Paid media economics.', path: '/tmp/a/SKILL.md', content },
  ], { stage: 'cro' });

  assert.ok(!md.includes('marketing-paid-media'), 'a fully-parked skill is omitted entirely');
}

// Default stage: callers that pass no options get the CONFIGURED current phase
// rather than "everything", so an un-updated caller cannot leak parked tactics.
//
// This used to assert that a `traffic`-parked section was hidden by default, which
// silently encoded "traffic is still in the future". CURRENT_STAGE reached 'traffic'
// on 2026-08-17, so that fixture would now fail for the right reason — the gate is
// open — and pinning any single stage's visibility just re-breaks on the next bump.
// Pin the actual contract instead: default === explicit CURRENT_STAGE, and a stage
// beyond the current one is still hidden.
{
  const content = [
    '---', 'name: marketing-paid-media', 'description: Paid.', '---', '',
    '# Paid', '',
    '## Parked thing', '',
    '**Stage:** traffic — later.', '',
    '**Why it works:** Later.', '',
    '## Active thing', '',
    '**Why it works:** Now.', '',
  ].join('\n');

  const inv = [{ name: 'marketing-paid-media', description: 'Paid.', path: '/tmp/a/SKILL.md', content }];
  assert.equal(
    renderContextMirror(inv),
    renderContextMirror(inv, { stage: CURRENT_STAGE }),
    'the default projection is the configured stage, not a permissive "everything"',
  );
  assert.ok(renderContextMirror(inv).includes('Active thing'), 'an unstaged section is always live');

  // The gating machinery itself still works — check against an earlier phase, which
  // is the only direction left to test now that 'traffic' is the last stage.
  const atCro = renderContextMirror(inv, { stage: 'cro' });
  assert.ok(!atCro.includes('Parked thing'), 'a later-stage section is hidden from an earlier phase');
  assert.ok(atCro.includes('Active thing'), 'an unstaged section survives an earlier phase');
}

// The extraction prompt must tell the model to park rather than reject, or the
// model keeps discarding stage-blocked tactics and none of the above ever fires.
{
  const b = buildConstraintBlock({ sourceType: 'video' });
  assert.match(b, /stage/i, 'the constraint block explains staging');
  assert.match(b, /traffic/, 'the traffic phase is named for the model');
  // Every gate is open as of 2026-08-17, so the block must say so and must stop the
  // model discounting a tactic for a gate that no longer exists. That mis-scoring is
  // not hypothetical: it cost six Meta reporting tactics 4/10 apiece on 2026-08-16,
  // the same week the ad account was being built for the giveaway.
  assert.match(b, /gate is OPEN|gates \(tracking, cro, offer-aov, traffic\) are open/i,
    'the constraint block states the traffic gate is open');
  // …but "open" must not read as "nothing can ever be parked again". Between
  // 2026-08-17 and 2026-08-20 the block told the model to omit stage entirely,
  // and 41 sound-but-premature tactics were rejected instead of parked. The
  // capacity gates ahead of traffic are what give them somewhere to go.
  assert.ok(!/omit `stage` on every tactic/i.test(b),
    'the block no longer tells the model to stop setting stage');
  assert.match(b, /Timing is a stage, never a reject/i,
    'the block leads with the rule that timing never produces a rejection');
  assert.match(b, /"Not yet" is a stage\. Only "not ever" is a\s+reject\./i,
    'and states the test in one line the model can apply');
  assert.ok(
    !/Requires ad budget materially above current spend\.\n/.test(b) ||
      /do not reject/i.test(b),
    'budget-gated tactics are no longer an outright-reject rule',
  );
}

// The merge model rewrites whole files, so it can drop a **Stage:** line while
// otherwise growing the file — invisible to the shrink guard. The consequence is
// not cosmetic: an unmarked tactic immediately enters the fleet projection, which
// is the one thing parking exists to prevent. Same class as the falsified guard,
// and likewise code rather than persuasion.
{
  const staged = [
    '---', 'name: marketing-paid-media', 'description: Paid.', '---', '',
    '# Paid Media', '',
    '## Break even on the first purchase', '',
    '**Stage:** traffic — parked.', '',
    '**Why it works:** LTV pays for the second order.', '',
  ].join('\n');

  const unmarked = staged.replace('**Stage:** traffic — parked.\n\n', '') + '\n\nExtra padding so the file grows rather than shrinks, defeating the size guard.\n';

  assert.throws(
    () => validateSkillEdit(staged, unmarked),
    /[Ss]tage/,
    'dropping a stage marker is refused',
  );

  // Re-staging to a DIFFERENT gate is a legitimate edit — a tactic can turn out to
  // be blocked by CRO rather than Traffic. Only losing the marker entirely is damage.
  const restaged = staged.replace('**Stage:** traffic', '**Stage:** cro');
  assert.doesNotThrow(() => validateSkillEdit(staged, restaged), 'changing which gate applies is allowed');

  // Unparking is how a tactic goes live, but it must be declared, not silent.
  const unparked = staged.replace('**Stage:** traffic — parked.\n\n', '');
  assert.doesNotThrow(
    () => validateSkillEdit(staged, unparked, { supersedes: 'traffic phase opened; tactic is now live' }),
    'an explicit supersedes reason unparks it',
  );
}

// A skill whose headings are a numbered sequence renumbers its own later steps whenever a
// merge inserts one in the middle. "Step 5 — X" legitimately becomes "Step 7 — X" with the
// marker intact, and matching staged tactics on the raw claim read that as an unpark. The
// false positive blocked every merge into marketing-performance-pattern-analysis — the
// fleet's only numbered skill — and killed two ingests before it was diagnosed.
{
  const { validateSkillEdit, normalizeStagedClaim } = await import('../../lib/marketing-learner.js');

  const mk = (n, extra = '') => [
    '---', 'name: marketing-steps', 'description: d', '---', '', '# Steps', '',
    '## Step 1 — name the constraint.', '', '**Why it works:** body.', '', '*Source: A — "B" (book)*', '',
    `## Step ${n} — read a high conversion rate as a narrow-funnel symptom.`, '',
    '**Stage:** scale', '', '**Why it works:** body.', '', '*Source: A — "B" (book)*', '', extra,
  ].join('\n');
  const INSERTED = '## Step 9 — a newly adopted tactic.\n\n**Why it works:** b.\n\n*Source: A — "B" (book)*\n';
  const before = mk(5);

  assert.doesNotThrow(
    () => validateSkillEdit(before, mk(7, INSERTED)),
    'renumbering a staged tactic while keeping its marker is not an unpark',
  );
  assert.doesNotThrow(
    () => validateSkillEdit(before, mk(5, INSERTED)),
    'the ordinary same-number case still passes',
  );

  // The fallback must not mask real damage. It only consults tactics that are STAGED in
  // the replacement, so a dropped marker is absent from both sets however it was numbered.
  assert.throws(
    () => validateSkillEdit(before, mk(7, INSERTED).replace('**Stage:** scale\n', '')),
    /unparks/,
    'renumbering AND dropping the marker is still refused',
  );
  assert.throws(
    () => validateSkillEdit(before, mk(5, INSERTED).replace('**Stage:** scale\n', '')),
    /unparks/,
    'dropping the marker without renumbering is still refused',
  );

  // Narrow by construction: only an ordinal prefix is stripped, so two different claims
  // never collapse onto one key.
  assert.equal(normalizeStagedClaim('Step 7 — read a high rate.'), 'read a high rate.');
  assert.equal(normalizeStagedClaim('Step 12: read a high rate.'), 'read a high rate.');
  assert.equal(normalizeStagedClaim('read a high rate.'), 'read a high rate.');
  assert.notEqual(
    normalizeStagedClaim('Step 1 — name the constraint.'),
    normalizeStagedClaim('Step 1 — read a high rate.'),
    'distinct claims stay distinct after normalizing',
  );
  assert.equal(normalizeStagedClaim('Stepping back — a claim.'), 'stepping back — a claim.',
    'only a real ordinal is stripped, not any word beginning "step"');
}

console.log('✓ marketing-learner staged-tactic tests pass');

// ── re-gating tactics that were adopted before the stage field existed ──────
{
  const { buildRegatePrompt, regateAdopted, insertStageMarker, extractStagedTactics, STAGES } =
    await import('../../lib/marketing-learner.js');

  const items = [
    { skill: 'marketing-a', claim: 'Hire two agencies in sequence.', fit: '7/10 needs budget' },
    { skill: 'marketing-b', claim: 'Write a subject line with a number.', fit: '8/10 free' },
  ];
  const p = buildRegatePrompt({ items });
  assert.match(p, /\[0\] skill: marketing-a/, 'items are indexed for a positional merge');
  assert.match(p, /Do NOT re-score/, 'the pass is stage-only — scoring a parked tactic down double-counts the timing');
  assert.match(p, /never park behind\nthose/, 'the four open funnel gates are excluded');

  const reply = (obj) => ({
    messages: { stream: () => ({ finalMessage: async () => ({
      stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }],
    }) }) },
  });

  const out = await regateAdopted({
    items, retryOptions: { delayMs: 1 },
    client: reply({ decisions: [
      { index: 0, stage: 'team', reasoning: 'no agency budget and no one to brief them' },
      { index: 1, stage: null },
    ] }),
  });
  assert.equal(out.length, 1, 'only gated tactics come back');
  assert.equal(out[0].claim, items[0].claim, 'joined by index, not by text');
  assert.equal(out[0].stage, 'team');

  // The join is positional, so a response that drops or doubles an index is corrupt, not partial.
  for (const [label, decisions] of [
    ['a skipped index', [{ index: 0, stage: null }]],
    ['a doubled index', [{ index: 0, stage: null }, { index: 0, stage: null }, { index: 1, stage: null }]],
    ['an out-of-range index', [{ index: 0, stage: null }, { index: 9, stage: null }]],
  ]) {
    await assert.rejects(
      () => regateAdopted({ items, client: reply({ decisions }), retryOptions: { delayMs: 1 } }),
      /Re-gate/,
      `${label} is refused rather than silently mis-joined`,
    );
  }
  await assert.rejects(
    () => regateAdopted({ items, retryOptions: { delayMs: 1 },
      client: reply({ decisions: [{ index: 0, stage: 'team' }, { index: 1, stage: null }] }) }),
    /no reasoning/,
    'a gate with no justification is refused',
  );
  await assert.rejects(
    () => regateAdopted({ items, retryOptions: { delayMs: 1 },
      client: reply({ decisions: [{ index: 0, stage: 'someday', reasoning: 'x' }, { index: 1, stage: null }] }) }),
    /not one of/,
    'an invented gate is refused',
  );

  // insertStageMarker: surgery, not regeneration.
  const skill = ['---', 'name: marketing-a', 'description: d', '---', '', '# A', '',
    '## Hire two agencies in sequence.', '', '**Why it works:** body.', '', '*Source: X — "Y" (book)*', '',
    '## Another live one.', '', '**Why it works:** body.', '', '*Source: X — "Y" (book)*', ''].join('\n');
  const staged = insertStageMarker(skill, 'Hire two agencies in sequence.', 'team');
  assert.equal(extractStagedTactics(staged).length, 1, 'the tactic is now staged');
  assert.equal(extractStagedTactics(staged)[0].stage, 'team');
  assert.match(staged, /## Hire two agencies in sequence\.\n\n\*\*Stage:\*\* team/,
    'the marker sits directly under the heading, where extractStagedTactics reads it');
  assert.ok(staged.includes('## Another live one.'), 'other sections survive');
  assert.throws(() => insertStageMarker(staged, 'Hire two agencies in sequence.', 'scale'), /already carries a stage/);
  assert.throws(() => insertStageMarker(skill, 'No such claim.', 'team'), /no live tactic/);
  assert.throws(() => insertStageMarker(skill, 'Hire two agencies in sequence.', 'nonsense'), /must be one of/);
}

console.log('✓ marketing-learner re-gate tests pass');
