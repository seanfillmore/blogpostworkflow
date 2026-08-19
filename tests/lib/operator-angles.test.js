import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadOperatorAngles, applyOperatorOverlay, overlayPersonas, OVERLAY_RELPATH,
} from '../../lib/operator-angles.js';
import { allPersonaAngles } from '../../lib/ad-brief-plan.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PERSONAS = {
  cluster: 'skin',
  personas: [
    { id: 'p1', name: 'One', angles: [{ id: 'p1a1', label: 'keep me', awareness: 'problem-aware' }] },
    {
      id: 'p2',
      name: 'Two',
      angles: [
        { id: 'p2a1', label: 'keep me too', awareness: 'solution-aware' },
        { id: 'p2a2', label: '125 chemicals a day', awareness: 'unaware' },
      ],
    },
  ],
};

function withOverlay(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'operator-angles-'));
  try {
    mkdirSync(join(dir, 'data', 'context'), { recursive: true });
    if (contents !== null) {
      writeFileSync(join(dir, ...OVERLAY_RELPATH), typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── loading ─────────────────────────────────────────────────────────────────────────

// No overlay file is the ordinary case for every product and every checkout that has never
// retired anything. It must not throw and must not change behaviour.
test('a missing overlay file yields empty lists rather than throwing', () => {
  withOverlay(null, (root) => {
    assert.deepEqual(loadOperatorAngles({ root }), { retired: [], angles: [] });
  });
});

// A syntax error must NOT degrade to "no retirements". That would silently re-enable an
// angle somebody deliberately retired — the one failure this file exists to prevent.
test('a malformed overlay throws instead of silently disabling retirements', () => {
  withOverlay('{ not json', (root) => {
    assert.throws(() => loadOperatorAngles({ root }), /JSON/i);
  });
});

// ── retirement ──────────────────────────────────────────────────────────────────────

test('a retired angle is removed from its persona and from the flatten', () => {
  const out = applyOperatorOverlay(PERSONAS, { retired: [{ id: 'p2a2', why: 'wrong number' }] });
  assert.deepEqual(out.personas.find(p => p.id === 'p2').angles.map(a => a.id), ['p2a1']);
  assert.deepEqual(allPersonaAngles(out).map(pa => pa.angle.id), ['p1a1', 'p2a1']);
});

test('a bare string id retires just as an object does', () => {
  const out = applyOperatorOverlay(PERSONAS, { retired: ['p2a2'] });
  assert.deepEqual(out.personas.find(p => p.id === 'p2').angles.map(a => a.id), ['p2a1']);
});

// The input must not be mutated — the same loaded object is handed to several consumers.
test('the overlay returns a new object and leaves the input untouched', () => {
  const out = applyOperatorOverlay(PERSONAS, { retired: ['p2a2'] });
  assert.notEqual(out, PERSONAS);
  assert.equal(PERSONAS.personas.find(p => p.id === 'p2').angles.length, 2, 'input unchanged');
});

// An empty overlay must be a true no-op, so an installed-but-unused file cannot perturb
// anything — same discipline as the giveaway block contributing nothing when absent.
test('an empty overlay returns the input unchanged', () => {
  assert.equal(applyOperatorOverlay(PERSONAS, { retired: [], angles: [] }), PERSONAS);
  assert.equal(applyOperatorOverlay(PERSONAS, {}), PERSONAS);
  assert.equal(applyOperatorOverlay(PERSONAS, null), PERSONAS);
});

// ── authored angles ─────────────────────────────────────────────────────────────────

test('an authored angle joins its persona and is marked authored', () => {
  const out = applyOperatorOverlay(PERSONAS, {
    angles: [{ personaId: 'p2', id: 'p2a4', label: '112 ingredients, or one', awareness: 'unaware' }],
  });
  const p2 = out.personas.find(p => p.id === 'p2');
  assert.deepEqual(p2.angles.map(a => a.id), ['p2a1', 'p2a2', 'p2a4']);
  assert.equal(p2.angles.find(a => a.id === 'p2a4').authored, true);
  // ...and mined angles are NOT marked, so the two are always distinguishable downstream.
  assert.equal(p2.angles.find(a => a.id === 'p2a1').authored, undefined);
});

// Retire-then-replace in one pass is the actual use case: p2a2 out, p2a4 in.
test('retirement runs before addition, so an id can be retired and replaced together', () => {
  const out = applyOperatorOverlay(PERSONAS, {
    retired: ['p2a2'],
    angles: [{ personaId: 'p2', id: 'p2a4', label: 'replacement', awareness: 'unaware' }],
  });
  assert.deepEqual(out.personas.find(p => p.id === 'p2').angles.map(a => a.id), ['p2a1', 'p2a4']);
});

// THROWS rather than skipping. Skipping means an operator writes an angle, sees no error,
// and never learns it was dropped — while the run they are watching spends money briefing
// everything except the thing they just wrote. The monthly voice-of-customer run can
// renumber personas, so this is a live failure mode, not a hypothetical typo.
test('an authored angle naming an unknown persona throws and says why', () => {
  assert.throws(
    () => applyOperatorOverlay(PERSONAS, { angles: [{ personaId: 'p9', id: 'p9a1', label: 'x' }] }),
    /names persona "p9".*known: p1, p2.*re-point the angle/s,
  );
});

test('an authored angle with no personaId throws', () => {
  assert.throws(
    () => applyOperatorOverlay(PERSONAS, { angles: [{ id: 'px', label: 'x' }] }),
    /missing personaId/,
  );
});

// ── the shipped overlay ─────────────────────────────────────────────────────────────
//
// Asserted against the REAL files, because the whole point is that these two changes are
// live. p2a2 was retired for citing a superseded statistic behind a health-claim framing;
// p2a4 replaces it on the figure that is actually in the brand kit.

test('the shipped overlay retires p2a2 and replaces it with an unaware angle', () => {
  const { retired, angles } = loadOperatorAngles({ root: REPO_ROOT });
  assert.ok(retired.some(r => r.id === 'p2a2'), 'p2a2 must be retired');
  const p2a4 = angles.find(a => a.id === 'p2a4');
  assert.ok(p2a4, 'p2a4 must be authored');
  assert.equal(p2a4.awareness, 'unaware', 'it has to be unaware or fact-hook cannot render it');
  assert.equal(p2a4.personaId, 'p2');
});

// The figures in the authored angle must be quotable from the brand kit, or the claim gate
// rejects the copy and the replacement is no better than what it replaced. This asserts the
// contiguous-substring relationship the gate actually tests.
test('every figure in the authored angle is a verbatim substring of the brand kit', async () => {
  const brandKit = (await import('../../data/brand/brand-kit.json', { with: { type: 'json' } })).default;
  const source = JSON.stringify(brandKit);
  const { angles } = loadOperatorAngles({ root: REPO_ROOT });
  const p2a4 = angles.find(a => a.id === 'p2a4');
  for (const fragment of [
    '12 personal care products a day',
    'as many as 112 unique chemical ingredients',
  ]) {
    assert.ok(source.includes(fragment), `brand kit must contain "${fragment}"`);
    assert.ok(
      JSON.stringify(p2a4).includes(fragment),
      `the authored angle must quote "${fragment}" verbatim, or the claim gate will reject it`,
    );
  }
  // The retired angle's number must NOT come back.
  assert.ok(!/125\+/.test(JSON.stringify(p2a4)), 'the superseded 125+ figure must not reappear');
});

// The replacement exists because the original was a health claim. If the new one trips the
// same gate we have achieved nothing, so this asserts the actual gate, not a wordlist.
test('the authored angle survives the health-claim filter that the angle it replaces motivated', async () => {
  const { sanitizeAngle } = await import('../../lib/voice-of-customer.js');
  const { angles } = loadOperatorAngles({ root: REPO_ROOT });
  const p2a4 = angles.find(a => a.id === 'p2a4');
  const { angle, drops } = sanitizeAngle(p2a4);
  assert.ok(angle, 'the authored angle must not be withheld');
  assert.deepEqual(drops, [], 'and must lose no hook examples');
});

// End to end through the real files: the retired angle is gone and the replacement is
// present in the flatten every consumer reads.
test('overlayPersonas applied to the real personas file drops p2a2 and offers p2a4', async () => {
  const personas = (await import('../../data/context/personas.json', { with: { type: 'json' } })).default;
  const ids = allPersonaAngles(overlayPersonas(personas, { root: REPO_ROOT })).map(pa => pa.angle.id);
  assert.ok(!ids.includes('p2a2'), 'p2a2 must not be briefable');
  assert.ok(ids.includes('p2a4'), 'p2a4 must be briefable');
});
