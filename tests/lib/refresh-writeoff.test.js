/**
 * The refused-refresh loop.
 *
 * `legacy-rebuilder` → `refresh-runner` → `content-refresher` rewrites
 * `data/posts/<slug>/content.html`, then `agents/publisher`'s mirror gate refuses
 * to republish because the rewrite reads as a DIFFERENT ARTICLE against live.
 * Before this module existed the failure path did neither of the two things it
 * had to do: it left the overwritten mirror in place, and it recorded nothing.
 *
 * So the post stayed unpublishable forever (every later publish refuses on the
 * same divergence), stayed "legacy" forever (the restored-from-nothing mirror
 * carries no injected JSON-LD), and was re-picked and re-paid for every morning.
 * Measured on production 2026-08-31: 19 refusals in the scheduler log,
 * `best-fragrance-free-body-lotion-2025` 8 times, and TEN unused
 * `content.backup-*.html` files sitting in that post's backups/ — the rollback
 * material, captured by the same function that then walked past it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  EXIT_MIRROR_DIVERGED,
  mirrorFingerprint,
  buildRefreshWriteoff,
  isRefreshWrittenOff,
  decideRefreshFailure,
  excludeWrittenOff,
} from '../../lib/refresh-writeoff.js';

const LIVE = '<h2>Original</h2><p>The body that is live on Shopify.</p>';
const REWRITE = '<h2>Wholly different</h2><p>What content-refresher produced.</p>';

test('the refusal exit code is distinct from a generic failure', () => {
  // Every existing publisher caller (scheduler.js, pipeline.js, refresh-runner)
  // treats any nonzero as failure and branches on none of them, so a dedicated
  // code is additive. It is the only thing that lets the failure path tell a
  // DETERMINISTIC refusal from a transient one.
  assert.equal(EXIT_MIRROR_DIVERGED, 3);
  assert.notEqual(EXIT_MIRROR_DIVERGED, 1);
});

test('a failure after the mirror was overwritten always restores it', () => {
  const d = decideRefreshFailure({ exitCode: 1, mirrorOverwritten: true });
  assert.equal(d.restoreMirror, true);
});

test('a failure BEFORE the mirror was overwritten restores nothing', () => {
  // content-refresher failing is the real case: it dies before the copy at
  // refresh-runner's line 239, so there is nothing to roll back and a restore
  // would be writing over a mirror nobody touched.
  const d = decideRefreshFailure({ exitCode: 1, mirrorOverwritten: false });
  assert.equal(d.restoreMirror, false);
  assert.equal(d.writeOff, false);
});

test('ONLY a mirror-gate refusal writes the post off', () => {
  const refused = decideRefreshFailure({ exitCode: EXIT_MIRROR_DIVERGED, mirrorOverwritten: true });
  assert.equal(refused.writeOff, true);
  assert.equal(refused.restoreMirror, true);
});

test('a transient failure restores but NEVER writes off', () => {
  // A Shopify 500 or a network blip must not bench a post permanently. The
  // write-off lapses only when the mirror changes, so a wrongly-written-off post
  // would never come back on its own — which is the PINNED_MIRROR_SLUGS mistake
  // (a hold with no expiry becomes an outage nobody is looking for).
  for (const exitCode of [1, 2, 127, null, undefined]) {
    const d = decideRefreshFailure({ exitCode, mirrorOverwritten: true });
    assert.equal(d.writeOff, false, `exit ${exitCode} must not write off`);
    assert.equal(d.restoreMirror, true, `exit ${exitCode} must still restore`);
  }
});

test('a successful run neither restores nor writes off', () => {
  const d = decideRefreshFailure({ exitCode: 0, mirrorOverwritten: true });
  assert.equal(d.restoreMirror, false);
  assert.equal(d.writeOff, false);
});

test('the fingerprint is stable, and different for different bodies', () => {
  assert.equal(mirrorFingerprint(LIVE), mirrorFingerprint(LIVE));
  assert.notEqual(mirrorFingerprint(LIVE), mirrorFingerprint(REWRITE));
});

test('an absent mirror fingerprints to null rather than to a hash of ""', () => {
  // Otherwise every post with no content.html shares one fingerprint and a single
  // write-off would bench all of them at once.
  assert.equal(mirrorFingerprint(null), null);
  assert.equal(mirrorFingerprint(undefined), null);
  assert.notEqual(mirrorFingerprint(''), mirrorFingerprint(null));
});

test('a written-off post is skipped while its mirror is unchanged', () => {
  const meta = { refresh_writeoff: buildRefreshWriteoff({ reason: 'mirror gate', fingerprint: mirrorFingerprint(LIVE), at: '2026-08-31T15:32:00Z' }) };
  assert.equal(isRefreshWrittenOff(meta, LIVE), true);
});

test('the write-off LAPSES the moment the mirror changes — this is the expiry', () => {
  // The recovery path is real and cheap: `scripts/reconcile-content-mirrors.mjs`
  // pulls live over the mirror, the fingerprint no longer matches, and the post
  // re-enters the pick list on its own. Nobody has to remember to un-bench it.
  const meta = { refresh_writeoff: buildRefreshWriteoff({ reason: 'mirror gate', fingerprint: mirrorFingerprint(LIVE), at: '2026-08-31T15:32:00Z' }) };
  assert.equal(isRefreshWrittenOff(meta, REWRITE), false);
});

test('a post with no write-off, or a malformed one, is never skipped', () => {
  // Unknown-means-allow: the failure direction is "we did the work again",
  // never "we silently stopped working on a live page".
  assert.equal(isRefreshWrittenOff({}, LIVE), false);
  assert.equal(isRefreshWrittenOff(null, LIVE), false);
  assert.equal(isRefreshWrittenOff({ refresh_writeoff: {} }, LIVE), false);
  assert.equal(isRefreshWrittenOff({ refresh_writeoff: 'yes' }, LIVE), false);
  assert.equal(isRefreshWrittenOff({ refresh_writeoff: { mirror_fingerprint: null } }, null), false);
});

test('the record carries why, when and what it was decided on', () => {
  const rec = buildRefreshWriteoff({ reason: 'mirror gate: different article', fingerprint: 'abc123', at: '2026-08-31T15:32:00Z' });
  assert.equal(rec.reason, 'mirror gate: different article');
  assert.equal(rec.mirror_fingerprint, 'abc123');
  assert.equal(rec.written_off_at, '2026-08-31T15:32:00Z');
});

test('excludeWrittenOff splits the pick list and names what it held', () => {
  const posts = [
    { slug: 'clean', meta: {} },
    { slug: 'benched', meta: { refresh_writeoff: buildRefreshWriteoff({ reason: 'r', fingerprint: mirrorFingerprint(LIVE), at: 'now' }) } },
    { slug: 'lapsed', meta: { refresh_writeoff: buildRefreshWriteoff({ reason: 'r', fingerprint: 'stale-fingerprint', at: 'now' }) } },
  ];
  const mirrorFor = () => LIVE;
  const { kept, held } = excludeWrittenOff(posts, { mirrorFor });

  assert.deepEqual(kept.map((p) => p.slug), ['clean', 'lapsed']);
  assert.deepEqual(held.map((p) => p.slug), ['benched']);
});

test('excludeWrittenOff holds nothing when it cannot read a mirror', () => {
  // Same fail-open shape as lib/cluster-hold.js: an input we cannot read may
  // never be the reason a live page stops being maintained.
  const posts = [{ slug: 'a', meta: { refresh_writeoff: buildRefreshWriteoff({ reason: 'r', fingerprint: 'x', at: 'now' }) } }];
  const { kept, held } = excludeWrittenOff(posts, { mirrorFor: () => null });
  assert.equal(kept.length, 1);
  assert.equal(held.length, 0);
});
