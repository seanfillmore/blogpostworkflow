import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const raw = read('config/amazon-inbound.json');
const cfg = JSON.parse(raw);

test('four Culina SKUs with expected units per case', () => {
  const got = Object.fromEntries(cfg.skus.map((s) => [s.key, [s.sku, s.units_per_case]]));
  assert.deepEqual(got, {
    '2-pack': ['BLI-029655_026708-028658-SET2_CLN_FBA', 20],
    '3-pack': ['salt_Soap_conditioner', 12],
    '4-pack': ['soap_oil_stick_salt2', 12],
    '6-pack': ['soap_oil_salt_stick_scrubber_brush', 12],
  });
});

test('no used-item amzn.gr SKUs', () => {
  for (const s of cfg.skus) assert.ok(!s.sku.startsWith('amzn.gr.'));
});

test('aliases are unique and lower-case', () => {
  const all = cfg.skus.flatMap((s) => s.aliases);
  assert.equal(new Set(all).size, all.length);
  for (const a of all) assert.equal(a, a.toLowerCase());
});

test('no phone number other than the ship-from line', () => {
  const runs = raw.match(/\d{10}/g) || [];
  for (const r of runs) assert.equal(r, '8662238199');
});

test('gitignore and offsite backup wiring', () => {
  assert.match(read('.gitignore'), /^data\/amazon-inbound\/$/m);
  assert.ok(read('scripts/backup-snapshots-offsite.sh').includes('data/amazon-inbound'));
});
