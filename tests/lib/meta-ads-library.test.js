// tests/lib/meta-ads-library.test.js
import { strict as assert } from 'node:assert';
import {
  buildAdArchiveUrl,
  slugifyPageName,
  extractNextCursor,
} from '../../lib/meta-ads-library.js';

// buildAdArchiveUrl — keyword search URL
{
  const url = buildAdArchiveUrl({
    searchTerms: 'natural deodorant',
    adReachedCountries: ['US'],
    after: null,
  });
  assert.ok(url.includes('ads_archive'), 'must target ads_archive endpoint');
  assert.ok(url.includes('search_terms=natural+deodorant') || url.includes('search_terms=natural%20deodorant'), 'must include search terms');
  assert.ok(url.includes('ad_reached_countries'), 'must include country filter');
  assert.ok(url.includes('ad_delivery_start_time'), 'must request start time field');
  assert.ok(url.includes('ad_snapshot_url'), 'must request snapshot URL field');
}

// buildAdArchiveUrl — page ID search URL
{
  const url = buildAdArchiveUrl({ searchPageIds: ['123456789'], adReachedCountries: ['US'], after: null });
  assert.ok(url.includes('search_page_ids=123456789'), 'must include page ID filter');
}

// buildAdArchiveUrl — pagination cursor
{
  const url = buildAdArchiveUrl({ searchTerms: 'test', adReachedCountries: ['US'], after: 'cursor123' });
  assert.ok(url.includes('after=cursor123'), 'must include cursor for pagination');
}

// buildAdArchiveUrl — requests plural field names (what Meta API expects)
{
  const url = buildAdArchiveUrl({ searchTerms: 'test', adReachedCountries: ['US'], after: null });
  assert.ok(url.includes('ad_creative_bodies'), 'must request plural bodies field');
  assert.ok(url.includes('ad_creative_link_titles'), 'must request plural titles field');
  assert.ok(url.includes('ad_delivery_start_time'), 'must request start time');
  assert.ok(url.includes('ad_delivery_stop_time'), 'must request stop time');
}

// normalizeAd — maps plural array fields to singular string fields in output
{
  const { normalizeAd } = await import('../../lib/meta-ads-library.js');
  const raw = {
    id: 'ad1', page_id: 'p1', page_name: 'Dove',
    ad_delivery_start_time: '2026-01-01', ad_delivery_stop_time: null,
    ad_creative_bodies: ['First body', 'Second body'],
    ad_creative_link_titles: ['First title'],
    ad_creative_link_descriptions: ['First desc'],
    ad_snapshot_url: 'https://meta.com/snapshot/1',
    publisher_platforms: ['instagram'],
  };
  const normalized = normalizeAd(raw);
  assert.equal(normalized.ad_creative_body, 'First body', 'must extract [0] from bodies array');
  assert.equal(normalized.ad_creative_link_title, 'First title', 'must extract [0] from titles array');
  assert.equal(normalized.ad_creative_link_description, 'First desc', 'must extract [0] from descriptions array');
  assert.equal(normalized.page_slug, 'dove', 'must slugify page name');
  // Confirm singular field names in output (not plural)
  assert.ok(!('ad_creative_bodies' in normalized), 'output must not contain plural bodies');
}

// normalizeAd — handles missing array fields gracefully
{
  const { normalizeAd } = await import('../../lib/meta-ads-library.js');
  const raw = { id: 'ad2', page_id: 'p2', page_name: 'Brand' };
  const normalized = normalizeAd(raw);
  assert.equal(normalized.ad_creative_body, '', 'missing bodies → empty string');
  assert.deepEqual(normalized.publisher_platforms, [], 'missing platforms → empty array');
}

// slugifyPageName
assert.equal(slugifyPageName("Dr. Squatch Men's Soap"), 'dr-squatch-mens-soap');
assert.equal(slugifyPageName('Nécessaire'), 'ncessaire');
assert.equal(slugifyPageName('Dove Men+Care'), 'dove-men-care');
assert.equal(slugifyPageName('  spaces  '), 'spaces');

// extractNextCursor — present
{
  const body = { paging: { cursors: { after: 'abc123' }, next: 'https://example.com' } };
  assert.equal(extractNextCursor(body), 'abc123');
}

// extractNextCursor — absent (no next page)
{
  const body = { paging: { cursors: { after: 'abc123' } } };
  assert.equal(extractNextCursor(body), null);
}

// extractNextCursor — no paging key
assert.equal(extractNextCursor({}), null);

console.log('✓ meta-ads-library unit tests pass');

// authHint — names the user token on the two Ad Library auth subcodes
{
  const { authHint } = await import('../../lib/meta-ads-library.js');
  assert.match(authHint('{"error":{"error_subcode":2332004}}'), /FACEBOOK_ACCESS_TOKEN/);
  assert.match(authHint('{"error":{"error_subcode":2332002}}'), /FACEBOOK_ACCESS_TOKEN/);
  assert.equal(authHint('{"error":{"code":4,"message":"rate limit"}}'), '');
}

// the Ad Library reads FACEBOOK_ACCESS_TOKEN, never the app or system token
// (both measured to fail on ads_archive, 2026-10-05)
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../lib/meta-ads-library.js', import.meta.url), 'utf8');
  const decl = src.split('\n').find(l => l.startsWith('const ACCESS_TOKEN'));
  assert.match(decl, /FACEBOOK_ACCESS_TOKEN/);
  assert.doesNotMatch(decl, /META_APP_ACCESS_TOKEN|META_USER_ACCESS_TOKEN/);
}

// nextPageUrl — page 2 keeps the search, only the cursor changes
{
  const { nextPageUrl } = await import('../../lib/meta-ads-library.js');
  const first = buildAdArchiveUrl({ searchTerms: 'natural deodorant', adReachedCountries: ['US'] });
  const next = new URL(nextPageUrl(first, 'CURSOR2'));
  assert.equal(next.searchParams.get('search_terms'), 'natural deodorant');
  assert.equal(next.searchParams.get('after'), 'CURSOR2');
  const third = new URL(nextPageUrl(next.toString(), 'CURSOR3'));
  assert.equal(third.searchParams.get('after'), 'CURSOR3');
  assert.equal(third.searchParams.getAll('after').length, 1);
}
