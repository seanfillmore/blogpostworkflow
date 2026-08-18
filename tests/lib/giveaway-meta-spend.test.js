// tests/lib/giveaway-meta-spend.test.js
// The gate guards $30/day. Its job is to refuse to answer when either half of
// the comparison is not real yet — a confident wrong verdict is worse than none.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { evaluateSpendGate, fetchCampaignSpend, resolveAccessToken } from '../../lib/giveaway/meta-spend.js';

const value = (v, matured = 10, basis = '30d') => ({ value: v, matured, basis, segment: 'new' });

test('cost below value passes', async () => {
  const g = evaluateSpendGate({ spend: 100, entrants: 50, entryValue: value(5) });
  assert.equal(g.verdict, 'ok');
  assert.match(g.line, /\$2\b/, '100 over 50 entrants is $2/entry');
});

test('cost above value fires the gate and says what to do', async () => {
  const g = evaluateSpendGate({ spend: 300, entrants: 50, entryValue: value(2) });
  assert.equal(g.verdict, 'over');
  assert.match(g.line, /^GATE:/, 'it must be prefixed so it reaches the digest subject line');
  assert.match(g.line, /before raising budget/);
});

test('no spend yet is unknown, not a pass — a gate that green-lights on no data is worse than none', async () => {
  const g = evaluateSpendGate({ spend: 0, entrants: 0, entryValue: value(5) });
  assert.equal(g.verdict, 'unknown');
});

test('spend with zero entrants is called out as an entry-path problem, not a value problem', async () => {
  // Money going out with nobody coming in means the funnel is broken, and no
  // amount of creative iteration fixes that.
  const g = evaluateSpendGate({ spend: 60, entrants: 0, entryValue: value(5) });
  assert.equal(g.verdict, 'unknown');
  assert.match(g.line, /zero entrants/);
  assert.match(g.line, /check the entry path/);
});

test('an unmatured value refuses a verdict rather than comparing against nothing', async () => {
  // This is the common state for the first month. Judging cost alone here is
  // exactly the mistake the cohort work exists to prevent.
  const g = evaluateSpendGate({
    spend: 300, entrants: 100,
    entryValue: { value: null, matured: 0, basis: 'since-entry (no window matured)' },
  });
  assert.equal(g.verdict, 'unknown');
  assert.match(g.line, /not measurable yet/);
  assert.match(g.line, /do not judge the campaign on cost alone/);
});

test('a matured value of exactly zero is a real verdict, not unknown', async () => {
  // 200 matured new entrants and none bought is information, and it should fire.
  const g = evaluateSpendGate({ spend: 300, entrants: 100, entryValue: value(0, 200) });
  assert.equal(g.verdict, 'over');
});

test('fetchCampaignSpend returns null without credentials rather than throwing', async () => {
  assert.equal(await fetchCampaignSpend({}), null);
  assert.equal(await fetchCampaignSpend({ campaignId: 'x' }), null);
});

test('a Meta error resolves to an error field, never a throw — the daily report must survive it', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ error: { message: 'Invalid OAuth' } }) });
  try {
    const r = await fetchCampaignSpend({ campaignId: 'c', accessToken: 't' });
    assert.equal(r.error, 'Invalid OAuth');
    assert.equal(r.spend, 0);
  } finally { globalThis.fetch = real; }
});

test('a network throw is caught', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  try {
    const r = await fetchCampaignSpend({ campaignId: 'c', accessToken: 't' });
    assert.equal(r.error, 'ECONNRESET');
  } finally { globalThis.fetch = real; }
});

test('a campaign that has never delivered is zero spend, not an error', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ data: [] }) });
  try {
    const r = await fetchCampaignSpend({ campaignId: 'c', accessToken: 't' });
    assert.equal(r.spend, 0);
    assert.equal(r.error, null, 'a paused campaign is a normal state, not a failure');
  } finally { globalThis.fetch = real; }
});

test('resolveAccessToken prefers process.env over the .env file', async () => {
  assert.equal(resolveAccessToken({ FACEBOOK_ACCESS_TOKEN: 'from-env' }), 'from-env');
});
