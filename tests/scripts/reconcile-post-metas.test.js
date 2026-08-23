// tests/scripts/reconcile-post-metas.test.js
//
// End-to-end against real git. Each test builds an "upstream" repo and a clone
// standing in for the production box, dirties the clone's working tree the way
// cron does, lands a compliance commit upstream, and then runs the real script
// as a child process — so exit codes, backups, refusals and the run record are
// all exercised the way a deploy would exercise them.
//
// The scenario is 2026-08-23's incident 2 (PR #634): five meta.json files where
// the committed copies were missing `indexing_state`, `indexing_submissions`,
// `published_at` and `shopify_status: published` (including a backfill run
// hours earlier), while the box was missing the compliance edit to `title`.
// `git stash push && git pull && git stash pop` conflicted all five into
// invalid JSON. The assertions below are the two things that has to stop doing:
// the pull must not text-merge these paths at all, and the merged file must
// carry BOTH sides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'reconcile-post-metas.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Run the script against `root`. Never throws — the exit code is the subject. */
function run(root, args = []) {
  const res = execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SEO_CLAUDE_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
    // execFileSync throws on non-zero, and every interesting case here is
    // non-zero, so catch and normalise instead.
  });
  return { code: 0, stdout: res, stderr: '' };
}

function runAllowFail(root, args = []) {
  try { return run(root, args); }
  catch (err) { return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }; }
}

const metaPath = (root, slug) => join(root, 'data', 'posts', slug, 'meta.json');
const readMeta = (root, slug) => JSON.parse(readFileSync(metaPath(root, slug), 'utf8'));

/** The committed state of best-soap-for-tattoos before PR #634. */
const COMMITTED = {
  slug: 'best-soap-for-tattoos',
  title: 'Best Soap for Tattoos: What to Use for Safe Healing',
  meta_description: 'Looking for the best soap for tattoos? Learn what ingredients to look for, what to avoid, and how a natural bar soap supports healthy tattoo aftercare.',
  target_keyword: 'best soap for tattoos',
  tags: ['soap', 'natural soap', 'natural skincare', 'organic'],
  word_count: 3009,
  brief_path: '/root/seo-claude/data/briefs/best-soap-for-tattoos.json',
  shopify_blog_id: 48998449187,
  shopify_article_id: 563424362666,
  shopify_status: 'draft',
  legacy_bucket: 'winner',
  legacy_locked: true,
};

/** What cron had stamped on the box since that commit. */
const CRON_STAMPS = {
  shopify_status: 'published',
  shopify_status_verified_at: '2026-08-23T04:10:00.000Z',
  published_at: '2026-04-24T15:00:02.049Z',
  indexing_state: {
    state: 'discovered_not_crawled',
    coverage: 'Discovered - currently not indexed',
    last_checked: '2026-08-22T13:12:37.716Z',
    last_crawled: null,
    google_canonical: null,
    canonical_mismatch: false,
    page_fetch_state: 'PAGE_FETCH_STATE_UNSPECIFIED',
  },
  indexing_submissions: [{ method: 'sitemap_resubmit', submitted_at: '2026-08-09T13:13:53.025Z', result: 'ok' }],
  legacy_triaged_at: '2026-08-04T03:55:43.000Z',
};

/**
 * upstream repo + a clone standing in for the production box.
 * 89 of 94 real meta.json files carry no trailing newline, so neither do these.
 */
function scenario({ slugs = ['best-soap-for-tattoos'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'meta-reconcile-'));
  const upstream = join(dir, 'upstream');
  const server = join(dir, 'server');

  mkdirSync(upstream, { recursive: true });
  git(upstream, ['init', '-q', '-b', 'main']);
  git(upstream, ['config', 'user.email', 'test@example.com']);
  git(upstream, ['config', 'user.name', 'Test']);
  for (const slug of slugs) {
    mkdirSync(join(upstream, 'data', 'posts', slug), { recursive: true });
    writeFileSync(join(upstream, 'data', 'posts', slug, 'meta.json'), JSON.stringify({ ...COMMITTED, slug }, null, 2));
  }
  git(upstream, ['add', '-A']);
  git(upstream, ['commit', '-q', '-m', 'base']);

  git(dir, ['clone', '-q', upstream, server]);
  git(server, ['config', 'user.email', 'test@example.com']);
  git(server, ['config', 'user.name', 'Test']);

  return {
    dir, upstream, server, slugs,
    /** cron writes on the box */
    stampCron(slug = slugs[0], extra = CRON_STAMPS) {
      const p = metaPath(server, slug);
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...extra }, null, 2));
    },
    /** a compliance commit lands upstream */
    commitUpstream(patch, message = 'fix(compliance): tone down live health claims') {
      for (const slug of slugs) {
        const p = join(upstream, 'data', 'posts', slug, 'meta.json');
        writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...patch }, null, 2));
      }
      git(upstream, ['add', '-A']);
      git(upstream, ['commit', '-q', '-m', message]);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const NEW_TITLE = 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free';

// ─────────────────────────────────────────────────────────────────────────────

test('the full corrected deploy sequence loses neither side, and the pull never conflicts', () => {
  const s = scenario();
  try {
    s.stampCron();
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);

    // 1. DETECT, before the pull. Exit 1 is the gate.
    const detect = runAllowFail(s.server, ['--ref', 'origin/main']);
    assert.equal(detect.code, 1, 'divergence must exit 1 so a deploy can gate on it');
    assert.match(detect.stdout, /best-soap-for-tattoos/);

    // 2. SNAPSHOT the box's truth.
    const snap = runAllowFail(s.server, ['--snapshot']);
    assert.equal(snap.code, 0);
    const snapDir = readdirSync(join(s.server, 'data', 'reports', 'post-meta-reconcile'))
      .filter((d) => d.startsWith('snapshot-')).map((d) => join(s.server, 'data', 'reports', 'post-meta-reconcile', d))[0];
    assert.ok(snapDir, 'a snapshot directory should exist');
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.head_sha, git(s.server, ['rev-parse', 'HEAD']).trim(), 'the manifest must record the pre-pull SHA — it is the merge base');
    assert.deepEqual(JSON.parse(readFileSync(join(snapDir, 'metas', 'best-soap-for-tattoos.json'), 'utf8')).indexing_state, CRON_STAMPS.indexing_state);

    // 3. Reset the paths and pull. THIS is the step the stash dance got wrong:
    //    with the box's truth on disk, git is never asked to text-merge a
    //    machine-written JSON file, so there is nothing to conflict.
    git(s.server, ['checkout', '--', 'data/posts']);
    const pull = git(s.server, ['pull', '-q', '--ff-only', 'origin', 'main']);
    assert.ok(typeof pull === 'string', 'the pull must fast-forward cleanly');
    assert.equal(readMeta(s.server, 'best-soap-for-tattoos').title, NEW_TITLE);
    assert.equal(readMeta(s.server, 'best-soap-for-tattoos').shopify_status, 'draft', 'the pull did revert the box, as expected — step 4 puts it back');

    // 4. RECONCILE the snapshot back in.
    const apply = runAllowFail(s.server, ['--against', snapDir, '--apply']);
    assert.equal(apply.code, 0, apply.stdout + apply.stderr);

    const merged = readMeta(s.server, 'best-soap-for-tattoos');
    // The PR's authored change survived.
    assert.equal(merged.title, NEW_TITLE);
    // Everything cron stamped survived — this is what the stash pop destroyed.
    assert.equal(merged.shopify_status, 'published');
    assert.equal(merged.published_at, CRON_STAMPS.published_at);
    assert.equal(merged.shopify_status_verified_at, CRON_STAMPS.shopify_status_verified_at);
    assert.deepEqual(merged.indexing_state, CRON_STAMPS.indexing_state);
    assert.deepEqual(merged.indexing_submissions, CRON_STAMPS.indexing_submissions);
    assert.equal(merged.legacy_triaged_at, CRON_STAMPS.legacy_triaged_at);
    // And nothing authored was lost either.
    assert.deepEqual(merged.tags, COMMITTED.tags);
    assert.equal(merged.meta_description, COMMITTED.meta_description);
  } finally { s.cleanup(); }
});

test('the merged file is valid JSON with no conflict markers', () => {
  const s = scenario();
  try {
    s.stampCron();
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);
    const snapDir = (() => {
      runAllowFail(s.server, ['--snapshot']);
      const base = join(s.server, 'data', 'reports', 'post-meta-reconcile');
      return join(base, readdirSync(base).find((d) => d.startsWith('snapshot-')));
    })();
    git(s.server, ['checkout', '--', 'data/posts']);
    git(s.server, ['pull', '-q', '--ff-only', 'origin', 'main']);
    runAllowFail(s.server, ['--against', snapDir, '--apply']);

    const text = readFileSync(metaPath(s.server, 'best-soap-for-tattoos'), 'utf8');
    assert.ok(!/<{7}|={7}|>{7}/.test(text), 'no conflict markers');
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(!text.endsWith('\n'), 'the file had no trailing newline and must not gain one');
  } finally { s.cleanup(); }
});

test('applying is idempotent — a second run writes nothing and exits 0', () => {
  const s = scenario();
  try {
    s.stampCron();
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);
    const base = join(s.server, 'data', 'reports', 'post-meta-reconcile');
    runAllowFail(s.server, ['--snapshot']);
    const snapDir = join(base, readdirSync(base).find((d) => d.startsWith('snapshot-')));
    git(s.server, ['checkout', '--', 'data/posts']);
    git(s.server, ['pull', '-q', '--ff-only', 'origin', 'main']);

    const first = runAllowFail(s.server, ['--against', snapDir, '--apply']);
    assert.equal(first.code, 0);
    const afterFirst = readFileSync(metaPath(s.server, 'best-soap-for-tattoos'), 'utf8');

    const second = runAllowFail(s.server, ['--against', snapDir, '--apply']);
    assert.equal(second.code, 0);
    assert.equal(readFileSync(metaPath(s.server, 'best-soap-for-tattoos'), 'utf8'), afterFirst, 'byte-identical');
    assert.match(second.stdout, /In sync|0 would change/);
  } finally { s.cleanup(); }
});

test('a backup of every file it touches is written BEFORE the file is', () => {
  const s = scenario();
  try {
    s.stampCron();
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);
    const base = join(s.server, 'data', 'reports', 'post-meta-reconcile');
    runAllowFail(s.server, ['--snapshot']);
    const snapDir = join(base, readdirSync(base).find((d) => d.startsWith('snapshot-')));
    git(s.server, ['checkout', '--', 'data/posts']);
    git(s.server, ['pull', '-q', '--ff-only', 'origin', 'main']);
    const preWrite = readFileSync(metaPath(s.server, 'best-soap-for-tattoos'), 'utf8');

    runAllowFail(s.server, ['--against', snapDir, '--apply']);
    const runDir = join(base, readdirSync(base).find((d) => d.startsWith('run-')));
    const backup = join(runDir, 'backup', 'best-soap-for-tattoos.json');
    assert.ok(existsSync(backup), 'a backup must exist');
    assert.equal(readFileSync(backup, 'utf8'), preWrite, 'the backup is the file as it was, not as it became');
  } finally { s.cleanup(); }
});

test('the run record names every field-level decision, including the value that lost', () => {
  const s = scenario();
  try {
    // Both sides move `title`: meta-optimizer rewrote it on the box for CTR,
    // the compliance commit rewrote it in git.
    s.stampCron('best-soap-for-tattoos', { ...CRON_STAMPS, title: 'Tattoo Soap — Fragrance-Free (CTR variant B)' });
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);

    const detect = runAllowFail(s.server, ['--ref', 'origin/main']);
    assert.equal(detect.code, 1);

    const latest = JSON.parse(readFileSync(join(s.server, 'data', 'reports', 'post-meta-reconcile', 'latest.json'), 'utf8'));
    const post = latest.decisions.find((d) => d.slug === 'best-soap-for-tattoos');
    const titleDecision = post.fields.find((f) => f.field === 'title');
    assert.equal(titleDecision.outcome, 'resolved-by-owner');
    assert.equal(titleDecision.arbitratedBy, 'repo');
    assert.equal(titleDecision.contested, true);
    assert.equal(titleDecision.repoValue, NEW_TITLE);
    assert.equal(titleDecision.serverValue, 'Tattoo Soap — Fragrance-Free (CTR variant B)', 'the losing value must be recorded');
    // The ownership table itself is in the record, so a run stays explicable
    // after the table changes.
    assert.equal(latest.field_owners.title, 'repo');
    assert.equal(latest.field_owners.indexing_state, 'server');
    assert.ok(latest.contested_fields.includes('title'));
    // And the report says it out loud.
    assert.match(detect.stdout, /CTR variant B/);
  } finally { s.cleanup(); }
});

test('a field with no owner that both sides changed exits 2, not 0', () => {
  const s = scenario();
  try {
    s.stampCron('best-soap-for-tattoos', { ...CRON_STAMPS, some_new_agent_field: 'from the box' });
    s.commitUpstream({ some_new_agent_field: 'from git' });
    git(s.server, ['fetch', '-q', 'origin']);
    const r = runAllowFail(s.server, ['--ref', 'origin/main', '--apply']);
    assert.equal(r.code, 2, 'an unclassified both-sides conflict must not exit 0 even after --apply');
    assert.match(r.stdout, /UNCLASSIFIED FIELD/);
    assert.match(r.stdout, /classify it in lib\/post-meta-reconcile\.js/);
    // Nothing lost: the live box's value is what survived.
    assert.equal(readMeta(s.server, 'best-soap-for-tattoos').some_new_agent_field, 'from the box');
  } finally { s.cleanup(); }
});

test('a conflict-markered file is REFUSED, not laundered into a clean write', () => {
  const s = scenario();
  try {
    s.stampCron();
    // What a `git stash pop` left behind on 2026-08-23.
    const broken = '{\n  "slug": "best-soap-for-tattoos",\n<<<<<<< Updated upstream\n  "title": "A"\n=======\n  "title": "B"\n>>>>>>> Stashed changes\n}';
    writeFileSync(metaPath(s.server, 'best-soap-for-tattoos'), broken);
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);

    const r = runAllowFail(s.server, ['--ref', 'origin/main', '--apply']);
    assert.equal(r.code, 3, 'a file it cannot parse must exit 3');
    assert.match(r.stderr, /conflict marker/i);
    assert.equal(readFileSync(metaPath(s.server, 'best-soap-for-tattoos'), 'utf8'), broken, 'the broken file must be left exactly as it was');
  } finally { s.cleanup(); }
});

test('--slug restricts the run to one post, so a fix can be rehearsed before bulk-applying', () => {
  const s = scenario({ slugs: ['best-soap-for-tattoos', 'no-fluoride-toothpaste'] });
  try {
    s.stampCron('best-soap-for-tattoos');
    s.stampCron('no-fluoride-toothpaste');
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);

    const r = runAllowFail(s.server, ['--ref', 'origin/main', '--slug', 'best-soap-for-tattoos', '--apply']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(readMeta(s.server, 'best-soap-for-tattoos').title, NEW_TITLE);
    // Untouched: still carries the box's state and the OLD title, because the
    // pull has not happened for it in this direction.
    assert.equal(readMeta(s.server, 'no-fluoride-toothpaste').title, COMMITTED.title);
    const latest = JSON.parse(readFileSync(join(s.server, 'data', 'reports', 'post-meta-reconcile', 'latest.json'), 'utf8'));
    assert.equal(latest.only_slug, 'best-soap-for-tattoos');
    assert.equal(latest.summary.posts, 1);
  } finally { s.cleanup(); }
});

test('a post only one side has is left alone and is not a divergence', () => {
  const s = scenario();
  try {
    // A local draft git has never seen.
    mkdirSync(join(s.server, 'data', 'posts', 'brand-new-draft'), { recursive: true });
    writeFileSync(join(s.server, 'data', 'posts', 'brand-new-draft', 'meta.json'), JSON.stringify({ slug: 'brand-new-draft', title: 'Draft' }, null, 2));
    const r = runAllowFail(s.server, []);
    assert.equal(r.code, 0, 'an untracked local post is not a divergence');
    assert.ok(existsSync(join(s.server, 'data', 'posts', 'brand-new-draft', 'meta.json')));
    const latest = JSON.parse(readFileSync(join(s.server, 'data', 'reports', 'post-meta-reconcile', 'latest.json'), 'utf8'));
    assert.equal(latest.summary.serverOnly, 1);
  } finally { s.cleanup(); }
});

test('detect mode writes nothing', () => {
  const s = scenario();
  try {
    s.stampCron();
    s.commitUpstream({ title: NEW_TITLE });
    git(s.server, ['fetch', '-q', 'origin']);
    const before = readFileSync(metaPath(s.server, 'best-soap-for-tattoos'), 'utf8');
    const r = runAllowFail(s.server, ['--ref', 'origin/main']);
    assert.equal(r.code, 1);
    assert.equal(readFileSync(metaPath(s.server, 'best-soap-for-tattoos'), 'utf8'), before);
  } finally { s.cleanup(); }
});

test('--snapshot prints the snapshot path in the one shape CLAUDE.md parses', () => {
  // CLAUDE.md's deploy sequence resolves the snapshot directory on the box with
  // `sed -n "s/.*→ //p"`, so exactly one line of this output may contain "→".
  // If that stops being true the documented deploy silently snapshots to one
  // directory and reconciles against another.
  const s = scenario();
  try {
    s.stampCron();
    const r = runAllowFail(s.server, ['--snapshot']);
    assert.equal(r.code, 0);
    const arrowLines = r.stdout.split('\n').filter((l) => l.includes('→'));
    assert.equal(arrowLines.length, 1, `expected exactly one "→" line, got:\n${arrowLines.join('\n')}`);
    const extracted = arrowLines[0].replace(/.*→ /, '').trim();
    assert.ok(existsSync(join(extracted, 'manifest.json')), `extracted path should be the snapshot dir, got ${extracted}`);
    assert.ok(existsSync(join(extracted, 'metas')));
  } finally { s.cleanup(); }
});

test('with no divergence at all, exit 0 and say so', () => {
  const s = scenario();
  try {
    const r = runAllowFail(s.server, ['--ref', 'origin/main']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /In sync/);
  } finally { s.cleanup(); }
});
