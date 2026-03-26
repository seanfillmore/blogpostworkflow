import { strict as assert } from 'assert';
import { readFileSync } from 'fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

// Task 1: Anthropic client
assert.ok(src.includes("import Anthropic from '@anthropic-ai/sdk'"), 'must import Anthropic SDK');
assert.ok(src.includes('new Anthropic()'), 'must instantiate Anthropic client');

// Task 2: Chat endpoint structure
assert.ok(src.includes('const adsInFlight = new Set()'), 'must have adsInFlight concurrency guard');
assert.ok(src.includes("req.url.endsWith('/chat')"), 'must check for /chat suffix to distinguish from existing handler');

// Route ordering: chat handler must appear before the generic suggestion handler
const chatHandlerIdx    = src.indexOf("req.url.endsWith('/chat')");
const genericHandlerIdx = src.indexOf("req.url.includes('/suggestion/')");
assert.ok(chatHandlerIdx < genericHandlerIdx, 'chat route must be registered before generic suggestion handler');

assert.ok(src.includes("'date/id' key"), 'must have 429 in-flight guard comment or equivalent');
assert.ok(src.includes('message.length > 2000'), 'must validate message length');

console.log('✓ ads suggestion chat tests pass');
