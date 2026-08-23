// tests/lib/demand-questions-persona-integration.test.js
//
// Sibling of tests/lib/demand-questions-leaks-integration.test.js, covering the
// OTHER seed origin that file's own docstring says it does not: persona_objection.
//
// The real chain (see agents/demand-miner/index.js's runDemandMiner and
// lib/operator-angles.js's own header, which lists demand-miner as the fifth of
// five personas.json readers):
//   agents/voice-of-customer/index.js's Claude tool_use call (module A — the
//     shape's real origin) requires exactly { id, label, awareness,
//     objection_addressed, proof, hook_examples, source_quotes } on every angle
//     (see that file's `required: [...]` schema, ~line 209)
//     -> written to data/context/personas.json
//     -> overlayPersonas (lib/operator-angles.js, module B) applied at load
//     -> sanitizePersonas (lib/voice-of-customer.js, module C) strips health-claim
//        violations, preserving order
//     -> deriveSeeds (lib/demand-questions.js, module D) destructures
//        `p.angles[].objection_addressed` by name to build persona_objection seeds
//
// No existing test ran a persona shaped with the REAL schema's full field set
// through this whole seam. tests/lib/demand-questions.test.js's own persona
// fixtures only ever set `{ id, angles: [{ objection_addressed }] }` — enough to
// exercise deriveSeeds in isolation, but that under-specification is exactly the
// gap this file closes: a persona object here carries every field the real
// schema requires, plus the overlay and sanitize stages actually run.
//
// This does NOT import agents/voice-of-customer/index.js (unguarded past its own
// `main()` gate check would still make a paid Claude API call) or
// agents/demand-miner/index.js (also runs on import). Both are pure-lib imports.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { overlayPersonas } from '../../lib/operator-angles.js';
import { sanitizePersonas } from '../../lib/voice-of-customer.js';
import { deriveSeeds } from '../../lib/demand-questions.js';

// One angle per required field in agents/voice-of-customer/index.js's real
// tool_use schema (`required: ['id', 'label', 'awareness', 'objection_addressed',
// 'proof', 'hook_examples', 'source_quotes']`). Nothing here is invented shorthand.
function realAngle(id, objection) {
  return {
    id,
    label: id,
    awareness: 'problem-aware',
    objection_addressed: objection,
    proof: 'Reviewers with sensitive skin report no irritation after switching.',
    hook_examples: ['Still breaking out from your deodorant?'],
    source_quotes: ['q1'],
  };
}

test('a real-schema persona angle survives overlayPersonas -> sanitizePersonas -> deriveSeeds with its actual objection text', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'persona-integration-'));
  try {
    const personasData = {
      personas: [
        {
          id: 'p1',
          name: 'The tried-everything buyer',
          summary: 'Sensitive skin, nothing has worked yet.',
          evidence_count: 12,
          emotional_intensity: 8,
          angles: [
            realAngle('p1a1', 'will a natural deodorant actually control odor all day'),
            realAngle('p1a2', 'is this gentle enough for skin that reacts to everything'),
          ],
        },
      ],
    };

    // No data/context/operator-angles.json in this empty temp root, so
    // overlayPersonas is a real no-op pass-through — proves the chain order
    // (overlay before sanitize, per lib/operator-angles.js's own contract)
    // without coupling this test to the live repo's current overlay content.
    const overlaid = overlayPersonas(personasData, { root: tmp });
    const { personas: sanitized } = sanitizePersonas(overlaid.personas);

    assert.equal(sanitized.length, 1, 'a clean persona with no health-claim violations must survive sanitizePersonas');
    assert.equal(sanitized[0].angles.length, 2, 'both clean angles must survive sanitizePersonas');

    const { seeds, partial } = deriveSeeds({ leaks: [], personas: sanitized });

    const personaSeeds = seeds.filter((s) => s.origin === 'persona_objection');
    assert.equal(personaSeeds.length, 2, `expected both angle objections to survive as seeds, got ${JSON.stringify(seeds)}`);
    assert.deepEqual(
      personaSeeds.map((s) => s.text).sort(),
      [
        'is this gentle enough for skin that reacts to everything',
        'will a natural deodorant actually control odor all day',
      ],
    );
    assert.ok(personaSeeds.every((s) => s.personaId === 'p1'));
    // No leaks were supplied, so the run is partial — but the persona half must not be.
    assert.equal(partial, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a health-claim angle is dropped by sanitizePersonas before it ever reaches deriveSeeds', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'persona-integration-'));
  try {
    const personasData = {
      personas: [
        {
          id: 'p2',
          name: 'The tried-everything-else buyer',
          summary: 'Nothing worked until they switched.',
          evidence_count: 5,
          emotional_intensity: 7,
          angles: [
            // health-claims.js rejects a prescription/steroid reference outright —
            // this is the exact shape of the 2026-07-27 incident CLAUDE.md documents.
            realAngle('p2a1', 'tried prescription strength treatments and steroids to no avail'),
            realAngle('p2a2', 'worried about aluminum in regular deodorant'),
          ],
        },
      ],
    };

    const overlaid = overlayPersonas(personasData, { root: tmp });
    const { personas: sanitized, drops } = sanitizePersonas(overlaid.personas);

    assert.ok(drops.some((d) => d.angleId === 'p2a1'), 'the prescription/steroid angle must be dropped, not silently kept');
    assert.equal(sanitized[0].angles.length, 1);
    assert.equal(sanitized[0].angles[0].id, 'p2a2');

    const { seeds } = deriveSeeds({ leaks: [], personas: sanitized });
    const texts = seeds.map((s) => s.text);
    assert.ok(!texts.some((t) => /prescription|steroid/i.test(t)), 'a health-claim objection must never reach a demand-question seed');
    assert.deepEqual(texts, ['worried about aluminum in regular deodorant']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
