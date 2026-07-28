#!/usr/bin/env node
/**
 * Marketing Learner
 *
 * Turns a YouTube marketing video into a reviewed pull request that creates or
 * sharpens a project-level Claude Code skill, plus a report scoring every tactic
 * found — including the rejects and why.
 *
 * Usage:
 *   node agents/marketing-learner/index.js <url> [<url>…]
 *     --published <YYYY-MM-DD>  Upload date. Optional but recommended — the API does
 *                               not provide it. Repeatable, pairs positionally with URLs.
 *     --extract-only            Fetch + extract + report. Do not touch skills or open a PR.
 *     --no-pr                   Write into the working tree. No branch, no PR.
 *     --refetch                 Ignore the transcript cache (costs a credit).
 *
 *   node agents/marketing-learner/index.js --falsify <skill-name> --claim "<substring
 *       of the tactic's heading>" --reason "<what happened when you tested it>"
 *     A separate mode — cannot be combined with URLs or any of the flags above. Marks
 *     one live tactic in an existing skill dead: moves its section into that skill's
 *     "## Falsified" graveyard, stamped with today's Pacific-time date and --reason, then
 *     regenerates data/context/marketing-tactics.md so the "Do not propose" blocklist
 *     every agent reads picks it up immediately. Pure text surgery — no network call,
 *     no LLM call, no credential required, and unlike the video path above it does
 *     NOT branch or open a PR: it writes directly into the current working tree
 *     (mutates the target skill's SKILL.md and the mirror file, both tracked files —
 *     commit them yourself). Throws (does not warn-and-continue) on: skill not found,
 *     zero or multiple matching live tactics, or a claim that is already falsified.
 *
 * Requires TRANSCRIPTAPI_KEY in .env for the video path. --falsify needs neither that
 * nor ANTHROPIC_API_KEY — it never touches the network.
 * Spec: docs/superpowers/specs/2026-07-27-marketing-learner-design.md
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '../../lib/anthropic.js';
import { notify } from '../../lib/notify.js';
import { fetchTranscript, extractVideoId, TranscriptError } from '../../lib/transcript-source.js';
import {
  parsePublishedFlags,
  scanSkillInventory,
  renderSkillMarkdown,
  parseFrontmatter,
  extractTactics,
  mergeSkillContent,
  renderReport,
  falsifyTactic,
  renderContextMirror,
} from '../../lib/marketing-learner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const CORPUS_DIR = join(ROOT, 'data', 'marketing-corpus');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'marketing-learner');

const FLAGS = { '--extract-only': 'extractOnly', '--no-pr': 'noPr', '--refetch': 'refetch' };

/** Repo convention: agents read .env themselves. There is no dotenv import anywhere here. */
function loadEnv(root = ROOT) {
  try {
    const lines = readFileSync(join(root, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const VALUE_FLAGS = { '--published': 'published', '--falsify': 'falsify', '--claim': 'claim', '--reason': 'reason' };

export function parseArgs(argv) {
  const out = {
    urls: [], published: [], extractOnly: false, noPr: false, refetch: false,
    falsify: null, claim: null, reason: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS[a]) {
      const v = argv[++i];
      if (!v || v.startsWith('--')) {
        if (a === '--falsify') throw new Error('--falsify requires a skill name.');
        if (a === '--published') throw new Error('--published requires a YYYY-MM-DD value.');
        throw new Error(`${a} requires a value.`);
      }
      if (a === '--published') out.published.push(v);
      else out[VALUE_FLAGS[a]] = v;
    } else if (FLAGS[a]) {
      out[FLAGS[a]] = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      out.urls.push(a);
    }
  }

  if (out.falsify) {
    if (!out.claim) throw new Error('--falsify requires --claim "<substring of the tactic>".');
    if (!out.reason) throw new Error('--falsify requires --reason "<what happened when you tested it>".');
    if (out.urls.length) throw new Error('--falsify cannot be combined with URLs — it is a separate mode.');
    if (out.extractOnly || out.noPr || out.refetch || out.published.length) {
      throw new Error('--falsify cannot be combined with --extract-only, --no-pr, --refetch, or --published.');
    }
    return out;
  }

  if (out.claim || out.reason) throw new Error('--claim and --reason are only valid with --falsify.');
  if (!out.urls.length) throw new Error('Provide at least one YouTube URL.');
  return out;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

/**
 * Cached fetch. The video id is derived from the URL WITHOUT calling the API, so a
 * cache hit costs zero credits — deriving it from a fetch response first would spend
 * a credit on every run and make the cache pointless.
 */
async function loadVideo(url, publishedAt, { refetch, apiKey }) {
  const videoId = extractVideoId(url);
  const dir = join(CORPUS_DIR, videoId);
  const cachePath = join(dir, 'video.json');

  if (!refetch && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      console.log('  (transcript from cache — 0 credits)');
      return { ...cached, publishedAt };
    } catch {
      // A partial write (e.g. a Ctrl-C mid-write) leaves opaque, unparseable JSON on
      // disk. That is not a TranscriptError, so letting it propagate would kill the
      // whole batch and the only way out would cost another credit. Treat it as a
      // cache miss instead — refetching is cheap next to losing the run.
      console.warn(`  ⚠ cached transcript at ${cachePath} is corrupt (partial write?) — refetching`);
    }
  }

  const fetched = await fetchTranscript(url, { apiKey });
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(fetched, null, 2));
  writeFileSync(join(dir, 'transcript.txt'), fetched.text);
  return { ...fetched, publishedAt };
}

/**
 * Create a new skill, or merge into an existing one via the LLM so later videos
 * revise earlier claims rather than stacking duplicates on top of them.
 *
 * `skillsDir` defaults to the real project skills dir; tests pass a temp dir.
 */
export async function writeSkill({ name, description, tactics, existing, client, skillsDir = SKILLS_DIR }) {
  // Belt-and-braces: validateExtraction already constrains targetSkill.name to
  // /^marketing-[a-z0-9]+(-[a-z0-9]+)*$/, but this function is the last thing
  // standing between model output and a filesystem write, so it checks again.
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Refusing to write skill with unsafe name: "${name}"`);
  }

  if (existing) {
    // Write to the path the inventory scan actually found — NEVER recompute it from
    // the model's name. If the on-disk frontmatter `name` differs from the directory
    // name (or the model just echoed a slightly different name), join(skillsDir, name)
    // points at a directory that may not exist, or worse, at a different directory
    // than the one the model read when it produced this merge.
    const { content, supersedes } = await mergeSkillContent({
      existingContent: existing.content,
      tactics,
      client,
    });
    writeFileSync(existing.path, content);
    if (supersedes) console.log(`  ↻ ${name} superseded content: ${supersedes}`);
    return { path: existing.path, action: 'edit' };
  }

  const dir = join(skillsDir, name);
  const path = join(dir, 'SKILL.md');

  // A skill file can exist on disk without being in the inventory: malformed
  // frontmatter makes scanSkillInventory warn-and-skip it, and a symlinked skill
  // directory is invisible too (readdirSync withFileTypes: entry.isDirectory() is
  // false for a symlink). Either way `existing` comes back undefined even though
  // real, accumulated content sits at this exact path. Refuse rather than let
  // writeFileSync silently overwrite it wholesale — validateSkillEdit's
  // shrink/rename guard never gets a chance to run on the CREATE path.
  if (existsSync(path)) {
    throw new Error(
      `Refusing to create "${name}": ${path} already exists but was not found by the skill ` +
      `inventory scan. Its frontmatter is probably malformed (or the directory is a symlink), ` +
      `which made it invisible to scanSkillInventory. Fix the file by hand, then re-run — ` +
      `this run will not overwrite it.`
    );
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderSkillMarkdown({ name, description, tactics }));
  return { path, action: 'create' };
}

const MIRROR_PATH = join(ROOT, 'data', 'context', 'marketing-tactics.md');

/**
 * Regenerate the fleet-readable projection of the skills. Runs after EVERY write
 * to .claude/skills/ — create, merge, or falsify — so the mirror cannot drift.
 * Re-scans rather than tracking deltas: it is a handful of file reads, and
 * correctness beats cleverness for a file other agents act on.
 *
 * `skillsDir`/`mirrorPath` default to the real project paths; tests pass
 * `mkdtempSync` sandboxes so `npm test` never rewrites the tracked mirror file.
 */
function syncContextMirror(skillsDir = SKILLS_DIR, mirrorPath = MIRROR_PATH) {
  mkdirSync(dirname(mirrorPath), { recursive: true });
  writeFileSync(mirrorPath, renderContextMirror(scanSkillInventory(skillsDir)));
  return mirrorPath;
}

/**
 * If any skill was created or edited, regenerate the mirror AND capture its path
 * into `writtenPaths` — the exact array `openPullRequest` stages from (it
 * `git add`s only `writtenPaths`, never whole directories). Pulled out as its own
 * function so this specific wiring — "the mirror rides along in the same PR as
 * the skills and report" — is directly testable without exercising the rest of
 * processVideo (network fetch, LLM extraction, git/PR).
 *
 * Called once per skill write inside processVideo's loop (not once after the
 * whole loop) so a mid-loop failure on a later skill still leaves the mirror
 * consistent with whatever already landed on disk — see the shrink/rename/
 * falsified guards in validateSkillEdit, any of which can throw mid-batch.
 */
export function syncMirrorIfTouched(writtenPaths, skillsTouched, { skillsDir = SKILLS_DIR, mirrorPath = MIRROR_PATH } = {}) {
  if (!skillsTouched.length) return writtenPaths;
  syncContextMirror(skillsDir, mirrorPath);
  // Deliberately NOT pushed onto writtenPaths, so the PR never stages it.
  //
  // The mirror is gitignored. It used to be committed, which made a generated
  // file a version-controlled artifact: every learner run regenerated it, so any
  // two concurrent PRs conflicted on it, and git could 3-way-merge it into
  // content the generator would never emit. creative-packager now generates the
  // menu in memory from .claude/skills/ instead of reading this file, so the
  // only reader is a human running `cat` — and a local, uncommitted copy serves
  // that fine.
  return writtenPaths;
}

/**
 * Today in Pacific time, not UTC. A falsification date is a permanent audit
 * record on a hand-run operator command: toISOString() stamps tomorrow's date
 * for anything run after 5pm PT, which is most of the evening.
 */
function todayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * Mark a tactic dead. No network, no LLM call — pure text surgery.
 *
 * `skillsDir`/`mirrorPath`/`today` default to the real project paths and the
 * real clock; tests pass a `mkdtempSync` sandbox and a fixed date so this write
 * path is exercised without touching a tracked file.
 */
export function runFalsify(
  { falsify, claim, reason },
  { skillsDir = SKILLS_DIR, mirrorPath = MIRROR_PATH, today = todayPacific() } = {}
) {
  const inventory = scanSkillInventory(skillsDir);
  const skill = inventory.find((s) => s.name === falsify);
  if (!skill) {
    const names = inventory.map((s) => s.name).join(', ') || '(no marketing skills yet)';
    throw new Error(`No skill named "${falsify}". Available: ${names}`);
  }
  writeFileSync(skill.path, falsifyTactic(skill.content, { claim, reason, today }));
  console.log(`✓ falsified in ${relative(ROOT, skill.path)}`);
  console.log(`✓ mirror updated: ${relative(ROOT, syncContextMirror(skillsDir, mirrorPath))}`);
  return { skillPath: skill.path, mirrorPath };
}

async function processVideo(item, { client, apiKey, args }) {
  const video = await loadVideo(item.url, item.publishedAt, { refetch: args.refetch, apiKey });
  if (item.warning) console.warn(`  ⚠ ${item.warning}`);

  const inventory = scanSkillInventory(SKILLS_DIR);
  let extraction;
  try {
    extraction = await extractTactics({ video, inventory, client });
  } catch (err) {
    // Spec: a schema-validation failure must throw AND write the offending payload
    // to the corpus dir for inspection — otherwise the operator can't see what was
    // malformed and has to re-pay for the Opus call just to look at it again.
    // lib/marketing-learner.js deliberately doesn't know the corpus path, so it
    // attaches the raw payload to the error and this is where it gets persisted.
    if (err.offendingPayload !== undefined) {
      const dir = join(CORPUS_DIR, video.videoId);
      mkdirSync(dir, { recursive: true });
      const badPath = join(dir, `invalid-extraction-${Date.now()}.json`);
      writeFileSync(badPath, JSON.stringify(err.offendingPayload, null, 2));
      console.error(`  ✗ schema validation failed — offending payload saved to ${relative(ROOT, badPath)}`);
    }
    throw err;
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const extractionJsonPath = join(REPORT_DIR, `${video.videoId}.json`);
  writeFileSync(extractionJsonPath, JSON.stringify(extraction, null, 2));

  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt');
  const skillsTouched = [];
  const writtenPaths = [extractionJsonPath];

  if (!args.extractOnly) {
    const bySkill = new Map();
    for (const t of adopted) {
      const key = t.targetSkill.name;
      if (!bySkill.has(key)) bySkill.set(key, { action: t.targetSkill.action, tactics: [] });
      bySkill.get(key).tactics.push({ ...t, source: { creator: video.creator, title: video.title, videoId: video.videoId } });
    }
    for (const [name, { tactics }] of bySkill) {
      const existing = inventory.find((s) => s.name === name);
      // For an existing skill, keep its current description — mergeSkillContent
      // already lets the model sharpen it in place. For a new skill, use the
      // model-supplied description (it just read the transcript and knows what the
      // tactic is actually for); validateExtraction guarantees every adopted
      // tactic carries one. Several adopted tactics can map to the same new skill,
      // so use the first one's.
      const description = existing
        ? parseFrontmatter(existing.content).description
        : tactics[0].targetSkill.description;
      const { path, action } = await writeSkill({ name, description, tactics, existing, client });
      skillsTouched.push({ name, action, path });
      writtenPaths.push(path);
      // Resync after EACH write, not once after the whole loop: if the next
      // skill in this batch throws (shrink/rename/falsified guard), this one's
      // change must not be left invisible to the mirror every other agent reads.
      syncMirrorIfTouched(writtenPaths, skillsTouched);
    }
  }

  const report = renderReport({ extraction, video, skillsTouched });
  const reportMdPath = join(REPORT_DIR, `${video.videoId}.md`);
  writeFileSync(reportMdPath, report);
  writtenPaths.push(reportMdPath);

  console.log(`  ${adopted.length} adopted, ${extraction.tactics.length - adopted.length} rejected`);
  return { video, extraction, skillsTouched, writtenPaths };
}

function branchExists(name) {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The design encourages repeat incremental runs against the same skill, so a
 * `feature/marketing-skill-<topic>` collision is expected, normal use — not an
 * error. Disambiguate by videoId first (stable, meaningful), then a numeric
 * suffix, rather than aborting a run that already wrote files and spent credits.
 */
function resolveBranchName(base, results) {
  if (!branchExists(base)) return base;

  const videoId = results[0]?.video?.videoId ?? 'run';
  const withVideo = `${base}-${videoId}`;
  if (!branchExists(withVideo)) return withVideo;

  for (let i = 2; i <= 10; i++) {
    const candidate = `${withVideo}-${i}`;
    if (!branchExists(candidate)) return candidate;
  }
  throw new Error(
    `Could not find an available branch name. Tried "${base}", "${withVideo}", and `
    + `"${withVideo}-2" through "${withVideo}-10" — all already exist.`
  );
}

function openPullRequest(results) {
  const touched = results.flatMap((r) => r.skillsTouched);
  if (!touched.length) {
    console.log('No skills changed — skipping the PR.');
    return null;
  }

  // Fail fast, before any commit/push, if gh is missing or unauthenticated — a
  // pushed branch with no PR (because gh died after the push) is a worse state
  // than never having started.
  try {
    execFileSync('gh', ['--version'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    throw new Error('gh CLI is not available. Install/auth GitHub CLI before running with PR automation (or pass --no-pr).');
  }

  const topics = [...new Set(touched.map((s) => s.name.replace(/^marketing-/, '')))];
  const baseBranch = topics.length === 1
    ? `feature/marketing-skill-${topics[0]}`
    : `feature/marketing-skills-${topics.length}-topics`;
  const branch = resolveBranchName(baseBranch, results);

  // The repo's working tree is habitually dirty (per-project convention, not a bug
  // here). Record where the operator actually is so we can put them back — and only
  // ever stage the exact files this run wrote, never whole directories, so an
  // unrelated in-flight edit or a hand-authored skill never rides along in the commit.
  const originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const paths = [...new Set(results.flatMap((r) => r.writtenPaths))].map((p) => relative(ROOT, p));

  try {
    // -b (not -B): the design encourages repeat incremental runs against the same
    // skill, so branch-name collisions are expected. -B would silently reset an
    // existing branch and discard whatever work is sitting on it.
    //
    // Branch from `main`, not current HEAD: `checkout -b` with no start-point branches
    // from wherever the operator happens to be, so running this from an unrelated
    // feature branch would carry its unrelated commits straight into the PR.
    git(['checkout', '-b', branch, 'main']);

    // The mirror is a projection of whatever .claude/skills/ the working tree
    // holds. The in-loop sync ran while we were still on the operator's branch,
    // which may carry skills that do not exist on main — checking out from main
    // drops those files, so that mirror would advertise tactics whose SKILL.md
    // this PR does not contain. Regenerate now that the tree is main + this
    // run's writes, and stage that. (Concurrent `learn` runs still each rewrite
    // the whole file and will conflict; the runs are hand-triggered and rare.)
    if (paths.includes(relative(ROOT, MIRROR_PATH))) syncContextMirror();

    git(['add', ...paths]);
    git(['commit', '-m', `feat(skills): marketing tactics from ${results.length} video(s)\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`]);
    git(['push', '-u', 'origin', branch]);

    const body = results.map((r) => {
      const rows = r.extraction.tactics
        .sort((a, b) => b.rscFit.score - a.rscFit.score)
        .map((t) => `| ${t.rscFit.score}/10 | ${t.verdict} | ${t.claim} | ${t.rejectReason ?? t.rscFit.reasoning} |`)
        .join('\n');
      const title = r.video.title ?? r.video.videoId;
      return `## ${title}\n\nhttps://www.youtube.com/watch?v=${r.video.videoId}\n\n| Score | Verdict | Claim | Reasoning |\n|---|---|---|---|\n${rows}`;
    }).join('\n\n');

    execFileSync('gh', ['pr', 'create', '--title', `Marketing skills: ${topics.join(', ')}`, '--body',
      `${body}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`],
      { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
    return branch;
  } finally {
    // Land back where the operator started even if any step above throws — this run
    // must never silently relocate whatever they had in progress onto a new branch.
    git(['checkout', originalBranch]);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.falsify) {
    runFalsify(args);
    return;
  }

  const env = loadEnv();
  const apiKey = env.TRANSCRIPTAPI_KEY || process.env.TRANSCRIPTAPI_KEY;
  if (!apiKey) {
    console.error('TRANSCRIPTAPI_KEY is not set. Add it to .env.');
    process.exit(1);
  }

  // loadEnv() reads .env into a local object — it does NOT populate process.env,
  // so constructing the client with no arguments finds no credentials and throws
  // at request time, after a paid transcript credit has already been spent. Every
  // agent in this repo passes the key explicitly; see agents/voice-of-customer.
  const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY is not set. Add it to .env.');
    process.exit(1);
  }

  const items = parsePublishedFlags(args.urls, args.published, {});
  const client = new Anthropic({ apiKey: anthropicKey });

  const results = [];
  for (const item of items) {
    console.log(`\n▶ ${item.url}`);
    try {
      results.push(await processVideo(item, { client, apiKey, args }));
    } catch (err) {
      // RATE_LIMIT (408/429/503) has already exhausted lib/transcript-source.js's
      // capped backoff retries by the time it reaches here — spec: skip the video,
      // don't kill a batch where earlier videos already wrote skills and spent credits.
      if (err instanceof TranscriptError && ['NOT_FOUND', 'NO_ENGLISH', 'RATE_LIMIT'].includes(err.code)) {
        console.warn(`  ⏭ skipped: ${err.message}`);
        continue; // one bad video must not kill the batch
      }
      throw err;
    }
  }

  if (!results.length) {
    console.log('\nNothing processed.');
    return;
  }
  if (!args.extractOnly && !args.noPr) openPullRequest(results);

  const adopted = results.reduce((n, r) => n + r.extraction.tactics.filter((t) => t.verdict === 'adopt').length, 0);
  const rejected = results.reduce((n, r) => n + r.extraction.tactics.filter((t) => t.verdict === 'reject').length, 0);
  await notify({
    subject: `Marketing learner: ${adopted} adopted, ${rejected} rejected`,
    body: results.map((r) => `${r.video.title ?? r.video.videoId}: ${r.skillsTouched.map((s) => s.name).join(', ') || 'no skills changed'}`).join('\n'),
    category: 'marketing-learner',
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
