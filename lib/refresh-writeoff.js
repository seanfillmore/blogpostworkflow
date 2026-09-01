/**
 * What to do when a refresh cannot be published — the two halves of the failure
 * path that were both missing.
 *
 * THE LOOP THIS EXISTS TO CLOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * `agents/refresh-runner` copies `content-refreshed.html` over `content.html`
 * (its line 239) so the editor and the injectors operate on the canonical file,
 * and only then runs `agents/publisher`. When the publisher's mirror gate refuses
 * — the rewrite reads as a DIFFERENT ARTICLE against the live body — the old
 * failure path returned `{ ok: false }` and did nothing else.
 *
 * That left the mirror overwritten, which is worse than it sounds. It is not one
 * bad day: the divergence is now PERMANENT, so every later publish of that post
 * refuses on the same grounds, and because the stranded rewrite carries no
 * injected JSON-LD the post also reads as "legacy" forever, so
 * `agents/legacy-rebuilder` re-picks it and pays for the whole chain again the
 * next morning, and the morning after that.
 *
 * Measured on production 2026-08-31: 19 `Mirror gate: refusing` lines in
 * `data/reports/scheduler/scheduler.log` — `best-fragrance-free-body-lotion-2025`
 * eight times, `11-benefits-of-incorporating-tea-tree-oil…` four, the
 * stretch-marks post three. That post's `backups/` held TEN unused
 * `content.backup-*.html` files: refresh-runner captures the rollback material
 * immediately before the overwrite and then walks straight past it on failure.
 * The same three posts are the `DIFFERENT ARTICLE 3` in `check-content-mirrors`
 * and the reason ten health-claim remediation mirror tests are red on the box.
 *
 * It concentrates on lotion because the pick list is ordered by
 * `lib/cluster-efficiency.js`, which ranks lotion first — the same mechanism that
 * aimed PR #699's `published:false` bug at the highest-earning cluster. A gate
 * pointed at the best category points the waste there too.
 *
 * TWO DECISIONS, DELIBERATELY NOT ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * RESTORE happens on ANY failure after the overwrite. It destroys nothing: the
 * paid rewrite survives as `content-refreshed.html` and in the backup that was
 * just taken, so this only ends the window CLAUDE.md already describes ("a file
 * ahead of live is a normal state for the minutes between those two steps") at
 * the point the publish is known to have failed.
 *
 * WRITE-OFF happens only on the mirror-gate refusal, which is why the publisher
 * now exits `EXIT_MIRROR_DIVERGED` rather than a generic 1. A refusal is
 * DETERMINISTIC — nothing about tomorrow makes the same rewrite publishable — but
 * a Shopify 500 is not, and benching a live page on a network blip would be the
 * worse bug. Unknown exit codes therefore restore and do not write off.
 *
 * THE WRITE-OFF HAS AN EXPIRY, AND IT IS NOT A DATE
 * ─────────────────────────────────────────────────────────────────────────────
 * It is fingerprinted against the mirror it was decided on, so it LAPSES by
 * itself the moment that file changes — which is exactly what
 * `scripts/reconcile-content-mirrors.mjs` does when somebody fixes the post. The
 * lesson is `PINNED_MIRROR_SLUGS`: a hold with no expiry becomes an outage nobody
 * is looking for, and that one left a live indexed page unpublishable for days.
 * Nobody has to remember to un-bench anything here.
 *
 * The fingerprint reads the LOCAL mirror, not the live body, for two reasons: the
 * picker already reads that file for `isLegacy`, so the check costs no Shopify
 * call per candidate; and the realistic recovery is somebody reconciling the
 * mirror, which this sees. The gap is honest and one-directional — if LIVE moves
 * and local does not, the post stays benched longer than it should. That fails
 * toward "we did not re-run a refresh", never toward "we overwrote a live page".
 */
import { createHash } from 'node:crypto';

/**
 * Exit code `agents/publisher` uses for a mirror-gate refusal.
 *
 * Deliberately distinct from 1. Verified before choosing it: the three callers
 * (`scheduler.js:121`, `pipeline.js:150`, `agents/refresh-runner`) all run the
 * publisher through execSync and treat any nonzero as failure without branching
 * on the value, so this is additive for every one of them and newly legible to
 * the one caller that needs to tell a refusal from a blip.
 */
export const EXIT_MIRROR_DIVERGED = 3;

/**
 * Fingerprint the mirror a decision was made against.
 *
 * Returns null for an absent body rather than hashing the empty string — else
 * every post without a `content.html` shares one fingerprint and a single
 * write-off benches all of them at once.
 */
export function mirrorFingerprint(html) {
  if (html === null || html === undefined) return null;
  return createHash('sha256').update(String(html)).digest('hex').slice(0, 16);
}

/** The record stamped on `meta.refresh_writeoff`. */
export function buildRefreshWriteoff({ reason, fingerprint, at }) {
  return {
    reason,
    mirror_fingerprint: fingerprint,
    written_off_at: at,
  };
}

/**
 * Is this post currently written off?
 *
 * True only when a well-formed record's fingerprint matches the mirror as it is
 * RIGHT NOW. Anything else — no record, a malformed one, a null fingerprint, an
 * unreadable mirror — is false, because unknown-means-allow: the failure
 * direction has to be "we ran the refresh again", never "we silently stopped
 * maintaining a live page".
 */
export function isRefreshWrittenOff(meta, mirrorHtml) {
  const rec = meta?.refresh_writeoff;
  if (!rec || typeof rec !== 'object') return false;
  const stamped = rec.mirror_fingerprint;
  if (!stamped) return false;
  const current = mirrorFingerprint(mirrorHtml);
  if (!current) return false;
  return stamped === current;
}

/**
 * What the failure path should do, given how the publisher exited.
 *
 * `mirrorOverwritten` is false when the run died before refresh-runner's copy —
 * a content-refresher failure is the real case — and there is then nothing to
 * roll back.
 */
export function decideRefreshFailure({ exitCode, mirrorOverwritten }) {
  const failed = exitCode !== 0;
  const restoreMirror = Boolean(failed && mirrorOverwritten);
  return {
    restoreMirror,
    writeOff: Boolean(restoreMirror && exitCode === EXIT_MIRROR_DIVERGED),
  };
}

/**
 * Split a pick list into what may be worked and what is currently written off.
 *
 * `mirrorFor(slug)` returns the post's current `content.html`, or null when it
 * cannot be read — in which case the post is KEPT. Same fail-open shape as
 * `lib/cluster-hold.js`: an input we cannot read may never be the reason a live
 * page stops being maintained.
 *
 * `held` is returned rather than dropped so every caller can say out loud what it
 * withheld. A hold nobody can see becomes a mystery outage six weeks later.
 */
export function excludeWrittenOff(posts, { mirrorFor }) {
  const kept = [];
  const held = [];
  for (const post of posts) {
    if (isRefreshWrittenOff(post.meta, mirrorFor(post.slug))) held.push(post);
    else kept.push(post);
  }
  return { kept, held };
}
