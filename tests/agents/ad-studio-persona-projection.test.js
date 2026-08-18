// tests/agents/ad-studio-persona-projection.test.js
//
// main() projects personas.json into the { name, angles: [flat strings] } shape
// copy.js's buildCopyPrompt renders as "WHAT THEY ALREADY TRIED". It used to take
// `personas[0]` blindly and map every angle to `objection_addressed || label`.
//
// The live 2026-07-27 personas.json made that a self-inflicted wound: persona p1 —
// top-ranked, so `personas[0]`, so the default — had `p1a1.objection_addressed` naming
// steroids and `p1a2.objection_addressed` naming eczema. This agent's OWN health-claims
// gate then hard-failed the copy those strings produced, after the copy call was paid for.
//
// projectPersonaForCopy is that projection, extracted and pure so the withholding is
// testable without running main() (which loads .env, hits Gemini and Anthropic, and writes
// to data/creatives/).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPersonaForCopy } from '../../agents/ad-studio/index.js';
import { findHealthClaims } from '../../agents/ad-studio/health-claims.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const angle = (id, objection) => ({
  id, label: id, awareness: 'problem-aware', objection_addressed: objection,
  proof: 'Reviewers say it lasts all day', hook_examples: [], source_quotes: ['q'],
});

test('a clean top persona projects exactly as before', () => {
  const { persona, drops } = projectPersonaForCopy({
    personas: [{ id: 'p1', name: 'The tried-everything buyer', summary: 'Nothing worked.',
      angles: [angle('p1a1', 'Why would this be different?'), angle('p1a2', 'Is natural strong enough?')] }],
  });
  assert.equal(persona.name, 'The tried-everything buyer');
  assert.deepEqual(persona.angles, ['Why would this be different?', 'Is natural strong enough?']);
  assert.deepEqual(drops, []);
});

test('an angle whose projected string carries a health claim never reaches the prompt', () => {
  const { persona, drops } = projectPersonaForCopy({
    personas: [{ id: 'p1', name: 'The tried-everything buyer', summary: 'Nothing worked.',
      angles: [
        angle('p1a1', "'I already tried steroids — why would a coconut lotion work?'"),
        angle('p1a2', 'Is natural strong enough?'),
      ] }],
  });
  assert.deepEqual(persona.angles, ['Is natural strong enough?']);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].angleId, 'p1a1');
  assert.equal(drops[0].category, 'drug');
});

test('a withheld top persona falls through to the next, it does not empty the brief', () => {
  const { persona } = projectPersonaForCopy({
    personas: [
      { id: 'p1', name: 'The eczema-exhausted parent', summary: 'x', angles: [angle('p1a1', 'ok')] },
      { id: 'p2', name: 'The ingredient reader', summary: 'Reads every label.', angles: [angle('p2a1', 'What is in it?')] },
    ],
  });
  assert.equal(persona.name, 'The ingredient reader');
});

test('every persona withheld degrades to null — the same path as no personas.json at all', () => {
  const { persona, drops } = projectPersonaForCopy({
    personas: [{ id: 'p1', name: 'The eczema-exhausted parent', summary: 'x', angles: [angle('p1a1', 'ok')] }],
  });
  assert.equal(persona, null);
  assert.ok(drops.length);
});

test('missing, empty and malformed persona data degrade to null rather than throwing', () => {
  for (const input of [null, undefined, {}, { personas: null }, { personas: [] }, { personas: [{}] }]) {
    let out;
    assert.doesNotThrow(() => { out = projectPersonaForCopy(input); });
    assert.equal(out.persona, null);
  }
});

// The end-to-end claim, on the real file: whatever main() would project today, no string in
// it can fail the gate that runs a few hundred lines later.
test('the real personas.json projects to strings that all pass the health-claims gate', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'context', 'personas.json'), 'utf8'));
  const { persona, drops } = projectPersonaForCopy(raw);
  assert.deepEqual(drops, [], 'nothing should need withholding from the committed file');
  assert.ok(persona.angles.length, 'and the default persona must still have angles to brief');
  for (const s of [persona.name, ...persona.angles]) {
    assert.deepEqual(findHealthClaims(s), [], `"${s}" would fail assertNoHealthClaims`);
  }
});
