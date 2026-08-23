import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRevision, reviseWithLinkGuard, linkDropRetryInstruction } from '../../lib/content-revision.js';

const now = { year: 2026, month: 8 };
const ORIGINAL = [
  '<p>Intro about coconut oil.</p>',
  '<p>Read our <a href="https://www.realskincare.com/collections/lotion">lotion collection</a>.</p>',
  '<p>Or the <a href="https://www.realskincare.com/products/body-cream">body cream</a>.</p>',
  '<p>Also the <a href="https://www.realskincare.com/blogs/news/dry-skin">dry skin guide</a>.</p>',
].join('\n');

const keepAllLinks = ORIGINAL.replace('Intro about coconut oil.', 'Intro about virgin coconut oil and how people use it.');
const dropsOneLink = ORIGINAL
  .replace('<p>Also the <a href="https://www.realskincare.com/blogs/news/dry-skin">dry skin guide</a>.</p>', '<p>Also see our dry skin guide.</p>')
  .replace('Intro about coconut oil.', 'Intro about virgin coconut oil and how people use it every day.');

// ── validateRevision: the guard stays HARD ───────────────────────────────────

test('validateRevision accepts a revision that preserves every link', () => {
  assert.doesNotThrow(() => validateRevision({ original: ORIGINAL, revised: keepAllLinks, now }));
});

test('validateRevision still refuses a revision that drops a link', () => {
  assert.throws(
    () => validateRevision({ original: ORIGINAL, revised: dropsOneLink, now }),
    /Revision dropped links \(2 < 3\)/,
  );
});

test('the link-drop error carries the dropped links so a retry can name them', () => {
  try {
    validateRevision({ original: ORIGINAL, revised: dropsOneLink, now });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(Array.isArray(err.droppedLinks), 'droppedLinks is attached to the error');
    assert.equal(err.droppedLinks.length, 1);
    assert.equal(err.droppedLinks[0].href, 'https://www.realskincare.com/blogs/news/dry-skin');
    assert.equal(err.droppedLinks[0].anchor, 'dry skin guide');
    assert.equal(err.retryable, true, 'a dropped link is worth one more attempt');
  }
});

test('validateRevision keeps the other fatal guards, and they are NOT retryable', () => {
  assert.throws(() => validateRevision({ original: ORIGINAL, revised: ORIGINAL, stopReason: 'max_tokens', now }), /truncated/i);
  assert.throws(() => validateRevision({ original: ORIGINAL, revised: '<p>tiny</p>', now }), /suspiciously short/i);
  const withFabricatedLink = keepAllLinks + '<p><a href="https://www.fda.gov/made-up">FDA</a></p>';
  assert.throws(() => validateRevision({ original: ORIGINAL, revised: withFabricatedLink, now }), /unverified external link/i);
  const withFutureDate = keepAllLinks.replace('Intro', 'A December 2026 study. Intro');
  assert.throws(() => validateRevision({ original: ORIGINAL, revised: withFutureDate, now }), /future-dated/i);
  try {
    validateRevision({ original: ORIGINAL, revised: '<p>tiny</p>', now });
  } catch (err) {
    assert.notEqual(err.retryable, true, 'only the link-drop failure earns a retry');
  }
});

// ── reviseWithLinkGuard: ONE retry, then fail closed ─────────────────────────
// 2026-08-21: "Revision dropped links (16 < 19) — refusing to save" surfaced as
// a digest failure. The guard was right; giving up on the first sample was not.

test('a dropped-link revision is retried once, and the second sample is accepted', async () => {
  const prompts = [];
  const samples = [dropsOneLink, keepAllLinks];
  const out = await reviseWithLinkGuard({
    original: ORIGINAL,
    basePrompt: 'BASE PROMPT',
    now,
    callModel: async (prompt) => { prompts.push(prompt); return { text: samples.shift(), stopReason: 'end_turn' }; },
  });

  assert.equal(out.revised, keepAllLinks);
  assert.equal(out.attempts, 2);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], 'BASE PROMPT');
  assert.match(prompts[1], /BASE PROMPT/, 'the retry keeps the original instructions');
  assert.match(prompts[1], /dry skin guide/, 'the retry names the anchor that went missing');
  assert.match(prompts[1], /verbatim/i, 'the retry demands verbatim reproduction');
});

test('a SECOND dropped-link revision still throws — the guard is not softened', async () => {
  await assert.rejects(
    reviseWithLinkGuard({
      original: ORIGINAL,
      basePrompt: 'BASE',
      now,
      callModel: async () => ({ text: dropsOneLink, stopReason: 'end_turn' }),
    }),
    /Revision dropped links/,
  );
});

test('a non-link failure is NOT retried (one model call, then throw)', async () => {
  let calls = 0;
  await assert.rejects(
    reviseWithLinkGuard({
      original: ORIGINAL,
      basePrompt: 'BASE',
      now,
      callModel: async () => { calls++; return { text: '<p>tiny</p>', stopReason: 'end_turn' }; },
    }),
    /suspiciously short/i,
  );
  assert.equal(calls, 1, 'retrying a truncation/short output just burns a paid call');
});

test('a clean first sample costs exactly one model call', async () => {
  let calls = 0;
  const out = await reviseWithLinkGuard({
    original: ORIGINAL,
    basePrompt: 'BASE',
    now,
    callModel: async () => { calls++; return { text: keepAllLinks, stopReason: 'end_turn' }; },
  });
  assert.equal(calls, 1);
  assert.equal(out.attempts, 1);
});

test('code fences are stripped before the guards run', async () => {
  const out = await reviseWithLinkGuard({
    original: ORIGINAL,
    basePrompt: 'BASE',
    now,
    callModel: async () => ({ text: '```html\n' + keepAllLinks + '\n```', stopReason: 'end_turn' }),
  });
  assert.equal(out.revised, keepAllLinks);
});

test('linkDropRetryInstruction lists every dropped anchor and href', () => {
  const msg = linkDropRetryInstruction([
    { href: '/a', anchor: 'anchor one' },
    { href: '/b', anchor: 'anchor two' },
  ]);
  assert.match(msg, /anchor one/);
  assert.match(msg, /anchor two/);
  assert.match(msg, /\/a/);
  assert.match(msg, /\/b/);
});
