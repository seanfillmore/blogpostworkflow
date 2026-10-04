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

test('pickPersonalEmail rejects the wrong person and keeps the right one', () => {
  const d = ['example.com'];
  const jane = { name: 'Jane Doe', domains: d };
  for (const bad of ['janet.smith@example.com', 'john.doe@example.com', 'adoe@example.com', 'jane.smith@gmail.com']) {
    assert.equal(pickPersonalEmail([bad], jane), null, bad);
  }
  assert.equal(pickPersonalEmail(['samantha.k@example.com'], { name: 'Sam Lee', domains: d }), null);
  assert.equal(pickPersonalEmail(['jlimited@example.com'], { name: 'Jane Li', domains: d }), null);
  for (const good of ['jane.doe@example.com', 'jdoe@example.com', 'jane@example.com', 'janedoe@gmail.com', 'doe.jane@example.com']) {
    assert.equal(pickPersonalEmail([good], jane), good, good);
  }
  assert.equal(pickPersonalEmail(['jane@gmail.com'], jane), null);
  assert.equal(pickPersonalEmail(['rivers@example.com'], { name: 'Jane Rivers', domains: d }), 'rivers@example.com');
});

test('extractEmails decodes escapes and skips script text', () => {
  assert.deepEqual(extractEmails(String.raw`\u003cjane@example.com`), ['jane@example.com']);
  assert.deepEqual(extractEmails('<a href="mailto:%20jane@example.com">x</a>'), ['jane@example.com']);
  assert.deepEqual(extractEmails('jane&#64;example.com and sam&#x40;example.com and lee&commat;example.com').sort(),
    ['jane@example.com', 'lee@example.com', 'sam@example.com']);
  assert.deepEqual(extractEmails('<script>var a="hidden@example.com"</script><p>x</p><style>.a{}</style>'), []);
  assert.deepEqual(extractEmails('<script>1</script><a href="mailto:Keep@example.com">k</a>'), ['keep@example.com']);
});

test('tavily host match uses labels, not substrings', async () => {
  const p = { ...prospect, domain: 'outlet.example.net', person: { name: 'Jane Doe', authorUrl: null } };
  const r = await findAddress(p, {
    fetchPage: async () => blocked,
    tavilySearch: async () => [{ url: 'https://doevents.com/x', content: 'jane.doe@doevents.com' }],
  });
  assert.equal(r.address, null);
  const p2 = { ...p, person: { name: 'Jane Rivers', authorUrl: null } };
  const r2 = await findAddress(p2, {
    fetchPage: async () => blocked,
    tavilySearch: async () => [{ url: 'https://janerivers.com/about', content: 'jane@janerivers.com' }, { url: 'https://rivers.blog/about', content: 'jane.rivers@rivers.blog' }],
  });
  assert.equal(r2.address, 'jane.rivers@rivers.blog');
  assert.match(r2.source, /rivers\.blog/);
});

test('tavily results cannot smuggle in a different person', async () => {
  const p = { ...prospect, domain: 'outlet.example.net', person: { name: 'Jane Smith', authorUrl: null } };
  const run = async (url, content) => (await findAddress(p, {
    fetchPage: async () => blocked, tavilySearch: async () => [{ url, content }],
  })).address;
  assert.equal(await run('https://smithandco.com/a', 'jane@smithandco.com'), null);
  assert.equal(await run('https://smithlaw.com/a', 'jane@smithlaw.com'), null);
  assert.equal(await run('https://smithandco.com/a', 'smith@smithandco.com'), null);
  assert.equal(await run('https://smithandco.com/a', 'jane.smith@smithandco.com'), null);
  assert.equal(await run('https://janesmith.com/about', 'jane.smith@janesmith.com'), 'jane.smith@janesmith.com');
  assert.equal(await run('https://janesmith.com/about', 'jane@janesmith.com'), null);
  assert.equal(await run('https://outlet.example.net/staff', 'jane@outlet.example.net'), 'jane@outlet.example.net');
});
