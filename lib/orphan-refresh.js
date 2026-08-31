// lib/orphan-refresh.js
//
// What to do with a post directory that has no meta.json.
//
// These are the accumulated damage of the content-refresher slug-mismatch fixed
// in PR #679: the agent wrote its output to `data/posts/<shopify handle>/` when
// the post already lived under a shorter local slug, so it created a SECOND
// directory holding a paid `content-refreshed.html`, an editor report, and
// nothing else. 34 of them on production, 31 carrying a refresh.
//
// THE FILENAME IS THE WHOLE SAFETY ARGUMENT. A re-homed refresh is written as
// `orphaned-refresh-<date>.html`, never as `content-refreshed.html`, and that is
// not tidiness — it is the difference between preserving paid work and arming it.
// `agents/refresh-runner` moves `content-refreshed.html` over `content.html` and
// PUBLISHES it once the editor gate passes. These refreshes are one to four
// months old and were generated against article bodies that have since changed
// (several of those mirrors have since been reconciled against live). Writing
// them under the consumed filename would queue stale content for publication
// over live ranking pages — this repo's worst failure mode, wearing a new
// costume. Verified: nothing globs `*.html` inside a post directory; every
// reader uses the exact name via `getRefreshedPath`, so any other filename is
// inert and a human can still find it next to the post it belongs to.
//
// NOTHING IS EVER DELETED. The orphan directory is MOVED to
// `data/posts/_orphaned/`, the same "move, never delete" rule
// `lib/brief-archive.js` exists to enforce after `--drop-non-earning` destroyed
// three paid-for briefs on 2026-08-19.

/** Where an archived orphan directory goes. Invisible to listAllSlugs(), which
 *  requires a meta.json in the directory it is scanning and does not recurse. */
export const ORPHAN_DIR = '_orphaned';

/** The filename a re-homed refresh takes. Deliberately NOT content-refreshed.html. */
export function rehomedName(dateIso) {
  const day = String(dateIso || '').slice(0, 10) || 'undated';
  return `orphaned-refresh-${day}.html`;
}

/**
 * Decide what happens to one orphan directory.
 *
 * @param {object} o
 * @param {string}  o.slug            the orphan directory name
 * @param {boolean} o.hasRefresh      it holds a content-refreshed.html
 * @param {string|null} o.target      resolvePostSlug(slug), or null
 * @param {boolean} o.targetIsLive    the target carries a shopify_article_id
 * @param {boolean} o.targetHasRefresh the target already has a pending refresh
 * @returns {{action:'rehome'|'archive', reason:string}}
 *
 * Every branch ends in the directory being archived; `rehome` additionally
 * carries the refresh across first. There is no 'delete' and no 'leave'.
 */
export function decideOrphan({ slug, hasRefresh, target, targetIsLive, targetHasRefresh }) {
  if (!hasRefresh) {
    return { action: 'archive', reason: 'no content-refreshed.html — nothing to carry across' };
  }
  if (!target) {
    return { action: 'archive', reason: 'no live post resolves from this handle' };
  }
  if (target === slug) {
    return { action: 'archive', reason: 'resolves to itself — there is no real post behind it' };
  }
  if (!targetIsLive) {
    return { action: 'archive', reason: `target ${target} has no shopify_article_id` };
  }
  if (targetHasRefresh) {
    // The target's own refresh is the newer, correctly-addressed one. Copying
    // over it — even under an inert name — invites someone to compare two files
    // and pick the older. Keep the orphan's copy in the archive instead.
    return { action: 'archive', reason: `target ${target} already has its own pending refresh` };
  }
  return { action: 'rehome', reason: `carry the refresh to ${target}, inert` };
}
