/**
 * The recap reviewer's memory between mornings: data/reports/recap-reviewer/state.json
 * (gitignored, server-only).
 *
 *   firstSeen[key]    first UTC day an item appeared, so "since" is honest
 *   fixAttempts[key]  fix sessions spent on a key; none after MAX_FIX_ATTEMPTS
 *   regenerated[key]  day a needs_decision item got its one retry
 *   remediated[key]   day a blocked draft got its one content-remediator pass
 *   closed[key]       day a needs_decision item was closed out
 *
 * An unreadable file is reported (`unreadable: true`), never thrown: the review
 * still runs, and the worst case is one extra retry, which every handler bounds.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REVIEWER_DIR = join(ROOT, 'data', 'reports', 'recap-reviewer');
export const STATE_PATH = join(REVIEWER_DIR, 'state.json');
export const MAX_FIX_ATTEMPTS = 3;

const MAPS = ['firstSeen', 'fixAttempts', 'regenerated', 'remediated', 'closed'];

export function emptyState() {
  return Object.fromEntries(MAPS.map((k) => [k, {}]));
}

export function loadState(path = STATE_PATH) {
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const s = emptyState();
    for (const k of MAPS) if (raw?.[k] && typeof raw[k] === 'object') s[k] = { ...raw[k] };
    return s;
  } catch {
    return { ...emptyState(), unreadable: true };
  }
}

export function saveState(state, path = STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const out = Object.fromEntries(MAPS.map((k) => [k, state?.[k] || {}]));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, path);
}
