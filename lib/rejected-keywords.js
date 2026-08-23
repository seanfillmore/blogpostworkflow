// lib/rejected-keywords.js
//
// data/rejected-keywords.json — one writer, and a merge that cannot lose an
// entry.
//
// WHAT THIS FILE IS
// ─────────────────
// The record of every keyword the fleet has been told not to write about:
// operator policy (brand conflicts), auto-rejections from
// `agents/content-strategist` when a proposal maps to no product, keywords
// retired by `lib/post-kill.js`, and dashboard rejections. Nine agents read it;
// it is the last gate before `agents/calendar-runner` spends a full paid
// content pipeline on a topic.
//
// WHY IT NEEDED A MODULE
// ──────────────────────
// It is TRACKED in git and WRITTEN by production, which is the combination
// CLAUDE.md's server-authoritative rule exists to warn about. Audited
// 2026-08-23: **39 entries on the server, 2 committed** — last commit
// 2026-04-08 (`6c89b2f7`). 37 entries exist nowhere but the production box.
//
// It is NOT gitignored, and must not be. This is a record of decisions, some of
// them human, that cannot be regenerated from anything — the same reasoning
// that keeps `data/briefs/_dropped/` tracked: "an untracked archive is the
// condition that made the original loss unrecoverable."
//
// Two ways it could have been lost, and where each now stands:
//
// 1. A DEPLOY CLOBBER. `git pull` on a tracked file with local modifications is
//    the deploy-hygiene hazard CLAUDE.md documents; the `git stash push && git
//    pull && git stash pop` recovery ends in a hand-resolved conflict, and
//    resolving it the wrong way silently reverts 37 rejections and sets the
//    strategist re-proposing keywords Sean already rejected — 18 of them
//    straight into a paid research + writing pipeline each.
//    **This has NOT happened.** The 18 `content-strategist:product-scope`
//    entries match the 18 `[SKIP] Off product scope` lines in
//    `data/reports/scheduler/scheduler.log` one-for-one, the server's reflog
//    (back to 2026-05-10) holds only fast-forward pulls and mixed resets, and
//    both committed keywords are still present. It survives only because no
//    commit has touched the file since April, so a pull has never had to
//    reconcile it. `scripts/reconcile-rejected-keywords.mjs` is what keeps that
//    true once one does; `diffRejections` below is its engine.
//
// 2. A LOST UPDATE. All four writers did `readFileSync → push → writeFileSync`
//    with no lock, no re-read and no atomic rename. `content-strategist` writes
//    from the 15:00 UTC cron scheduler while the long-lived PM2 `seo-dashboard`
//    process writes from two routes; a dashboard rejection submitted mid-run
//    silently lost one side. `appendRejection` re-reads and merges immediately
//    before writing, and writes through a temp file + rename so a crash cannot
//    leave a truncated JSON array that every reader then parses as `[]`.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
// ─────────────────────────────────────────
// It does not touch matching. Nine readers hand-roll `isRejected` with three
// different semantics for `matchType: 'exact'` (raw string / slug-normalized /
// exact-only-ignoring-matchType), a divergence pinned by
// `tests/agents/rejected-keywords.test.js`. Unifying them changes which
// keywords are blocked across the whole fleet and belongs in its own change.
// This module governs the FILE, not the rule.

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolved at CALL time, not import time, and honouring `SEO_CLAUDE_ROOT` for
 * the same reason lib/posts.js does: a test that exercises `lib/post-kill.js`
 * points that variable at a scratch directory, and a path frozen at import
 * would send the write to the real data tree instead. Production never sets it.
 * (Read lib/posts.js's note on why that name must never appear in `.env`.)
 */
export function rejectedKeywordsPath() {
  return join(process.env.SEO_CLAUDE_ROOT || MODULE_ROOT, 'data', 'rejected-keywords.json');
}

const key = (k) => String(k ?? '').trim().toLowerCase();

/** broad ⊃ phrase ⊃ exact. A merge may widen a rejection, never narrow one. */
const MATCH_BREADTH = { exact: 0, phrase: 1, broad: 2 };

/**
 * One canonical shape from the four the writers actually produce.
 *
 * `rejectedAt` (the dashboard DataForSEO route) and `added_at` (hand-authored
 * entries) both become `rejected_at`, which is the spelling 36 of the 39 server
 * entries already use. `matchType` is NEVER defaulted: its absence means
 * substring matching in eight of the nine readers, so inventing `'exact'` here
 * would quietly un-block every content-strategist auto-rejection.
 *
 * @returns {object|null} null when there is no keyword to match on.
 */
export function normalizeRejection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const keyword = String(raw.keyword ?? '').trim();
  if (!keyword) return null;

  const out = { keyword };
  if (raw.matchType) out.matchType = raw.matchType;
  if (raw.slug) out.slug = raw.slug;
  if (raw.reason !== undefined && raw.reason !== null) out.reason = raw.reason;
  const at = raw.rejected_at ?? raw.rejectedAt ?? raw.added_at ?? null;
  if (at) out.rejected_at = at;
  if (raw.source) out.source = raw.source;
  return out;
}

function combine(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null || v === '') continue;
    if (out[k] === undefined || out[k] === null || out[k] === '') { out[k] = v; continue; }
    if (k === 'rejected_at') {
      // Earliest wins: the first time somebody said no is the fact worth keeping.
      out[k] = String(out[k]) <= String(v) ? out[k] : v;
    } else if (k === 'matchType') {
      out[k] = (MATCH_BREADTH[v] ?? -1) > (MATCH_BREADTH[out[k]] ?? -1) ? v : out[k];
    }
    // Everything else: first non-empty value wins. Never blank a field out.
  }
  return out;
}

/**
 * Union two rejection lists. Never drops an entry either side holds.
 *
 * Order-independent by construction, because "which side wins" is the question
 * that loses data. On a duplicate keyword the merge keeps the EARLIEST date and
 * the BROADEST `matchType` — widening blocks more, narrowing lets a keyword
 * back through, and a reconcile must never be the thing that lets one through.
 */
export function mergeRejections(a, b) {
  const byKey = new Map();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const r = normalizeRejection(raw);
      if (!r) continue;
      const k = key(r.keyword);
      byKey.set(k, byKey.has(k) ? combine(byKey.get(k), r) : r);
    }
  }
  return [...byKey.values()];
}

/**
 * Read the list, normalized and free of entries a reader would crash on.
 *
 * Eight of the nine `isRejected` implementations call `r.keyword.toLowerCase()`
 * with no guard, so a null row or a keyword-less entry takes the whole agent
 * down. Missing or unparseable file → `[]`, matching what every caller already
 * did in its own try/catch.
 */
export function loadRejections({ path = rejectedKeywordsPath() } = {}) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRejection).filter(Boolean);
  } catch { return []; }
}

/**
 * Add one rejection: re-read, merge, write atomically.
 *
 * The re-read is the point. A caller that loaded the list a minute ago is
 * holding a stale copy, and writing it back is how the other process's entry
 * disappeared. Nothing here trusts the caller's view of the file.
 *
 * @returns {{added: boolean, total: number}} added=false when the keyword was
 *   already on the list, or when there is no keyword to add.
 */
export function appendRejection(entry, { path = rejectedKeywordsPath() } = {}) {
  const incoming = normalizeRejection(entry);
  if (!incoming) return { added: false, total: loadRejections({ path }).length };

  const current = loadRejections({ path });
  const exists = current.some((r) => key(r.keyword) === key(incoming.keyword));
  const merged = mergeRejections(current, [incoming]);

  // Temp file + rename: a crash mid-write must not leave a truncated array,
  // which every reader's `catch { return [] }` would silently read as "nothing
  // is rejected" and re-propose all 39 keywords at once.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  return { added: !exists, total: merged.length };
}

/**
 * What would a one-sided overwrite destroy?
 *
 * `base` is typically the committed version, `head` the working tree — but the
 * comparison is symmetric on purpose, because the loss can run either way: a
 * deploy can revert the server's 37, and a careless local commit can revert a
 * rejection that only git has.
 */
export function diffRejections({ base = [], head = [] } = {}) {
  const B = new Map(mergeRejections(base, []).map((r) => [key(r.keyword), r]));
  const H = new Map(mergeRejections(head, []).map((r) => [key(r.keyword), r]));
  const onlyInBase = [...B.entries()].filter(([k]) => !H.has(k)).map(([, r]) => r);
  const onlyInHead = [...H.entries()].filter(([k]) => !B.has(k)).map(([, r]) => r);
  const merged = mergeRejections(base, head);
  return {
    onlyInBase, onlyInHead, merged,
    wouldLose: onlyInBase.length + onlyInHead.length,
    inSync: onlyInBase.length === 0 && onlyInHead.length === 0,
  };
}

/** Human-readable reconcile report — the counts alone never told anyone what was at stake. */
export function renderReconcileReport(diff, { baseLabel = 'base', headLabel = 'head' } = {}) {
  if (!diff || diff.inSync) {
    return `data/rejected-keywords.json: ${baseLabel} and ${headLabel} are in sync (${diff?.merged?.length ?? 0} entries). Nothing to reconcile.`;
  }
  const lines = [
    `data/rejected-keywords.json — ${baseLabel} vs ${headLabel}`,
    '',
    `  ${diff.onlyInBase.length} entr${diff.onlyInBase.length === 1 ? 'y' : 'ies'} only in ${baseLabel}`,
    `  ${diff.onlyInHead.length} entr${diff.onlyInHead.length === 1 ? 'y' : 'ies'} only in ${headLabel}`,
    `  ${diff.merged.length} after merging both sides`,
    '',
  ];
  const show = (label, rows) => {
    if (!rows.length) return;
    lines.push(`Only in ${label}:`);
    for (const r of rows) {
      lines.push(`  "${r.keyword}"${r.matchType ? ` (${r.matchType})` : ''}${r.source ? ` — ${r.source}` : ''}${r.rejected_at ? `, ${r.rejected_at}` : ''}`);
    }
    lines.push('');
  };
  show(baseLabel, diff.onlyInBase);
  show(headLabel, diff.onlyInHead);
  lines.push(
    `Overwriting one side with the other would drop ${diff.wouldLose} rejection(s).`,
    'Every dropped rejection is a keyword agents/content-strategist may re-propose,',
    'which agents/calendar-runner may then draft — a full paid research + writing',
    'pipeline per keyword. Merge; never pick a side.',
  );
  return lines.join('\n');
}
