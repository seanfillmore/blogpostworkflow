import { strict as assert } from 'assert';
import { readFileSync } from 'fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

// Task 1: Anthropic client
assert.ok(src.includes("import Anthropic from '@anthropic-ai/sdk'"), 'must import Anthropic SDK');
assert.ok(src.includes('new Anthropic()'), 'must instantiate Anthropic client');

console.log('✓ ads suggestion chat tests pass');
