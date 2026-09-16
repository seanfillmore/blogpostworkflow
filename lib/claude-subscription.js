// lib/claude-subscription.js
//
// Runs a Messages API request through the Claude Code CLI (`claude -p`) so it is billed
// to the Claude SUBSCRIPTION instead of the per-token Console API key.
//
// WHY THIS EXISTS. The fleet was believed to have moved off per-token billing on
// 2026-09-08. It had not: every agent still built `new Anthropic({ apiKey })` from
// ANTHROPIC_API_KEY, and the server's own usage log measured $114.01 over the 31 days to
// 2026-09-16 (~$26/wk). lib/anthropic.js is the one import all 43 LLM-calling agents share,
// so routing its create()/stream() through here moves the whole fleet with no call site
// changing.
//
// WHAT THE CLI IS MADE TO BE. A bare completion, not a coding agent:
//   --system-prompt-file  REPLACES Claude Code's own system prompt (measured: 244 input
//                         tokens for a one-line prompt, i.e. nothing of Claude Code's added).
//                         A file, not the argv flag — Linux caps ONE argv string at 128 KB
//                         and the fleet's largest system prompts exceed that.
//   --tools ""            no tools, so a request cannot read, write or run anything
//   --setting-sources ""  no user/project settings, hooks or CLAUDE.md
//   --strict-mcp-config   no MCP servers
//   --max-turns 1, --no-session-persistence
// and it runs in an empty temp directory, so nothing in the repo is in scope.
//
// THREE BEHAVIOURS THAT DIFFER FROM THE API, each measured 2026-09-16 on CLI 2.1.250:
//
// 1. Thinking is ON by default. With a small output cap it consumed the whole budget and
//    returned no text. MAX_THINKING_TOKENS=0 + alwaysThinkingEnabled:false turn it off;
//    a request that passes `thinking` gets it back on at its own budget.
//
// 2. max_tokens is enforced by CLAUDE_CODE_MAX_OUTPUT_TOKENS, and hitting it does NOT
//    return stop_reason 'max_tokens'. The CLI auto-continues up to three times, then ends
//    with `is_error: true` and "Claude's response exceeded the N output token maximum".
//    parseCliOutput maps that back to stop_reason 'max_tokens' with the partial text, so
//    every truncation guard in the fleet (assertHtmlComplete, the stop_reason checks in 22
//    call sites) still fires. A request that recovers inside those continuations returns
//    the joined text with 'end_turn' — more complete than the API would have given, never
//    less.
//
// 3. ANTHROPIC_API_KEY in the child's environment makes Claude Code bill THAT KEY. It is
//    stripped from the child env unconditionally; forgetting this would silently keep the
//    exact spend this module exists to remove.
//
// ONE AT A TIME BY DEFAULT. A `claude -p` process peaks at ~210 MB RSS and the production
// box has 961 MB total with ~590 MB available — the same box whose dashboard has been
// OOM-killed hundreds of times. agents/editor fans calls out with Promise.all, so an
// in-process semaphore (LLM_SUBSCRIPTION_CONCURRENCY, default 1) queues them.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Error for a request shape the CLI cannot carry. The caller falls back to the API. */
export class SubscriptionUnsupportedError extends Error {
  constructor(msg) { super(msg); this.name = 'SubscriptionUnsupportedError'; }
}

// ── configuration ───────────────────────────────────────────────────────────────

let dotenvCache;
function dotenv() {
  if (dotenvCache) return dotenvCache;
  dotenvCache = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) dotenvCache[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch { /* no .env — process.env only */ }
  return dotenvCache;
}

/** process.env first, then .env — agents' loadEnv() keeps .env OUT of process.env. */
export function setting(name, env = process.env, file = dotenv()) {
  return env[name] ?? file[name];
}

/**
 * Which transport a request takes. Pure given its inputs.
 *   LLM_TRANSPORT=api           → always the API
 *   LLM_TRANSPORT=subscription  → always the CLI (a local login may supply auth)
 *   unset                       → the CLI when CLAUDE_CODE_OAUTH_TOKEN is configured,
 *                                 otherwise the API. So deploying this changes nothing
 *                                 until a token is put in .env.
 */
export function resolveTransport({ transport, token } = {}) {
  const t = String(transport || '').trim().toLowerCase();
  if (t === 'api') return 'api';
  if (t === 'subscription') return 'subscription';
  return token ? 'subscription' : 'api';
}

export function currentTransport() {
  return resolveTransport({
    transport: setting('LLM_TRANSPORT'),
    token: setting('CLAUDE_CODE_OAUTH_TOKEN'),
  });
}

function resolveClaudeBin() {
  const configured = setting('CLAUDE_BIN');
  if (configured) return configured;
  // cron's PATH does not include ~/.local/bin, where the native installer puts it.
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

// ── request → CLI ───────────────────────────────────────────────────────────────

function stripCacheControl(block) {
  if (!block || typeof block !== 'object') return block;
  const { cache_control: _drop, ...rest } = block;
  return rest;
}

function systemText(system) {
  if (system == null) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n\n');
  throw new SubscriptionUnsupportedError('system prompt is neither a string nor text blocks');
}

/**
 * Translate Messages API params into a CLI invocation. Pure; throws
 * SubscriptionUnsupportedError for anything the CLI cannot carry faithfully.
 * @returns {{ args: string[], system: string, stdin: string, env: object }}
 */
export function buildCliRequest(params = {}) {
  if (params.tools?.length || params.tool_choice) {
    throw new SubscriptionUnsupportedError('tool use is not supported over the subscription transport');
  }
  const messages = params.messages || [];
  if (!messages.length) throw new SubscriptionUnsupportedError('no messages');
  if (messages.some((m) => m.role !== 'user')) {
    // A prefilled or multi-turn conversation cannot be replayed as one CLI turn.
    throw new SubscriptionUnsupportedError('non-user turns are not supported over the subscription transport');
  }
  const content = [];
  for (const m of messages) {
    if (typeof m.content === 'string') content.push({ type: 'text', text: m.content });
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type !== 'text' && b?.type !== 'image' && b?.type !== 'document') {
          throw new SubscriptionUnsupportedError(`content block type "${b?.type}" is not supported`);
        }
        content.push(stripCacheControl(b));
      }
    } else throw new SubscriptionUnsupportedError('message content is neither a string nor blocks');
  }

  const thinkingBudget = params.thinking?.type === 'enabled' ? params.thinking.budget_tokens : null;
  const thinkingOn = params.thinking && params.thinking.type !== 'disabled';
  const env = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(params.max_tokens || 4096),
    MAX_THINKING_TOKENS: thinkingOn ? String(thinkingBudget || 16000) : '0',
  };

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', String(params.model),
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--settings', JSON.stringify({ alwaysThinkingEnabled: Boolean(thinkingOn) }),
    '--no-session-persistence',
    '--max-turns', '1',
  ];
  const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  return { args, system: systemText(params.system), stdin, env };
}

/** Child env: inherit, add the request's env, and NEVER pass an API key (see header §3). */
export function childEnv(base = process.env, extra = {}, token = setting('CLAUDE_CODE_OAUTH_TOKEN')) {
  const env = { ...base, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

// ── CLI → response ──────────────────────────────────────────────────────────────

const OUTPUT_CAP_RE = /exceeded the \d+ output token maximum/i;

function statusError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Turn the CLI's stream-json stdout into a Messages API response object. Pure.
 * Throws an Error carrying `.status` (429 rate/usage limit, 401 auth, 500 other) so
 * lib/retry.js classifies it the way it classifies the SDK's own errors.
 */
export function parseCliOutput(stdout, { model, stderr = '' } = {}) {
  let text = '';
  let lastStop = null;
  let result = null;
  let rejected = false;
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'assistant' && ev.message && ev.message.model !== '<synthetic>') {
      for (const b of ev.message.content || []) if (b.type === 'text') text += b.text;
      if (ev.message.stop_reason) lastStop = ev.message.stop_reason;
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') {
      rejected = true;
    } else if (ev.type === 'result') {
      result = ev;
    }
  }

  if (!result) {
    throw statusError(`claude CLI produced no result${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`, 500);
  }

  const u = result.usage || {};
  const usage = {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
  const message = (stop_reason, body) => ({
    id: `msg_subscription_${result.session_id || Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: body }],
    stop_reason,
    stop_sequence: null,
    usage,
  });

  const resultText = String(result.result || '');
  if (result.is_error) {
    if (OUTPUT_CAP_RE.test(resultText)) return message('max_tokens', text);
    if (rejected || /rate limit|usage limit|limit reached|429/i.test(resultText)) {
      throw statusError(`claude subscription rate-limited: ${resultText.slice(0, 300)}`, 429);
    }
    if (/auth|log ?in|401|403|invalid.*(token|key)|credential/i.test(resultText)) {
      throw statusError(`claude subscription auth failed: ${resultText.slice(0, 300)}`, 401);
    }
    throw statusError(`claude CLI error: ${resultText.slice(0, 500)}`, 500);
  }
  return message(result.stop_reason || lastStop || 'end_turn', text || resultText);
}

// ── process ─────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 20 * 60_000;

let active = 0;
const waiters = [];
function concurrency() {
  const n = Number(setting('LLM_SUBSCRIPTION_CONCURRENCY'));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
async function acquire() {
  if (active < concurrency()) { active += 1; return; }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}
function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

function abortError(signal) {
  const err = new Error(signal?.reason?.message || 'Request was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Run one request through the CLI and resolve a Messages API response.
 * @param {object} params   Messages API params
 * @param {{signal?: AbortSignal, timeout?: number}} [options]
 * @param {{spawnImpl?: Function}} [deps]  injectable for tests
 */
export async function createViaSubscription(params, options = {}, { spawnImpl = spawn } = {}) {
  const req = buildCliRequest(params); // throws Unsupported before queueing
  const { signal } = options;
  if (signal?.aborted) throw abortError(signal);

  await acquire();
  const dir = mkdtempSync(join(tmpdir(), 'claude-sub-'));
  try {
    const sysPath = join(dir, 'system.txt');
    writeFileSync(sysPath, req.system);
    const args = [...req.args, '--system-prompt-file', sysPath];

    const { stdout, stderr, code } = await new Promise((resolve, reject) => {
      const child = spawnImpl(resolveClaudeBin(), args, {
        cwd: dir,
        env: childEnv(process.env, req.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let errText = '';
      let settled = false;
      const finish = (fn) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); fn(); } };
      const onAbort = () => finish(() => { child.kill('SIGTERM'); reject(abortError(signal)); });
      const timer = setTimeout(() => finish(() => {
        child.kill('SIGTERM');
        reject(statusError(`claude CLI timed out after ${Math.round((options.timeout || DEFAULT_TIMEOUT_MS) / 1000)}s`, 408));
      }), options.timeout || DEFAULT_TIMEOUT_MS);
      signal?.addEventListener?.('abort', onAbort, { once: true });

      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { errText += d; });
      child.on('error', (e) => finish(() => reject(statusError(`claude CLI failed to start (${resolveClaudeBin()}): ${e.message}`, 500))));
      child.on('close', (c) => finish(() => resolve({ stdout: out, stderr: errText, code: c })));
      child.stdin.on('error', () => { /* child exited early; close() reports it */ });
      child.stdin.end(req.stdin);
    });

    try {
      return parseCliOutput(stdout, { model: params.model, stderr });
    } catch (err) {
      if (code && !err.status) err.status = 500;
      throw err;
    }
  } finally {
    release();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * A stand-in for the SDK's MessageStream over a completed CLI response. The CLI output is
 * buffered, so the whole text arrives as ONE text_delta — every consumer in the fleet
 * (agents/blog-post-writer) accumulates deltas, and finalMessage() is exact.
 */
export function subscriptionStream(params, options, deps) {
  const done = createViaSubscription(params, options, deps);
  done.catch(() => { /* surfaced through iteration / finalMessage() */ });
  return {
    finalMessage: () => done,
    async *[Symbol.asyncIterator]() {
      const msg = await done;
      yield { type: 'message_start', message: { ...msg, content: [] } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: msg.content[0].text } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } };
      yield { type: 'message_stop' };
    },
    on(event, cb) {
      if (event === 'text') done.then((m) => cb(m.content[0].text, m.content[0].text), () => {});
      else if (event === 'message' || event === 'finalMessage') done.then(cb, () => {});
      else if (event === 'error') done.catch(cb);
      return this;
    },
    abort() { /* the caller's AbortSignal is the supported path */ },
  };
}
