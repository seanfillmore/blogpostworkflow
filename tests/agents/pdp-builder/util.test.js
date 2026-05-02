// tests/agents/pdp-builder/util.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_MODEL, gitSha, parseClaudeJson, MAX_PARSE_RETRIES } from '../../../agents/pdp-builder/lib/util.js';

test('CLAUDE_MODEL: pinned to claude-opus-4-7', () => {
  assert.equal(CLAUDE_MODEL, 'claude-opus-4-7');
});

test('gitSha: returns a non-empty string', () => {
  const sha = gitSha();
  assert.equal(typeof sha, 'string');
  assert.ok(sha.length > 0);
});

test('parseClaudeJson: returns parsed object for clean JSON', () => {
  const response = { content: [{ type: 'text', text: '{"hello":"world"}' }] };
  assert.deepEqual(parseClaudeJson(response), { hello: 'world' });
});

test('parseClaudeJson: strips ```json code fences', () => {
  const response = { content: [{ type: 'text', text: '```json\n{"a":1}\n```' }] };
  assert.deepEqual(parseClaudeJson(response), { a: 1 });
});

test('parseClaudeJson: strips bare ``` code fences', () => {
  const response = { content: [{ type: 'text', text: '```\n{"a":1}\n```' }] };
  assert.deepEqual(parseClaudeJson(response), { a: 1 });
});

test('parseClaudeJson: throws clearly when stop_reason is max_tokens', () => {
  const response = {
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: '{"truncated":' }], // partial JSON, would also throw on parse
  };
  assert.throws(
    () => parseClaudeJson(response),
    /max_tokens|truncated|incomplete/i,
    'throws referencing truncation, not a generic JSON SyntaxError'
  );
});

test('parseClaudeJson: throws when no text block present', () => {
  const response = { content: [] };
  assert.throws(
    () => parseClaudeJson(response),
    /no text|text block/i,
  );
});

test('parseClaudeJson: throws SyntaxError-style on invalid JSON', () => {
  const response = { content: [{ type: 'text', text: 'not json at all' }] };
  assert.throws(() => parseClaudeJson(response));
});

test('MAX_PARSE_RETRIES: exported as a non-negative integer', () => {
  assert.equal(typeof MAX_PARSE_RETRIES, 'number');
  assert.ok(Number.isInteger(MAX_PARSE_RETRIES));
  assert.ok(MAX_PARSE_RETRIES >= 0);
});
