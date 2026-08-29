// lib/content-reconcile.js
//
// `lib/content-mirror.js` answers "has this mirror drifted, and how far?" and
// deliberately stops there — its header explains at length why the tool that
// cannot tell stale from ahead must not be the tool that overwrites.
//
// This module is the answer to the follow-up question: GIVEN a measured
// comparison, may THIS post's mirror be replaced by the live body, and if not,
// exactly why not? The decision half is pure — no I/O, no Shopify, no process —
// so every hold below is a case a test can construct. `applyMirrorReconcile()`
// at the foot of the file is the one function that writes, and it lives here
// rather than inline in the script so its ROLLBACK arm is exercised by a test
// against a real temp directory. Nothing in this module reaches Shopify.
//
// DIRECTION IS LIVE → LOCAL, AND IT IS CHECKED PER POST
// ────────────────────────────────────────────────────
// Shopify is authoritative for published content — `scripts/remediate-live-post.js`
// and `scripts/regate-live-posts.js` both already pull `body_html` down over
// `content.html`. But "no local file is ahead" is a measurement of one corpus on
// one day, not a law, so `hold:local-ahead` re-derives it per post from the
// comparison rather than trusting the survey. On 2026-08-24 exactly one post
// (`best-toothpaste-for-sensitive-teeth-2025`, 1 local-only block, similarity
// 0.991) came back `local-superset` — a case the 2026-08-23 survey did not have.
// That is the whole reason the check is per post.
//
// FOUR HOLDS, EACH FROM SOMETHING THAT WOULD ACTUALLY BREAK
// ────────────────────────────────────────────────────────
//   hold:live-empty     the live body has no substantive text blocks, so there
//                       is nothing to copy down and overwriting would blank the
//                       mirror. Same call `assessRepublish` makes in reverse.
//   hold:local-ahead    live ⊆ local. Whatever the corpus looked like yesterday,
//                       THIS file holds text live does not, and nothing here can
//                       tell a stale local extra from an unpublished edit.
//   hold:pinned-mirror  the file is a byte-pinned fixture of a committed
//                       health-claim remediation plan (see PINNED_MIRROR_SLUGS).
//   schemaRegression()  decided AFTER the write, not predicted — see below.
//
// WHY INJECTED SCHEMA IS LOAD-BEARING, WHICH IS NOT OBVIOUS FROM THIS FILE
// ────────────────────────────────────────────────────────────────────────
// `agents/legacy-rebuilder` runs daily from `scheduler.js` at `--limit 5
// --apply`, and a "legacy" verdict is a full PAID pipeline rebuild of a live
// page. Its `isLegacy` asks whether `content.html` carries any injected JSON-LD.
// 36 mirrors carry schema their live article does NOT (it was injected locally
// and never pushed). A plain live -> local copy therefore hands that agent 36
// fresh "legacy" posts and it starts paying for rebuilds of live pages,
// unattended, at five a day — a spend nobody asked for, triggered by a
// reconciliation that was otherwise correct.
//
// The fix is to re-run `agents/schema-injector` on the reconciled body, which
// regenerates the schema FROM THE NEW PROSE and restores the invariant
// `legacy-rebuilder` keys on. JSON-LD is invisible to `compareBodies` —
// `normalizeText` drops `<script>` wholesale and `textBlocks` only matches prose
// tags — so re-injecting cannot re-open the gate it just closed.
//
// `schemaRegression` is a VERIFY, not a PREDICTION. What the injector emits is
// the injector's business, and a second copy of that decision here would drift
// from the agent silently. So the caller writes, re-injects, and then asks
// whether any JSON-LD survived; if none did, the caller restores its backup.
//
// THIS WAS KEYED ON THE STRING `FAQPage` UNTIL 2026-08-24, AND HAD TO MOVE
// ───────────────────────────────────────────────────────────────────────
// The injector stopped emitting FAQPage that day (Google removed the FAQ rich
// result from Search), so a re-injection now REPLACES an old mirror's
// FAQPage/HowTo/Article with a BreadcrumbList. Under the old predicate that read
// as a regression, and this module would have rolled back and held every mirror
// it reconciled — including the 35 of 36 that CLAUDE.md records as recovering
// cleanly. `lib/injected-schema.js` holds the predicate now, shared with
// `agents/legacy-rebuilder` so the two can never disagree about what "has been
// through the injector" means.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { DIVERGENT_WARN_MAX } from './content-mirror.js';
import { hasInjectedSchema, schemaRegression } from './injected-schema.js';

// Re-exported so a caller reasoning about a reconcile can reach the predicate
// the rollback arm uses without also having to know where it lives.
export { hasInjectedSchema, schemaRegression };

/**
 * JSON-LD blocks, and the whitespace that follows them.
 *
 * Deliberately the same shape as `agents/schema-injector`'s own
 * `stripExistingSchemas`, because "the mirror differs from live only by schema"
 * has to mean the same thing on both sides of that agent's write.
 */
const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>\s*/gi;

/** The body with every JSON-LD block removed. */
export function stripLdJson(html) {
  return String(html ?? '').replace(LD_JSON_RE, '');
}

/**
 * Mirrors that must never be replaced by the live body.
 *
 * EMPTY SINCE 2026-08-29, and the emptiness is the decision — read this before
 * adding to it.
 *
 * It held three slugs, for a reason that was real at the time: both remediation
 * plans carry `kind: 'file'` entries naming an exact BEFORE literal inside those
 * mirrors, and their tests asserted that literal against the REAL repo file. A
 * reconcile pulls the LIVE body down, live already carries every AFTER, so the
 * strict assertion failed on files that were MORE correct than before. Pinning
 * was the right holding answer, but it had no expiry, and it left one live
 * indexed post (the tea-tree article) permanently unpublishable: its mirror was
 * a different, older draft linking four DEAD product handles, so every publish
 * was refused and its buy box could never be rebuilt.
 *
 * What replaced it is a better invariant, asserted in each plan's own tests:
 * a mirror carries EITHER the BEFORE or the AFTER, never a third value. That
 * still catches the real hazard — a plan entry nobody can find and nobody can
 * verify — while tolerating the one transition the strict form could not: a
 * remediation that has already shipped.
 *
 * `mirror-coconut-why-antibacterial-stale-draft` was retired outright rather
 * than relaxed, because it could not satisfy even the loose form: verified
 * against live 2026-08-29, that section is numbered 4 (not 5), worded
 * differently, and already remediated ("Naturally Odor-Fighting", no
 * "antifungal"). Neither its BEFORE nor its AFTER exists anywhere. An entry
 * describing a draft that no longer exists is not compliance coverage.
 *
 * THE MECHANISM IS INTACT AND TESTED (`decideMirrorAction`'s `pinned` argument,
 * and the `pinned-mirror` hold). Add a slug here when a plan genuinely needs a
 * byte-exact fixture the live body cannot satisfy — and give it an expiry, or it
 * becomes what this list became.
 */
export const PINNED_MIRROR_SLUGS = Object.freeze([]);

/**
 * Is this post inside the default reconcile scope?
 *
 * The default is exactly what `scripts/check-content-mirrors.mjs` flags — the
 * `different-article` tier (its exit 2) plus the 0.25–0.75 warn band (its exit
 * 1). The ~50 ordinary divergent mirrors above 0.75 have drifted too, but they
 * are recognisably the same article and a republish edits rather than replaces
 * the page; sweeping them is `--all`, an explicit choice, not a default.
 */
export function inDefaultScope(comparison) {
  if (!comparison) return false;
  if (comparison.tier === 'different-article') return true;
  return comparison.tier === 'divergent' && comparison.blockSimilarity < DIVERGENT_WARN_MAX;
}

/**
 * May this mirror be replaced by the live body?
 *
 * @param {object} o
 * @param {object} o.comparison   a `compareBodies()` result
 * @param {string} o.localHtml
 * @param {string} o.liveHtml
 * @param {boolean} [o.pinned]    slug is in PINNED_MIRROR_SLUGS
 * @returns {{ action:'in-sync'|'reconcile'|'hold', hold:string|null, reinjectSchema:boolean, reason:string }}
 *
 * `in-sync` compares the bodies WITH JSON-LD STRIPPED, and that is what makes a
 * second `--apply` a no-op. After a reconcile the mirror is the live prose plus
 * regenerated schema live does not have, so a byte comparison would call it
 * drifted forever and rewrite (and back up) the same file every run.
 */
export function decideMirrorAction({ comparison, localHtml, liveHtml, pinned = false } = {}) {
  const local = String(localHtml ?? '');
  const live = String(liveHtml ?? '');

  if (stripLdJson(local).trim() === stripLdJson(live).trim()) {
    return {
      action: 'in-sync',
      hold: null,
      reinjectSchema: false,
      reason: local === live
        ? 'byte-identical to the live body'
        : 'identical to the live body apart from JSON-LD, which the schema pipeline owns',
    };
  }

  if (!comparison || comparison.liveBlocks === 0) {
    return {
      action: 'hold',
      hold: 'live-empty',
      reinjectSchema: false,
      reason: 'the live article has no substantive text blocks — copying it down would blank the mirror',
    };
  }

  if (comparison.direction === 'local-superset') {
    return {
      action: 'hold',
      hold: 'local-ahead',
      reinjectSchema: false,
      reason: `live is a subset of local — this file holds ${comparison.localOnlyBlocks} text block(s) live does not, and nothing here can tell an unpublished edit from a stale extra`,
    };
  }

  if (pinned) {
    return {
      action: 'hold',
      hold: 'pinned-mirror',
      reinjectSchema: false,
      reason: 'this file is a byte-pinned fixture of a committed health-claim remediation plan — reconciling it retires plan entries, which is a compliance decision, not a mirror one',
    };
  }

  return {
    action: 'reconcile',
    hold: null,
    reinjectSchema: hasInjectedSchema(local),
    reason: `replace ${comparison.localBlocks} local block(s) with the ${comparison.liveBlocks} live block(s) (similarity ${comparison.blockSimilarity}, direction ${comparison.direction})`,
  };
}

/**
 * Write one reconciled mirror: back up → overwrite from live → re-inject schema
 * → verify → roll back if the body ended up with no JSON-LD at all.
 *
 * The only function in this module that touches disk, and it is here rather
 * than inline in the script so the rollback arm is exercised by a test against a
 * real temp directory instead of being asserted in a comment. It writes exactly
 * two paths — `contentPath` and `backupPath` — and never Shopify.
 *
 * @param {object} o
 * @param {string} o.contentPath          data/posts/<slug>/content.html
 * @param {string} o.backupPath           where the pre-image is copied first
 * @param {string} o.liveHtml             the live body_html to install
 * @param {boolean} [o.reinject]          run the injector after writing
 * @param {(contentPath: string) => void} [o.runInjector]
 *        invoked only when `reinject` is true. Injected so the test can drive
 *        the regression arm without shelling out; production passes a call to
 *        `agents/schema-injector` WITHOUT `--apply`, so it writes locally and
 *        never touches Shopify.
 * @returns {{ applied:boolean, rolledBack:boolean, injectorError:string|null }}
 *
 * The backup is taken BEFORE anything is written and is never removed — a
 * rolled-back post keeps it too, because "we tried this and put it back" is
 * worth being able to see. Deleting a Shopify image taught this project what an
 * unrecoverable original costs; a local copy is free.
 */
export function applyMirrorReconcile({
  contentPath, backupPath, liveHtml, reinject = false, runInjector = null,
} = {}) {
  const before = readFileSync(contentPath, 'utf8');

  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(contentPath, backupPath);

  writeFileSync(contentPath, String(liveHtml ?? ''));

  let injectorError = null;
  if (reinject && runInjector) {
    try { runInjector(contentPath); }
    catch (err) { injectorError = String(err?.message || err).slice(0, 200); }
  }

  const after = readFileSync(contentPath, 'utf8');
  if (schemaRegression(before, after)) {
    copyFileSync(backupPath, contentPath);
    return { applied: false, rolledBack: true, injectorError };
  }
  return { applied: true, rolledBack: false, injectorError };
}
