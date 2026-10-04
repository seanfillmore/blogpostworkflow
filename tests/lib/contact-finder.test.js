import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEmails, pickPersonalEmail, pickOutletEmail, findAddress, hunterBudgetOk, hunterClient,
} from '../../lib/contact-finder.js';

const prospect = {
  key: 'pr-target:example.com', source: 'pr-target', domain: 'example.com',
  targetUrl: 'https://example.com/a/best-soap',
  person: { name: 'Jane Doe', authorUrl: 'https://example.com/authors/jane' },
  publication: 'Example Daily',
};
const okPage = (html) => ({ outcome: 'ok', status: 200, html });
const blocked = { outcome: 'blocked', status: 403, html: null };
const boom = () => { throw new Error('should not be called'); };
const richAccount = async () => ({ data: { requests: { searches: { used: 10, available: 1000 }, verifications: { used: 10, available: 1000 } } } });

test('extractEmails reads mailto, deobfuscates, ignores asset names', () => {
  const html = '<a href="mailto:Jane@Example.com?subject=x">m</a> reach jane [at] example [dot] com or <img src="image@2x.png"> bob(at)example(dot)org';
  const out = extractEmails(html);
  assert.deepEqual(out.sort(), ['bob@example.org', 'jane@example.com']);
});

test('pickPersonalEmail prefers the named writer', () => {
  const got = pickPersonalEmail(['ads@example.com', 'jane.doe@example.com'], { name: 'Jane Doe', domains: ['example.com'] });
  assert.equal(got, 'jane.doe@example.com');
  assert.equal(pickPersonalEmail(['ads@example.com'], { name: 'Jane Doe', domains: ['example.com'] }), null);
  assert.equal(pickPersonalEmail(['jdoe@gmail.com'], { name: 'Jane Doe', domains: ['example.com'] }), 'jdoe@gmail.com');
  assert.equal(pickPersonalEmail(['jane@other.org'], { name: 'Jane Doe', domains: ['example.com'] }), null);
});

test('pickOutletEmail prefers editorial-style addresses on the site domain', () => {
  assert.equal(pickOutletEmail(['x@gmail.com', 'info@example.com', 'editor@example.com'], 'example.com'), 'editor@example.com');
  assert.equal(pickOutletEmail(['x@gmail.com'], 'example.com'), null);
});

test('hunterBudgetOk stops at 80% of either allowance', async () => {
  const mk = (s, v) => ({ data: { requests: { searches: { used: s, available: 1000 }, verifications: { used: v, available: 1000 } } } });
  assert.equal(hunterBudgetOk(mk(10, 10)), true);
  assert.equal(hunterBudgetOk(mk(800, 10)), false);
  assert.equal(hunterBudgetOk(mk(10, 800)), false);
  assert.equal(hunterBudgetOk({ errors: [{}] }), false);
});

test('free hit returns without touching Hunter', async () => {
  const r = await findAddress(prospect, {
    fetchPage: async (u) => (u.includes('/authors/jane') ? okPage('<a href="mailto:jane.doe@example.com">x</a>') : blocked),
    tavilySearch: boom,
    hunter: { account: boom, finder: boom, domainSearch: boom, verify: boom },
  });
  assert.equal(r.address, 'jane.doe@example.com');
  assert.match(r.source, /^published:/);
  assert.equal(r.verified, true);
  assert.equal(r.spentHunter, 0);
});

test('falls back to Hunter and accepts valid', async () => {
  const r = await findAddress(prospect, {
    fetchPage: async () => blocked,
    tavilySearch: async () => [],
    hunter: {
      account: richAccount,
      finder: async () => ({ data: { email: 'jane.doe@example.com' } }),
      verify: async () => ({ data: { status: 'valid' } }),
    },
    today: '2026-10-05',
  });
  assert.equal(r.address, 'jane.doe@example.com');
  assert.equal(r.source, 'hunter:verified:2026-10-05');
  assert.equal(r.verified, true);
  assert.ok(r.spentHunter >= 1);
});

test('rejects accept_all and webmail', async () => {
  for (const status of ['accept_all', 'webmail', 'unknown']) {
    const r = await findAddress(prospect, {
      fetchPage: async () => blocked, tavilySearch: async () => [],
      hunter: {
        account: richAccount,
        finder: async () => ({ data: { email: 'jane.doe@example.com' } }),
        verify: async () => ({ data: { status } }),
      },
    });
    assert.equal(r.address, null);
    assert.equal(r.reason, `hunter: ${status}`);
  }
});

test('does not call Hunter at 800/1000 used', async () => {
  const r = await findAddress(prospect, {
    fetchPage: async () => blocked, tavilySearch: async () => [],
    hunter: {
      account: async () => ({ data: { requests: { searches: { used: 800, available: 1000 }, verifications: { used: 0, available: 1000 } } } }),
      finder: boom, domainSearch: boom, verify: boom,
    },
  });
  assert.equal(r.address, null);
  assert.match(r.reason, /budget/);
});

test('blocked fetches fall through to later sources (tavily)', async () => {
  const r = await findAddress(prospect, {
    fetchPage: async () => blocked,
    tavilySearch: async () => [{ url: 'https://example.com/about', content: 'Contact Jane at jane.doe [at] example [dot] com' }],
    hunter: { account: boom, finder: boom, verify: boom },
  });
  assert.equal(r.address, 'jane.doe@example.com');
});

test('link-gap uses domainSearch and generic addresses', async () => {
  const gap = { key: 'link-gap:example.com', source: 'link-gap', domain: 'example.com', targetUrl: 'https://example.com/', person: null };
  const r = await findAddress(gap, {
    fetchPage: async () => blocked, tavilySearch: boom,
    hunter: {
      account: richAccount,
      domainSearch: async () => ({ data: { emails: [
        { value: 'sam@example.com', type: 'personal', confidence: 99 },
        { value: 'info@example.com', type: 'generic', confidence: 80 },
        { value: 'editor@example.com', type: 'generic', confidence: 90 },
      ] } }),
      verify: async (e) => { assert.equal(e, 'editor@example.com'); return { data: { status: 'valid' } }; },
    },
  });
  assert.equal(r.address, 'editor@example.com');
});

test('hunterClient builds URLs and never throws on errors body', async () => {
  const seen = [];
  const c = hunterClient('KEY', async (url) => { seen.push(url); return { json: async () => ({ errors: [{ id: 'x' }] }) }; });
  const out = await c.verify('a@example.com');
  assert.ok(out.errors);
  assert.match(seen[0], /email-verifier\?email=a%40example\.com&api_key=KEY/);
});
