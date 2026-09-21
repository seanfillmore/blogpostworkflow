import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  extractByline, pageMentionsBrand, looksLikeStore,
  nonPersonReason, looksLikePersonName,
  teamBylineReason, isTeamByline, classifyByline,
  MAX_AUTHOR_WORDS,
} from '../../lib/html-byline.js';

// ---------------------------------------------------------------------------
// nonPersonReason / looksLikePersonName — "is this string shaped like a name?"
// ---------------------------------------------------------------------------

test('real bylines from the live report are accepted', () => {
  // Every one of these is a genuine author string in data/reports/pr-targets.
  for (const name of [
    'Kate Arceo', 'Catherine Conelly', 'Mila Milosevic', 'Sydney Cook',
    'Natalie Arroyo Camacho', 'Abbie Kozolchyk', 'Mili Godio',
    'Nicole Saunders', 'Tatjana Freund', 'Emily Goldman',
    'Masha Vapnitchnaia', 'Lindsey St. Mary', 'Mary Beth Van Horn',
  ]) {
    assert.equal(nonPersonReason(name), null, `rejected a real byline: ${name}`);
    assert.ok(looksLikePersonName(name));
  }
});

test('a URL in the author field is rejected', () => {
  // Observed live on marieclaire.com, thefiltery.com, theguardian.com and
  // organicbeautylover.com — the theme puts the author-archive href there.
  assert.equal(nonPersonReason('https://www.marieclaire.com/author/jane-doe'), 'url');
  assert.equal(nonPersonReason('//www.theguardian.com/profile/x'), 'url');
  assert.equal(nonPersonReason('www.thefiltery.com'), 'url');
  assert.equal(nonPersonReason('facebook.com/someprofile'), 'url');
  assert.equal(nonPersonReason('organicbeautylover.com'), 'url');
});

test('an email address is rejected', () => {
  assert.equal(nonPersonReason('editor@bettergoods.org'), 'email');
});

test('a social handle is rejected', () => {
  assert.equal(nonPersonReason('@thefiltery'), 'social-handle');
  assert.equal(nonPersonReason('Follow @janedoe'), 'social-handle');
});

test('more than four words is rejected', () => {
  assert.equal(nonPersonReason('Written by our editorial staff in NYC'), 'too-long');
  // Exactly the ceiling is still fine.
  assert.equal(MAX_AUTHOR_WORDS, 4);
  assert.equal(nonPersonReason('Mary Beth Van Horn'), null);
});

test('a single bare token is rejected — cultivatewp is a WordPress theme vendor', () => {
  assert.equal(nonPersonReason('cultivatewp'), 'single-token');
  assert.equal(nonPersonReason('admin'), 'single-token');
});

test('empty and letterless strings are rejected with their own reasons', () => {
  assert.equal(nonPersonReason(null), 'empty');
  assert.equal(nonPersonReason(''), 'empty');
  assert.equal(nonPersonReason('   '), 'empty');
  assert.equal(nonPersonReason('2024 —'), 'no-letters');
});

// ---------------------------------------------------------------------------
// teamBylineReason — "is this the outlet rather than a person at it?"
// ---------------------------------------------------------------------------

test('every team byline from the 2026-09-20 audit is caught', () => {
  const cases = [
    ['Better Goods Team', { domain: 'bettergoods.org' }],
    ['Curology Team', { domain: 'curology.com' }],
    ['Enamelly Editorial Team', { domain: 'enamelly.com' }],
    ['Dental Reviewed', { domain: 'dentalreviewed.com' }],
    ['BABOR Team', { domain: 'babor.com' }],
    ['Cleveland Clinic', { domain: 'clevelandclinic.org' }],
  ];
  for (const [name, opts] of cases) {
    assert.ok(isTeamByline(name, opts), `missed a team byline: ${name}`);
  }
});

test('team words are matched whole-word, not as substrings', () => {
  assert.equal(teamBylineReason('Editorial Staff'), 'team-byline');
  assert.equal(teamBylineReason('The Editors'), 'team-byline');
  // "Teamer" and "Staffordshire" are not "team"/"staff".
  assert.equal(teamBylineReason('Jane Teamer'), null);
  assert.equal(teamBylineReason('Ellen Staffordshire'), null);
});

test('surnames that look like org nouns are NOT rejected', () => {
  // The org list only fires on the LAST word, and only on nouns that cannot be
  // a surname. These are all plausible real people.
  for (const name of ['Sydney Cook', 'Anna Bishop', 'Rachel Marshall', 'Paul Church']) {
    assert.equal(teamBylineReason(name), null, `false positive on ${name}`);
  }
});

test('an organization noun in the last position is caught', () => {
  assert.equal(teamBylineReason('Mayo Clinic'), 'organization');
  assert.equal(teamBylineReason('Hearst Magazine'), 'organization');
  assert.equal(teamBylineReason('Acme Labs'), 'organization');
});

test('a byline matching the site name EXACTLY is caught', () => {
  assert.equal(teamBylineReason('Better Goods', { domain: 'bettergoods.org' }), 'matches-publication');
  assert.equal(teamBylineReason('Well Good', { publication: 'Well+Good' }), 'matches-publication');
});

test('matching is EXACT, so a prefix of the site name is not flagged', () => {
  // "Kate Arceo" on thegoodtrade.com must survive; so must a partial overlap.
  assert.equal(teamBylineReason('Kate Arceo', { domain: 'thegoodtrade.com' }), null);
  assert.equal(teamBylineReason('Goodwin Hale', { domain: 'thegoodtrade.com' }), null);
});

test('ACCEPTED RESIDUAL: a personal-brand blog whose byline IS its domain is flagged', () => {
  // Known and deliberate. The consequence is a DEMOTED row carrying the reason
  // `matches-publication`, never a dropped one — see the module comment. If
  // this ever needs to change, change it knowingly, not by accident.
  assert.equal(teamBylineReason('Lara Voss', { domain: 'laravoss.com' }), 'matches-publication');
});

// ---------------------------------------------------------------------------
// classifyByline — the single decision, with a reason
// ---------------------------------------------------------------------------

test('classifyByline reports WHICH check rejected the byline', () => {
  assert.deepEqual(classifyByline('Better Goods Team', { domain: 'bettergoods.org' }),
    { author: null, reason: 'team-byline' });
  assert.deepEqual(classifyByline('https://x.com/author/y'), { author: null, reason: 'url' });
  assert.deepEqual(classifyByline('cultivatewp'), { author: null, reason: 'single-token' });
  assert.deepEqual(classifyByline('Kate Arceo'), { author: 'Kate Arceo', reason: null });
});

test('an absent byline is not a REJECTED byline — reason stays null', () => {
  // "we found nothing" and "we refused what we found" are different findings
  // and the report renders them differently.
  assert.deepEqual(classifyByline(null), { author: null, reason: null });
  assert.deepEqual(classifyByline(''), { author: null, reason: null });
});

test('classifyByline strips a leading "By" before judging', () => {
  assert.deepEqual(classifyByline('By Kate Arceo'), { author: 'Kate Arceo', reason: null });
});

// ---------------------------------------------------------------------------
// extractByline — end to end over the shapes real pages use
// ---------------------------------------------------------------------------

test('extractByline returns a person and keeps the publication', () => {
  const html = `<html><head>
    <meta name="author" content="Kate Arceo">
    <meta property="og:site_name" content="The Good Trade">
  </head><body></body></html>`;
  const out = extractByline(html, { domain: 'thegoodtrade.com' });
  assert.equal(out.author, 'Kate Arceo');
  assert.equal(out.publication, 'The Good Trade');
  assert.equal(out.author_rejected, null);
});

test('extractByline nulls a team byline but REPORTS it via author_raw + reason', () => {
  const html = `<html><head>
    <meta name="author" content="Better Goods Team">
    <meta property="og:site_name" content="Better Goods">
  </head></html>`;
  const out = extractByline(html, { domain: 'bettergoods.org' });
  assert.equal(out.author, null);
  assert.equal(out.author_raw, 'Better Goods Team');
  assert.equal(out.author_rejected, 'team-byline');
});

test('extractByline rejects a URL that JSON-LD put in the author slot', () => {
  const html = `<script type="application/ld+json">
    {"@type":"Article","author":{"name":"https://www.marieclaire.com/author/j-doe"}}
  </script>`;
  const out = extractByline(html, { domain: 'marieclaire.com' });
  assert.equal(out.author, null);
  assert.equal(out.author_rejected, 'url');
});

test('extractByline still falls back to the domain for publication', () => {
  assert.equal(extractByline('<html></html>', { domain: 'health.com' }).publication, 'health.com');
  assert.equal(extractByline(null, { domain: 'health.com' }).author, null);
});

// ---------------------------------------------------------------------------
// untouched helpers — pinned so this change cannot regress them
// ---------------------------------------------------------------------------

test('pageMentionsBrand is case-insensitive and needs an alias', () => {
  assert.equal(pageMentionsBrand('<p>Visit RealSkinCare.com</p>', ['realskincare.com']), true);
  assert.equal(pageMentionsBrand('<p>nothing here</p>', ['realskincare.com']), false);
  assert.equal(pageMentionsBrand('<p>realskincare.com</p>', []), false);
});

test('looksLikeStore needs two signals', () => {
  assert.equal(looksLikeStore('<a href="/cart">Cart</a>'), false);
  assert.equal(looksLikeStore('<script src="https://cdn.shopify.com/x"></script><button>Add to cart</button>'), true);
});
