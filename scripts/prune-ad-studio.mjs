#!/usr/bin/env node
/**
 * Retention policy for agents/ad-studio run output — data/creatives/ad-studio/<run-id>/.
 *
 * The directory is gitignored (one default run is ~137 MB of 2K renders) and nothing
 * prunes it. The production box has already lost four days of cron to a full disk
 * from unpruned dumps (see CLAUDE.md's Server Deployment notes) — this script exists
 * so ad-studio output doesn't do the same thing again.
 *
 * POLICY — "keep what we need, ditch the rest":
 *   - KEEP FOREVER, any age: every JSON file (run.json, copy.json, proof.json,
 *     demand-gen-assets.json). These are tiny and are the permanent record of what
 *     happened — a run stays auditable forever at a few KB even after its images
 *     are gone.
 *   - DELETE, after a grace period (default 7 days): image artifacts belonging to a
 *     REJECTED variation. You want to inspect a failure the day it happens, not a
 *     month later — and the rejected frame's proof.json survives regardless, so the
 *     reason is never lost.
 *   - DELETE, unconditionally (default 90 days): image artifacts from runs older
 *     than the retention window, accepted or not. The JSON always stays.
 *
 * Accepted vs. rejected is read from run.json's `results[].variations[].ok`
 * (written by buildRunReport/finalizeRunReport in agents/ad-studio/index.js) — never
 * inferred from filenames. A run directory with NO readable run.json (missing,
 * unparseable — an aborted run) has ALL of its images treated as rejected and
 * subject to the grace period. It is never treated as accepted (that would keep
 * images nobody ever confirmed), and it is never skipped (that would let an aborted
 * run's images accumulate forever, which is the exact failure mode this script
 * exists to prevent).
 *
 * Directory shape (packaging.js `variationDir`):
 *   <run-id>/run.json
 *   <run-id>/<concept-slug>/copy.json
 *   <run-id>/<concept-slug>/demand-gen-assets.json
 *   <run-id>/<concept-slug>/v<n>/proof.json
 *   <run-id>/<concept-slug>/v<n>/*.{png,jpg,jpeg,webp}   <- the only files ever deleted
 *
 * SAFETY — dry-run by default, deliberately inverted from this repo's usual
 * apply-by-default agent convention (CLAUDE.md's Autonomy Principle). That default
 * is for agents that can be re-run or whose mistakes are recoverable from git. This
 * script is destructive against the ONLY copy of the data — data/creatives/ad-studio
 * is gitignored, so deleted bytes are gone for good — so the safe mode has to be the
 * one you get by accident. Pass --apply to actually delete.
 *
 * Usage:
 *   node scripts/prune-ad-studio.mjs [--apply] [--rejected-days N] [--run-days N] [--dir <path>]
 *   npm run prune-ad-studio -- [--apply] [...]
 *
 * --dir is only for pointing the script at a fixture tree in tests; production runs
 * should never pass it. Whatever the resolved target is, it must end in
 * data/creatives/ad-studio or the script refuses to run — see assertSafeTarget.
 */

import { readFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_TARGET = join(ROOT, 'data', 'creatives', 'ad-studio');
export const REQUIRED_SUFFIX = join('data', 'creatives', 'ad-studio');

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REJECTED_DAYS = 7;
export const DEFAULT_RUN_DAYS = 90;

// Only these are ever candidates for deletion. Anything else — every .json file
// above all — is left alone unconditionally; see isImageArtifact.
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

/** True only for the rendered image artifacts this script is allowed to delete. */
export function isImageArtifact(filename) {
  if (filename.toLowerCase().endsWith('.json')) return false; // belt and suspenders — never delete JSON
  return IMAGE_EXT_RE.test(filename);
}

// ── argv ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const getFlag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const apply = argv.includes('--apply');
  const rejectedDaysRaw = getFlag('--rejected-days');
  const runDaysRaw = getFlag('--run-days');
  const rejectedDays = rejectedDaysRaw === undefined ? DEFAULT_REJECTED_DAYS : Number(rejectedDaysRaw);
  const runDays = runDaysRaw === undefined ? DEFAULT_RUN_DAYS : Number(runDaysRaw);
  if (!Number.isFinite(rejectedDays) || rejectedDays < 0) {
    throw new Error(`prune-ad-studio: --rejected-days must be a non-negative number, got "${rejectedDaysRaw}"`);
  }
  if (!Number.isFinite(runDays) || runDays < 0) {
    throw new Error(`prune-ad-studio: --run-days must be a non-negative number, got "${runDaysRaw}"`);
  }
  const dir = getFlag('--dir');
  return { apply, rejectedDays, runDays, dir };
}

/**
 * Refuse to operate on anything that doesn't resolve to (or under, for test
 * fixtures rooted elsewhere) a `data/creatives/ad-studio` directory. This is the
 * only thing standing between a typo'd --dir and deleting the wrong tree.
 */
export function assertSafeTarget(targetDir) {
  const resolved = resolve(targetDir);
  const ok = resolved === REQUIRED_SUFFIX || resolved.endsWith(sep + REQUIRED_SUFFIX);
  if (!ok) {
    throw new Error(
      `prune-ad-studio: refusing to run — resolved target "${resolved}" does not end in "${REQUIRED_SUFFIX}"`
    );
  }
  return resolved;
}

// ── run.json ─────────────────────────────────────────────────────────────────

/**
 * Read and parse a run's run.json. Returns null (never throws) for a missing or
 * unparseable file — the caller treats that as an aborted run, per policy.
 */
export function loadRunReport(runDir) {
  const path = join(runDir, 'run.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The set of "<concept-slug>/v<n>" keys whose variation was ACCEPTED (ok: true),
 * read from run.json's results[].variations[] — never inferred from filenames or
 * directory contents. A null report (aborted run) yields an empty set, so every
 * variation in that run falls through to "rejected" below.
 */
export function acceptedVariationKeys(report) {
  const keys = new Set();
  for (const concept of report?.results || []) {
    for (const v of concept.variations || []) {
      if (v.ok) keys.add(`${concept.conceptSlug}/v${v.n}`);
    }
  }
  return keys;
}

/**
 * How old a run is, in ms. Prefers run.json's generatedAt (the moment the run
 * actually finished); falls back to the run directory's mtime for an aborted run
 * that never got that far.
 */
export function runAgeMs(runDir, report, now = Date.now()) {
  const generatedAt = report?.generatedAt ? Date.parse(report.generatedAt) : NaN;
  if (Number.isFinite(generatedAt)) return now - generatedAt;
  return now - statSync(runDir).mtimeMs;
}

// ── planning ─────────────────────────────────────────────────────────────────

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Sum of every file's size under dir, recursively. Used only for the "total disk used" line. */
export function treeBytes(dir) {
  let total = 0;
  for (const ent of safeReaddir(dir)) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) total += treeBytes(p);
    else if (ent.isFile()) total += statSync(p).size;
  }
  return total;
}

/**
 * Walk targetDir (data/creatives/ad-studio) and decide, per run, which image files
 * would be deleted. Never touches JSON files (isImageArtifact excludes them) and
 * never returns a directory for deletion — only file paths.
 *
 * @returns {{targetDir:string, generatedAt:number, rejectedDays:number, runDays:number,
 *   totalTreeBytes:number, runs:{runId:string, aborted:boolean, ageDays:number,
 *   files:{path:string, bytes:number, reason:string}[], bytes:number}[],
 *   totals:{files:number, bytes:number}}}
 */
export function planPrune({ targetDir, rejectedDays = DEFAULT_REJECTED_DAYS, runDays = DEFAULT_RUN_DAYS, now = Date.now() }) {
  const runIds = safeReaddir(targetDir)
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const runs = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const runId of runIds) {
    const runDir = join(targetDir, runId);
    const report = loadRunReport(runDir);
    const aborted = report === null;
    const accepted = acceptedVariationKeys(report); // empty set for an aborted run
    const ageMs = runAgeMs(runDir, report, now);
    const runExpired = ageMs >= runDays * DAY_MS;
    const rejectedGraceExpired = ageMs >= rejectedDays * DAY_MS;

    const files = [];
    let runBytes = 0;

    for (const conceptEnt of safeReaddir(runDir)) {
      if (!conceptEnt.isDirectory()) continue; // run.json itself — never a deletion candidate
      const conceptDir = join(runDir, conceptEnt.name);

      for (const vEnt of safeReaddir(conceptDir)) {
        if (!vEnt.isDirectory()) continue; // copy.json, demand-gen-assets.json — kept
        const vDir = join(conceptDir, vEnt.name);
        const key = `${conceptEnt.name}/${vEnt.name}`;
        const isAccepted = accepted.has(key);

        for (const fileEnt of safeReaddir(vDir)) {
          if (!fileEnt.isFile() || !isImageArtifact(fileEnt.name)) continue; // proof.json kept
          let reason = null;
          if (runExpired) reason = 'run-older-than-retention-window';
          else if (!isAccepted && rejectedGraceExpired) reason = 'rejected-past-grace-period';
          if (!reason) continue; // accepted, run still fresh, within window — kept

          const filePath = join(vDir, fileEnt.name);
          const bytes = statSync(filePath).size;
          files.push({ path: filePath, bytes, reason });
          runBytes += bytes;
        }
      }
    }

    if (files.length) {
      runs.push({ runId, aborted, ageDays: ageMs / DAY_MS, files, bytes: runBytes });
      totalFiles += files.length;
      totalBytes += runBytes;
    }
  }

  return {
    targetDir,
    generatedAt: now,
    rejectedDays,
    runDays,
    totalTreeBytes: treeBytes(targetDir),
    runs,
    totals: { files: totalFiles, bytes: totalBytes },
  };
}

// ── execution / reporting ────────────────────────────────────────────────────

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function printPlan(plan, { apply }) {
  console.log(`Ad Studio retention — ${apply ? 'APPLY (deleting)' : 'DRY RUN (pass --apply to delete)'}`);
  console.log(`Target: ${plan.targetDir}`);
  console.log(`Rejected grace: ${plan.rejectedDays} day(s)   Run retention: ${plan.runDays} day(s)`);
  console.log(`Total tree size right now: ${humanBytes(plan.totalTreeBytes)}`);
  console.log('');

  if (!plan.runs.length) {
    console.log('Nothing to prune.');
    return;
  }

  for (const run of plan.runs) {
    console.log(
      `Run ${run.runId}${run.aborted ? ' [ABORTED — no readable run.json, images treated as rejected]' : ''} ` +
      `(age ${run.ageDays.toFixed(1)}d)`
    );
    const byReason = new Map();
    for (const f of run.files) {
      const key = f.reason;
      const agg = byReason.get(key) || { files: 0, bytes: 0 };
      agg.files += 1;
      agg.bytes += f.bytes;
      byReason.set(key, agg);
    }
    for (const [reason, agg] of byReason) {
      console.log(`  ${reason}: ${agg.files} file(s), ${humanBytes(agg.bytes)}`);
    }
    console.log(`  subtotal: ${run.files.length} file(s), ${humanBytes(run.bytes)}`);
  }

  console.log('');
  console.log(
    `TOTAL: ${plan.runs.length} run(s) affected, ${plan.totals.files} file(s), ` +
    `${humanBytes(plan.totals.bytes)} would be reclaimed.`
  );
  console.log(apply ? 'Deleting now.' : 'Dry run — nothing deleted. Pass --apply to delete.');
}

/** Deletes every file in the plan. Only ever unlinks files — never rmdir. */
export function applyPlan(plan) {
  let deleted = 0;
  let bytes = 0;
  const errors = [];
  for (const run of plan.runs) {
    for (const f of run.files) {
      try {
        unlinkSync(f.path);
        deleted += 1;
        bytes += f.bytes;
      } catch (err) {
        errors.push({ path: f.path, error: err.message });
      }
    }
  }
  return { deleted, bytes, errors };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDir = assertSafeTarget(args.dir || DEFAULT_TARGET);

  const plan = planPrune({ targetDir, rejectedDays: args.rejectedDays, runDays: args.runDays });
  printPlan(plan, { apply: args.apply });

  if (args.apply && plan.totals.files) {
    const result = applyPlan(plan);
    console.log(`\nDeleted ${result.deleted} file(s), reclaimed ${humanBytes(result.bytes)}.`);
    if (result.errors.length) {
      console.error(`${result.errors.length} file(s) failed to delete:`);
      for (const e of result.errors) console.error(`  ${e.path}: ${e.error}`);
      process.exitCode = 1;
    }
  }
}

// Guard: importing this module must not run the script.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
