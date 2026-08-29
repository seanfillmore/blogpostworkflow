// tests/lib/content-reconcile.test.js
//
// Every hold in lib/content-reconcile.js came from something that would
// actually have broken on this corpus, so each one is constructed here rather
// than asserted in prose. The two that are easy to get wrong and impossible to
// notice are:
//
//   * idempotence — a second --apply must be a no-op even though re-injected
//     JSON-LD leaves the mirror not byte-equal to live, and
//   * schemaRegression — `agents/legacy-rebuilder` queues a PAID full rebuild
//     for any mirror carrying no injected JSON-LD, daily and unattended. That
//     predicate was `!html.includes('FAQPage')` until 2026-08-24, when
//     agents/schema-injector stopped emitting FAQPage (Google removed the FAQ
//     rich result). Keyed on FAQPage, re-injecting an old mirror — which now
//     swaps FAQPage/HowTo/Article for a BreadcrumbList — read as a LOSS, and
//     every mirror this module reconciled would have been rolled back and held.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareBodies } from '../../lib/content-mirror.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const occurrences = (hay, needle) => (needle ? String(hay).split(needle).length - 1 : 0);
import {
  stripLdJson,
  hasInjectedSchema,
  schemaRegression,
  inDefaultScope,
  decideMirrorAction,
  applyMirrorReconcile,
  PINNED_MIRROR_SLUGS,
} from '../../lib/content-reconcile.js';

// A block has to clear MIN_BLOCK_CHARS (40) to count, so these are padded.
const P = (n) => `<p>Paragraph number ${n} carries enough characters to count as a real text block.</p>`;
const body = (...ns) => ns.map(P).join('\n');
const LD = (type) => `<script type="application/ld+json">\n{"@type":"${type}"}\n</script>`;

// ── stripLdJson / hasInjectedSchema ──────────────────────────────────────────

test('stripLdJson removes JSON-LD blocks and leaves prose untouched', () => {
  const html = `${LD('FAQPage')}\n${body(1, 2)}`;
  assert.equal(stripLdJson(html).trim(), body(1, 2));
  assert.equal(stripLdJson(body(1)), body(1));
});

test('stripLdJson handles single quotes and extra attributes', () => {
  const html = `<script data-x="1" type='application/ld+json'>{"@type":"FAQPage"}</script>${body(1)}`;
  assert.equal(stripLdJson(html), body(1));
});

test('stripLdJson leaves non-JSON-LD scripts alone', () => {
  const html = `<script>var a = 1;</script>${body(1)}`;
  assert.equal(stripLdJson(html), html);
});

test('hasInjectedSchema matches what legacy-rebuilder actually reads', () => {
  assert.equal(hasInjectedSchema(LD('BreadcrumbList')), true);
  assert.equal(hasInjectedSchema(LD('FAQPage')), true);
  assert.equal(hasInjectedSchema(body(1)), false);
  assert.equal(hasInjectedSchema(''), false);
  assert.equal(hasInjectedSchema(null), false);
});

// ── schemaRegression ─────────────────────────────────────────────────────────

test('schemaRegression fires only when schema is present before and gone after', () => {
  assert.equal(schemaRegression(LD('FAQPage'), body(1)), true);
  assert.equal(schemaRegression(LD('FAQPage'), LD('FAQPage')), false);
  assert.equal(schemaRegression(body(1), body(1)), false);
  // Gaining schema is never a regression — a mirror that never had it is not
  // one legacy-rebuilder's verdict changes for.
  assert.equal(schemaRegression(body(1), LD('BreadcrumbList')), false);
});

test('SWAPPING A RETIRED TYPE FOR THE LIVE ONE IS NOT A REGRESSION', () => {
  // The reason this predicate had to move off `FAQPage`. Re-injecting an old
  // mirror replaces its retired FAQPage/HowTo/Article with a BreadcrumbList,
  // which is the migration working. The old key called it a loss and would have
  // rolled back all 35 of the 36 mirrors CLAUDE.md records as recovering.
  assert.equal(schemaRegression(LD('FAQPage') + LD('HowTo'), LD('BreadcrumbList')), false);
});

// ── inDefaultScope ───────────────────────────────────────────────────────────

test('inDefaultScope covers exactly what check-content-mirrors flags', () => {
  const scope = (local, live) => inDefaultScope(compareBodies(local, live));

  // different-article: nothing shared
  assert.equal(scope(body(1, 2, 3), body(7, 8, 9)), true);

  // warn band: shares more than a quarter but under three quarters
  const warn = compareBodies(body(1, 2, 3, 4, 5), body(1, 2, 11, 12, 13, 14, 15));
  assert.ok(warn.blockSimilarity > 0.25 && warn.blockSimilarity < 0.75, `got ${warn.blockSimilarity}`);
  assert.equal(inDefaultScope(warn), true);

  // ordinary divergence above the warn threshold is NOT swept by default
  const ordinary = compareBodies(body(1, 2, 3, 4, 5, 6, 7, 8, 9), body(1, 2, 3, 4, 5, 6, 7, 8, 20));
  assert.ok(ordinary.blockSimilarity >= 0.75, `got ${ordinary.blockSimilarity}`);
  assert.equal(inDefaultScope(ordinary), false);

  assert.equal(inDefaultScope(null), false);
});

// ── decideMirrorAction ───────────────────────────────────────────────────────

const decide = (local, live, pinned = false) =>
  decideMirrorAction({ comparison: compareBodies(local, live), localHtml: local, liveHtml: live, pinned });

test('a byte-identical mirror is in-sync and is not rewritten', () => {
  const d = decide(body(1, 2), body(1, 2));
  assert.equal(d.action, 'in-sync');
  assert.match(d.reason, /byte-identical/);
});

test('IDEMPOTENCE: a reconciled mirror carrying re-injected schema is in-sync on the next run', () => {
  const live = body(1, 2, 3);
  // What the previous --apply left behind: live prose plus regenerated JSON-LD
  // that live does not have. A byte comparison would call this drifted forever.
  const reconciled = `${LD('Article')}\n${LD('FAQPage')}\n${live}`;
  const d = decide(reconciled, live);
  assert.equal(d.action, 'in-sync');
  assert.equal(d.reinjectSchema, false);
  assert.match(d.reason, /apart from JSON-LD/);
});

test('a different article is reconciled, and schema re-injection is requested when the mirror had any', () => {
  const local = `${LD('FAQPage')}\n${body(1, 2, 3)}`;
  const d = decide(local, body(7, 8, 9));
  assert.equal(d.action, 'reconcile');
  assert.equal(d.reinjectSchema, true);
  assert.match(d.reason, /similarity 0/);
});

test('a mirror with no JSON-LD at all is reconciled without re-injection', () => {
  const d = decide(body(1, 2, 3), body(7, 8, 9));
  assert.equal(d.action, 'reconcile');
  assert.equal(d.reinjectSchema, false);
});

test('HOLD local-ahead: live is a strict subset of local', () => {
  // best-toothpaste-for-sensitive-teeth-2025 in miniature: every live block is
  // in local, and local has one more.
  const d = decide(body(1, 2, 3), body(1, 2));
  assert.equal(d.action, 'hold');
  assert.equal(d.hold, 'local-ahead');
  assert.match(d.reason, /live is a subset of local/);
});

test('HOLD live-empty: an empty live body never overwrites a populated mirror', () => {
  const d = decide(body(1, 2, 3), '');
  assert.equal(d.action, 'hold');
  assert.equal(d.hold, 'live-empty');
});

test('HOLD live-empty also covers a live body of markup with no substantive text', () => {
  const d = decide(body(1, 2, 3), '<div><p>too short</p></div>');
  assert.equal(d.action, 'hold');
  assert.equal(d.hold, 'live-empty');
});

test('HOLD pinned-mirror: a remediation-plan fixture is never overwritten', () => {
  const d = decide(body(1, 2, 3), body(7, 8, 9), true);
  assert.equal(d.action, 'hold');
  assert.equal(d.hold, 'pinned-mirror');
  assert.match(d.reason, /compliance decision/);
});

test('an in-sync pinned mirror reports in-sync rather than a hold — there is nothing to hold back', () => {
  const d = decide(body(1, 2), body(1, 2), true);
  assert.equal(d.action, 'in-sync');
});

test('local-ahead outranks pinned, so the strongest reason is the one reported', () => {
  const d = decide(body(1, 2, 3), body(1, 2), true);
  assert.equal(d.hold, 'local-ahead');
});

test('no hold is ever returned with reinjectSchema set', () => {
  for (const d of [
    decide(body(1, 2, 3), ''),
    decide(`${LD('FAQPage')}${body(1, 2, 3)}`, body(1, 2)),
    decide(`${LD('FAQPage')}${body(1, 2, 3)}`, body(7, 8, 9), true),
  ]) {
    assert.equal(d.action, 'hold');
    assert.equal(d.reinjectSchema, false);
  }
});

// ── the pin is retired, and the invariant that replaced it ──────────────────

test('PINNED_MIRROR_SLUGS is EMPTY — the strict-literal pin was retired', () => {
  // It pinned three mirrors so a reconcile could not break the remediation
  // plans' "BEFORE is present" assertions. Those assertions were relaxed to
  // "EITHER the BEFORE or the AFTER, never a third value", which tolerates a
  // remediation that has already shipped, so the pin has no job left.
  //
  // The pin had no expiry, and the cost was concrete: the tea-tree post — live,
  // indexed, 5,744 impressions/90d — kept a mirror that was a different, older
  // draft linking four DEAD product handles, so every publish was refused and
  // its buy box could never be rebuilt.
  assert.deepEqual([...PINNED_MIRROR_SLUGS], []);
});

test('every plan mirror carries EITHER its BEFORE or its AFTER — what makes unpinning safe', async () => {
  // This is the property the pin used to buy by brute force. Asserted here
  // across BOTH plans at once, because it is the reason a reconcile may now
  // overwrite these files: whatever the mirror holds, the plan can still find
  // itself in it, so no compliance entry goes unverifiable.
  const plans = await Promise.all([
    import('../../scripts/remediate-ingredient-benefit-headings.js'),
    import('../../scripts/remediate-tea-tree-11-benefits-post.js'),
  ]);
  let checked = 0;
  for (const mod of plans) {
    for (const entry of mod.PLAN) {
      if (entry.target?.kind !== 'file') continue;
      const html = readFileSync(join(ROOT, entry.target.path), 'utf8');
      const seen = occurrences(html, entry.before) + occurrences(html, entry.after);
      assert.equal(seen, entry.expectedOccurrences, `${entry.id}: drifted to a third value`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'precondition: the plans still carry mirror entries');
});

// ── applyMirrorReconcile — real files, real rollback ─────────────────────────
//
// Against a real temp directory rather than a stubbed fs: the whole point of
// this function is that a backup exists on disk before anything is overwritten,
// and a fake filesystem cannot fail the way a real one does.

test('applyMirrorReconcile backs up first, then installs the live body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-reconcile-'));
  const contentPath = join(dir, 'content.html');
  const backupPath = join(dir, 'backups', 'content-reconcile-STAMP.html');
  const local = body(1, 2, 3);
  const live = body(7, 8, 9);
  writeFileSync(contentPath, local);

  const out = applyMirrorReconcile({ contentPath, backupPath, liveHtml: live });

  assert.deepEqual(out, { applied: true, rolledBack: false, injectorError: null });
  assert.equal(readFileSync(contentPath, 'utf8'), live);
  assert.equal(readFileSync(backupPath, 'utf8'), local, 'the pre-image must survive verbatim');
  rmSync(dir, { recursive: true, force: true });
});

test('applyMirrorReconcile ROLLS BACK when no schema can be regenerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-reconcile-'));
  const contentPath = join(dir, 'content.html');
  const backupPath = join(dir, 'backups', 'content-reconcile-STAMP.html');
  const local = `${LD('FAQPage')}\n${body(1, 2, 3)}`;
  writeFileSync(contentPath, local);

  // The injector ran and left no JSON-LD behind at all. Leaving that on disk is
  // what hands agents/legacy-rebuilder a paid full rebuild the next morning.
  // (Under the retired FAQPage key this arm also fired when the injector
  // succeeded and simply emitted a BreadcrumbList — see the schemaRegression
  // swap test above for why that was wrong.)
  const out = applyMirrorReconcile({
    contentPath,
    backupPath,
    liveHtml: body(7, 8, 9),
    reinject: true,
    runInjector: (p) => writeFileSync(p, readFileSync(p, 'utf8')),
  });

  assert.deepEqual(out, { applied: false, rolledBack: true, injectorError: null });
  assert.equal(readFileSync(contentPath, 'utf8'), local, 'the mirror must be exactly as it was');
  assert.equal(readFileSync(backupPath, 'utf8'), local, 'the backup is kept even on a rollback');
  rmSync(dir, { recursive: true, force: true });
});

test('applyMirrorReconcile keeps the write when the injector restores schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-reconcile-'));
  const contentPath = join(dir, 'content.html');
  const backupPath = join(dir, 'backups', 'content-reconcile-STAMP.html');
  const live = body(7, 8, 9);
  writeFileSync(contentPath, `${LD('FAQPage')}\n${body(1, 2, 3)}`);

  const out = applyMirrorReconcile({
    contentPath,
    backupPath,
    liveHtml: live,
    reinject: true,
    runInjector: (p) => writeFileSync(p, `${LD('BreadcrumbList')}\n${readFileSync(p, 'utf8')}`),
  });

  assert.equal(out.applied, true);
  assert.equal(out.rolledBack, false);
  assert.equal(stripLdJson(readFileSync(contentPath, 'utf8')).trim(), live);
});

test('a failing injector is recorded, and still rolls back rather than shipping the loss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-reconcile-'));
  const contentPath = join(dir, 'content.html');
  const backupPath = join(dir, 'backups', 'content-reconcile-STAMP.html');
  const local = `${LD('FAQPage')}\n${body(1, 2, 3)}`;
  writeFileSync(contentPath, local);

  const out = applyMirrorReconcile({
    contentPath,
    backupPath,
    liveHtml: body(7, 8, 9),
    reinject: true,
    runInjector: () => { throw new Error('schema-injector exploded'); },
  });

  assert.match(out.injectorError, /exploded/);
  assert.equal(out.rolledBack, true, 'a crashed injector leaves no schema, which is a regression like any other');
  assert.equal(readFileSync(contentPath, 'utf8'), local);
  rmSync(dir, { recursive: true, force: true });
});

test('a mirror that never had schema is not rolled back for still not having it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-reconcile-'));
  const contentPath = join(dir, 'content.html');
  const backupPath = join(dir, 'backups', 'content-reconcile-STAMP.html');
  writeFileSync(contentPath, body(1, 2, 3));

  const out = applyMirrorReconcile({ contentPath, backupPath, liveHtml: body(7, 8, 9) });

  assert.equal(out.applied, true);
  assert.equal(out.rolledBack, false);
  rmSync(dir, { recursive: true, force: true });
});

test('with re-injection OFF, a mirror that had schema is still rolled back rather than shipped without it', () => {
  // `--no-reinject-schema` does not switch the legacy-rebuilder protection off —
  // it just means there is nothing to restore the schema, so every such post is
  // held. That is the honest consequence of the flag, not a bug in it.
  const dir = mkdtempSync(join(tmpdir(), 'mirror-reconcile-'));
  const contentPath = join(dir, 'content.html');
  const backupPath = join(dir, 'backups', 'content-reconcile-STAMP.html');
  const local = `${LD('FAQPage')}\n${body(1, 2, 3)}`;
  writeFileSync(contentPath, local);

  const out = applyMirrorReconcile({ contentPath, backupPath, liveHtml: body(7, 8, 9), reinject: false });

  assert.equal(out.rolledBack, true);
  assert.equal(readFileSync(contentPath, 'utf8'), local);
  rmSync(dir, { recursive: true, force: true });
});
