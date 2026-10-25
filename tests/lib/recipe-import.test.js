// tests/lib/recipe-import.test.js
// The recipe importer fetches a page a stranger pasted, from inside the shared
// dashboard process. The parser tests pin what we read out of JSON-LD; the fetch
// tests pin the private-address guard, the redirect re-check, the byte cap and the
// timeout. No test here touches the real network: DNS is always injected, and the
// one local server is reached only by explicitly lifting the address/port guard.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import http from 'node:http';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractRecipe, parseDurationMinutes, isPublicAddress, fetchRecipePage, importRecipeFromUrl, RecipeImportError,
} from '../../lib/recipe-import.js';

const here = dirname(fileURLToPath(import.meta.url));
const page = (...blocks) => `<!doctype html><html><head>${blocks.map((b) => `<script type="application/ld+json">${typeof b === 'string' ? b : JSON.stringify(b)}</script>`).join('\n')}</head><body></body></html>`;

// ---- parser -------------------------------------------------------------------

test('extractRecipe: @graph form with Organization name', () => {
  const html = page({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'Page' },
      { '@type': 'Organization', name: 'Grandma Kitchen' },
      { '@type': 'Recipe', name: 'Pie', recipeIngredient: ['2 apples', ' 1 cup sugar '], recipeInstructions: ['Peel.', 'Bake.'], recipeYield: '8', totalTime: 'PT1H30M' },
    ],
  });
  const r = extractRecipe(html);
  assert.equal(r.name, 'Pie');
  assert.deepEqual(r.ingredients, ['2 apples', '1 cup sugar']);
  assert.deepEqual(r.steps, ['Peel.', 'Bake.']);
  assert.equal(r.recipeYield, '8');
  assert.equal(r.totalMinutes, 90);
  assert.equal(r.siteName, 'Grandma Kitchen');
});

test('extractRecipe: top-level array and @type as an array', () => {
  const html = page([{ '@type': 'WebSite', name: 'Site A' }, { '@type': ['Recipe', 'NewsArticle'], name: 'Soup', recipeIngredient: ['water'], recipeInstructions: 'Boil.' }]);
  const r = extractRecipe(html);
  assert.equal(r.name, 'Soup');
  assert.deepEqual(r.steps, ['Boil.']);
  assert.equal(r.siteName, 'Site A');
});

test('extractRecipe: nested Recipe inside another node is found', () => {
  const html = page({ '@type': 'WebPage', mainEntity: { '@type': 'Recipe', name: 'Nested', recipeIngredient: ['x'] } });
  assert.equal(extractRecipe(html).name, 'Nested');
});

test('extractRecipe: HowToSection becomes a heading line followed by its steps', () => {
  const html = page({
    '@type': 'Recipe', name: 'Turkey', recipeIngredient: ['turkey'],
    recipeInstructions: [
      { '@type': 'HowToSection', name: 'For the brine', itemListElement: [{ '@type': 'HowToStep', text: 'Mix salt.' }, { '@type': 'HowToStep', name: 'Soak.' }] },
      { '@type': 'HowToSection', name: 'To cook:', itemListElement: [{ '@type': 'HowToStep', text: 'Smoke it.' }] },
    ],
  });
  const r = extractRecipe(html);
  assert.deepEqual(r.steps, ['For the brine:', 'Mix salt.', 'Soak.', 'To cook:', 'Smoke it.']);
  assert.deepEqual(r.headings, [0, 3]);
});

test('extractRecipe: string instructions split on newlines and HTML line breaks', () => {
  const html = page({ '@type': 'Recipe', name: 'Bread', recipeIngredient: ['flour'], recipeInstructions: 'Mix.\n\nKnead.<br>Bake.<p>Cool.</p>' });
  assert.deepEqual(extractRecipe(html).steps, ['Mix.', 'Knead.', 'Bake.', 'Cool.']);
});

test('extractRecipe: entities decoded, tags stripped, whitespace collapsed, empties dropped', () => {
  const html = page({
    '@type': 'Recipe', name: 'Mac &amp; Cheese',
    recipeIngredient: ['<b>1&frac12;</b> cups   milk', '&quot;sharp&quot; cheddar', 'chef&#39;s salt &#x27;n pepper', '   ', '&#8220;fancy&#8221;'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Don&#39;t  <a href="x">burn</a> it.' }],
  });
  const r = extractRecipe(html);
  assert.equal(r.name, 'Mac & Cheese');
  assert.deepEqual(r.ingredients, ['1½ cups milk', '"sharp" cheddar', "chef's salt 'n pepper", '“fancy”']);
  assert.deepEqual(r.steps, ["Don't burn it."]);
});

test('extractRecipe: legacy `ingredients` fallback and yield arrays', () => {
  const html = page({ '@type': 'Recipe', name: 'Old', ingredients: ['egg'], recipeYield: ['', '4', '4 servings'] });
  const r = extractRecipe(html);
  assert.deepEqual(r.ingredients, ['egg']);
  assert.equal(r.recipeYield, '4 servings', 'a bare number defers to the same number spelled out');
  assert.equal(r.totalMinutes, null);
  assert.equal(r.siteName, null);
});

test('extractRecipe: yield keeps a unit when the site gives one (WPRM ["2", "2 dozen"])', () => {
  const y = (recipeYield) => extractRecipe(page({ '@type': 'Recipe', name: 'C', recipeIngredient: ['a'], recipeYield })).recipeYield;
  assert.equal(y(['2', '2 dozen']), '2 dozen');
  assert.equal(y(['12']), '12');
  assert.equal(y('6 to 8 servings'), '6 to 8 servings');
  assert.equal(y(8), '8');
  assert.equal(y(['4', '6 servings']), '4');
  assert.equal(y([]), null);
});

test('extractRecipe: no Recipe node → null; empty Recipe → null', () => {
  assert.equal(extractRecipe(page({ '@type': 'Article', name: 'x' })), null);
  assert.equal(extractRecipe('<html><body>no json here</body></html>'), null);
  assert.equal(extractRecipe(page({ '@type': 'Recipe', name: 'Empty', recipeIngredient: [], recipeInstructions: [] })), null);
  assert.equal(extractRecipe(''), null);
  assert.equal(extractRecipe(null), null);
});

test('extractRecipe: a malformed block is skipped, a later good one is read', () => {
  const html = page('{ "@type": "Recipe", broken', { '@type': 'Recipe', name: 'Good', recipeIngredient: ['a'] });
  assert.equal(extractRecipe(html).name, 'Good');
});

test('extractRecipe: attribute order, single quotes, whitespace and CDATA tolerated; og:site_name fallback', () => {
  const json = JSON.stringify({ '@type': 'Recipe', name: 'Cdata', recipeIngredient: ['b'] });
  const html = `<html><head><meta content="Og Kitchen &amp; Co" property="og:site_name">
    <script id="x" type = 'application/ld+json' class="y">
    //<![CDATA[
    ${json}
    //]]>
    </script></head></html>`;
  const r = extractRecipe(html);
  assert.equal(r.name, 'Cdata');
  assert.equal(r.siteName, 'Og Kitchen & Co');
});

test('extractRecipe: real dinneratthezoo.com fixture', () => {
  const html = readFileSync(join(here, '..', 'fixtures', 'recipe-import', 'dinneratthezoo-smoked-turkey.html'), 'utf8');
  const r = extractRecipe(html);
  assert.equal(r.name, 'Smoked Turkey Recipe');
  assert.equal(r.ingredients.length, 9);
  assert.equal(r.steps.length, 8);
  assert.equal(r.recipeYield, '12');
  assert.equal(r.totalMinutes, 370);
  assert.equal(r.siteName, 'Dinner at the Zoo');
  assert.ok(r.steps[5].includes("you don't need to baste it"), 'entity decoded in a real step');
});

test('parseDurationMinutes', () => {
  assert.equal(parseDurationMinutes('PT370M'), 370);
  assert.equal(parseDurationMinutes('PT6H10M'), 370);
  assert.equal(parseDurationMinutes('P0DT1H'), 60);
  assert.equal(parseDurationMinutes('P1DT2H'), 26 * 60);
  assert.equal(parseDurationMinutes('PT45S'), 1);
  assert.equal(parseDurationMinutes('pt20m'), 20);
  assert.equal(parseDurationMinutes('PT0M'), null);
  assert.equal(parseDurationMinutes('20 minutes'), null);
  assert.equal(parseDurationMinutes(''), null);
  assert.equal(parseDurationMinutes(null), null);
  assert.equal(parseDurationMinutes('P'), null);
});

// ---- address guard ------------------------------------------------------------

test('isPublicAddress rejects every private, loopback, link-local and reserved range', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
    '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2001:db8::1', 'not-an-ip', '']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

const neverLookup = async () => { throw new Error('lookup must not be called'); };
const lookupTo = (address, family = 4) => async () => [{ address, family }];

async function codeOf(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof RecipeImportError, `expected RecipeImportError, got ${err && err.stack}`);
    return err.code;
  }
  return 'resolved';
}

test('fetchRecipePage refuses bad and blocked URLs without touching the network', async () => {
  const cases = [
    ['not a url', 'bad_url'],
    ['ftp://example.com/x', 'bad_url'],
    ['javascript:alert(1)', 'bad_url'],
    ['https://example.com:8080/x', 'blocked_url'],
    ['https://user:pass@example.com/', 'blocked_url'],
    ['http://127.0.0.1/', 'blocked_url'],
    ['http://10.1.2.3/', 'blocked_url'],
    ['http://192.168.0.10/', 'blocked_url'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked_url'],
    ['http://[::1]/', 'blocked_url'],
    ['http://[::ffff:127.0.0.1]/', 'blocked_url'],
    ['http://0x7f000001/', 'blocked_url'],
    ['http://2130706433/', 'blocked_url'],
  ];
  for (const [url, code] of cases) {
    assert.equal(await codeOf(fetchRecipePage(url, { lookup: neverLookup })), code, url);
  }
});

test('fetchRecipePage refuses a hostname whose DNS answer is private (localhost, rebinding)', async () => {
  assert.equal(await codeOf(fetchRecipePage('http://localhost/', { lookup: lookupTo('127.0.0.1') })), 'blocked_url');
  assert.equal(await codeOf(fetchRecipePage('https://evil.example/', { lookup: lookupTo('10.0.0.5') })), 'blocked_url');
  assert.equal(await codeOf(fetchRecipePage('https://evil.example/', { lookup: lookupTo('::1', 6) })), 'blocked_url');
  // One public and one private answer: refuse rather than pick.
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  assert.equal(await codeOf(fetchRecipePage('https://evil.example/', { lookup: mixed })), 'blocked_url');
  const nx = async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; };
  assert.equal(await codeOf(fetchRecipePage('https://nope.example/', { lookup: nx })), 'unreachable');
});

test('without lifting the guard, a fake public name that resolves to the local server is refused', async () => {
  await withServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); }, async (port) => {
    // Port is non-default AND the address is loopback: both checks would refuse.
    assert.equal(await codeOf(fetchRecipePage(`http://recipes.example:${port}/`, { lookup: lookupTo('127.0.0.1') })), 'blocked_url');
    assert.equal(await codeOf(fetchRecipePage('http://recipes.example/', { lookup: lookupTo('127.0.0.1') })), 'blocked_url');
  });
});

// ---- fetch behaviour against a local server, guard lifted by injection ---------

function withServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        resolve(await fn(server.address().port, server));
      } catch (err) {
        reject(err);
      } finally {
        server.closeAllConnections?.();
        server.close();
      }
    });
  });
}

// Test-only lifting: the loopback test server is allowed, any port is allowed.
// Everything else (scheme, credentials, redirect re-check, caps) still applies.
const lifted = (extra = {}) => ({ lookup: lookupTo('127.0.0.1'), isAllowedAddress: () => true, isAllowedPort: () => true, ...extra });

test('fetchRecipePage: happy path pins the validated address and sends browser-like headers', async () => {
  let seen;
  await withServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page({ '@type': 'Recipe', name: 'Café pie', recipeIngredient: ['x'] }));
  }, async (port) => {
    const out = await fetchRecipePage(`http://recipes.example:${port}/pie`, lifted());
    assert.match(out.html, /Café pie/);
    assert.equal(out.finalUrl, `http://recipes.example:${port}/pie`);
  });
  assert.equal(seen.host.startsWith('recipes.example'), true, 'Host header keeps the hostname, not the IP');
  assert.match(seen['user-agent'], /Mozilla\/5\.0/);
  assert.match(seen.accept, /text\/html/);
});

test('fetchRecipePage: a gzip body is decoded', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('<html>zipped recipe</html>'));
  }, async (port) => {
    const out = await fetchRecipePage(`http://r.example:${port}/`, lifted());
    assert.match(out.html, /zipped recipe/);
  });
});

test('fetchRecipePage: redirects are followed and every hop is re-validated', async () => {
  await withServer((req, res) => {
    if (req.url === '/a') { res.writeHead(301, { location: '/b' }); return res.end(); }
    if (req.url === '/b') { res.writeHead(302, { location: `http://r.example:${req.socket.localPort}/c` }); return res.end(); }
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url === '/to-internal') { res.writeHead(302, { location: 'http://internal.example/' }); return res.end(); }
    if (req.url === '/to-ftp') { res.writeHead(302, { location: 'ftp://r.example/' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html>landed</html>');
  }, async (port) => {
    const base = `http://r.example:${port}`;
    const ok = await fetchRecipePage(`${base}/a`, lifted());
    assert.match(ok.html, /landed/);
    assert.equal(ok.finalUrl, `${base}/c`);

    // The redirect target is re-checked with the REAL address guard: a lifted guard is
    // only used for the test server's own address, so a hop to the metadata IP is refused.
    const realGuardForOthers = (ip) => ip === '127.0.0.1';
    assert.equal(await codeOf(fetchRecipePage(`${base}/to-metadata`, lifted({ isAllowedAddress: realGuardForOthers }))), 'blocked_url');
    const lookup = async (host) => (host === 'internal.example' ? [{ address: '10.0.0.9', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    assert.equal(await codeOf(fetchRecipePage(`${base}/to-internal`, lifted({ lookup, isAllowedAddress: realGuardForOthers }))), 'blocked_url');
    assert.equal(await codeOf(fetchRecipePage(`${base}/to-ftp`, lifted())), 'bad_url');
    assert.equal(await codeOf(fetchRecipePage(`${base}/loop`, lifted({ maxRedirects: 3 }))), 'unreachable');
  });
});

test('fetchRecipePage: content-type, status and size checks', async () => {
  await withServer((req, res) => {
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    if (req.url === '/none') { res.writeHead(200); return res.end('x'); }
    if (req.url === '/404') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('gone'); }
    if (req.url === '/declared') { res.writeHead(200, { 'content-type': 'text/html', 'content-length': '5000' }); return res.end('x'.repeat(5000)); }
    if (req.url === '/streamed') {
      res.writeHead(200, { 'content-type': 'text/html' });
      let n = 0;
      const t = setInterval(() => { res.write('y'.repeat(1000)); if (++n > 50) { clearInterval(t); res.end(); } }, 1);
      res.on('close', () => clearInterval(t));
      return undefined;
    }
    if (req.url === '/bomb') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(Buffer.alloc(200_000, 0x61)));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('ok');
  }, async (port) => {
    const base = `http://r.example:${port}`;
    assert.equal(await codeOf(fetchRecipePage(`${base}/json`, lifted())), 'not_html');
    assert.equal(await codeOf(fetchRecipePage(`${base}/none`, lifted())), 'not_html');
    assert.equal(await codeOf(fetchRecipePage(`${base}/404`, lifted())), 'http_error');
    assert.equal(await codeOf(fetchRecipePage(`${base}/declared`, lifted({ maxBytes: 1000 }))), 'too_large');
    assert.equal(await codeOf(fetchRecipePage(`${base}/streamed`, lifted({ maxBytes: 10_000 }))), 'too_large');
    // Compressed size is tiny; the DECOMPRESSED size is what the cap measures.
    assert.equal(await codeOf(fetchRecipePage(`${base}/bomb`, lifted({ maxBytes: 50_000 }))), 'too_large');
  });
});

test('fetchRecipePage: a server that never answers times out', async () => {
  await withServer(() => { /* never respond */ }, async (port) => {
    const t0 = Date.now();
    assert.equal(await codeOf(fetchRecipePage(`http://r.example:${port}/`, lifted({ timeoutMs: 200 }))), 'timeout');
    assert.ok(Date.now() - t0 < 2000, 'gave up promptly');
  });
  // A body that trickles forever also times out (the deadline covers the whole fetch).
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const t = setInterval(() => res.write('z'), 20);
    res.on('close', () => clearInterval(t));
  }, async (port) => {
    assert.equal(await codeOf(fetchRecipePage(`http://r.example:${port}/`, lifted({ timeoutMs: 250 }))), 'timeout');
  });
  // Slow DNS counts against the deadline too.
  const slowLookup = () => new Promise(() => {});
  assert.equal(await codeOf(fetchRecipePage('https://slow.example/', { lookup: slowLookup, timeoutMs: 150 })), 'timeout');
});

test('fetchRecipePage: connection refused is unreachable', async () => {
  const server = http.createServer();
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  await new Promise((r) => server.close(r));
  assert.equal(await codeOf(fetchRecipePage(`http://r.example:${port}/`, lifted())), 'unreachable');
});

test('importRecipeFromUrl: extracts, or throws no_recipe', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/plain') return res.end('<html><body>Just a blog post</body></html>');
    return res.end(page({ '@type': 'Recipe', name: 'Stew', recipeIngredient: ['beef'], recipeInstructions: ['Cook.'] }));
  }, async (port) => {
    const r = await importRecipeFromUrl(`http://r.example:${port}/stew`, lifted());
    assert.equal(r.name, 'Stew');
    assert.equal(await codeOf(importRecipeFromUrl(`http://r.example:${port}/plain`, lifted())), 'no_recipe');
  });
});
