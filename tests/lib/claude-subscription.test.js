// tests/lib/claude-subscription.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LLM_USAGE_DIR = mkdtempSync(join(tmpdir(), 'llm-usage-sub-test-'));

const {
  resolveTransport,
  buildCliRequest,
  parseCliOutput,
  childEnv,
  createViaSubscription,
  subscriptionStream,
  SubscriptionUnsupportedError,
} = await import('../../lib/claude-subscription.js');

const MODEL = 'claude-haiku-4-5-20251001';
const lines = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const assistant = (text, extra = {}) => ({ type: 'assistant', message: { model: MODEL, content: [{ type: 'text', text }], stop_reason: null, ...extra } });
const result = (extra) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', usage: { input_tokens: 12, output_tokens: 34 }, stop_reason: 'end_turn', result: '', ...extra });

// ── transport selection ─────────────────────────────────────────────────────────

test('transport: deploying without a token changes nothing', () => {
  assert.equal(resolveTransport({}), 'api');
  assert.equal(resolveTransport({ token: 'sk-ant-oat-x' }), 'subscription');
  assert.equal(resolveTransport({ token: 'sk-ant-oat-x', transport: 'api' }), 'api', 'explicit api wins over a token');
  assert.equal(resolveTransport({ transport: 'Subscription' }), 'subscription', 'a local login can supply auth');
});

// ── request translation ─────────────────────────────────────────────────────────

test('buildCliRequest: system goes to a file, content to stdin, max_tokens to the env', () => {
  const req = buildCliRequest({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }],
    messages: [{ role: 'user', content: 'hello' }, { role: 'user', content: [{ type: 'text', text: 'again', cache_control: { type: 'ephemeral' } }] }],
  });
  assert.equal(req.system, 'A\n\nB');
  assert.equal(req.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8000');
  assert.equal(req.env.MAX_THINKING_TOKENS, '0', 'thinking is off unless requested — it ate the whole budget when left on');
  const sent = JSON.parse(req.stdin);
  assert.deepEqual(sent.message.content, [{ type: 'text', text: 'hello' }, { type: 'text', text: 'again' }]);
  for (const flag of ['--tools', '--strict-mcp-config', '--setting-sources', '--no-session-persistence']) {
    assert.ok(req.args.includes(flag), `a bare completion needs ${flag}`);
  }
  assert.equal(req.args[req.args.indexOf('--tools') + 1], '', 'no tools at all');
  assert.ok(!req.args.includes('--system-prompt'), 'never on argv — Linux caps one argv string at 128 KB');
});

test('buildCliRequest: images pass through; thinking is honoured', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const req = buildCliRequest({ model: MODEL, max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 5000 }, messages: [{ role: 'user', content: [img, { type: 'text', text: 'x' }] }] });
  assert.deepEqual(JSON.parse(req.stdin).message.content[0], img);
  assert.equal(req.env.MAX_THINKING_TOKENS, '5000');
});

test('buildCliRequest: shapes one CLI turn cannot carry are refused, not mangled', () => {
  const base = { model: MODEL, max_tokens: 10 };
  const cases = [
    { ...base, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '{' }] },
    { ...base, tools: [{ name: 't' }], messages: [{ role: 'user', content: 'q' }] },
    { ...base, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] },
  ];
  for (const c of cases) assert.throws(() => buildCliRequest(c), SubscriptionUnsupportedError);
});

test('childEnv: an API key NEVER reaches the CLI — it would bill that key', () => {
  const env = childEnv({ ANTHROPIC_API_KEY: 'sk-ant-api', ANTHROPIC_AUTH_TOKEN: 'x', PATH: '/bin' }, { MAX_THINKING_TOKENS: '0' }, 'sk-ant-oat');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat');
  assert.equal(env.PATH, '/bin');
});

// ── output parsing (shapes captured from CLI 2.1.250, 2026-09-16) ───────────────

test('parseCliOutput: a normal reply becomes a Messages API response', () => {
  const msg = parseCliOutput(lines({ type: 'system', subtype: 'init' }, assistant('PONG'), result()), { model: MODEL });
  assert.equal(msg.content[0].text, 'PONG');
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.usage.output_tokens, 34);
  assert.equal(msg.model, MODEL);
});

test('parseCliOutput: hitting the output cap maps back to max_tokens so truncation guards fire', () => {
  const out = lines(
    assistant('One, Two, Th'),
    assistant('ree, Four'),
    { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Claude\'s response exceeded the 60 output token maximum.' }], stop_reason: 'stop_sequence' } },
    result({ is_error: true, stop_reason: 'stop_sequence', result: "API Error: Claude's response exceeded the 60 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable." }),
  );
  const msg = parseCliOutput(out, { model: MODEL });
  assert.equal(msg.stop_reason, 'max_tokens');
  assert.equal(msg.content[0].text, 'One, Two, Three, Four', 'continuations are joined; the synthetic error text is not content');
});

test('parseCliOutput: errors carry the status lib/retry.js classifies on', () => {
  const rate = lines({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, result({ is_error: true, result: 'Claude usage limit reached' }));
  assert.throws(() => parseCliOutput(rate, { model: MODEL }), (e) => e.status === 429);
  const auth = lines(result({ is_error: true, result: 'Invalid API key · Please run /login' }));
  assert.throws(() => parseCliOutput(auth, { model: MODEL }), (e) => e.status === 401);
  assert.throws(() => parseCliOutput('', { model: MODEL, stderr: 'boom' }), (e) => e.status === 500 && /boom/.test(e.message));
});

// ── process handling ────────────────────────────────────────────────────────────

function fakeSpawn({ stdout, delayMs = 0, seen = [] }) {
  return (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = Object.assign(new EventEmitter(), { end: (s) => { input = s; } });
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    const call = { args, opts, get input() { return input; }, child, system: null };
    const sysIdx = args.indexOf('--system-prompt-file');
    call.system = readFileSync(args[sysIdx + 1], 'utf8');
    seen.push(call);
    setTimeout(() => {
      if (child.killed) return;
      child.stdout.emit('data', stdout);
      child.emit('close', 0);
    }, delayMs);
    return child;
  };
}

test('createViaSubscription: runs in an empty temp dir with the system prompt in a file', async () => {
  const seen = [];
  const msg = await createViaSubscription(
    { model: MODEL, max_tokens: 50, system: 'SYS', messages: [{ role: 'user', content: 'hi' }] },
    {},
    { spawnImpl: fakeSpawn({ stdout: lines(assistant('ok'), result()), seen }) },
  );
  assert.equal(msg.content[0].text, 'ok');
  assert.equal(seen[0].system, 'SYS');
  assert.ok(seen[0].opts.cwd.startsWith(tmpdir()), 'never the repo');
  assert.equal(readdirSync(tmpdir()).includes(seen[0].opts.cwd.split('/').pop()), false, 'temp dir is removed');
  assert.equal(seen[0].opts.env.ANTHROPIC_API_KEY, undefined);
});

test('createViaSubscription: one process at a time by default (a CLI peaks ~210 MB on a 961 MB box)', async () => {
  let running = 0, peak = 0;
  const spawnImpl = (bin, args, opts) => {
    running += 1; peak = Math.max(peak, running);
    const child = fakeSpawn({ stdout: lines(assistant('x'), result()), delayMs: 15 })(bin, args, opts);
    child.on('close', () => { running -= 1; });
    return child;
  };
  const params = { model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'q' }] };
  await Promise.all([1, 2, 3, 4].map(() => createViaSubscription(params, {}, { spawnImpl })));
  assert.equal(peak, 1);
});

test('createViaSubscription: an aborted signal kills the child and rejects as AbortError', async () => {
  const seen = [];
  const ac = new AbortController();
  const p = createViaSubscription(
    { model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'q' }] },
    { signal: ac.signal },
    { spawnImpl: fakeSpawn({ stdout: lines(assistant('late'), result()), delayMs: 500, seen }) },
  );
  setTimeout(() => ac.abort(new Error('deadline')), 20);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(seen[0].child.killed, true);
});

test('subscriptionStream: text_delta + finalMessage match what blog-post-writer consumes', async () => {
  const stream = subscriptionStream(
    { model: MODEL, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] },
    {},
    { spawnImpl: fakeSpawn({ stdout: lines(assistant('<p>post</p>'), result()) }) },
  );
  let html = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') html += chunk.delta.text;
  }
  const final = await stream.finalMessage();
  assert.equal(html, '<p>post</p>');
  assert.equal(final.stop_reason, 'end_turn');
});

// ── the chokepoint must stay the only way to Claude ─────────────────────────────

test('no agent, lib or script imports the SDK around lib/anthropic.js', () => {
  const ROOT = new URL('../../', import.meta.url).pathname;
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(m?js)$/.test(e) && /from ['"]@anthropic-ai\/sdk['"]/.test(readFileSync(full, 'utf8'))) {
        offenders.push(full.slice(ROOT.length));
      }
    }
  };
  for (const d of ['agents', 'lib', 'scripts']) walk(join(ROOT, d));
  assert.deepEqual(offenders.filter((f) => f !== 'lib/anthropic.js'), [],
    'a direct SDK import bills the per-token API key and bypasses the subscription transport');
});
