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

export const BRIEF_STATES = ['needs-evidence', 'ready', 'approved', 'rejected', 'rendered'];

const SAFE_SEGMENT = /^[\w.-]+$/;

/** Strict: `1` and `'true'` do not count. Shared by writeBrief and decideBrief so the rule is one rule. */
const gatesPass = (gates) => gates?.health?.ok === true && gates?.claims?.ok === true;

const checkSegment = (value, label) => {
  const s = String(value || '');
  if (!s || s === '.' || s === '..' || !SAFE_SEGMENT.test(s)) {
    throw new Error(`ad-brief: invalid ${label} "${value}"`);
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

export function listProductsWithBriefs(root) {
  const dir = join(root, 'data', 'briefs', 'ad-studio');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => {
    try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
  });
}
