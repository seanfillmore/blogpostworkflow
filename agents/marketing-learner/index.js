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
 *   node agents/marketing-learner/index.js --file <path.txt|.md> --author "<name>" --title "<title>"
 *     A local text source instead of a video. Its own mode — cannot be combined with URLs.
 *     Needs no TRANSCRIPTAPI_KEY. Convert a PDF first: pdftotext -layout in.pdf out.txt.
 *     --source-kind <kind>      What the work IS, for the provenance line on every adopted
 *                               tactic: book (default), essay, social post, newsletter,
 *                               transcript… Say what it actually is. It also decides whether
 *                               the extraction prompt gets the "treat as durable principle"
 *                               nudge, which only a book earns — a pasted social post is as
 *                               platform-era as any video and must be scored like one.
 *     --published <YYYY|YYYY-MM-DD>   A bare year is accepted here; a book has no upload date.
 *     --chunk-words / --split-on      Chunking knobs for a long source.
 *
 *   node agents/marketing-learner/index.js --staged [<gate>]
 *     Read-only listing of every tactic parked behind a stage gate, grouped by gate
 *     in operating-sequence order. A tactic that is sound here but blocked by timing
 *     is adopted into its skill with a `**Stage:**` marker rather than rejected, and
 *     hidden from the fleet projection until that gate opens; this is how you find
 *     them again. Pass a gate (tracking, cro, offer-aov, traffic, scale, team) to ask
 *     what reaching that phase unlocks. No network, no LLM call, no credential.
 *
 *   node agents/marketing-learner/index.js --readjudicate [--all] [--no-pr]
 *     Re-reads tactics ALREADY REJECTED in data/reports/marketing-learner/*.json against
 *     the current stage rules, and parks the ones whose only problem was timing. Run it
 *     after appending a gate to STAGES or bumping CURRENT_STAGE — a rule change is only
 *     retroactive if something goes back and looks, and nothing did between 2026-08-17
 *     and 2026-08-20, which is how 41 sound-but-early tactics were discarded.
 *     By default it re-reads only rejections whose recorded reasoning turns on volume,
 *     budget or people (isTimingReject); --all re-reads every rejection in the corpus,
 *     which costs more and mostly re-confirms duplication rejects. A recovered tactic is
 *     always adopted WITH a stage — this pass can never promote straight into the live
 *     projection, because anything runnable today was not a timing rejection.
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
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '../../lib/anthropic.js';
import { notify } from '../../lib/notify.js';
import { fetchTranscript, extractVideoId, TranscriptError } from '../../lib/transcript-source.js';
import { loadTextFile, validateSourceKind } from '../../lib/text-source.js';
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
  extractStagedTactics,
  isStageActive,
  STAGES,
  CURRENT_STAGE,
  chunkText,
  consolidateTactics,
  buildConstraintBlock,
  isTimingReject,
  readjudicateRejects,
} from '../../lib/marketing-learner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const CORPUS_DIR = join(ROOT, 'data', 'marketing-corpus');
const REPORT_DIR = join(ROOT, 'data', 'reports', 'marketing-learner');

const FLAGS = {
  '--extract-only': 'extractOnly', '--no-pr': 'noPr', '--refetch': 'refetch',
  '--readjudicate': 'readjudicate', '--all': 'all',
};

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

const VALUE_FLAGS = {
  '--published': 'published', '--falsify': 'falsify', '--claim': 'claim', '--reason': 'reason',
  '--file': 'file', '--author': 'author', '--title': 'title',
  '--chunk-words': 'chunkWords', '--split-on': 'splitOn', '--source-kind': 'sourceKind',
};

export function parseArgs(argv) {
  const out = {
    urls: [], published: [], extractOnly: false, noPr: false, refetch: false,
    falsify: null, claim: null, reason: null, staged: null,
    file: null, author: null, title: null, chunkWords: 4500, splitOn: null, sourceKind: null,
    readjudicate: false, all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Optional-value flag, so it cannot go in VALUE_FLAGS (which requires one) or
    // FLAGS (which forbids one). Bare `--staged` lists everything parked.
    if (a === '--staged') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out.staged = v; i++; } else out.staged = 'all';
      continue;
    }
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

  if (out.readjudicate) {
    if (out.urls.length || out.file || out.falsify || out.staged) {
      throw new Error('--readjudicate cannot be combined with URLs, --file, --falsify, or --staged — it is a separate mode over the existing reports.');
    }
    return out;
  }
  if (out.all) throw new Error('--all is only valid with --readjudicate.');

  if (out.staged) {
    if (out.staged !== 'all' && !STAGES.includes(out.staged)) {
      throw new Error(`--staged takes one of: ${STAGES.join(', ')} (or no value for all). Got "${out.staged}".`);
    }
    if (out.urls.length || out.file || out.falsify) {
      throw new Error('--staged cannot be combined with URLs, --file, or --falsify — it is a read-only listing mode.');
    }
    return out;
  }

  if (out.falsify) {
    if (!out.claim) throw new Error('--falsify requires --claim "<substring of the tactic>".');
    if (!out.reason) throw new Error('--falsify requires --reason "<what happened when you tested it>".');
    if (out.urls.length || out.file) throw new Error('--falsify cannot be combined with URLs or --file — it is a separate mode.');
    if (out.extractOnly || out.noPr || out.refetch || out.published.length) {
      throw new Error('--falsify cannot be combined with --extract-only, --no-pr, --refetch, or --published.');
    }
    return out;
  }

  if (out.claim || out.reason) throw new Error('--claim and --reason are only valid with --falsify.');

  // Coerced for both modes, not just --file: the video path chunks too, and a string
  // chunkWords would reach chunkText and compare as a string against word counts.
  const chunkWords = Number(out.chunkWords);
  if (!Number.isInteger(chunkWords) || chunkWords <= 0) {
    throw new Error(`--chunk-words must be a positive integer, got "${out.chunkWords}".`);
  }
  out.chunkWords = chunkWords;

  // --file is a MODE, not a batch member. One source per run: a book and a video
  // have nothing to share in a single PR, and mixing them would make the report
  // and the branch name incoherent.
  if (out.file) {
    if (!out.author) throw new Error('--file requires --author "<name>" — it is the provenance on every claim.');
    if (!out.title) throw new Error('--file requires --title "<title>" — it is the provenance on every claim.');
    if (out.urls.length) throw new Error('--file cannot be combined with URLs — it is a separate mode. Run once per source.');
    // Default to "book" — the case the file source was built for, and the one
    // whose durability nudge the extraction prompt still depends on.
    out.sourceKind ??= 'book';
    validateSourceKind(out.sourceKind);
    return out;
  }

  for (const [prop, flag] of [['author', '--author'], ['title', '--title'], ['splitOn', '--split-on'], ['sourceKind', '--source-kind']]) {
    if (out[prop]) throw new Error(`${flag} is only valid with --file.`);
  }
  // --chunk-words is valid for videos too: long transcripts chunk on the same path.
  // --split-on stays file-only — it splits on headings, which transcripts don't have.

  if (!out.urls.length) throw new Error('Provide at least one YouTube URL, or --file <path> for a local text source.');
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
      return withSourceIdentity({ ...cached, publishedAt });
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
  return withSourceIdentity({ ...fetched, publishedAt });
}

/**
 * Both loaders return a `sourceId`/`sourceType` pair so everything downstream —
 * corpus paths, report filenames, the extraction prompt — stops caring which
 * front door the text came through. For a video the id IS the video id.
 */
function withSourceIdentity(video) {
  return { ...video, sourceId: video.videoId, sourceType: 'video' };
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

/**
 * List what is parked, and behind which gate. Read-only, no network, no LLM call.
 *
 * This is the retrieval path that stage-blocked tactics used to lack: they were
 * rejected into per-video JSON reports that nothing ever read again, so reaching
 * the gate meant re-deriving them from scratch. Reads the skills themselves, so it
 * stays correct no matter which video a tactic originally came from.
 */
export function runStaged({ staged }, { skillsDir = SKILLS_DIR } = {}) {
  const wanted = staged === 'all' ? null : staged;
  const rows = [];
  for (const s of scanSkillInventory(skillsDir)) {
    for (const t of extractStagedTactics(s.content)) {
      if (wanted && t.stage !== wanted) continue;
      rows.push({ skill: s.name, ...t });
    }
  }

  if (!rows.length) {
    console.log(wanted ? `Nothing parked behind "${wanted}".` : 'Nothing parked.');
    return rows;
  }

  const byStage = new Map();
  for (const r of rows) {
    if (!byStage.has(r.stage)) byStage.set(r.stage, []);
    byStage.get(r.stage).push(r);
  }
  // Sequence order, not insertion order — the list reads as a roadmap.
  for (const stage of STAGES) {
    const group = byStage.get(stage);
    if (!group) continue;
    const live = isStageActive(stage, CURRENT_STAGE);
    console.log(`\n${stage}${live ? ' (gate already open — these are live)' : ''} — ${group.length} tactic${group.length === 1 ? '' : 's'}`);
    for (const r of group) console.log(`  • [${r.skill}] ${r.claim}`);
  }
  console.log(`\n${rows.length} parked total. Current phase: ${CURRENT_STAGE}.`);
  return rows;
}

async function processVideo(item, { client, apiKey, args }) {
  const video = await loadVideo(item.url, item.publishedAt, { refetch: args.refetch, apiKey });
  if (item.warning) console.warn(`  ⚠ ${item.warning}`);

  console.log(`  ${video.text.split(/\s+/).length.toLocaleString()} words`);

  const inventory = scanSkillInventory(SKILLS_DIR);
  let extraction;
  try {
    extraction = await extractFromSource({ source: video, inventory, args, client });
  } catch (err) {
    // Spec: a schema-validation failure must throw AND write the offending payload
    // to the corpus dir for inspection — otherwise the operator can't see what was
    // malformed and has to re-pay for the Opus call just to look at it again.
    // lib/marketing-learner.js deliberately doesn't know the corpus path, so it
    // attaches the raw payload to the error and this is where it gets persisted.
    if (err.offendingPayload !== undefined) {
      const dir = join(CORPUS_DIR, video.sourceId);
      mkdirSync(dir, { recursive: true });
      const badPath = join(dir, `invalid-extraction-${Date.now()}.json`);
      writeFileSync(badPath, JSON.stringify(err.offendingPayload, null, 2));
      console.error(`  ✗ schema validation failed — offending payload saved to ${relative(ROOT, badPath)}`);
    }
    throw err;
  }

  return finishSource({ source: video, extraction, inventory, args, client });
}

/**
 * Everything after extraction: write the report, group adopted tactics by target
 * skill, write/merge each skill, resync the mirror.
 *
 * Shared by both front doors so a book and a video cannot drift in how they
 * write skills. The ONLY source-type-dependent thing in here is the provenance
 * locator.
 */
async function finishSource({ source, extraction, inventory, args, client }) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const extractionJsonPath = join(REPORT_DIR, `${source.sourceId}.json`);
  writeFileSync(extractionJsonPath, JSON.stringify(extraction, null, 2));

  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt');
  const skillsTouched = [];
  const writtenPaths = [extractionJsonPath];

  if (!args.extractOnly) {
    const bySkill = new Map();
    for (const t of adopted) {
      const key = t.targetSkill.name;
      if (!bySkill.has(key)) bySkill.set(key, { action: t.targetSkill.action, tactics: [] });
      bySkill.get(key).tactics.push({
        ...t,
        source: {
          creator: source.creator,
          title: source.title,
          // A long file cites the excerpt a tactic came from; consolidation records
          // every excerpt that fed each canonical tactic, and the first is the
          // one to cite. A short one has no excerpt worth naming, and appending
          // "excerpt unknown" to every line of a 1,200-word essay is noise, not
          // provenance. A video cites its id, exactly as it always has.
          locator: source.sourceType === 'file'
            ? [source.sourceKind, t.mergedFrom?.[0]?.label].filter(Boolean).join(', ')
            : source.videoId,
        },
      });
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

  const report = renderReport({ extraction, video: source, skillsTouched });
  const reportMdPath = join(REPORT_DIR, `${source.sourceId}.md`);
  writeFileSync(reportMdPath, report);
  writtenPaths.push(reportMdPath);

  console.log(`  ${adopted.length} adopted, ${extraction.tactics.length - adopted.length} rejected`);
  return { video: source, extraction, skillsTouched, writtenPaths };
}

/**
 * Every rejected tactic the corpus holds, newest report first.
 *
 * Reads the JSON reports rather than the markdown ones: the JSON is the structured
 * record and carries the fields a re-adjudication needs (mechanism, score, reason).
 */
export function collectRejects(reportDir = REPORT_DIR, { all = false } = {}) {
  let files;
  try {
    files = readdirSync(reportDir).filter((f) => f.endsWith('.json') && f !== 'staged-backfill.json');
  } catch { return []; }

  const out = [];
  for (const f of files.sort()) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(reportDir, f), 'utf8')); } catch { continue; }
    for (const t of doc.tactics ?? []) {
      if (t.verdict !== 'reject') continue;
      if (!all && !isTimingReject(t)) continue;
      out.push({ ...t, sourceId: doc.sourceId ?? f.replace(/\.json$/, ''), sourceCreator: doc.creator, sourceTitle: doc.title, reportFile: f });
    }
  }
  return out;
}

/**
 * Re-adjudicate previously rejected tactics under the current stage rules and park
 * the recoverable ones in their skills.
 *
 * Batched because the whole corpus is a few hundred tactics and one call carrying
 * all of them would push the response past max_tokens — which this repo treats as
 * corruption, not partial success, so it would discard the entire pass.
 */
const READJUDICATE_BATCH = 25;

async function runReadjudicate({ client, args }) {
  const rejects = collectRejects(REPORT_DIR, { all: args.all });
  if (!rejects.length) {
    console.log(args.all
      ? 'No rejected tactics in the corpus.'
      : 'No timing-based rejections to re-examine. Pass --all to re-read every rejection.');
    return;
  }

  const ahead = STAGES.slice(STAGES.indexOf(CURRENT_STAGE) + 1);
  console.log(`\n▶ re-adjudicating ${rejects.length} rejected tactic(s) against gates ahead of `
    + `"${CURRENT_STAGE}": ${ahead.join(', ')}`);
  if (!args.all) console.log('  (timing-flagged only — pass --all to re-read every rejection)');

  const inventory = scanSkillInventory(SKILLS_DIR);
  const judged = [];
  for (let i = 0; i < rejects.length; i += READJUDICATE_BATCH) {
    const batch = rejects.slice(i, i + READJUDICATE_BATCH);
    process.stdout.write(`  batch ${Math.floor(i / READJUDICATE_BATCH) + 1}: ${batch.length} tactics… `);
    const verdicts = await readjudicateRejects({ tactics: batch, inventory, client });
    const recovered = verdicts.filter((v) => v.outcome === 'recover').length;
    console.log(`${recovered} recovered, ${batch.length - recovered} upheld`);
    judged.push(...verdicts);
  }

  const recovered = judged.filter((t) => t.outcome === 'recover');
  const writtenPaths = [];
  const skillsTouched = [];

  const bySkill = new Map();
  for (const t of recovered) {
    const key = t.targetSkill.name;
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key).push({
      ...t,
      source: { creator: t.sourceCreator, title: t.sourceTitle, locator: t.sourceId },
    });
  }

  for (const [name, tactics] of bySkill) {
    const existing = inventory.find((s) => s.name === name);
    const description = existing
      ? parseFrontmatter(existing.content).description
      : tactics[0].targetSkill.description;
    const { path, action } = await writeSkill({ name, description, tactics, existing, client });
    skillsTouched.push({ name, action, path });
    writtenPaths.push(path);
    syncMirrorIfTouched(writtenPaths, skillsTouched);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  // Pacific, like every other date this agent stamps (--falsify uses todayPacific too).
  // toISOString would label an evening run with tomorrow's date.
  const stamp = todayPacific();
  const reportPath = join(REPORT_DIR, `readjudication-${stamp}.md`);
  const L = [
    `# Re-adjudication — ${stamp}`, '',
    `Re-read ${rejects.length} previously rejected tactic${rejects.length === 1 ? '' : 's'} `
    + `(${args.all ? 'every rejection in the corpus' : 'timing-flagged only'}) against the gates `
    + `now sitting ahead of \`${CURRENT_STAGE}\`: ${ahead.map((s) => `\`${s}\``).join(', ')}.`, '',
    `**${recovered.length} recovered and parked. ${judged.length - recovered.length} upheld.**`, '',
  ];
  if (recovered.length) {
    L.push('## Recovered', '');
    for (const t of recovered.sort((a, b) => b.rscFit.score - a.rscFit.score)) {
      L.push(`### ${t.claim} — ${t.rscFit.score}/10 · parked until \`${t.stage}\``, '');
      L.push(`**Now:** ${t.rscFit.reasoning}`, '');
      L.push(`**Originally rejected because:** ${t.rejectReason ?? 'n/a'}`, '');
      L.push(`**Source:** \`${t.sourceId}\` → \`${t.targetSkill.name}\``, '');
    }
  }
  const upheld = judged.filter((t) => t.outcome === 'uphold');
  if (upheld.length) {
    L.push('## Upheld', '');
    for (const t of upheld) L.push(`- **${t.claim}** — ${t.rscFit.reasoning}`);
    L.push('');
  }
  if (skillsTouched.length) {
    L.push('## Skills touched', '');
    for (const s of skillsTouched) L.push(`- \`${s.name}\` (${s.action})`);
  }
  writeFileSync(reportPath, L.join('\n'));
  writtenPaths.push(reportPath);

  console.log(`\n  ${recovered.length} recovered, ${judged.length - recovered.length} upheld`);
  console.log(`  report: ${relative(ROOT, reportPath)}`);

  notify({
    agent: 'marketing-learner',
    subject: `Re-adjudication: ${recovered.length} tactic(s) recovered from the reject pile`,
    body: `${rejects.length} re-read, ${recovered.length} parked behind ${ahead.join('/')}, `
      + `${judged.length - recovered.length} upheld. Skills touched: ${skillsTouched.map((s) => s.name).join(', ') || 'none'}.`,
  });

  if (args.noPr || !skillsTouched.length) return;
  openPullRequest([{ video: { sourceId: `readjudication-${stamp}`, sourceType: 'file', sourceKind: 'reject pile', title: `Re-adjudication ${stamp}` }, extraction: { tactics: judged.map((t) => ({ ...t, rejectReason: t.outcome === 'uphold' ? t.rscFit.reasoning : null })) }, skillsTouched, writtenPaths }]);
}

/**
 * Cache key for one chunk's extraction.
 *
 * The skill inventory is in the hash deliberately. If skills changed between
 * runs the extraction prompt changed, so the cache MUST miss — otherwise run 2
 * writes skills from an extraction that never saw the current inventory, and
 * the anti-duplication mechanism silently stops working.
 */
export function chunkCacheKey({ chunkText: body, inventoryFingerprint, constraintBlock }) {
  return createHash('sha256')
    .update(body).update(' ')
    .update(inventoryFingerprint).update(' ')
    .update(constraintBlock)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Chunk -> extract -> consolidate. Shared by both source paths.
 *
 * Length, not source type, is what decides whether chunking is needed: a 70-minute
 * video transcript is longer than a short book excerpt. Splitting only the file path
 * left long videos going one-shot into a 16k output cap, where they truncated and the
 * run aborted (pLhQOYMGa88, 9,794 words). A single chunk skips consolidation entirely
 * so short sources keep the cheaper one-call behaviour.
 */
async function extractFromSource({ source, inventory, args, client }) {
  const chunks = chunkText(source.text, { maxWords: args.chunkWords, splitOn: args.splitOn });
  console.log(`  ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} at ${args.chunkWords} words`);

  if (chunks.length === 1) {
    return extractTactics({ video: source, inventory, client });
  }
  const inventoryFingerprint = createHash('sha256')
    .update(inventory.map((s) => `${s.name} ${s.content}`).join(''))
    .digest('hex');
  // Must track the source, not be hardcoded: buildExtractionPrompt embeds the block
  // keyed off source.sourceType, so a hardcoded value desyncs the cache fingerprint
  // from the prompt the chunk was actually extracted with.
  const constraintBlock = buildConstraintBlock({ sourceType: source.sourceType });

  const corpusDir = join(CORPUS_DIR, source.sourceId);
  const cacheDir = join(corpusDir, 'chunks');
  mkdirSync(cacheDir, { recursive: true });

  const candidates = [];
  for (const chunk of chunks) {
    const key = chunkCacheKey({ chunkText: chunk.text, inventoryFingerprint, constraintBlock });
    const cachePath = join(cacheDir, `${String(chunk.index).padStart(3, '0')}-${key}.json`);

    let extraction = null;
    if (!args.refetch && existsSync(cachePath)) {
      try {
        extraction = JSON.parse(readFileSync(cachePath, 'utf8'));
        console.log(`  ${chunk.label}: cached`);
      } catch {
        console.warn(`  ⚠ cached chunk at ${relative(ROOT, cachePath)} is corrupt (partial write?) — re-extracting`);
      }
    }

    if (!extraction) {
      console.log(`  ${chunk.label}: extracting…`);
      try {
        extraction = await extractTactics({ video: source, inventory, chunk, client });
      } catch (err) {
        if (err.offendingPayload !== undefined) {
          const badPath = join(cacheDir, `invalid-${chunk.index}-${Date.now()}.json`);
          writeFileSync(badPath, JSON.stringify(err.offendingPayload, null, 2));
          console.error(`  ✗ schema validation failed — offending payload saved to ${relative(ROOT, badPath)}`);
        }
        throw err;
      }
      writeFileSync(cachePath, JSON.stringify(extraction, null, 2));
    }

    for (const t of extraction.tactics) {
      candidates.push({ ...t, chunk: { index: chunk.index, label: chunk.label } });
    }
  }

  console.log(`  ${candidates.length} candidate tactics across ${chunks.length} chunks — consolidating…`);

  const consolidatedPath = join(
    corpusDir,
    `consolidated-${createHash('sha256').update(JSON.stringify(candidates)).digest('hex').slice(0, 16)}.json`,
  );

  let extraction = null;
  if (!args.refetch && existsSync(consolidatedPath)) {
    try {
      extraction = JSON.parse(readFileSync(consolidatedPath, 'utf8'));
      console.log('  (consolidation from cache)');
    } catch {
      console.warn('  ⚠ cached consolidation is corrupt — redoing');
    }
  }
  if (!extraction) {
    try {
      extraction = await consolidateTactics({ candidates, source, client });
    } catch (err) {
      if (err.offendingPayload !== undefined) {
        const badPath = join(corpusDir, `invalid-consolidation-${Date.now()}.json`);
        writeFileSync(badPath, JSON.stringify(err.offendingPayload, null, 2));
        console.error(`  ✗ consolidation guard tripped — payload saved to ${relative(ROOT, badPath)}`);
      }
      throw err;
    }
    writeFileSync(consolidatedPath, JSON.stringify(extraction, null, 2));
  }
  console.log(`  ${extraction.tactics.length} canonical tactics after consolidation`);

  return extraction;
}

async function processFile(item, { client, args }) {
  const source = loadTextFile(item.file, {
    author: item.author, title: item.title, publishedAt: item.publishedAt,
    sourceKind: item.sourceKind,
  });
  if (item.warning) console.warn(`  ⚠ ${item.warning}`);
  console.log(`  ${source.text.split(/\s+/).length.toLocaleString()} words`);

  const inventory = scanSkillInventory(SKILLS_DIR);
  const extraction = await extractFromSource({ source, inventory, args, client });
  return finishSource({ source, extraction, inventory, args, client });
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
    // Branch from `origin/main`, not current HEAD: `checkout -b` with no start-point
    // branches from wherever the operator happens to be, so running this from an
    // unrelated feature branch would carry its unrelated commits straight into the PR.
    //
    // And origin/main rather than local `main`, because `main` is ONE ref shared by every
    // worktree — it tracks whatever the main checkout last pulled, which is routinely
    // 40+ commits stale, and a worktree cut from origin/main does not change it. On
    // 2026-08-20 that put PR #566 on a base two merges old; it merged cleanly only
    // because nothing overlapped. The next run would have reverted #566's edits to the
    // very skills it was about to edit again. Fetch first so origin/main is current:
    // the whole point is a fresh base, and a stale remote ref is the same bug renamed.
    git(['fetch', 'origin', 'main']);
    git(['checkout', '-b', branch, 'origin/main']);

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
      const title = r.video.title ?? r.video.sourceId;
      const link = r.video.sourceType === 'file'
        ? `\`${r.video.sourceId}\` (${r.video.sourceKind ?? 'book'})`
        : `https://www.youtube.com/watch?v=${r.video.videoId}`;
      return `## ${title}\n\n${link}\n\n| Score | Verdict | Claim | Reasoning |\n|---|---|---|---|\n${rows}`;
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

  if (args.staged) {
    runStaged(args);
    return;
  }

  if (args.falsify) {
    runFalsify(args);
    return;
  }

  const env = loadEnv();

  // A file source spends no transcript credits, so demanding this key would
  // block a book run on a credential it never uses.
  let apiKey = null;
  if (!args.file) {
    apiKey = env.TRANSCRIPTAPI_KEY || process.env.TRANSCRIPTAPI_KEY;
    if (!apiKey) {
      console.error('TRANSCRIPTAPI_KEY is not set. Add it to .env.');
      process.exit(1);
    }
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

  const client = new Anthropic({ apiKey: anthropicKey });
  const results = [];

  if (args.readjudicate) {
    return runReadjudicate({ client, args });
  }

  if (args.file) {
    // parsePublishedFlags does double duty here: it validates the date (bare
    // YYYY allowed for files) and produces the staleness warning.
    const [dated] = parsePublishedFlags([args.file], args.published, { allowYearOnly: true });
    console.log(`\n▶ ${args.file}`);
    results.push(await processFile(
      { ...dated, file: args.file, author: args.author, title: args.title, sourceKind: args.sourceKind },
      { client, args },
    ));
    return finish(results, args);
  }

  const items = parsePublishedFlags(args.urls, args.published, {});

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

  return finish(results, args);
}

/** PR + notification tail, shared by both front doors. */
async function finish(results, args) {
  if (!results.length) {
    console.log('\nNothing processed.');
    return;
  }
  if (!args.extractOnly && !args.noPr) openPullRequest(results);

  const adopted = results.reduce((n, r) => n + r.extraction.tactics.filter((t) => t.verdict === 'adopt').length, 0);
  const rejected = results.reduce((n, r) => n + r.extraction.tactics.filter((t) => t.verdict === 'reject').length, 0);
  await notify({
    subject: `Marketing learner: ${adopted} adopted, ${rejected} rejected`,
    body: results.map((r) => `${r.video.title ?? r.video.sourceId}: ${r.skillsTouched.map((s) => s.name).join(', ') || 'no skills changed'}`).join('\n'),
    category: 'marketing-learner',
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
