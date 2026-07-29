// The metering wrapper originally covered only messages.create(). Consolidation had
// to move to messages.stream() because the SDK rejects a non-streaming call whose
// max_tokens implies a >10-minute operation — which would have made the fleet's most
// expensive calls the exact ones missing from the cost report.
//
// Metering is redirected to a temp dir via LLM_USAGE_DIR: these stubs return usage
// objects, so logUsage fires for real and would otherwise append fake token counts to
// data/reports/llm-usage and skew `scripts/llm-cost.mjs --week`. The env var must be
// set before lib/llm-usage.js is first imported (it reads the path at module load),
// hence the dynamic import below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USAGE_DIR = mkdtempSync(join(tmpdir(), 'llm-usage-test-'));
process.env.LLM_USAGE_DIR = USAGE_DIR;

const { default: RealAnthropic } = await import('@anthropic-ai/sdk');
const { default: Anthropic } = await import('../../lib/anthropic.js');

/** Patch the SDK's Messages.prototype before constructing — the wrapper binds the
 *  original at construction time, so a post-construction stub would replace the
 *  wrapper instead of the transport underneath it. */
function withStubbedStream(stub, fn) {
  const probe = new RealAnthropic({ apiKey: 'test' });
  const proto = Object.getPrototypeOf(probe.messages);
  const original = proto.stream;
  proto.stream = stub;
  try { return fn(); } finally { proto.stream = original; }
}

test('messages.stream() is metered and the stream is passed through unchanged', async () => {
  let finalMessageCalls = 0;
  const fakeStream = {
    finalMessage: async () => {
      finalMessageCalls += 1;
      return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } };
    },
  };

  const returned = withStubbedStream(() => fakeStream, () => {
    const client = new Anthropic({ apiKey: 'test' });
    return client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 32000,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  assert.equal(returned, fakeStream, 'caller gets the SDK stream object, not a wrapper');
  await returned.finalMessage();
  // One drain from the metering hook, one from the caller above.
  assert.equal(finalMessageCalls, 2, 'metering drains finalMessage() without consuming the caller\'s');
});

test('create() returns the SDK APIPromise, not a plain Promise', async () => {
  // messages.stream() calls create(...).withResponse() internally, so an async
  // wrapper here breaks all streaming with "withResponse is not a function".
  const probe = new RealAnthropic({ apiKey: 'test' });
  const proto = Object.getPrototypeOf(probe.messages);
  const original = proto.create;

  const apiPromise = Object.assign(Promise.resolve({ usage: { input_tokens: 1, output_tokens: 1 } }), {
    withResponse: () => 'sentinel',
  });
  proto.create = () => apiPromise;

  try {
    const client = new Anthropic({ apiKey: 'test' });
    const returned = client.messages.create({ model: 'claude-opus-4-6', max_tokens: 16000, messages: [] });
    assert.equal(typeof returned.withResponse, 'function', 'APIPromise methods survive the wrapper');
    assert.equal(returned.withResponse(), 'sentinel');
    await returned;
  } finally {
    proto.create = original;
  }
});

test('a rejected stream does not produce an unhandled rejection from metering', async () => {
  const boom = new Error('stream failed');
  const failing = { finalMessage: async () => { throw boom; } };

  const returned = withStubbedStream(() => failing, () => {
    const client = new Anthropic({ apiKey: 'test' });
    return client.messages.stream({ model: 'claude-opus-4-6', max_tokens: 32000, messages: [] });
  });

  await assert.rejects(() => returned.finalMessage(), /stream failed/, 'caller still sees the real error');
  // Let the metering hook's own .catch() settle; an unhandled rejection would fail the run.
  await new Promise((r) => setImmediate(r));
});

test('metering from these tests lands in the temp dir, not the real cost report', async () => {
  // Guards the redirect itself: if LLM_USAGE_DIR stops being honoured, these fake
  // token counts go back to skewing data/reports/llm-usage.
  await new Promise((r) => setImmediate(r));
  const written = readdirSync(USAGE_DIR);
  assert.ok(written.length > 0, `expected metering output in ${USAGE_DIR}, found none`);
  assert.ok(written.every((f) => f.endsWith('.jsonl')), 'writes the usual JSONL shape');
});
