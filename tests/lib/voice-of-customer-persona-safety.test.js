// tests/lib/voice-of-customer-persona-safety.test.js
//
// personas.json is COPY INPUT, not reference material. Four agents project persona and
// angle prose straight into an ad-copy prompt, and `personas[0].angles[0]` is the
// documented default angle for a creative run.
//
// The generated 2026-07-27 file put disease and drug language into every copy-facing field
// of the top-ranked persona — `p1a1`'s label named prescriptions, its objection_addressed
// named steroids, its proof named eczema, and the persona's own name was "The
// Eczema-Exhausted Parent". So the DEFAULT creative brief was seeded with exactly the
// language agents/ad-studio/health-claims.js exists to hard-fail, and the only thing
// standing between it and a shipped ad was a gate that fires AFTER a paid copy call.
//
// This file pins the withholding at the library level. The regression guard at the bottom
// pins the real committed file, so a future voice-of-customer run cannot quietly put it
// back.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadOperatorAngles } from '../../lib/operator-angles.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANGLE_COPY_FIELDS,
  PERSONA_COPY_FIELDS,
  findAngleHealthClaims,
  findPersonaFieldHealthClaims,
  sanitizeAngle,
  sanitizePersona,
  sanitizePersonas,
  formatPersonaDrops,
} from '../../lib/voice-of-customer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const cleanAngle = (over = {}) => ({
  id: 'a1',
  label: 'Ingredients you can actually read',
  awareness: 'problem-aware',
  objection_addressed: "'Clean lotions cost a fortune.'",
  proof: 'Buyers who spent $200 hunting an organic lotion say this one beat them all.',
  hook_examples: ['Ingredients you can read. Every one of them.'],
  source_quotes: ['I love that you can read the ingredients'],
  ...over,
});

const cleanPersona = (over = {}) => ({
  id: 'p1',
  name: 'The Ingredient-Label Reader',
  summary: 'Reads every label and rejects anything she cannot pronounce.',
  evidence_count: 20,
  emotional_intensity: 7,
  angles: [cleanAngle()],
  ...over,
});

// ── detection ────────────────────────────────────────────────────────────────

test('findAngleHealthClaims covers every copy-facing field and names where it found each', () => {
  const hits = findAngleHealthClaims({
    label: 'After prescriptions failed',
    objection_addressed: "'I tried steroids.'",
    proof: 'A reviewer with severe eczema.',
    hook_examples: ['fine', 'It healed my hands.'],
  });
  const fields = hits.map(h => h.field);
  assert.deepEqual(fields, ['label', 'objection_addressed', 'proof', 'hook_examples[1]']);
  assert.deepEqual(hits.map(h => h.category), ['drug', 'drug', 'disease', 'therapeutic']);
});

test('source_quotes is never screened — it is the evidence record, not copy', () => {
  // The whole point: the reviewer really did say "prescription strength lotions, steroids".
  // That has to survive verbatim for findUnsourcedQuotes to keep working and for a human to
  // see why the angle exists. No consumer feeds it to a writer.
  const angle = cleanAngle({
    source_quotes: ['I have tried prescription strength lotions, steroids, you name it, to no avail'],
  });
  assert.equal(findAngleHealthClaims(angle).length, 0);
  const { angle: kept } = sanitizeAngle(angle);
  assert.deepEqual(kept.source_quotes, angle.source_quotes);
  assert.ok(!ANGLE_COPY_FIELDS.includes('source_quotes'));
});

test('findPersonaFieldHealthClaims reads the persona name and summary', () => {
  const hits = findPersonaFieldHealthClaims({
    name: 'The Eczema-Exhausted Parent',
    summary: 'Has burned through prescription steroids.',
  });
  assert.deepEqual(hits.map(h => h.field), PERSONA_COPY_FIELDS);
});

// ── sanitizing an angle ──────────────────────────────────────────────────────

test('a clean angle passes through as the identical object', () => {
  const angle = cleanAngle();
  const res = sanitizeAngle(angle);
  assert.equal(res.angle, angle, 'no copy when nothing was removed');
  assert.deepEqual(res.drops, []);
});

test('one violating hook is removed and the angle survives — the others still direct the writer', () => {
  const angle = cleanAngle({
    hook_examples: ['Ingredients you can read.', 'It healed my cracked hands.', 'Simple and affordable.'],
  });
  const res = sanitizeAngle(angle);
  assert.deepEqual(res.angle.hook_examples, ['Ingredients you can read.', 'Simple and affordable.']);
  assert.equal(res.drops.length, 1);
  assert.equal(res.drops[0].action, 'dropped-hook');
  assert.equal(res.drops[0].field, 'hook_examples[1]');
  assert.equal(res.angle.label, angle.label, 'nothing else is touched');
});

test('a violating scalar field kills the whole angle — this module never rewrites research', () => {
  for (const field of ANGLE_COPY_FIELDS) {
    const res = sanitizeAngle(cleanAngle({ [field]: 'Clears up eczema in a week.' }));
    assert.equal(res.angle, null, `${field} must make the angle unusable`);
    assert.equal(res.drops[0].action, 'dropped-angle');
    assert.equal(res.drops[0].field, field);
    assert.equal(res.drops[0].angleId, 'a1');
  }
});

// ── sanitizing a persona ─────────────────────────────────────────────────────

test('a persona whose NAME carries a claim is dropped whole, however clean its angles', () => {
  const res = sanitizePersona(cleanPersona({ name: 'The Eczema-Exhausted Parent' }));
  assert.equal(res.persona, null);
  assert.equal(res.drops[0].action, 'dropped-persona');
  assert.equal(res.drops[0].field, 'name');
});

test('a persona whose SUMMARY carries a claim is dropped whole', () => {
  const res = sanitizePersona(cleanPersona({ summary: 'Burned through prescription steroids.' }));
  assert.equal(res.persona, null);
  assert.equal(res.drops[0].field, 'summary');
});

test('a persona that loses every angle is dropped, and the drop says why', () => {
  const res = sanitizePersona(cleanPersona({
    angles: [cleanAngle({ id: 'a1', proof: 'treats eczema' }), cleanAngle({ id: 'a2', label: 'Cures dry skin' })],
  }));
  assert.equal(res.persona, null);
  const last = res.drops[res.drops.length - 1];
  assert.equal(last.action, 'dropped-persona');
  assert.match(last.why, /nothing briefable/);
  // One drop per HIT, so "treats eczema" contributes two (therapeutic + disease) for a1.
  assert.deepEqual(
    [...new Set(res.drops.filter(d => d.action === 'dropped-angle').map(d => d.angleId))],
    ['a1', 'a2']
  );
});

test('a persona keeps its clean angles when only some are unusable', () => {
  const res = sanitizePersona(cleanPersona({
    angles: [cleanAngle({ id: 'a1', proof: 'treats eczema' }), cleanAngle({ id: 'a2' })],
  }));
  assert.deepEqual(res.persona.angles.map(a => a.id), ['a2']);
});

test('a persona that arrived with no angles is passed through, not swallowed', () => {
  // Different defect, handled with its own message in creative-packager's loadPersonas.
  // Reporting it here as a health-claim drop would name the wrong cause.
  const persona = cleanPersona({ angles: [] });
  const res = sanitizePersona(persona);
  assert.equal(res.persona, persona);
  assert.deepEqual(res.drops, []);
});

// ── sanitizing a list ────────────────────────────────────────────────────────

test('sanitizePersonas preserves order, so the surviving first entry is the new default', () => {
  const bad = cleanPersona({ id: 'p1', name: 'The Eczema-Exhausted Parent' });
  const ok1 = cleanPersona({ id: 'p2' });
  const ok2 = cleanPersona({ id: 'p3' });
  const res = sanitizePersonas([bad, ok1, ok2]);
  assert.deepEqual(res.personas.map(p => p.id), ['p2', 'p3'], 'order is the contract — never reordered');
  assert.equal(res.drops.length, 1);
  assert.equal(res.drops[0].personaId, 'p1');
});

test('sanitizePersonas degrades to an empty list rather than throwing on junk', () => {
  for (const input of [null, undefined, [], [null], [{}]]) {
    assert.doesNotThrow(() => sanitizePersonas(input));
  }
  assert.deepEqual(sanitizePersonas(null).personas, []);
});

test('formatPersonaDrops names the persona, the angle, the field and the reason', () => {
  const { drops } = sanitizePersonas([cleanPersona({ angles: [cleanAngle({ id: 'p1a1', proof: 'treats eczema' })] })]);
  const text = formatPersonaDrops(drops);
  assert.match(text, /p1\.p1a1\.proof/);
  assert.match(text, /eczema/);
  assert.match(text, /unapproved drug/, 'the WHY from health-claims.js must survive to the operator');
});

// ── REGRESSION GUARD over the real committed file ────────────────────────────
//
// personas.json is regenerated monthly by an LLM reading a corpus full of the words
// "eczema", "psoriasis" and "steroids". The generator now refuses to write them and every
// consumer refuses to read them, but neither is visible in a diff. This is: it fails on the
// actual file in the repo the moment a health claim reappears in any copy-facing field.
//
// It deliberately does NOT go through sanitizePersonas — that would pass by construction,
// since sanitizing removes the offender. It reads the raw file and asserts nothing was
// found, so a regression shows up as a red test naming the exact angle and word.
test('the committed data/context/personas.json carries no health claim in any copy-facing field', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'context', 'personas.json'), 'utf8'));
  const found = [];
  // RETIRED angles are skipped, and only retired ones. This test stays deliberately raw —
  // going through sanitizePersonas would pass by construction — but an angle the operator
  // has explicitly retired is one we have already decided never to brief, so holding the
  // committed file to account for it would make this permanently red for a decision that was
  // correct. p2a2 is the live case: retired 2026-08-18 precisely BECAUSE of the language the
  // systemic-absorption and toxicity categories now catch. Everything still live is scanned.
  const retiredIds = new Set(loadOperatorAngles({ root: ROOT }).retired.map(r => r.id || r));

  for (const persona of raw.personas || []) {
    for (const hit of findPersonaFieldHealthClaims(persona)) {
      found.push(`${persona.id}.${hit.field}: "${hit.match}" (${hit.category}) — ${hit.why}`);
    }
    for (const angle of (persona.angles || []).filter(a => !retiredIds.has(a?.id))) {
      for (const hit of findAngleHealthClaims(angle)) {
        found.push(`${persona.id}.${angle.id}.${hit.field}: "${hit.match}" (${hit.category}) — ${hit.why}`);
      }
    }
  }

  assert.deepEqual(found, [],
    'A cosmetic may not name a disease or a drug, or claim to treat/heal/cure/prevent. These ' +
    'fields are pasted into ad-copy prompts, so re-word them (keep the insight, drop the ' +
    'condition name) — source_quotes stays verbatim and is not checked:\n' + found.join('\n'));
});

// The default angle is the one that matters most: it is what a creative run uses when
// nobody names a persona or an angle. Pinned separately so a failure says "the DEFAULT is
// unusable" rather than being one line in a list.
test('the default angle — personas[0].angles[0] — survives sanitizing and stays first', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'context', 'personas.json'), 'utf8'));
  const { personas } = sanitizePersonas(raw.personas);
  assert.equal(personas[0].id, raw.personas[0].id, 'the top-ranked persona must not be withheld');
  assert.equal(personas[0].angles[0].id, raw.personas[0].angles[0].id, 'nor its first angle');
  assert.deepEqual(findAngleHealthClaims(personas[0].angles[0]), []);
});
