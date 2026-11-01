import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptPrompt, parseAction, actionInstructions } from '../../agents/dashboard/lib/chat-transcript.js';
import adsRoutes from '../../agents/dashboard/routes/ads.js';
import chatRoutes from '../../agents/dashboard/routes/chat.js';
import { buildCliRequest } from '../../lib/claude-subscription.js';

function makeRes() {
  const res = { status: 0, chunks: [], writeHead(s) { this.status = s; return this; }, write(c) { this.chunks.push(String(c)); return true; }, end(c) { if (c) this.chunks.push(String(c)); this.ended = true; }, on() { return this; } };
  return res;
}
function makeReq(method, url, body) {
  const s = JSON.stringify(body);
  return { method, url, headers: { 'user-agent': 'node-test' }, destroy() {}, on(e, cb) { if (e === 'data') cb(Buffer.from(s)); if (e === 'end') cb(); return this; } };
}
const fakeClient = (reply, seen) => ({ messages: { create: async (params) => { seen.push(params); return { content: [{ type: 'text', text: reply }] }; } } });

test('transcriptPrompt: one turn, oldest first, actions as notes, capped', () => {
  const t = transcriptPrompt([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'action', content: 'approve_suggestion (status: approved)' }, { role: 'user', content: 'x'.repeat(5000) }]);
  assert.match(t, /User: hi\n\nAssistant: hello\n\n\[Action taken by the app: approve_suggestion \(status: approved\)\]/);
  assert.ok(!t.includes('x'.repeat(4001)));
});

test('parseAction validates, strips the tag, and never applies a bad action', () => {
  const ok = parseAction('Done, approved.\n<ACTION>{"tool": "approve_suggestion", "input": {}}</ACTION>');
  assert.equal(ok.text, 'Done, approved.');
  assert.deepEqual(ok.action, { tool: 'approve_suggestion', input: {} });
  const upd = parseAction('<ACTION>{"tool":"update_suggestion","input":{"proposedCpcMicros":450000,"keyword":"sneaky"}}</ACTION>', ['proposedCpcMicros']);
  assert.deepEqual(upd.action.input, { proposedCpcMicros: 450000 }, 'a field not allowed for this type is dropped');
  assert.match(parseAction('<ACTION>{"tool":"update_suggestion","input":{"proposedCpcMicros":"lots"}}</ACTION>', ['proposedCpcMicros']).rejected, /positive integer/);
  assert.match(parseAction('<ACTION>{"tool":"update_suggestion","input":{"matchType":"FUZZY"}}</ACTION>', ['matchType']).rejected, /matchType/);
  assert.match(parseAction('<ACTION>{"tool":"delete_everything"}</ACTION>').rejected, /unknown action/);
  assert.match(parseAction('<ACTION>not json</ACTION>').rejected, /not valid JSON/);
  assert.match(parseAction('<ACTION>{"tool":"approve_suggestion"}</ACTION><ACTION>{"tool":"reject_suggestion"}</ACTION>').rejected, /more than one/);
  assert.equal(parseAction('Just chatting.').action, null);
});

test('actionInstructions names only the fields this type allows', () => {
  assert.match(actionInstructions('bid_adjust', ['proposedCpcMicros']), /Valid fields for this bid_adjust suggestion: proposedCpcMicros/);
  assert.match(actionInstructions('keyword_pause', []), /: none/);
});

function adsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ads-chat-'));
  writeFileSync(join(dir, '2026-10-01.json'), JSON.stringify({ suggestions: [{ id: 's1', type: 'bid_adjust', campaign: 'Lotion', rationale: 'CPC too high', proposedChange: { proposedCpcMicros: 600000 }, status: 'pending', chat: [] }] }));
  return dir;
}

test('ads chat: one subscription-shaped call, a valid action is applied and stored in the shape the UI reads', async () => {
  const dir = adsFixture();
  const seen = [];
  const ctx = { adsInFlight: new Set(), ADS_OPTIMIZER_DIR: dir, anthropic: fakeClient('Lowering it to $0.45 and approving.\n<ACTION>{"tool":"update_suggestion","input":{"proposedCpcMicros":450000}}</ACTION>', seen) };
  const route = adsRoutes.find((r) => typeof r.match === 'function' && r.match('/ads/2026-10-01/suggestion/s1/chat'));
  const res = makeRes();
  await route.handler(makeReq('POST', '/ads/2026-10-01/suggestion/s1/chat', { message: 'yes, drop it to 45 cents and approve' }), res, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tools, undefined, 'no tools: they force the per-token API');
  assert.equal(seen[0].messages.length, 1);
  assert.doesNotThrow(() => buildCliRequest(seen[0]), 'the request must be one the subscription transport can carry');
  const saved = JSON.parse(readFileSync(join(dir, '2026-10-01.json'), 'utf8')).suggestions[0];
  assert.equal(saved.status, 'approved');
  assert.equal(saved.proposedChange.proposedCpcMicros, 450000);
  assert.deepEqual(saved.chat.map((c) => c.role), ['user', 'assistant', 'tool_call', 'tool_result']);
  assert.ok(!saved.chat[1].content.includes('<ACTION>'));
  assert.ok(res.chunks.join('').includes('data: [DONE]'));
});

test('ads chat: a malformed action changes nothing and tells the user', async () => {
  const dir = adsFixture();
  const ctx = { adsInFlight: new Set(), ADS_OPTIMIZER_DIR: dir, anthropic: fakeClient('Sure.\n<ACTION>{"tool":"update_suggestion","input":{"proposedCpcMicros":-5}}</ACTION>', []) };
  const route = adsRoutes.find((r) => typeof r.match === 'function' && r.match('/ads/2026-10-01/suggestion/s1/chat'));
  const res = makeRes();
  await route.handler(makeReq('POST', '/ads/2026-10-01/suggestion/s1/chat', { message: 'set it to minus five' }), res, ctx);
  const saved = JSON.parse(readFileSync(join(dir, '2026-10-01.json'), 'utf8')).suggestions[0];
  assert.equal(saved.status, 'pending');
  assert.equal(saved.proposedChange.proposedCpcMicros, 600000);
  assert.match(res.chunks.join(''), /No change was made/);
});

test('tab chat: the history goes as one user turn the subscription can carry', async () => {
  const seen = [];
  const route = chatRoutes.find((r) => r.match === '/api/chat');
  await route.handler(makeReq('POST', '/api/chat', { tab: 'seo', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }), makeRes(), { anthropic: fakeClient('ok', seen) });
  assert.equal(seen[0].messages.length, 1);
  assert.equal(seen[0].messages[0].role, 'user');
  assert.match(seen[0].messages[0].content, /User: a\n\nAssistant: b\n\nUser: c/);
  assert.doesNotThrow(() => buildCliRequest(seen[0]));
});
