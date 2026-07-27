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
 * Requires TRANSCRIPTAPI_KEY in .env.
 * Spec: docs/superpowers/specs/2026-07-27-marketing-learner-design.md
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

export function parseArgs(argv) {
  const out = { urls: [], published: [], extractOnly: false, noPr: false, refetch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--published') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error('--published requires a YYYY-MM-DD value.');
      out.published.push(v);
    } else if (FLAGS[a]) {
      out[FLAGS[a]] = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      out.urls.push(a);
    }
  }
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
    console.log('  (transcript from cache — 0 credits)');
    return { ...JSON.parse(readFileSync(cachePath, 'utf8')), publishedAt };
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
 */
async function writeSkill({ name, description, tactics, existing, client }) {
  const dir = join(SKILLS_DIR, name);
  const path = join(dir, 'SKILL.md');

  if (existing) {
    const { content, supersedes } = await mergeSkillContent({
      existingContent: existing.content,
      tactics,
      client,
    });
    writeFileSync(path, content);
    if (supersedes) console.log(`  ↻ ${name} superseded content: ${supersedes}`);
    return { path, action: 'edit' };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderSkillMarkdown({ name, description, tactics }));
  return { path, action: 'create' };
}

async function processVideo(item, { client, apiKey, args }) {
  const video = await loadVideo(item.url, item.publishedAt, { refetch: args.refetch, apiKey });
  if (item.warning) console.warn(`  ⚠ ${item.warning}`);

  const inventory = scanSkillInventory(SKILLS_DIR);
  const extraction = await extractTactics({ video, inventory, client });

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, `${video.videoId}.json`), JSON.stringify(extraction, null, 2));

  const adopted = extraction.tactics.filter((t) => t.verdict === 'adopt');
  const skillsTouched = [];

  if (!args.extractOnly) {
    const bySkill = new Map();
    for (const t of adopted) {
      const key = t.targetSkill.name;
      if (!bySkill.has(key)) bySkill.set(key, { action: t.targetSkill.action, tactics: [] });
      bySkill.get(key).tactics.push({ ...t, source: { creator: video.creator, title: video.title, videoId: video.videoId } });
    }
    for (const [name, { tactics }] of bySkill) {
      const existing = inventory.find((s) => s.name === name);
      const description = existing
        ? parseFrontmatter(existing.content).description
        : `Use when working on ${name.replace(/^marketing-/, '').replace(/-/g, ' ')} for Real Skin Care.`;
      const { action } = await writeSkill({ name, description, tactics, existing, client });
      skillsTouched.push({ name, action });
    }
  }

  const report = renderReport({ extraction, video, skillsTouched });
  writeFileSync(join(REPORT_DIR, `${video.videoId}.md`), report);

  console.log(`  ${adopted.length} adopted, ${extraction.tactics.length - adopted.length} rejected`);
  return { video, extraction, skillsTouched };
}

function openPullRequest(results) {
  const touched = results.flatMap((r) => r.skillsTouched);
  if (!touched.length) {
    console.log('No skills changed — skipping the PR.');
    return null;
  }
  const topics = [...new Set(touched.map((s) => s.name.replace(/^marketing-/, '')))];
  const branch = topics.length === 1
    ? `feature/marketing-skill-${topics[0]}`
    : `feature/marketing-skills-${topics.length}-topics`;

  git(['checkout', '-b', branch]);
  git(['add', '.claude/skills', 'data/reports/marketing-learner']);
  git(['commit', '-m', `feat(skills): marketing tactics from ${results.length} video(s)\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`]);
  git(['push', '-u', 'origin', branch]);

  const body = results.map((r) => {
    const rows = r.extraction.tactics
      .sort((a, b) => b.rscFit.score - a.rscFit.score)
      .map((t) => `| ${t.rscFit.score}/10 | ${t.verdict} | ${t.claim} | ${t.rejectReason ?? t.rscFit.reasoning} |`)
      .join('\n');
    return `## ${r.video.title}\n\nhttps://www.youtube.com/watch?v=${r.video.videoId}\n\n| Score | Verdict | Claim | Reasoning |\n|---|---|---|---|\n${rows}`;
  }).join('\n\n');

  execFileSync('gh', ['pr', 'create', '--title', `Marketing skills: ${topics.join(', ')}`, '--body',
    `${body}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`],
    { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
  return branch;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = loadEnv().TRANSCRIPTAPI_KEY || process.env.TRANSCRIPTAPI_KEY;
  if (!apiKey) {
    console.error('TRANSCRIPTAPI_KEY is not set. Add it to .env.');
    process.exit(1);
  }
  const items = parsePublishedFlags(args.urls, args.published, {});
  const client = new Anthropic();

  const results = [];
  for (const item of items) {
    console.log(`\n▶ ${item.url}`);
    try {
      results.push(await processVideo(item, { client, apiKey, args }));
    } catch (err) {
      if (err instanceof TranscriptError && ['NOT_FOUND', 'NO_ENGLISH'].includes(err.code)) {
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
    body: results.map((r) => `${r.video.title}: ${r.skillsTouched.map((s) => s.name).join(', ') || 'no skills changed'}`).join('\n'),
    category: 'marketing-learner',
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
