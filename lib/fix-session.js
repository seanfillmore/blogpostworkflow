/**
 * An autonomous Claude Code session (`claude -p` WITH tools) that tries to fix a
 * code defect found in the daily digest.
 *
 * ISOLATION IS AN OS USER, NOT ENV STRIPPING. The session can run node and edit
 * files, so anything its user can read, it can read. It therefore runs as a
 * dedicated unprivileged user (`recapfix`, via `runuser -u`), never as root, in a
 * fresh clone under /srv/recap-fix — outside /root/seo-claude. root's home is
 * 0700, so /root/seo-claude/.env, ~/.ssh and root's ~/.claude are unreadable to
 * it. Its env is { HOME, PATH } plus the OAuth token from `childEnv` (which also
 * strips ANTHROPIC_API_KEY); no .env is ever copied or linked into the clone.
 *
 * ACCEPTED RESIDUAL RISK, stated plainly: the session still has network access
 * and holds the Claude OAuth token. Its output is checked afterwards by
 * lib/fix-diff-rules.js; nothing here ships anything.
 */
import { spawn } from 'node:child_process';
import { childEnv, setting } from './claude-subscription.js';
import { FORBIDDEN_PATHS, GATE_FILES, GUARD_FILES, GUARD_PREFIXES } from './fix-diff-rules.js';

export const ALLOWED_TOOLS = 'Read,Edit,Write,Grep,Glob,Bash(node:*),Bash(npm test:*),Bash(git diff:*),Bash(git status:*),Bash(git add:*),Bash(git commit:*)';
const VERDICTS = ['fixed', 'gate', 'external', 'no-fix'];

const asUser = (runAs, cmd, args) => ['runuser', ['-u', runAs, '--', cmd, ...args]];

/**
 * Fresh clone of the public repo for the unprivileged user. No .env, no symlinks.
 * @param {string} name  sanitized to [a-z0-9-], max 60
 * @param {{exec: (cmd: string, args: string[], opts?: object) => Promise<{stdout: string, stderr: string, code: number}>, baseDir?: string, repoUrl?: string, runAs?: string, ref?: string}} deps
 * @returns {Promise<string>} checkout path
 */
export async function createFixCheckout(name, {
  exec, baseDir = '/srv/recap-fix', repoUrl = 'https://github.com/seanfillmore/blogpostworkflow.git',
  runAs = 'recapfix', ref = 'origin/main',
}) {
  const safe = String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  if (!safe) throw new Error('createFixCheckout: empty name');
  const path = `${baseDir}/fix-${safe}`;
  const steps = [
    [['git', ['clone', '--quiet', repoUrl, path]], undefined],
    [['git', ['-C', path, 'checkout', '-b', `fix/recap-${safe}`, ...(ref && ref !== 'origin/main' ? [ref] : [])]], undefined],
    [['git', ['-C', path, 'config', 'user.name', 'Recap Reviewer']], undefined],
    [['git', ['-C', path, 'config', 'user.email', 'recap-reviewer@realskincare.com']], undefined],
    [['npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline']], { cwd: path }],
  ];
  for (const [[cmd, args], opts] of steps) {
    const [c, a] = asUser(runAs, cmd, args);
    const r = await exec(c, a, opts);
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

const CAP = 2 * 1024 * 1024;
const tailAppend = (cur, d) => { const n = cur + d; return n.length > CAP ? n.slice(-CAP) : n; };

/**
 * @returns {Promise<{exitCode: number|null, verdict: 'fixed'|'gate'|'external'|'no-fix', summary: string}>}
 */
export async function runFixSession({
  worktree, prompt, spawnImpl = spawn, timeoutMs = 45 * 60_000, killGraceMs = 10_000,
  token = setting('CLAUDE_CODE_OAUTH_TOKEN'), runAs = 'recapfix',
  claudeBin = setting('CLAUDE_FIX_BIN') || '/usr/local/bin/claude',
  killGroup = (pid, sig) => process.kill(-pid, sig),
}) {
  const args = ['-u', runAs, '--', claudeBin, '-p', prompt, '--output-format', 'json',
    '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS];
  const env = childEnv({ HOME: `/home/${runAs}`, PATH: '/usr/local/bin:/usr/bin:/bin' }, {}, token);
  return new Promise((resolve) => {
    let out = ''; let timedOut = false; let done = false; let killTimer;
    const child = spawnImpl('runuser', args, { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = (sig) => { try { killGroup(child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(killTimer); resolve(r); } };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    child.stdout.on('data', (d) => { out = tailAppend(out, d); });
    let err = '';
    child.stderr?.on('data', (d) => { err = tailAppend(err, d); });
    child.on('error', (e) => finish({ exitCode: null, verdict: 'no-fix', summary: `claude failed to start: ${e.message}` }));
    child.on('close', (code) => {
      if (timedOut) return finish({ exitCode: code, verdict: 'no-fix', summary: 'timed out' });
      finish({ exitCode: code, ...parseVerdict(sessionText(out)) });
    });
  });
}
