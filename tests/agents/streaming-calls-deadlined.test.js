// tests/agents/streaming-calls-deadlined.test.js
//
// Every `messages.stream(...)` call site must pass an abort signal.
//
// A source scan, for the reason the import-guard note in CLAUDE.md gives: importing
// `agents/*/index.js` RUNS the agent. Same shape as tests/agents/seo-copy-writers-gated.js.
//
// WHY THIS IS PINNED AT ALL. Streaming is the one call shape the Anthropic SDK's own
// timeout does not bound. `fetchWithTimeout` (client.js:334-365 in 0.78.0) clears its timer
// in a `finally` when `fetch()` resolves — i.e. at response HEADERS. Measured 2026-08-23 on
// Node 22 against the real API:
//
//   non-streaming, max_tokens 8000 : headers 171,394ms  body 171,402ms  (gap:       8ms)
//   streaming,     max_tokens 8000 : headers   7,456ms  body 224,586ms  (gap: 217,130ms)
//
// So messages.create() is bounded by the SDK's 10-minute default and needs nothing, while
// an unguarded stream can hang forever with the socket open and no error — a cron job that
// stops without failing. A NEW streaming call site added without a deadline reintroduces
// that silently, which is exactly what a source scan is good at catching.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

/**
 * Call sites deliberately left unguarded, each with the reason. An entry here is a
 * decision on the record, not an oversight — which is the point of requiring one.
 */
const ALLOWED_UNGUARDED = new Map([
  [
    'agents/dashboard/routes/ads.js',
    'Interactive dashboard route: a human is watching the request and can retry. A hang ' +
      'ties up one request rather than silently stalling an unattended cron pipeline, and ' +
      'the dispatch() contract already answers 500 on a rejection.',
  ],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = [...walk(join(ROOT, 'agents')), ...walk(join(ROOT, 'lib'))];

const unguarded = [];
let guardedCount = 0;

for (const file of files) {
  const rel = file.slice(ROOT.length);
  // lib/anthropic.js is the metering shim that WRAPS messages.stream — it is the thing
  // being called, not a call site, so it has no signal of its own to pass.
  if (rel === 'lib/anthropic.js') continue;

  const src = readFileSync(file, 'utf8');
  let idx = src.indexOf('messages.stream(');
  while (idx !== -1) {
    // Look at the call and a generous slice after it: the options object carrying the
    // signal is the SECOND argument, past a multi-line params object.
    const slice = src.slice(idx, idx + 2000);
    const hasSignal = /signal:\s*\w/.test(slice);

    if (hasSignal) guardedCount++;
    else if (!ALLOWED_UNGUARDED.has(rel)) {
      const line = src.slice(0, idx).split('\n').length;
      unguarded.push(`${rel}:${line}`);
    }
    idx = src.indexOf('messages.stream(', idx + 1);
  }
}

assert.deepEqual(
  unguarded,
  [],
  `Streaming call site(s) with no abort signal:\n  ${unguarded.join('\n  ')}\n\n` +
    'A stream the SDK cannot time out can hang forever. Wrap it with streamDeadline() / ' +
    'streamWithDeadline() from lib/stream-deadline.js, or add it to ALLOWED_UNGUARDED in ' +
    'this file with the reason it is safe.'
);

// Guard against the scan silently matching nothing (a rename would make it vacuous).
assert.ok(guardedCount >= 2,
  `expected at least 2 guarded streaming call sites, found ${guardedCount} — has the scan gone stale?`);

// And pin that the two known streams are where we think they are.
{
  const writer = readFileSync(join(ROOT, 'agents/blog-post-writer/index.js'), 'utf8');
  assert.match(writer, /streamDeadline/, 'blog-post-writer imports the deadline helper');
  assert.match(writer, /signal:\s*dl\.signal/, 'and passes its signal to the stream');
  assert.match(writer, /dl\.toTerminal\(err\)/,
    'and converts a fired deadline into a terminal error — without this withRetry retries ' +
    'the abort, which is the multi-hour storm the deadline exists to prevent');
  assert.match(writer, /dl\.clear\(\)/, 'and clears the timer so a finished run can exit');
}

console.log(`✓ streaming-call deadline scan passes (${guardedCount} guarded, ${ALLOWED_UNGUARDED.size} allowed unguarded)`);
