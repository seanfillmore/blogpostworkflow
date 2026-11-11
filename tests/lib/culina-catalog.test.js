import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadReportConfig, isCulinaTitle, components, componentRollup, isSourced } from '../../lib/culina-catalog.js';

const cogs = JSON.parse(readFileSync(new URL('../../config/culina-cogs.json', import.meta.url), 'utf8')).cogs;

test('isCulinaTitle', () => {
  assert.equal(isCulinaTitle('Culina Cast Iron Scrub'), true);
  assert.equal(isCulinaTitle('Real Skin Care Body Lotion'), false);
  assert.equal(isCulinaTitle('Griddle Cast Iron Soap'), true);
  assert.equal(isCulinaTitle(undefined), false);
});

test('components', () => {
  assert.deepEqual(components('B071SGF6GT', cogs), ['cleaning soap']);
  assert.deepEqual(components('NOPE', cogs), []);
});

test('componentRollup', () => {
  assert.deepEqual(componentRollup({ B08BTQK5Z9: 10, B071SGF6GT: 5 }, cogs),
    { 'conditioning oil': 10, 'cleaning soap': 15, 'salt scrub': 10 });
  const r = componentRollup({ B08KHGYYKQ: 3 }, cogs);
  assert.equal(r['chain mail scrubber'], 3);
  assert.equal(r.brush, 3);
  assert.deepEqual(componentRollup({ NOPE: 4 }, cogs), {});
});

test('isSourced', () => {
  const cfg = loadReportConfig();
  assert.equal(isSourced('brush', cfg), true);
  assert.equal(isSourced(' Brush ', cfg), true);
  assert.equal(isSourced('cleaning soap', cfg), false);
});

test('loadReportConfig loads defaults and throws on malformed', () => {
  assert.equal(loadReportConfig().to, 'travis@traviswales.com');
  const p = join(mkdtempSync(join(tmpdir(), 'cul-')), 'bad.json');
  writeFileSync(p, '{ nope');
  assert.throws(() => loadReportConfig(p));
});
