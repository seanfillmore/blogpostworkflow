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

export function writeBrief(root, brief) {
  if (!brief?.briefId) throw new Error('ad-brief: writeBrief requires a briefId');
  if (!brief?.product) throw new Error('ad-brief: writeBrief requires a product');
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
 * A brief the gates floored is not approvable. `needs-evidence` means a factual claim
 * could not be traced or a health-claim pattern fired; the fix is to supply evidence or
 * rewrite the line and REGENERATE, so the copy that renders is copy the gates have seen.
 * Letting a crafted request flip that state straight to `approved` would route unsourced
 * text to a paid render, which is the one thing this pipeline exists to prevent.
 */
export function decideBrief(root, product, briefId, { state, note } = {}) {
  if (!BRIEF_STATES.includes(state)) {
    throw new Error(`ad-brief: unknown state "${state}" — one of: ${BRIEF_STATES.join(', ')}`);
  }
  const current = readBrief(root, product, briefId);
  if (!current) throw new Error(`ad-brief: no such brief "${briefId}"`);
  if (current.state === 'needs-evidence' && state === 'approved') {
    throw new Error(
      `ad-brief: "${briefId}" is needs-evidence and cannot be approved — ` +
      `supply the missing evidence and regenerate, so the gates see the copy that renders`
    );
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
