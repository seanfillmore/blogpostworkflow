// lib/ad-brief.js
//
// Where ad briefs live between being generated and being rendered.
//
// A brief carries the FINISHED, gate-passed copy — approving one renders those exact
// strings with no second LLM call, so nothing can drift between what the operator read
// and what gets baked into a plate. That is the whole compliance argument for letting a
// human steer ad copy at all, and it is why `state` is a closed vocabulary rather than a
// free string: only `approved` renders.
//
// Same atomic-write discipline as lib/ad-studio-job.js — the dashboard reads these files
// while the agent writes them, and a partial read would show half a brief.

import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
// FORMATS is read for ONE purpose: the zone-shape check inside chooseFormat (see its
// docstring). formats.js is a pure data table with no I/O and no imports of its own, so
// this does not pull the storage layer into the render pipeline; and the check has to
// happen here, at the single write point, because that is the only place every caller of
// the format override passes through.
import { FORMATS } from '../agents/ad-studio/formats.js';

export const BRIEF_STATES = ['needs-evidence', 'ready', 'approved', 'rejected', 'rendered'];

const SAFE_SEGMENT = /^[\w.-]+$/;

/**
 * Strict: `1` and `'true'` do not count.
 *
 * Used by writeBrief — the single write point, and the one check no caller can bypass.
 * decideBrief deliberately re-implements the same rule INLINE rather than calling this,
 * because its job is to name WHICH gate failed before any work is done; this one only has
 * to answer yes/no at the moment of writing. Two checks, same rule, different errors — see
 * decideBrief's docstring for why both earn their place. (The comment here used to claim
 * this constant was shared between them, which it never was.)
 */
const gatesPass = (gates) => gates?.health?.ok === true && gates?.claims?.ok === true;

const checkSegment = (value, label) => {
  const s = String(value || '');
  if (!s || s === '.' || s === '..' || !SAFE_SEGMENT.test(s)) {
    throw new Error(`ad-brief: invalid ${label} "${value}"`);
  }
  // A LEADING DASH IS REFUSED SEPARATELY FROM THE CHARACTER SET, because the hazard is not
  // the filesystem — `-` is a perfectly ordinary filename character — it is argv. Every
  // one of these segments is spawned as a CLI value (`--angles <v>`, `--brief <v>`,
  // `--product <v>`), so a value of `--job-id` shifts the whole argument list by one: the
  // agent read `--job-id` as its OWN job id, claimed a job file literally named
  // `--job-id.json`, and left the route's real job at 'pending'. After the 60s pending
  // grace a second click then launched a second PAID batch. No legitimate handle, brief id,
  // angle id or format key has ever started with a dash. (Code review, 2026-08-17.)
  if (s.startsWith('-')) {
    throw new Error(`ad-brief: invalid ${label} "${value}" — must not start with "-" (it would be read as a CLI flag)`);
  }
  return s;
};

export function isValidBriefId(id) {
  try { checkSegment(id, 'briefId'); return true; } catch { return false; }
}

export function briefsDir(root, product) {
  return join(root, 'data', 'briefs', 'ad-studio', checkSegment(product, 'product'));
}

export function briefPath(root, product, briefId) {
  return join(briefsDir(root, product), `${checkSegment(briefId, 'briefId')}.json`);
}

/**
 * The single write point, so this is the single place the "approved" invariant can be
 * enforced without exception. decideBrief also checks gates before it gets here — for a
 * better, gate-naming error, and to fail before doing any work — but that is belt AND
 * braces, not either/or: writeBrief is a side door onto the same file, and in a later task
 * its inputs originate from an HTTP handler. No exemption flag; "an approved record must
 * carry passing gates" has to be true for every caller, with no internal bypass to pick.
 */
export function writeBrief(root, brief) {
  if (!brief?.briefId) throw new Error('ad-brief: writeBrief requires a briefId');
  if (!brief?.product) throw new Error('ad-brief: writeBrief requires a product');
  if (brief.state !== undefined && !BRIEF_STATES.includes(brief.state)) {
    throw new Error(`ad-brief: unknown state "${brief.state}" — one of: ${BRIEF_STATES.join(', ')}`);
  }
  if (brief.state === 'approved' && !gatesPass(brief.gates)) {
    throw new Error(
      `ad-brief: "${brief.briefId}" cannot be written as approved without both gates passing ` +
      `(gates.health.ok === true && gates.claims.ok === true)`
    );
  }
  const dir = briefsDir(root, brief.product);
  mkdirSync(dir, { recursive: true });
  const record = { createdAt: new Date().toISOString(), ...brief };
  const final = briefPath(root, brief.product, brief.briefId);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, final);
  return record;
}

/** null for missing OR corrupt — a reader must never crash on either. */
export function readBrief(root, product, briefId) {
  try { return JSON.parse(readFileSync(briefPath(root, product, briefId), 'utf8')); } catch { return null; }
}

/** Highest score first; unscored briefs sort last rather than poisoning the comparison. */
export function listBriefs(root, product) {
  let dir;
  try { dir = briefsDir(root, product); } catch { return []; }
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const b = readBrief(root, product, f.replace(/\.json$/, ''));
    if (b) out.push(b);
  }
  return out.sort((a, b) => {
    const sa = Number(a.score?.total);
    const sb = Number(b.score?.total);
    const na = Number.isFinite(sa) ? sa : -1;
    const nb = Number.isFinite(sb) ? sb : -1;
    if (nb !== na) return nb - na;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/**
 * Approval depends on IMMUTABLE EVIDENCE, not on the mutable `state` field. `gates` is
 * written once, when the copy is generated, and no decision ever edits it — so no sequence
 * of state transitions (however many hops) can launder a brief into approvability. Checking
 * `state === 'needs-evidence'` here instead would be a single-hop guard: a caller could walk
 * needs-evidence -> ready -> approved, since neither hop alone trips a same-state check. The
 * gates block is the one thing a decision cannot rewrite, so it's the one thing worth gating
 * on. A brief with no `gates` block at all is correctly unapprovable too — an angle with no
 * renderable format has no copy and nothing to gate.
 *
 * This check is NOT redundant with the one inside writeBrief: this one names which gate
 * failed (or that there was no gate record at all) and fails before any work is done. The
 * writeBrief check is the one that can't be bypassed by a different caller; this one is the
 * one that gives a human a useful error. Belt and braces, both earning their place.
 */
export function decideBrief(root, product, briefId, { state, note } = {}) {
  if (!BRIEF_STATES.includes(state)) {
    throw new Error(`ad-brief: unknown state "${state}" — one of: ${BRIEF_STATES.join(', ')}`);
  }
  const current = readBrief(root, product, briefId);
  if (!current) throw new Error(`ad-brief: no such brief "${briefId}"`);
  if (state === 'approved') {
    const gates = current.gates;
    if (!gates) {
      throw new Error(`ad-brief: "${briefId}" has no gate record and cannot be approved`);
    }
    if (gates.health?.ok !== true) {
      throw new Error(`ad-brief: "${briefId}" failed the health gate and cannot be approved`);
    }
    if (gates.claims?.ok !== true) {
      throw new Error(`ad-brief: "${briefId}" failed the claims gate and cannot be approved`);
    }
  }
  const next = { ...current, state, decidedAt: new Date().toISOString() };
  if (note !== undefined) next.note = note;
  return writeBrief(root, next);
}

/** The zone key set a format's copy is written against, as a stable, comparable string. */
const zoneShape = (format) => [...(format?.zones || [])].slice().sort().join('|');

/**
 * Which of a brief's offered formats can actually RENDER the copy it already has.
 *
 * A brief's `zones` object was written by buildConcept for ONE format's zone list, and
 * formats declare different ones. So an offered "alternative" is only genuinely selectable
 * if its zone key set is identical to that of the format the copy was authored for
 * (`format.proposed` — never `format.chosen`, which is the override itself and would let
 * the allowed set drift one hop at a time).
 *
 * Always includes `proposed` itself, which is trivially compatible. Returns `[]` for a
 * brief with no proposed format: there is no copy and nothing to be compatible with.
 *
 * Exported so the Briefs view can offer exactly this list rather than a dropdown whose
 * options the server will refuse. **As of 2026-08-17 this returns a single entry for every
 * angle in the catalogue** — no two formats sharing an awareness level share a zone shape,
 * so no angle has a selectable alternative today. That is the correct outcome, not a bug to
 * widen the rule around: see the README's "The format override, and why the dropdown is
 * usually empty".
 */
export function selectableFormats(brief, formats = FORMATS) {
  const proposed = brief?.format?.proposed ?? null;
  if (!proposed) return [];
  const byKey = new Map(formats.map(f => [f.key, f]));
  const wanted = zoneShape(byKey.get(proposed));
  const offered = [proposed, ...(brief.format?.alternatives || [])];
  return offered.filter(k => byKey.has(k) && zoneShape(byKey.get(k)) === wanted);
}

/**
 * The operator's format override. `resolveBriefFormatKey` (agents/ad-studio/index.js)
 * reads `format.chosen ?? format.proposed` at render time, so this is the only function
 * in the whole feature that ever writes `format.chosen` — before this, the Briefs view's
 * dropdown changed nothing on disk.
 *
 * The key is validated against THIS BRIEF'S OWN `format.proposed` + `format.alternatives`
 * — never against the global FORMATS table. Those two fields are exactly the formats
 * `formatsForAngle()` (lib/ad-brief-plan.js) found for this angle's awareness level;
 * accepting an arbitrary key from the global table would let an operator put a
 * product-aware layout under an unaware angle's copy and quietly defeat the whole
 * awareness join. A brief with no `format.proposed` has no alternatives to choose
 * from either — refuse rather than accept a key against an empty list.
 *
 * AND THE ZONE SHAPES MUST MATCH. This is the second half of the check, added 2026-08-17
 * after review found that the first half alone paired one format's layout with another
 * format's copy. `zones` was written by buildConcept for the PROPOSED format's zone list,
 * `state` and `gates` are deliberately carried through an override untouched (an override
 * is a parameter change, not a decision), and formats at the same awareness level declare
 * DIFFERENT zones. Concretely: a `problem-aware` angle proposes `manifesto` (headline,
 * rows, bottomBar) and is offered `testimonial` (headline, attribution, trustLine) as an
 * alternative. Switching an already-APPROVED brief to it kept the approval, left
 * `attribution` and `trustLine` with no copy at all, and dropped a written manifesto
 * assertion into `testimonial`'s quote slot — whose layoutBrief says in so many words
 * "THE QUOTE MUST BE A REAL CUSTOMER REVIEW, quoted verbatim... never written", and which
 * the operator then sets in quotation marks off the comp. No pixel is un-gated (a plate
 * carries no text), which is exactly why this could not be caught downstream: it is the one
 * place in this feature that can present authored copy as a customer testimonial.
 *
 * Goes through writeBrief() so the approval invariant still applies: `state` and
 * `gates` are carried over untouched, and if the brief happens to already be `approved`,
 * writeBrief's own gates check runs again against the unchanged `gates` block and passes,
 * exactly as it did before.
 */
export function chooseFormat(root, product, briefId, formatKey, { formats = FORMATS } = {}) {
  const key = String(formatKey || '').trim();
  if (!key) throw new Error('ad-brief: chooseFormat requires a formatKey');

  const current = readBrief(root, product, briefId);
  if (!current) throw new Error(`ad-brief: no such brief "${briefId}"`);

  const proposed = current.format?.proposed ?? null;
  if (!proposed) {
    throw new Error(`ad-brief: "${briefId}" has no proposed format — there are no alternatives to choose from`);
  }
  const allowed = [proposed, ...(current.format?.alternatives || [])];
  if (!allowed.includes(key)) {
    throw new Error(`ad-brief: "${key}" is not a format available to "${briefId}" — must be one of: ${allowed.join(', ')}`);
  }

  const selectable = selectableFormats(current, formats);
  if (!selectable.includes(key)) {
    const byKey = new Map(formats.map(f => [f.key, f]));
    throw new Error(
      `ad-brief: "${key}" cannot carry "${briefId}"'s copy — its zones are ` +
      `[${(byKey.get(key)?.zones || []).join(', ')}] but this brief's copy was written for ` +
      `"${proposed}"'s zones [${(byKey.get(proposed)?.zones || []).join(', ')}]. ` +
      `Selectable formats for this brief: ${selectable.join(', ') || '(none but the proposed one)'}. ` +
      `Generate a new brief against "${key}" instead — the copy has to be authored for the layout.`
    );
  }

  const next = { ...current, format: { ...current.format, chosen: key } };
  return writeBrief(root, next);
}

export function listProductsWithBriefs(root) {
  const dir = join(root, 'data', 'briefs', 'ad-studio');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => {
    try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
  });
}
