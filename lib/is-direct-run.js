// lib/is-direct-run.js
//
// One spelling of "was this module executed directly, or imported?".
//
// Importing an agent's index.js RUNS it — live Shopify writes, paid API calls,
// process.exit — so anything wanting to unit-test a function inside an agent has
// to guard the entry point first. Four different hand-rolled spellings of this
// predicate were already in the tree:
//
//   process.argv[1] && process.argv[1].endsWith('foo/index.js')
//   process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
//   process.argv[1] === fileURLToPath(import.meta.url)          // operand order flipped
//   const isDirectRun = ...; if (isDirectRun) { ... }
//
// The spread is not cosmetic: two separate audit passes miscounted which agents
// were guarded because a regex matched one spelling and not another.
//
// FAILURE MODES ARE NOT SYMMETRIC. A false positive means the agent runs when
// imported — the hazard we already live with. A false negative means a scheduled
// agent silently becomes a no-op that still exits 0, which cron and the daily
// digest both read as success. So this resolves symlinks before giving up, and
// falls back to a plain string compare if the filesystem lookup fails, rather
// than answering "no" on a technicality.

import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';

/**
 * @param {string} importMetaUrl  the caller's `import.meta.url`
 * @param {string} [entryPath]    the process entry point; defaults to process.argv[1]
 * @returns {boolean} true when this module IS the entry point
 */
export function isDirectRun(importMetaUrl, entryPath = process.argv[1]) {
  if (!entryPath || !importMetaUrl) return false;

  let selfPath;
  try {
    selfPath = fileURLToPath(importMetaUrl);
  } catch {
    return false; // not a file: URL — cannot be the CLI entry point
  }

  if (selfPath === entryPath) return true;

  // Resolve both through the filesystem so a symlinked checkout, a worktree, or
  // a /var → /private/var style prefix still matches. If either path cannot be
  // resolved, we've already done the exact compare above.
  try {
    return realpathSync(selfPath) === realpathSync(entryPath);
  } catch {
    return false;
  }
}
