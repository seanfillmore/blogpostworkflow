#!/usr/bin/env node
/**
 * Reconcile data/rejected-keywords.json against git, without picking a side.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The file is TRACKED in git and WRITTEN by production agents. Audited
 * 2026-08-23: 39 entries on the server, 2 committed — 37 that exist nowhere but
 * the production box, none of them lost yet only because no commit has touched
 * the file since 2026-04-08 (`6c89b2f7`).
 *
 * The moment one does, `git pull` on the server hits a tracked file with local
 * modifications: the deploy-hygiene hazard CLAUDE.md documents. The `git stash
 * push && git pull && git stash pop` recovery ends in a hand-resolved conflict,
 * and resolving it either way by taking one side reverts the other's
 * rejections. A reverted rejection is a keyword agents/content-strategist
 * re-proposes and agents/calendar-runner drafts — a full paid research +
 * writing pipeline per keyword.
 *
 * So the answer to "gitignore it / commit it back / merge it" is MERGE. The
 * file stays tracked (it records human decisions and cannot be regenerated —
 * the same reasoning that keeps data/briefs/_dropped/ tracked), and this script
 * is the merge. It never drops an entry either side holds.
 *
 * USAGE
 *   node scripts/reconcile-rejected-keywords.mjs            # report only (default)
 *   node scripts/reconcile-rejected-keywords.mjs --apply    # write the union to the working tree
 *   node scripts/reconcile-rejected-keywords.mjs --ref origin/main
 *   node scripts/reconcile-rejected-keywords.mjs --against <file>   # merge a copy pulled from the server
 *
 * Exit code 1 when the two sides diverge and --apply was not passed, so a
 * deploy step can gate on it. Reporting is deliberately the default: this
 * script decides nothing about content, it only refuses to let a merge lose
 * something.
 *
 * DEPLOY ORDER — after `git pull`, never before, matching CLAUDE.md's backfill
 * rule. Run `--apply`, then commit the result from a branch like any other
 * change. Running it before the pull merges against the old HEAD and tells you
 * nothing useful.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRejections, diffRejections, renderReconcileReport } from '../lib/rejected-keywords.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'data/rejected-keywords.json';
const PATH = join(ROOT, REL);

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const REF = arg('--ref', 'HEAD');
const AGAINST = arg('--against', null);

function baseSide() {
  if (AGAINST) {
    if (!existsSync(AGAINST)) {
      console.error(`--against: no such file: ${AGAINST}`);
      process.exit(1);
    }
    return { label: AGAINST, list: loadRejections({ path: AGAINST }) };
  }
  try {
    const raw = execFileSync('git', ['show', `${REF}:${REL}`], { cwd: ROOT, encoding: 'utf8' });
    return { label: `git ${REF}`, list: JSON.parse(raw) };
  } catch {
    // A ref that does not carry the file is not an error — it is the answer
    // "git has nothing here", and merging against nothing loses nothing.
    console.log(`  (${REF} does not carry ${REL} — treating git's side as empty)`);
    return { label: `git ${REF}`, list: [] };
  }
}

const base = baseSide();
const head = { label: 'working tree', list: loadRejections({ path: PATH }) };

const diff = diffRejections({ base: base.list, head: head.list });
console.log('');
console.log(renderReconcileReport(diff, { baseLabel: base.label, headLabel: head.label }));
console.log('');

if (diff.inSync) process.exit(0);

if (!APPLY) {
  console.log(`Report only. Re-run with --apply to write the ${diff.merged.length}-entry union to ${REL}.`);
  process.exit(1);
}

writeFileSync(PATH, `${JSON.stringify(diff.merged, null, 2)}\n`);
console.log(`Wrote ${diff.merged.length} entries to ${REL} (was ${head.list.length} in the working tree, ${base.list.length} in ${base.label}).`);
console.log('Nothing was dropped. Commit this from a branch — it is the only way the server side reaches git.');
