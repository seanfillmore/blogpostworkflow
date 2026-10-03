import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_MODELS } from '../../config/llm-models.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Files allowed to spell a model ID, each with its reason.
const ALLOWED = new Map([
  ['config/llm-models.js', 'the single source of truth'],
  ['lib/llm-clients.js', 'AI-citation MEASUREMENT model via DataForSEO; changing it breaks the baseline'],
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

test('the tiers are the current models', () => {
  assert.deepEqual({ ...LLM_MODELS }, {
    flagship: 'claude-opus-5-5',
    standard: 'claude-sonnet-5-5',
    fast: 'claude-haiku-4-5',
  });
  assert.ok(Object.isFrozen(LLM_MODELS));
});

test('no agent, library, script or config spells a Claude model ID of its own (source scan)', () => {
  const literal = /(['"`])claude-(?:opus|sonnet|haiku|fable|mythos)-[0-9][0-9a-z-]*\1/;
  const offenders = [];
  for (const dir of ['agents', 'lib', 'scripts', 'config']) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (literal.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  for (const top of ['scheduler.js', 'pipeline.js']) {
    try {
      readFileSync(join(ROOT, top), 'utf8').split('\n').forEach((line, i) => {
        if (literal.test(line)) offenders.push(`${top}:${i + 1}: ${line.trim()}`);
      });
    } catch { /* absent */ }
  }
  assert.deepEqual(offenders, [], 'import a tier from config/llm-models.js instead');
});

test('every allowed file still exists, so the allowlist cannot rot', () => {
  for (const rel of ALLOWED.keys()) assert.ok(statSync(join(ROOT, rel)).isFile(), rel);
});
