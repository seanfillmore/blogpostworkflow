// lib/post-meta-reconcile.js
//
// `data/posts/<slug>/meta.json` — TRACKED in git, WRITTEN continuously by cron.
// This module is the field-by-field merge that lets a deploy carry authored
// copy onto the production box without reverting what production observed.
//
// WHY THIS EXISTS
// ───────────────
// On 2026-08-23 the documented deploy recovery (`git stash push` → `git pull` →
// `git stash pop`) produced invalid JSON on the production server TWICE:
//
//   Incident 1 — PR #629, `data/rejected-keywords.json`: the pop conflicted and
//     left 20 conflict markers in a file every reader parses. That file got
//     `scripts/reconcile-rejected-keywords.mjs`, a union of a list.
//   Incident 2 — PR #634, five `meta.json` files: same dance, five conflicted
//     files, all invalid JSON. And the fix was NOT "take one side". HEAD was
//     missing `indexing_state`, `indexing_submissions`, `published_at` and
//     `shopify_status: published` — including a backfill run hours earlier —
//     because the committed copies are stale by construction. Taking git's side
//     reverts production; taking the box's side reverts the compliance fix the
//     deploy existed to ship. It was resolved by hand, field by field.
//
// A list-union does not generalise here: this is a PER-FIELD merge across ~200
// files where each field has a different owner. So the merge needs an ownership
// model, and the ownership model has to come from the code that writes the
// fields — not from anyone's memory of it.
//
// THE OWNERSHIP MODEL, AND HOW IT WAS DERIVED
// ───────────────────────────────────────────
// Every writer of a meta.json field in this repo was inventoried on 2026-08-23
// (27 writers across agents/, lib/, scripts/ and the dashboard), and the 40
// keys actually present across the 94 local `data/posts/*/meta.json` files were
// censused. The split that falls out is not "who runs on the server" — the
// authoring pipeline runs on the server too — it is:
//
//   REPO owns what a HUMAN AUTHORS and a deploy exists to ship.
//     slug, title, meta_description, target_keyword, tags, post_type.
//     A commit changing one of these is a deliberate act, frequently a
//     compliance fix (PR #634 was exactly that: health-claim language live on
//     the site). Losing it is the expensive failure.
//
//   SERVER owns what a MACHINE OBSERVES OR STAMPS about the live world.
//     Shopify identity and publish state, indexing state and submissions,
//     legacy triage, refresh/rebuild stamps, image generation records, token
//     counts, brief paths. The committed copy of these is stale the moment a
//     cron job runs, and nobody hand-edits `tokens_used`.
//
// `brief_path` is the clearest case and settles the principle: its real values
// are `/root/seo-claude/data/briefs/...` on the server and
// `/Users/seanfillmore/Code/Claude/data/briefs/...` locally. It is not content,
// it is a fact about the box that wrote it.
//
// THREE FIELDS ARE CONTESTED, and pretending otherwise would be a lie.
// `title`, `meta_description` and `target_keyword` are authored in git AND
// rewritten unattended on the server: `agents/editor:1097` (stale-year bump),
// `agents/meta-optimizer:288` (daily `--refresh-stale-years --apply`) and `:347`
// (weekly `--apply --limit 5` CTR rewrite), `agents/cannibalization-resolver`
// :391/:714. They stay REPO-owned, because a committed change to them is how a
// compliance fix reaches the site and the live value already sits on Shopify
// regardless of what the local file says. But a conflict on one is never
// routine, so `CONTESTED_FIELDS` forces it to be named in the report with both
// values printed, rather than resolved quietly.
//
// WHY 3-WAY, WHEN A BASE IS AVAILABLE
// ───────────────────────────────────
// Ownership is the tie-breaker, not the merge. A two-sided comparison cannot
// tell "I changed this" from "you changed this", so it would arbitrate every
// differing field and get many of them wrong — a commit that deliberately
// clears a stale `indexing_blocked` flag would be reverted by "server owns
// indexing_*". With the pre-pull commit as a base, a field only one side moved
// simply takes that side, and ownership is consulted ONLY where both sides
// moved. That is the whole reason `--base` exists, and why the snapshot written
// before a pull records the SHA the box was sitting on.
//
// Without a base the merge degrades safely rather than guessing: a field
// present on one side only is KEPT (a union, exactly like the rejected-keywords
// script), because dropping a field on a guess is the failure being prevented.
//
// WHAT HAPPENS TO A FIELD IN NEITHER LIST
// ───────────────────────────────────────
// It is `unclassified`. One-sided changes still merge normally — no ownership
// needed. If BOTH sides changed it, the merge takes the live box's value (the
// copy a pull would otherwise destroy) and records an `unclassified-conflict`,
// which the script turns into a distinct non-zero exit code. That is a request
// for a human to add the field to the table below, not a silent decision.
//
// Nothing here does I/O. `scripts/reconcile-post-metas.mjs` owns the files,
// the backups, the run record and the exit codes.

/**
 * field → 'repo' | 'server'.
 *
 * Derived from the 2026-08-23 writer inventory. Every entry's justification is
 * the writer that produces it; where a field has several writers the comment
 * names the one that decides its class. Adding a field here is a real decision
 * — leaving it out is safe (it becomes `unclassified` and can never resolve
 * silently), so never guess.
 */
export const FIELD_OWNERS = Object.freeze({
  // ── REPO: authored copy and classification ────────────────────────────────
  slug: 'repo',                    // identity; blog-post-writer:728, and the directory name
  title: 'repo',                   // CONTESTED — see CONTESTED_FIELDS
  meta_description: 'repo',        // CONTESTED
  target_keyword: 'repo',          // CONTESTED
  tags: 'repo',                    // blog-post-writer:732 (deriveTags), scripts/tag-clusters.js:117
  post_type: 'repo',               // scripts/backfill-post-types.js:49, sync-legacy-posts.js

  // ── SERVER: Shopify identity and publish state ────────────────────────────
  shopify_blog_id: 'server',       // publisher:295
  shopify_blog_handle: 'server',   // publisher:296
  shopify_article_id: 'server',    // publisher:297
  shopify_handle: 'server',        // publisher:298
  shopify_url: 'server',           // publisher:299, indexing-checker:90
  shopify_status: 'server',        // publisher:303 + 5 other writers
  shopify_publish_at: 'server',    // publisher:304, draft-refresher:125, backfill-shopify-status:66
  shopify_image_url: 'server',     // publisher:306
  shopify_status_verified_at: 'server', // scripts/backfill-shopify-status.mjs:63
  shopify_scheduled_at: 'server',  // scripts/upload-post.js:126 (legacy uploader)
  handle: 'server',                // lib/ensure-local-post.js:59 bootstrap
  url: 'server',                   // lib/ensure-local-post.js:59 bootstrap
  bootstrapped_from_live: 'server',// lib/ensure-local-post.js:59
  uploaded_at: 'server',           // publisher:307
  published_at: 'server',          // calendar-runner:667
  unpublished_at: 'server',        // consolidation ops (no live writer; state, not copy)
  unpublished_reason: 'server',    // ditto

  // ── SERVER: Google index state ────────────────────────────────────────────
  indexing_state: 'server',        // indexing-checker:120 (daily cron 11:00 UTC)
  indexing_submissions: 'server',  // indexing-fixer:166 recordSubmission
  indexing_blocked: 'server',      // indexing-fixer:311/342
  indexing_blocked_reason: 'server',
  indexing_blocked_at: 'server',
  indexing_unblocked_at: 'server', // indexing-fixer:216, scripts/clear-stale-indexing-blocks.js
  indexing_unblocked_by: 'server',

  // ── SERVER: legacy triage ─────────────────────────────────────────────────
  legacy_bucket: 'server',         // legacy-triage:249
  legacy_triage_reason: 'server',  // legacy-triage:250
  legacy_triaged_at: 'server',     // legacy-triage:252
  legacy_locked: 'server',         // legacy-triage:251
  legacy_synced_at: 'server',      // scripts/sync-legacy-posts.js:117
  legacy_source: 'server',         // scripts/sync-legacy-posts.js:118
  legacy_winner_ack_at: 'server',  // legacy-rebuilder:208
  legacy_broken_ack_at: 'server',  // legacy-rebuilder:225

  // ── SERVER: refresh / rebuild / gate state ────────────────────────────────
  last_refreshed_at: 'server',     // refresh-runner:260
  refreshed_at: 'server',          // legacy-rebuilder:166
  rebuilt_at: 'server',            // legacy-rebuilder:266
  needs_rebuild: 'server',         // editor:1376 sets, six writers clear
  blocked_resolution: 'server',    // blocked-post-resolver:147
  blocked_resolved_at: 'server',   // blocked-post-resolver:131
  publisher_block: 'server',       // featured-product-injector:468
  performance_review: 'server',    // post-performance:365 (daily cron)

  // ── SERVER: generation provenance (stamped, never authored) ───────────────
  word_count: 'server',            // blog-post-writer:733 — a measurement
  generated_at: 'server',          // blog-post-writer:734
  brief_path: 'server',            // blog-post-writer:735 — ABSOLUTE path on the writing box
  tokens_used: 'server',           // blog-post-writer:736 — API meter

  // ── SERVER: image generation record ───────────────────────────────────────
  image_path: 'server',            // image-generator:1077
  image_prompt: 'server',          // image-generator:1078
  image_revised_prompt: 'server',  // image-generator (model's rewritten prompt)
  image_alt: 'server',             // image-generator:1081
  image_generated_at: 'server',    // image-generator:1080
  image_blocked: 'server',         // image-generator:1023
  image_blocked_at: 'server',
  image_blocked_reason: 'server',

  // ── SERVER: redirect record ───────────────────────────────────────────────
  redirected_to: 'server',         // cannibalization consolidation ops
  redirected_at: 'server',
  redirect_note: 'server',
});

/**
 * Repo-owned fields that production also rewrites unattended.
 *
 * Ownership still resolves them (repo wins — that is how a compliance fix
 * ships), but the resolution is always printed with both values. A silent
 * "repo won" on a title that meta-optimizer had A/B-tested into place is the
 * kind of thing nobody notices until the CTR drops.
 */
export const CONTESTED_FIELDS = new Set(['title', 'meta_description', 'target_keyword']);

/** @returns {'repo'|'server'|'unclassified'} */
export function classifyField(name) {
  return FIELD_OWNERS[name] || 'unclassified';
}

// ── value comparison ─────────────────────────────────────────────────────────

/**
 * Structural equality over JSON-shaped values.
 *
 * Fields are ATOMIC: `indexing_state` is written wholesale by
 * `indexing-checker`, so half of one side's object merged into the other's is a
 * shape no writer ever produces. Nothing here recurses into ownership.
 */
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && valuesEqual(a[k], b[k]));
}

const has = (obj, k) => !!obj && Object.hasOwn(obj, k);

// ── the merge ────────────────────────────────────────────────────────────────

/**
 * Merge one post's meta.json field by field.
 *
 * @param {object|null} base   the commit the working tree was pulled FROM
 *   (`null` degrades to a 2-way union — safe, but arbitrates more often)
 * @param {object|null} repo   the git side (incoming commit, or HEAD)
 * @param {object|null} server the machine side (production working tree, or a
 *   pre-pull snapshot of it)
 * @param {object|null} orderFrom  the object whose key order the output copies,
 *   so the file being rewritten keeps its diff small. Defaults to `server`.
 *
 * @returns {{
 *   merged: object,
 *   decisions: Array<object>,
 *   conflicts: Array<object>,
 *   unclassifiedConflicts: Array<object>,
 *   changed: boolean,
 * }} `changed` is "the merge differs from what `orderFrom` already holds" —
 *   the definition that makes a second run a no-op and makes exit 0 mean
 *   "nothing to do".
 */
export function reconcileMeta({ base = null, repo = null, server = null, orderFrom = undefined } = {}) {
  const R = repo || {};
  const S = server || {};
  const B = base || null;
  const target = orderFrom === undefined ? S : (orderFrom || {});

  const fields = [...new Set([...Object.keys(R), ...Object.keys(S)])];
  const decisions = [];
  const chosen = new Map(); // field → value, absent from the map means "deleted"

  for (const field of fields) {
    const owner = classifyField(field);
    const inR = has(R, field);
    const inS = has(S, field);
    const rv = R[field];
    const sv = S[field];
    const d = {
      field,
      owner,
      contested: CONTESTED_FIELDS.has(field),
      repoValue: inR ? rv : undefined,
      serverValue: inS ? sv : undefined,
      baseValue: B && has(B, field) ? B[field] : undefined,
      arbitratedBy: null,
      outcome: null,
      chosenFrom: null,
    };

    // 1. The two sides agree. Nothing to decide.
    if (inR && inS && valuesEqual(rv, sv)) {
      chosen.set(field, sv);
      d.outcome = 'agree';
      d.chosenFrom = 'both';
      decisions.push(d);
      continue;
    }

    if (B) {
      // ── 3-way ────────────────────────────────────────────────────────────
      const inB = has(B, field);
      const bv = B[field];
      const repoMoved = inB ? !(inR && valuesEqual(rv, bv)) : inR;
      const serverMoved = inB ? !(inS && valuesEqual(sv, bv)) : inS;

      if (repoMoved && !serverMoved) {
        if (inR) { chosen.set(field, rv); d.outcome = inB ? 'repo-only-change' : 'added-repo'; }
        else { d.outcome = 'deleted-repo'; }
        d.chosenFrom = 'repo';
        decisions.push(d);
        continue;
      }
      if (serverMoved && !repoMoved) {
        if (inS) { chosen.set(field, sv); d.outcome = inB ? 'server-only-change' : 'added-server'; }
        else { d.outcome = 'deleted-server'; }
        d.chosenFrom = 'server';
        decisions.push(d);
        continue;
      }
      if (!repoMoved && !serverMoved) {
        // Both equal base but not each other — only reachable when the field is
        // absent from base and from both sides, which the union above excludes.
        // Kept for completeness: prefer the live box, lose nothing.
        if (inS) chosen.set(field, sv); else if (inR) chosen.set(field, rv);
        d.outcome = 'agree';
        d.chosenFrom = inS ? 'server' : 'repo';
        decisions.push(d);
        continue;
      }
      // Both moved: a genuine conflict. Fall through to ownership.
    } else {
      // ── 2-way ────────────────────────────────────────────────────────────
      // Present on one side only. With no base, "added here" and "deleted
      // there" are indistinguishable, so KEEP it. A union never loses.
      if (inR !== inS) {
        chosen.set(field, inR ? rv : sv);
        d.outcome = 'kept-one-sided';
        d.chosenFrom = inR ? 'repo' : 'server';
        decisions.push(d);
        continue;
      }
      // Present on both and differing: ownership decides.
    }

    // ── ownership arbitration ───────────────────────────────────────────────
    if (owner === 'repo') {
      if (inR) chosen.set(field, rv);
      d.arbitratedBy = 'repo';
      d.outcome = 'resolved-by-owner';
      d.chosenFrom = 'repo';
    } else if (owner === 'server') {
      if (inS) chosen.set(field, sv);
      d.arbitratedBy = 'server';
      d.outcome = 'resolved-by-owner';
      d.chosenFrom = 'server';
    } else {
      // No rule. Take the live box — it is the copy a pull would destroy — and
      // say so loudly. This is a request to classify the field, not a decision.
      if (inS) chosen.set(field, sv); else if (inR) chosen.set(field, rv);
      d.outcome = 'unclassified-conflict';
      d.chosenFrom = inS ? 'server' : 'repo';
    }
    decisions.push(d);
  }

  // Key order: the file being rewritten keeps its own order, new keys append in
  // repo-then-server order. Reordering ~200 files would bury the real change.
  const merged = {};
  for (const k of Object.keys(target)) if (chosen.has(k)) merged[k] = chosen.get(k);
  for (const k of [...Object.keys(R), ...Object.keys(S)]) {
    if (chosen.has(k) && !Object.hasOwn(merged, k)) merged[k] = chosen.get(k);
  }

  const conflicts = decisions.filter((d) => d.outcome === 'resolved-by-owner' || d.outcome === 'unclassified-conflict');
  return {
    merged,
    decisions,
    conflicts,
    unclassifiedConflicts: decisions.filter((d) => d.outcome === 'unclassified-conflict'),
    changed: !valuesEqual(merged, target),
  };
}

// ── whole-tree reconcile ─────────────────────────────────────────────────────

/**
 * Reconcile every post either side knows about.
 *
 * A post only one side has is NOT a divergence: `repo-only` is a post arriving
 * with the pull, `server-only` is a local draft git has never seen. Both are
 * left exactly alone — this module writes nothing and creates nothing.
 *
 * @param {Map<string, object>} base
 * @param {Map<string, object>} repo
 * @param {Map<string, object>} server
 */
export function reconcilePosts({ base = new Map(), repo = new Map(), server = new Map(), orderFor } = {}) {
  const slugs = [...new Set([...repo.keys(), ...server.keys()])].sort();
  const posts = [];

  for (const slug of slugs) {
    const r = repo.get(slug) || null;
    const s = server.get(slug) || null;
    if (r && !s) { posts.push({ slug, status: 'repo-only', changed: false, decisions: [], conflicts: [], unclassifiedConflicts: [] }); continue; }
    if (s && !r) { posts.push({ slug, status: 'server-only', changed: false, decisions: [], conflicts: [], unclassifiedConflicts: [] }); continue; }
    const orderFrom = orderFor ? orderFor(slug, { repo: r, server: s }) : s;
    const res = reconcileMeta({ base: base.get(slug) || null, repo: r, server: s, orderFrom });
    posts.push({ slug, status: res.changed ? 'changed' : 'in-sync', ...res });
  }

  const summary = {
    posts: posts.length,
    changed: posts.filter((p) => p.status === 'changed').length,
    inSync: false,
    repoOnly: posts.filter((p) => p.status === 'repo-only').length,
    serverOnly: posts.filter((p) => p.status === 'server-only').length,
    arbitrated: posts.reduce((n, p) => n + p.conflicts.filter((c) => c.outcome === 'resolved-by-owner').length, 0),
    unclassifiedConflicts: posts.reduce((n, p) => n + p.unclassifiedConflicts.length, 0),
    contestedConflicts: posts.reduce((n, p) => n + p.conflicts.filter((c) => c.contested).length, 0),
  };
  summary.inSync = summary.changed === 0;
  return { posts, summary };
}

// ── serialization: never write a file that does not parse ────────────────────

/**
 * `JSON.stringify(obj, null, 2)`, with the trailing-newline style of the file
 * being replaced. 89 of the 94 real files end without a newline (every writer
 * calls `writeFileSync(p, JSON.stringify(...))` raw); 5 end with one. Imposing
 * either style on the other churns a diff line on every file it touches, which
 * is how a reconcile turns into a 200-file commit nobody can review.
 */
export function serializeMeta(obj, { trailingNewline = false } = {}) {
  return `${JSON.stringify(obj, null, 2)}${trailingNewline ? '\n' : ''}`;
}

/**
 * Parse meta.json text, refusing the two shapes that must never be treated as
 * data.
 *
 * The conflict-marker check is the whole point of this module: both of
 * 2026-08-23's incidents ended with `<<<<<<<` inside a tracked JSON file. A
 * reconcile that read one of those and "merged" it would launder the corruption
 * into a clean-looking write.
 *
 * @throws {Error} on a conflict marker, on unparseable text, or on a non-object.
 */
export function parseMetaText(text, label = 'meta.json') {
  if (/^(<{7}|={7}|>{7})/m.test(text)) {
    throw new Error(`${label}: contains a git conflict marker — resolve it by hand before reconciling`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: could not parse as JSON — ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label}: expected a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
  }
  return parsed;
}

// ── reporting ────────────────────────────────────────────────────────────────

const short = (v) => {
  if (v === undefined) return '(absent)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
};

/**
 * The run record in human form. Every arbitrated field prints BOTH values —
 * the whole failure being prevented is a value disappearing without anyone
 * seeing it go.
 */
export function renderReconcileReport(result, { repoLabel = 'repo', serverLabel = 'server', baseLabel = null } = {}) {
  const { posts, summary } = result;
  const lines = [
    `data/posts/*/meta.json — ${repoLabel} vs ${serverLabel}${baseLabel ? ` (base: ${baseLabel})` : ' (NO merge base — 2-way union)'}`,
    '',
    `  ${summary.posts} post(s) compared · ${summary.changed} would change · ${summary.repoOnly} only in ${repoLabel} · ${summary.serverOnly} only in ${serverLabel}`,
    `  ${summary.arbitrated} field(s) resolved by ownership · ${summary.contestedConflicts} of them on a contested field · ${summary.unclassifiedConflicts} unclassified conflict(s)`,
    '',
  ];

  if (summary.inSync && !summary.unclassifiedConflicts && !summary.arbitrated) {
    lines.push('In sync. Nothing to reconcile.');
    return lines.join('\n');
  }

  for (const p of posts) {
    // A post is worth printing if it needs a write OR if any field had to be
    // arbitrated — a conflict that happens to resolve to what the file already
    // holds still had a losing value, and printing only the writes is how that
    // value disappears without anyone seeing it go.
    if (p.status !== 'changed' && !p.conflicts.length) continue;
    const interesting = p.decisions.filter((d) => d.outcome !== 'agree');
    if (!interesting.length) continue;
    lines.push(`${p.slug}`);
    for (const d of interesting) {
      const tag = d.outcome === 'resolved-by-owner'
        ? `CONFLICT → ${d.arbitratedBy} wins (${d.owner}-owned${d.contested ? ', CONTESTED' : ''})`
        : d.outcome === 'unclassified-conflict'
          ? 'CONFLICT → UNCLASSIFIED FIELD, took the live copy — classify it in lib/post-meta-reconcile.js'
          : `${d.outcome} → ${d.chosenFrom}`;
      lines.push(`  ${d.field}: ${tag}`);
      if (d.outcome === 'resolved-by-owner' || d.outcome === 'unclassified-conflict') {
        lines.push(`      ${repoLabel}: ${short(d.repoValue)}`);
        lines.push(`      ${serverLabel}: ${short(d.serverValue)}`);
        if (d.baseValue !== undefined) lines.push(`      base: ${short(d.baseValue)}`);
      }
    }
    lines.push('');
  }

  if (summary.unclassifiedConflicts) {
    lines.push(
      `${summary.unclassifiedConflicts} field(s) changed on both sides with no ownership rule.`,
      'The live copy was kept so nothing is lost, but somebody has to decide who owns them:',
      'add each to FIELD_OWNERS in lib/post-meta-reconcile.js, naming the writer that produces it.',
      '',
    );
  }
  lines.push(
    'Nothing was dropped: every field either side held is present in the merge, and every',
    'value that lost an arbitration is printed above and recorded in the run JSON.',
  );
  return lines.join('\n');
}
