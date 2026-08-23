/**
 * Winner-lock semantics — the single reader of `legacy_locked`.
 *
 * `agents/legacy-triage` stamps `legacy_locked: true` on posts it buckets as
 * winners (page-1 rankings we do not want to gamble with). Three agents were
 * each supposed to honour it and each hand-rolled its own read. One of them,
 * `meta-optimizer`, built the path as a FLAT `data/posts/<handle>.json` — a
 * layout this repo has not used for a long time (production: 0 flat files, 201
 * `data/posts/<slug>/meta.json`). Its `readFileSync` therefore threw on every
 * post, its bare `catch { /* proceed *​/ }` swallowed the throw, and the guard
 * was inert for its entire life while reading, in source, exactly like a guard.
 *
 * Two design decisions live here so they are decided once instead of three
 * times:
 *
 * 1. WHAT THE LOCK MEANS. It blocks BODY rewrites, not title/meta tests.
 *    Winner protection exists so a page that ranks is not rewritten into
 *    something that does not. A title/meta test does not touch the body, is a
 *    two-field change, and is auto-reverted by `agents/meta-ab-checker` when
 *    CTR regresses past the 0.5pp dead-band in `lib/meta-ab-decision.js`.
 *    Blocking it meant a winner could never have its CTR improved — the main
 *    lever a winner has left. The live example: the tattoo-soap winner sits at
 *    position #9 on ~38k impressions with 0.62% CTR and was unimprovable.
 *
 * 2. HOW IT FAILS. A guard that proceeds when it cannot read the lock is how
 *    this stayed hidden, so the four outcomes are named and handled separately:
 *
 *      unlocked   — meta.json read, flag falsy          → allow everything
 *      locked     — meta.json read, flag true           → block body rewrites
 *      no-post    — no local post record for this target → allow (see below)
 *      unreadable — meta.json is there but won't parse   → FAIL CLOSED on body
 *
 *    `no-post` allows because absence carries no lock signal: the flag is only
 *    ever stamped on a local meta.json, and agents that key off live Shopify
 *    URLs routinely see articles with no local directory. Refusing there would
 *    turn the guard into a total stall — the same silent breakage in the other
 *    direction. `unreadable` refuses because the evidence exists and we cannot
 *    read it, which is precisely when "might be a winner" has to win.
 *
 * The lock is the authority, not `legacy_bucket`. Production carries at least
 * one post (`natural-soap-bar`) that is `legacy_locked: true` while its bucket
 * has drifted to `flop`; an agent routing on the bucket alone would rebuild it.
 */

import { readFileSync, existsSync } from 'fs';
import { resolvePostSlug, getMetaPath, handleFromUrl } from './posts.js';

export const LOCK_UNLOCKED = 'unlocked';
export const LOCK_LOCKED = 'locked';
export const LOCK_NO_POST = 'no-post';
export const LOCK_UNREADABLE = 'unreadable';

/** Actions a caller can ask about. Anything else throws rather than defaulting. */
const POLICY = {
  // Rewriting the article body. A winner must never be rewritten.
  body: {
    [LOCK_UNLOCKED]: true,
    [LOCK_NO_POST]: true,
    [LOCK_LOCKED]: false,
    [LOCK_UNREADABLE]: false,
  },
  // Rewriting only the title / meta description. Reversible, body-preserving,
  // and covered by meta-ab-checker's auto-revert — allowed on a winner.
  metadata: {
    [LOCK_UNLOCKED]: true,
    [LOCK_NO_POST]: true,
    [LOCK_LOCKED]: true,
    [LOCK_UNREADABLE]: true,
  },
};

const REASON = {
  [LOCK_LOCKED]: 'legacy winner (locked)',
  [LOCK_UNREADABLE]: 'winner lock unreadable — refusing rather than guessing',
  [LOCK_NO_POST]: 'no local post record — nothing locked',
  [LOCK_UNLOCKED]: 'not locked',
};

/**
 * Pure policy table. No filesystem, no resolution — just "given this lock
 * state, may I do this?".
 *
 * @param {'body'|'metadata'} action
 * @param {string} state one of the LOCK_* constants
 * @returns {{allowed:boolean, action:string, state:string, reason:string}}
 */
export function decideLockAction(action, state) {
  const table = POLICY[action];
  if (!table) throw new Error(`post-lock: unknown action "${action}" (expected 'body' or 'metadata')`);
  if (!(state in table)) throw new Error(`post-lock: unknown lock state "${state}"`);
  return { allowed: table[state], action, state, reason: REASON[state] };
}

/**
 * Read the winner lock for a post, identified by local slug, Shopify article
 * handle, or live URL.
 *
 * Resolution goes through `lib/posts.js`'s `resolvePostSlug` because a Shopify
 * article handle is NOT always the local post-dir slug (the tattoo-soap winner
 * lives in `data/posts/best-soap-for-tattoos/` but its article handle is
 * `best-soap-for-tattoos-what-to-use-for-safe-healing`). Using the handle as a
 * slug is the second half of the same bug that made the guard inert.
 *
 * @param {string} target slug, handle, or URL
 * @returns {{target:string, slug:string|null, state:string, locked:boolean,
 *            bucket:string|null, reason:string, error:string|null}}
 */
export function readLockState(target) {
  const raw = target == null ? '' : String(target);
  const result = (state, extra = {}) => ({
    target: raw,
    slug: null,
    state,
    locked: state === LOCK_LOCKED,
    bucket: null,
    reason: REASON[state],
    error: null,
    ...extra,
  });

  if (!raw.trim()) return result(LOCK_NO_POST);

  // resolvePostSlug parses meta.json to match, so it returns null for a post
  // whose meta.json is corrupt. Fall back to the bare handle so an unreadable
  // file is still detected as unreadable instead of masquerading as absent.
  const slug = resolvePostSlug(raw) || handleFromUrl(raw) || raw;
  const metaPath = getMetaPath(slug);
  if (!existsSync(metaPath)) return result(LOCK_NO_POST);

  let text;
  try {
    text = readFileSync(metaPath, 'utf8');
  } catch (e) {
    // ENOENT can still land here on a race between existsSync and the read.
    if (e.code === 'ENOENT') return result(LOCK_NO_POST, { slug });
    return result(LOCK_UNREADABLE, { slug, error: e.message });
  }

  let meta;
  try {
    meta = JSON.parse(text);
  } catch (e) {
    return result(LOCK_UNREADABLE, { slug, error: e.message });
  }
  if (!meta || typeof meta !== 'object') {
    return result(LOCK_UNREADABLE, { slug, error: 'meta.json is not an object' });
  }

  const state = meta.legacy_locked ? LOCK_LOCKED : LOCK_UNLOCKED;
  return result(state, {
    slug,
    bucket: meta.legacy_bucket ?? null,
    reason: state === LOCK_LOCKED
      ? `${REASON[LOCK_LOCKED]}${meta.legacy_triage_reason ? ` — ${meta.legacy_triage_reason}` : ''}`
      : REASON[LOCK_UNLOCKED],
  });
}

/**
 * May I rewrite this post's BODY? Blocked on a winner, and blocked when the
 * lock cannot be read.
 *
 * @returns {{allowed:boolean, slug:string|null, state:string, reason:string}}
 */
export function mayRewriteBody(target) {
  const lock = readLockState(target);
  const d = decideLockAction('body', lock.state);
  return {
    allowed: d.allowed,
    slug: lock.slug,
    state: lock.state,
    bucket: lock.bucket,
    reason: d.allowed ? lock.reason : (lock.state === LOCK_LOCKED ? lock.reason : d.reason),
  };
}

/**
 * May I test this post's TITLE / META DESCRIPTION? Always yes — the lock does
 * not gate metadata.
 *
 * `requiresAbTracking` is the condition attached to that yes: on a locked
 * winner (or when the lock is unreadable, which we treat as if locked) the
 * caller MUST record an A/B baseline for the change, because auto-revert is the
 * entire reason touching a winner is safe. A Shopify mutation with no tracker
 * entry is one meta-ab-checker will never evaluate and never undo.
 *
 * @returns {{allowed:boolean, requiresAbTracking:boolean, slug:string|null,
 *            state:string, reason:string}}
 */
export function mayTestMetadata(target) {
  const lock = readLockState(target);
  const d = decideLockAction('metadata', lock.state);
  return {
    allowed: d.allowed,
    requiresAbTracking: lock.state === LOCK_LOCKED || lock.state === LOCK_UNREADABLE,
    slug: lock.slug,
    state: lock.state,
    bucket: lock.bucket,
    reason: lock.reason,
  };
}
