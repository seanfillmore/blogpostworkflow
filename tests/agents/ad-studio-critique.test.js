import { strict as assert } from 'node:assert';
import {
  SAFE_ZONE_RATIOS,
  buildCritiquePrompt,
  parseCritiqueResponse,
  normalizeZoneVerdict,
  critiqueVerdict,
} from '../../agents/ad-studio/critique.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

// ── Why this file exists ────────────────────────────────────────────────────────────
// The verify gate answers "is every fact on this frame correct?" — text, volume, product
// fidelity, image/label pairing. It has never answered "is this frame USABLE?". A frame
// can be correct in every fact and still be unrunnable: a headline sitting under
// Instagram's own UI chrome, or body copy set in a tone the background swallows at thumb
// size. Those are objective and they belong in the gate.
//
// It is a SEPARATE call from verify.js on purpose. buildVerifyPrompt's central
// instruction is "You are NOT reading for meaning. Do not repair, complete, normalize or
// auto-correct anything" — a literal pixel read. Asking that same call for a holistic
// art-direction judgement contradicts its own framing, and that prompt took five fix
// rounds to stabilise. Do not merge them.

const format = formatByKey('ingredient-callout');
const ok3 = { safeZone: 'OK', legibility: 'OK', score: 4, reasons: ['clean'] };

// ── Scope: FINISHED frames only ─────────────────────────────────────────────────────
// Both hard checks are about the ad's TYPESET COPY. A Demand Gen plate is text-free by
// construction, so it has no copy to place badly or set illegibly; asking would be the
// plate-pairing mistake again (a question with no correct answer, failing every plate).
assert.equal(critiqueVerdict({ ...ok3, mode: 'plate' }).ok, true);
assert.equal(critiqueVerdict({ safeZone: 'VIOLATION', legibility: 'VIOLATION', mode: 'plate' }).ok, true,
  'a plate carries no typeset copy — neither hard check may fail it');
assert.equal(critiqueVerdict({ ...ok3, mode: 'plate' }).status, 'not-applicable');

// ── normalizeZoneVerdict — the fidelity tolerance, again ────────────────────────────
// Three-valued, CANNOT_TELL passes, anything unrecognised is read as CANNOT_TELL rather
// than as a defect. Erring the other way rejects good frames at $0.13 a retry.
assert.equal(normalizeZoneVerdict('OK'), 'ok');
assert.equal(normalizeZoneVerdict('clear'), 'ok');
assert.equal(normalizeZoneVerdict('VIOLATION'), 'violation');
assert.equal(normalizeZoneVerdict('violates'), 'violation');
assert.equal(normalizeZoneVerdict('CANNOT_TELL'), 'cannot-tell');
assert.equal(normalizeZoneVerdict('banana'), 'cannot-tell');
assert.equal(normalizeZoneVerdict(undefined), 'cannot-tell');

// ── PART A: safe zone — 9:16 ONLY ───────────────────────────────────────────────────
// Meta unified Stories/Reels onto one 9:16 safe zone in March 2026: top 14%, bottom 20%
// (Stories) to 35% (Reels), sides 6%. Only 9:16 is gated, because only there does the
// platform draw its own UI over the creative. On 1:1 and 4:5 the same copy placement is
// a margin preference, not a defect — and gating a preference burns three paid renders.
assert.ok(SAFE_ZONE_RATIOS['9:16'], '9:16 must be gated');
assert.ok(!SAFE_ZONE_RATIOS['1:1'], '1:1 must not be gated — no platform UI covers it');
assert.ok(!SAFE_ZONE_RATIOS['4:5'], '4:5 must not be gated');

const vertical = { mode: 'finished', ratio: '9:16' };
assert.equal(critiqueVerdict({ ...ok3, ...vertical }).ok, true);

const buried = critiqueVerdict({ ...vertical, safeZone: 'VIOLATION', legibility: 'OK', score: 4,
  safeZoneDetail: 'the closing line sits in the bottom fifth, under the Reels action rail' });
assert.equal(buried.ok, false, 'copy under the platform UI must fail a 9:16 frame');
assert.ok(buried.reasons.some(r => /safe zone/i.test(r)));
assert.ok(buried.reasons.some(r => /action rail/.test(r)), 'the reason must carry the detail');

// The SAME answer on a square frame is not a failure — nothing covers a feed image.
assert.equal(
  critiqueVerdict({ mode: 'finished', ratio: '1:1', safeZone: 'VIOLATION', legibility: 'OK', score: 4 }).ok,
  true,
  'a safe-zone answer must not fail a ratio the platform does not overlay',
);

// CANNOT_TELL passes, exactly like fidelity's small-product case.
assert.equal(critiqueVerdict({ ...vertical, safeZone: 'CANNOT_TELL', legibility: 'OK', score: 3 }).ok, true);

// ── PART A: legibility — every finished ratio ───────────────────────────────────────
// Contrast is a property of the frame, not the placement, so this one is not ratio-gated.
const washed = critiqueVerdict({ mode: 'finished', ratio: '1:1', safeZone: 'OK', legibility: 'VIOLATION',
  score: 3, legibilityDetail: 'cream body copy on a cream background, unreadable at thumb size' });
assert.equal(washed.ok, false, 'copy that cannot be read at thumb size must fail');
assert.ok(washed.reasons.some(r => /legib|contrast/i.test(r)));
assert.ok(washed.reasons.some(r => /thumb size/.test(r)));

// ── PART B: the quality score NEVER blocks ──────────────────────────────────────────
// This is the whole reason the design is split in two. "Is this a good ad?" is a
// judgement; making it a hard fail would reject good work and pay for three attempts
// doing it — the false-positive class that cost two rounds on the fidelity check.
const ugly = critiqueVerdict({ mode: 'finished', ratio: '1:1', safeZone: 'OK', legibility: 'OK',
  score: 1, reasons: ['generic headline', 'no focal hierarchy'] });
assert.equal(ugly.ok, true, 'a low quality score must NEVER fail a render');
assert.equal(ugly.score, 1, 'but it must be recorded');
assert.deepEqual(ugly.reasons.filter(r => /generic headline/.test(r)).length, 0,
  'quality notes are not failure reasons');
assert.ok(ugly.notes.includes('generic headline'), 'quality notes live in notes, not reasons');

// A missing or nonsense score is recorded as null, never as 0 — 0 would sort below a
// genuinely bad frame when the UI ranks accepted frames by score.
assert.equal(critiqueVerdict({ mode: 'finished', ratio: '1:1', safeZone: 'OK', legibility: 'OK' }).score, null);
assert.equal(critiqueVerdict({ mode: 'finished', ratio: '1:1', safeZone: 'OK', legibility: 'OK', score: 'x' }).score, null);
assert.equal(critiqueVerdict({ mode: 'finished', ratio: '1:1', safeZone: 'OK', legibility: 'OK', score: 9 }).score, null,
  'a score outside 1-5 is not a score');

// ── A check that answers nothing is a check that did not run ────────────────────────
// The pairing check's precedent, and fidelity's: silence fails rather than passes,
// because a silent all-clear is indistinguishable from a stage that was never wired up.
const silent = critiqueVerdict({ mode: 'finished', ratio: '9:16' });
assert.equal(silent.ok, false);
assert.equal(silent.status, 'unreported');

// ── buildCritiquePrompt ─────────────────────────────────────────────────────────────
const pv = buildCritiquePrompt({ ratio: '9:16', format, zones: { headline: 'SIX INGREDIENTS.' } });
// It must NOT inherit verify.js's literal-pixel framing — this call is the opposite job.
assert.ok(/art director/i.test(pv), 'the critique call is framed as art direction, not proofreading');
assert.ok(!/glyph by glyph/i.test(pv), 'the literal-read framing must not leak into the critique call');
// The safe zone is described in FRACTIONS, not percentages. Vision models estimate
// "the top seventh" far more reliably than "the top 14%", and the whole check rests on
// that estimate being trustworthy.
assert.ok(/top (one-)?seventh|top seventh/i.test(pv), 'safe zone must be stated as an eyeball-able fraction');
assert.ok(/bottom (one-)?fifth|bottom fifth/i.test(pv));
assert.ok(/CANNOT_TELL/.test(pv), 'the cannot-tell escape must be offered');
assert.ok(/1 to 5|one to five/i.test(pv), 'the quality score scale must be stated');

// A square frame is never asked the safe-zone question at all — an unanswerable question
// invites an invented answer.
const ps = buildCritiquePrompt({ ratio: '1:1', format, zones: {} });
assert.ok(!/seventh/i.test(ps), 'no safe-zone section on a ratio the platform does not overlay');
assert.ok(/legib|contrast/i.test(ps), 'but legibility is asked on every finished ratio');

// ── parseCritiqueResponse ───────────────────────────────────────────────────────────
const rawc = '```json\n' + JSON.stringify({
  safeZone: 'OK', safeZoneDetail: '', legibility: 'OK', legibilityDetail: '',
  score: 4, reasons: ['strong headline'],
}) + '\n```';
const pc = parseCritiqueResponse(rawc);
assert.equal(pc.safeZone, 'OK');
assert.equal(pc.score, 4);
assert.deepEqual(pc.reasons, ['strong headline']);
assert.throws(() => parseCritiqueResponse('junk'), /ad-studio.*critique/i);
