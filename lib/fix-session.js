/**
 * An autonomous Claude Code session (`claude -p` WITH tools) that tries to fix a
 * code defect found in the daily digest.
 *
 * CREDENTIAL-FREE ON PURPOSE. The session can run node and edit files, so it must
 * not be able to reach production: its env is built from { HOME, PATH } only —
 * never process.env — plus the subscription OAuth token from `childEnv`, which
 * also strips ANTHROPIC_API_KEY. No .env is linked into its worktree, so Shopify,
 * Klaviyo, Hushmail and every other key are simply absent. Its output is checked
 * afterwards by lib/fix-diff-rules.js; nothing here ships anything.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnv, setting } from './claude-subscription.js';
import { FORBIDDEN_PATHS, GATE_FILES, GUARD_FILES, GUARD_PREFIXES } from './fix-diff-rules.js';

export const ALLOWED_TOOLS = 'Read,Edit,Write,Grep,Glob,Bash(node:*),Bash(npm test:*),Bash(git diff:*),Bash(git status:*),Bash(git add:*),Bash(git commit:*)';
const VERDICTS = ['fixed', 'gate', 'external', 'no-fix'];

function resolveClaudeBin() {
  const configured = setting('CLAUDE_BIN');
  if (configured) return configured;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

/**
 * Fresh worktree off origin/main with node_modules linked and NOTHING else (no .env).
 * @param {string} name
 * @param {{exec: (cmd: string, args: string[], opts?: object) => Promise<{stdout: string, stderr: string, code: number}>, root: string}} deps
 * @returns {Promise<string>} worktree path
 */
export async function createCleanWorktree(name, { exec, root }) {
  const path = `${root}/.claude/worktrees/fix-${name}`;
  const steps = [
    ['git', ['fetch', 'origin']],
    ['git', ['worktree', 'add', '-b', `fix/recap-${name}`, path, 'origin/main']],
    ['ln', ['-s', `${root}/node_modules`, `${path}/node_modules`]],
  ];
  for (const [cmd, args] of steps) {
    const r = await exec(cmd, args, { cwd: root });
    if (r.code !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return path;
}

export function buildFixPrompt({ item, logTail = '', command = '' }) {
  return [
    'You are fixing a code defect found in the daily digest of the Real Skin Care SEO agent fleet. Work only in this worktree.',
    '',
    `FAILURE: ${item.subject}`,
    `SOURCE: ${item.source || '(unknown)'}`,
    `DETAIL: ${item.detail || ''}`,
    `ROW BODY:\n${item.row?.body || ''}`,
    command ? `RE-RUN COMMAND (dry): ${command}` : '',
    logTail ? `LOG TAIL:\n${logTail}` : '',
    '',
    'RULES',
    '- Find the root cause in code and fix it with the smallest change.',
    '- Remember: a failure caused by a gate correctly refusing is not a code defect. Do not change code to get past a gate; end with VERDICT: gate.',
    '- A failure caused by an outside service (API down, rate limit, credentials) is external; end with VERDICT: external.',
    '- You must add a test that fails before the fix and passes after it.',
    '- You must never weaken a test, delete a test, or change a notify status to make a problem look smaller.',
    '- The whole diff may not exceed 300 changed lines.',
    `- Never touch these paths: ${FORBIDDEN_PATHS.join(', ')}`,
    `- Never touch these gate files: ${GATE_FILES.join(', ')}`,
    `- Never touch these protected files: ${GUARD_FILES.join(', ')} or anything under ${GUARD_PREFIXES.join(', ')}`,
    '- You have no credentials and no network access to production. Do not try to obtain any.',
    '- Run `npm test` before finishing.',
    '- Then commit your fix in this worktree (git add, git commit). Do not push.',
    '',
    'End your final reply with exactly one line:',
    'VERDICT: fixed|gate|external|no-fix — <one sentence>',
  ].filter((l) => l !== '').join('\n');
}

/** Find the last VERDICT line (em dash or hyphen). No line means no-fix. */
export function parseVerdict(text) {
  const re = /^\s*VERDICT:\s*(fixed|gate|external|no-fix)\s*(?:[—–-]+\s*(.*))?$/gim;
  let m; let last = null;
  while ((m = re.exec(String(text || '')))) last = m;
  if (!last) return { verdict: 'no-fix', summary: 'no VERDICT line in the session output' };
  return { verdict: last[1].toLowerCase(), summary: (last[2] || '').trim() };
}

function sessionText(stdout) {
  try {
    const j = JSON.parse(stdout);
    if (j && typeof j.result === 'string') return j.result;
  } catch { /* not a single JSON object */ }
  return stdout;
}

/**
 * @returns {Promise<{exitCode: number|null, verdict: 'fixed'|'gate'|'external'|'no-fix', summary: string}>}
 */
export async function runFixSession({
  worktree, prompt, spawnImpl = spawn, timeoutMs = 45 * 60_000, killGraceMs = 10_000,
  token = setting('CLAUDE_CODE_OAUTH_TOKEN'),
}) {
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS];
  const env = childEnv({ HOME: process.env.HOME || homedir(), PATH: process.env.PATH || '/usr/bin:/bin' }, {}, token);
  return new Promise((resolve) => {
    let out = ''; let timedOut = false; let done = false;
    const child = spawnImpl(resolveClaudeBin(), args, { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(killTimer); resolve(r); } };
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr?.on('data', () => {});
    child.on('error', (e) => finish({ exitCode: null, verdict: 'no-fix', summary: `claude failed to start: ${e.message}` }));
    child.on('close', (code) => {
      if (timedOut) return finish({ exitCode: code, verdict: 'no-fix', summary: 'timed out' });
      finish({ exitCode: code, ...parseVerdict(sessionText(out)) });
    });
  });
}
