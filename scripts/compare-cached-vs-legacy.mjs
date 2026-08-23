#!/usr/bin/env node
/**
 * Compare an already-extracted (cached) slim-prompt run against the legacy full-body
 * prompt, on sampled chunks, using the SAME inventory the cached run saw.
 *
 * Only the legacy side costs anything — the slim side is read from
 * data/marketing-corpus/<sourceId>/chunks/. Restore the skills to their pre-run state
 * before running this, or the inventory will not match what the cached run was given.
 *
 * Usage: compare-cached-vs-legacy.mjs <file.txt> <sourceId> <chunkIndex,...>
 */
import { readFileSync, readdirSync } from 'node:fs';
import Anthropic from '../lib/anthropic.js';
import {
  scanSkillInventory, chunkText, buildExtractionPrompt, renderInventoryForExtraction,
  EXTRACTION_MODEL, parseJsonBlock,
} from '../lib/marketing-learner.js';
import { loadTextFile } from '../lib/text-source.js';

const [path, sourceId, idxCsv] = process.argv.slice(2);
if (!path || !sourceId || !idxCsv) {
  console.error('usage: compare-cached-vs-legacy.mjs <file.txt> <sourceId> <chunkIndex,...>');
  process.exit(1);
}
const indices = idxCsv.split(',').map(Number);

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const source = loadTextFile(path, { author: 'cmp', title: 'cmp', sourceKind: 'book' });
const chunks = chunkText(source.text, { chunkWords: 4500 });
const inventory = scanSkillInventory('.claude/skills');
const slimBlock = renderInventoryForExtraction(inventory);
const legacyBlock = inventory.map((s) => `### ${s.name}\n_${s.description}_\n\n${s.content}`).join('\n\n---\n\n');

const cacheDir = `data/marketing-corpus/${sourceId}/chunks`;
const cacheFiles = readdirSync(cacheDir).filter((f) => /^\d{3}-/.test(f));

const rate = (t) => {
  const a = t.filter((x) => x.verdict === 'adopt').length;
  const dup = t.filter((x) => /duplicat/i.test(x.rejectReason ?? '')).length;
  return { n: t.length, a, pct: Math.round((a / Math.max(1, t.length)) * 100), dup };
};

let S = { n: 0, a: 0, dup: 0 }, L = { n: 0, a: 0, dup: 0 };

for (const i of indices) {
  const f = cacheFiles.find((x) => x.startsWith(String(i).padStart(3, '0') + '-'));
  if (!f) { console.error(`no cached chunk ${i}`); continue; }
  const slim = JSON.parse(readFileSync(`${cacheDir}/${f}`, 'utf8')).tactics ?? [];

  const prompt = buildExtractionPrompt({ video: source, inventory, chunk: chunks[i] })
    .replace(slimBlock, legacyBlock);
  const res = await client.messages
    .stream({ model: EXTRACTION_MODEL, max_tokens: 32000, thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }] })
    .finalMessage();
  const text = (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const legacy = parseJsonBlock(text, `legacy ${i}`).tactics ?? [];

  const s = rate(slim), l = rate(legacy);
  console.log(`chunk ${String(i).padStart(2)}  slim ${String(s.a).padStart(2)}/${String(s.n).padStart(2)} = ${String(s.pct).padStart(3)}% adopt, ${s.dup} dup-rejects` +
              `   |   legacy ${String(l.a).padStart(2)}/${String(l.n).padStart(2)} = ${String(l.pct).padStart(3)}% adopt, ${l.dup} dup-rejects` +
              `   (${res.usage.input_tokens.toLocaleString()} in tok)`);
  S.n += s.n; S.a += s.a; S.dup += s.dup;
  L.n += l.n; L.a += l.a; L.dup += l.dup;
}

console.log('\n' + '─'.repeat(96));
console.log(`SLIM   ${S.a}/${S.n} adopted = ${Math.round(S.a / S.n * 100)}%   duplication rejects: ${S.dup}`);
console.log(`LEGACY ${L.a}/${L.n} adopted = ${Math.round(L.a / L.n * 100)}%   duplication rejects: ${L.dup}`);
console.log('\nIf slim adopts materially more AND cites duplication materially less, the headings');
console.log('projection is under-detecting duplicates and the full bodies were doing real work.');
