import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  siteLabel, affiliationMatchesOutlet, bioMentionsOutlet,
  extractAuthorUrl, extractPersonBio, affiliationClaims,
  classifyAuthorCurrency, isDepartedAuthor, UNCHECKABLE_REASONS,
} from '../../lib/author-currency.js';

// Every bio quoted below is VERBATIM from the live author page it names, read
// on 2026-09-20 while this module was being calibrated. They are the corpus the
// thresholds were measured against, so a change that breaks one of these is a
// change of behaviour on real data, not on a hypothetical.
const BIOS = {
  // TRUE POSITIVE — the current-role clause names a different outlet, and the
  // bio also marks this outlet as former.
  saunders: "Nicole Saunders is the beauty editor at Women's Health and has nine years of experience researching, writing, and editing lifestyle content. Previously, she was the beauty editor at Best Products where she tested quite literally thousands of launches for her quarterly column.",
  // TRUE POSITIVE — explicit "Previously, she worked at ELLE.com".
  freund: "Tatjana Freund is Hearst's Fashion & Luxury Commerce Editor, covering beauty, fashion and more across multiple brands. Previously, she worked at ELLE.com and Marie Claire. She's a fan of whiskey neat.",
  // TRUE POSITIVE — "formerly held the role of … at PureWow".
  lapolla: 'Brianna Lapolla formerly held the role of Senior Commerce Editor at PureWow covering all things shopping across beauty, fashion, and lifestyle. Now, she is putting her 12 years of professional experience to use on a freelance basis.',
  // FALSE POSITIVE the first version produced: a FREELANCER listing her other
  // mastheads. She still contributes to BAZAAR.COM, in the same sentence.
  segal: 'Lindy Segal is a beauty writer and editor. In addition to regularly contributing to BAZAAR.COM, she also writes for Glamour, People, WhoWhatWear, and Fashionista, among other publications.',
  // FALSE POSITIVE the second version produced: "Before joining SELF" names
  // the outlet she JOINED, i.e. the current one.
  ryu: 'Jenna Ryu is a Lifestyle Writer at SELF Magazine based in New York, where she covers topics ranging from beauty to mental health to relationships. Before joining SELF, she was a Wellness Reporter at USA TODAY.',
  // TRUE NEGATIVE — the outlet this module cannot catch, stated honestly. The
  // bio has simply not been updated since she left.
  goldman: 'Emily Goldman is the deputy digital director at Prevention. She has spent her career editing and writing about health, wellness, beauty, fashion, and food for Martha Stewart Living, Good Housekeeping, and more.',
  // TRUE NEGATIVE — two-token outlet name against a one-token domain label.
  godio: 'Mili Godio is the updates editor at NBC Selected. Since joining the team in 2021, she has written a variety of articles across beauty, skin care, hair care, wellness and pet care for the site.',
  // TRUE NEGATIVE — a founder-of clause.
  voss: 'Independent product safety researcher and founder of NonToxicLab. Background in biology; participates in scientific studies to stay current in the fields she writes about.',
};

const profilePage = (person) => `<html><head><script type="application/ld+json">${
  JSON.stringify({ '@type': 'ProfilePage', mainEntity: { '@type': 'Person', ...person } })
}</script></head><body></body></html>`;

// ---------------------------------------------------------------------------
// siteLabel
// ---------------------------------------------------------------------------

test('siteLabel strips scheme, www and TLD', () => {
  assert.equal(siteLabel('https://www.bestproducts.com/beauty/g1/'), 'bestproducts');
  assert.equal(siteLabel('nbcnews.com'), 'nbcnews');
  assert.equal(siteLabel('bettergoods.org'), 'bettergoods');
});

test('siteLabel handles a two-part TLD', () => {
  assert.equal(siteLabel('www.example.co.uk'), 'example');
});

test('siteLabel is empty for empty input', () => {
  assert.equal(siteLabel(''), '');
  assert.equal(siteLabel(null), '');
});

// ---------------------------------------------------------------------------
// affiliationMatchesOutlet
// ---------------------------------------------------------------------------

test('a two-token outlet name matches a one-token domain label', () => {
  // "NBC Selected" vs nbcnews.com — neither contains the other as a token, and
  // reading that as a departure would have demoted a perfectly current author.
  assert.equal(affiliationMatchesOutlet('NBC Selected', { domain: 'nbcnews.com', publication: 'NBC News' }), true);
  assert.equal(affiliationMatchesOutlet('Better Goods', { domain: 'bettergoods.org' }), true);
  assert.equal(affiliationMatchesOutlet('NonToxicLab', { domain: 'nontoxiclab.com' }), true);
});

test("a genuinely different outlet does not match", () => {
  assert.equal(affiliationMatchesOutlet("Women's Health", { domain: 'bestproducts.com', publication: 'Best Products' }), false);
  assert.equal(affiliationMatchesOutlet('Glamour', { domain: 'harpersbazaar.com' }), false);
});

test('an unresolvable affiliation is treated as MATCHING — unknown never demotes', () => {
  assert.equal(affiliationMatchesOutlet('', { domain: 'elle.com' }), true);
  assert.equal(affiliationMatchesOutlet('The', { domain: 'elle.com' }), true);
  assert.equal(affiliationMatchesOutlet("Women's Health", {}), true);
});

// ---------------------------------------------------------------------------
// bioMentionsOutlet — the precision guard on current-role-elsewhere
// ---------------------------------------------------------------------------

test('bioMentionsOutlet sees the outlet inside BAZAAR.COM', () => {
  assert.equal(bioMentionsOutlet(BIOS.segal, { domain: 'harpersbazaar.com', publication: "Harper's BAZAAR" }), true);
});

test('bioMentionsOutlet is false when the bio never names us', () => {
  assert.equal(bioMentionsOutlet('She writes for Glamour and People.', { domain: 'harpersbazaar.com', publication: "Harper's BAZAAR" }), false);
});

test('a generic word can never be what makes a bio "mention" an outlet', () => {
  // `the`/`com`/`online` are dropped by tokens(), so a bio full of filler does
  // not accidentally suppress a real departure.
  assert.equal(bioMentionsOutlet('She writes online for the web.', { domain: 'theonline.com', publication: 'The Online' }), false);
});

// ---------------------------------------------------------------------------
// extractAuthorUrl — DERIVED from markup, never guessed
// ---------------------------------------------------------------------------

test('reads author.url out of JSON-LD', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    author: [{ '@type': 'Person', name: 'Nicole Saunders', url: 'https://www.bestproducts.com/author/234196/nicole-saunders/' }],
  })}</script>`;
  assert.equal(
    extractAuthorUrl(html, { domain: 'bestproducts.com', author: 'Nicole Saunders' }),
    'https://www.bestproducts.com/author/234196/nicole-saunders/',
  );
});

test('picks the author matching the byline when a page lists several', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    author: [
      { '@type': 'Person', name: 'Hannah Jeon', url: 'https://www.prevention.com/author/224199/hannah-jeon/' },
      { '@type': 'Person', name: 'Emily Goldman', url: 'https://www.prevention.com/author/228990/emily-goldman/' },
    ],
  })}</script>`;
  assert.equal(
    extractAuthorUrl(html, { domain: 'prevention.com', author: 'Emily Goldman' }),
    'https://www.prevention.com/author/228990/emily-goldman/',
  );
});

test('recovers an author URL from JSON-LD that does not parse', () => {
  // 58 of this site's own pages carry unparseable JSON-LD; other people's are
  // no better, so a block that fails JSON.parse must still yield its URL.
  const html = '<script type="application/ld+json">{"author":{"name":"A "quoted" name","url":"https://nontoxiclab.com/author/lara-voss/"}}</script>';
  assert.equal(extractAuthorUrl(html, { domain: 'nontoxiclab.com' }), 'https://nontoxiclab.com/author/lara-voss/');
});

test('reads a rel="author" anchor and absolutizes it', () => {
  const html = '<a rel="author" href="/author/lara-voss/">Lara Voss</a>';
  assert.equal(
    extractAuthorUrl(html, { domain: 'nontoxiclab.com', author: 'Lara Voss' }),
    'https://nontoxiclab.com/author/lara-voss/',
  );
});

test('uses a raw byline that is itself an author URL', () => {
  // marieclaire.com, theguardian.com and two others put the ARCHIVE LINK where
  // the name should be, which html-byline correctly rejects as a person — the
  // string is still the best pointer to the author page we have.
  assert.equal(
    extractAuthorUrl('<html></html>', {
      domain: 'marieclaire.com', author: null,
      authorRaw: 'https://www.marieclaire.com/author/sophia-vilensky/',
    }),
    'https://www.marieclaire.com/author/sophia-vilensky/',
  );
});

test('REFUSES an off-site profile URL', () => {
  // thefiltery.com and organicbeautylover.com hand back a facebook.com profile.
  // That is not an outlet page and cannot answer "do they still work here".
  assert.equal(
    extractAuthorUrl('<html></html>', {
      domain: 'thefiltery.com', authorRaw: 'https://www.facebook.com/thefiltery',
    }),
    null,
  );
});

test('refuses a bare homepage — it answers nothing', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    author: { '@type': 'Person', name: 'X', url: 'https://elle.com/' },
  })}</script>`;
  assert.equal(extractAuthorUrl(html, { domain: 'elle.com' }), null);
});

test('falls back to an /author/ href whose slug matches the byline', () => {
  // A root-relative href is absolutized against the row's own (already
  // www-stripped) domain, which is what `rankTargets` hands us. Publishers
  // redirect the bare host, and `fetch` follows redirects, so the missing www
  // costs a hop and nothing else — verified live against purewow.com.
  const html = '<div><a href="/author/234196/nicole-saunders/">more</a></div>';
  assert.equal(
    extractAuthorUrl(html, { domain: 'bestproducts.com', author: 'Nicole Saunders' }),
    'https://bestproducts.com/author/234196/nicole-saunders/',
  );
});

test('returns null for missing or unusable html', () => {
  assert.equal(extractAuthorUrl(null, { domain: 'elle.com', author: 'X Y' }), null);
  assert.equal(extractAuthorUrl('<html></html>', { domain: 'elle.com', author: 'X Y' }), null);
});

// ---------------------------------------------------------------------------
// extractPersonBio
// ---------------------------------------------------------------------------

test('reads a ProfilePage mainEntity Person', () => {
  const bio = extractPersonBio(profilePage({
    name: 'Nicole Saunders', jobTitle: 'Beauty Editor', description: BIOS.saunders,
  }), { author: 'Nicole Saunders' });
  assert.equal(bio.name, 'Nicole Saunders');
  assert.equal(bio.jobTitle, 'Beauty Editor');
  assert.match(bio.description, /Women's Health/);
});

test('decodes &nbsp; and &amp; so the patterns see real prose', () => {
  const bio = extractPersonBio(profilePage({
    name: 'T F', description: 'T F is Hearst&#x27;s Fashion &amp; Luxury Editor.&nbsp;&nbsp;',
  }));
  assert.match(bio.description, /Fashion & Luxury/);
  assert.ok(!bio.description.includes('&nbsp;'));
});

test('falls back to the meta description when no Person node exists', () => {
  const bio = extractPersonBio('<meta name="description" content="Lara Voss is the founder of NonToxicLab and writes about PFAS.">');
  assert.match(bio.description, /NonToxicLab/);
});

test('returns all-null for html with nothing in it', () => {
  const bio = extractPersonBio('<html><body>hi</body></html>');
  assert.equal(bio.description, null);
  assert.equal(bio.jobTitle, null);
  assert.equal(bio.worksFor, null);
});

// ---------------------------------------------------------------------------
// affiliationClaims
// ---------------------------------------------------------------------------

test('splits a bio into current and former outlets', () => {
  const claims = affiliationClaims({ description: BIOS.saunders });
  assert.ok(claims.current.some((c) => /Women's Health/.test(c)), JSON.stringify(claims));
  assert.ok(claims.former.some((f) => /Best Products/.test(f)), JSON.stringify(claims));
});

test('a capitalised marker at a sentence start is matched', () => {
  // The first version compiled these patterns with 'g' and no 'i', so
  // "Previously," at a sentence start — the only place it ever appears —
  // matched nothing at all and the Elle bio scored bio-names-no-outlet.
  const claims = affiliationClaims({ description: BIOS.freund });
  assert.ok(claims.former.some((f) => /ELLE/i.test(f)), JSON.stringify(claims));
});

test("the possessive form 'is Hearst's … Editor' is read as a current role", () => {
  // The apostrophe used to sit inside the greedy character class, so the
  // pattern consumed the `'s` it then required and could never match.
  const claims = affiliationClaims({ description: BIOS.freund });
  assert.ok(claims.current.includes('Hearst'), JSON.stringify(claims));
});

test('a former-marked sentence contributes NOTHING to current', () => {
  // "Previously, she worked at ELLE.com" contains "worked at"; reading that as
  // a current role would invert the whole check.
  const claims = affiliationClaims({ description: BIOS.freund });
  assert.ok(!claims.current.some((c) => /ELLE/i.test(c)), JSON.stringify(claims));
});

test('"founder of X" is a current role', () => {
  const claims = affiliationClaims({ description: BIOS.voss });
  assert.ok(claims.current.some((c) => /NonToxicLab/.test(c)), JSON.stringify(claims));
});

test('worksFor is taken as a current affiliation', () => {
  const claims = affiliationClaims({ worksFor: 'Better Goods' });
  assert.deepEqual(claims.current, ['Better Goods']);
});

test('"Before joining SELF" does not make SELF a FORMER employer', () => {
  const claims = affiliationClaims({ description: BIOS.ryu });
  assert.ok(!claims.former.some((f) => /^SELF/.test(f)), JSON.stringify(claims));
  assert.ok(claims.former.some((f) => /USA TODAY/.test(f)), JSON.stringify(claims));
});

// ---------------------------------------------------------------------------
// classifyAuthorCurrency — the verdict
// ---------------------------------------------------------------------------

const classify = (bioText, opts) => classifyAuthorCurrency({
  author: opts.author, domain: opts.domain, publication: opts.publication,
  authorUrl: `https://${opts.domain}/author/x/`, fetchStatus: 'ok',
  html: profilePage({ name: opts.author, description: bioText }),
});

test('DEPARTED: the bio names this outlet as a former employer', () => {
  const v = classify(BIOS.saunders, { author: 'Nicole Saunders', domain: 'bestproducts.com', publication: 'Best Products' });
  assert.equal(v.state, 'departed');
  assert.equal(v.reason, 'previously-at-this-outlet');
  assert.ok(isDepartedAuthor(v));
  assert.match(v.evidence, /Best Products/);
  assert.ok(v.bio_excerpt);
});

test('DEPARTED: Tatjana Freund at elle.com', () => {
  const v = classify(BIOS.freund, { author: 'Tatjana Freund', domain: 'elle.com', publication: 'ELLE' });
  assert.equal(v.state, 'departed');
  assert.equal(v.reason, 'previously-at-this-outlet');
});

test('DEPARTED: Brianna Lapolla at purewow.com', () => {
  const v = classify(BIOS.lapolla, { author: 'Brianna Lapolla', domain: 'purewow.com', publication: 'PureWow' });
  assert.equal(v.state, 'departed');
});

test('DEPARTED: a current role at a different outlet, with no mention of us', () => {
  const v = classify(
    "Jane Roe is the beauty editor at Women's Health.",
    { author: 'Jane Roe', domain: 'bestproducts.com', publication: 'Best Products' },
  );
  assert.equal(v.state, 'departed');
  assert.equal(v.reason, 'current-role-elsewhere');
});

test('NOT DEPARTED: a freelancer who lists other mastheads and still writes for us', () => {
  // The live false positive. "writes for Glamour" is a current-role clause, but
  // the same sentence says she contributes to BAZAAR.COM.
  const v = classify(BIOS.segal, { author: 'Lindy Segal', domain: 'harpersbazaar.com', publication: "Harper's BAZAAR" });
  assert.equal(v.state, 'current');
  assert.equal(v.reason, 'bio-names-other-outlets-too');
});

test('NOT DEPARTED: "Before joining SELF" — current wins a tie', () => {
  const v = classify(BIOS.ryu, { author: 'Jenna Ryu', domain: 'self.com', publication: 'SELF' });
  assert.equal(v.state, 'current');
});

test('NOT DEPARTED: a two-token outlet name against a one-token domain', () => {
  const v = classify(BIOS.godio, { author: 'Mili Godio', domain: 'nbcnews.com', publication: 'NBC News' });
  assert.equal(v.state, 'current');
});

test('NOT DEPARTED: founder of the site itself', () => {
  const v = classify(BIOS.voss, { author: 'Lara Voss', domain: 'nontoxiclab.com', publication: 'NonToxicLab' });
  assert.equal(v.state, 'current');
});

test('THE HONEST MISS: a bio the outlet never updated reads as current', () => {
  // Emily Goldman left Prevention for the BCRF and her published Hearst address
  // is dead, but nothing on Prevention's page says so. This module answers from
  // the page; when the page is wrong, so is the answer. Do not quote this
  // check as catching four of the four known-bad targets.
  const v = classify(BIOS.goldman, { author: 'Emily Goldman', domain: 'prevention.com', publication: 'Prevention' });
  assert.equal(v.state, 'current');
});

// ---------------------------------------------------------------------------
// Fail-open: every branch that cannot answer
// ---------------------------------------------------------------------------

test('no person byline → unknown, never departed', () => {
  const v = classifyAuthorCurrency({ author: null, domain: 'elle.com', authorUrl: null });
  assert.equal(v.state, 'unknown');
  assert.equal(v.reason, 'no-person-byline');
});

test('no author page found → unknown', () => {
  const v = classifyAuthorCurrency({ author: 'A B', domain: 'elitedaily.com', authorUrl: null });
  assert.equal(v.state, 'unknown');
  assert.equal(v.reason, 'no-author-page-found');
});

test('a 404 author page is UNKNOWN, not a departure', () => {
  // Measured: teethtalkgirl.com's own markup emits a doubled path
  // (/authors//authors/whitney-difoggio, 404) for a page that serves 200 at
  // /authors/whitney-difoggio. A site restructure looks identical.
  const v = classifyAuthorCurrency({
    author: 'Whitney DiFoggio', domain: 'teethtalkgirl.com',
    authorUrl: 'https://www.teethtalkgirl.com/authors//authors/whitney-difoggio',
    fetchStatus: 'not-found',
  });
  assert.equal(v.state, 'unknown');
  assert.equal(v.reason, 'author-page-not-found');
});

test('an unreachable author page → unknown', () => {
  const v = classifyAuthorCurrency({
    author: 'A B', domain: 'elle.com', authorUrl: 'https://elle.com/author/a-b/', fetchStatus: 'error',
  });
  assert.equal(v.state, 'unknown');
  assert.equal(v.reason, 'author-page-unreachable');
});

test('an author page with no bio → unknown', () => {
  const v = classifyAuthorCurrency({
    author: 'A B', domain: 'elle.com', authorUrl: 'https://elle.com/author/a-b/',
    fetchStatus: 'ok', html: '<html><body>nothing here</body></html>',
  });
  assert.equal(v.state, 'unknown');
  assert.equal(v.reason, 'no-author-bio');
});

test('a bio that names no outlet at all → unknown, not departed', () => {
  const v = classify('A B writes about skin care and lives in Ohio.', { author: 'A B', domain: 'elle.com', publication: 'ELLE' });
  assert.equal(v.state, 'unknown');
  assert.equal(v.reason, 'bio-names-no-outlet');
});

test('every unknown reason this module emits is in UNCHECKABLE_REASONS', () => {
  // The agent counts these separately so a run reporting "0 moved" can never be
  // read as "every author was verified".
  const emitted = [
    classifyAuthorCurrency({ author: null }),
    classifyAuthorCurrency({ author: 'A B', authorUrl: null }),
    classifyAuthorCurrency({ author: 'A B', authorUrl: 'https://x.com/a/', fetchStatus: 'not-found' }),
    classifyAuthorCurrency({ author: 'A B', authorUrl: 'https://x.com/a/', fetchStatus: 'error' }),
    classifyAuthorCurrency({ author: 'A B', authorUrl: 'https://x.com/a/', fetchStatus: 'ok', html: '<p>x</p>' }),
    classify('A B writes about things.', { author: 'A B', domain: 'x.com', publication: 'X' }),
  ];
  for (const v of emitted) {
    assert.equal(v.state, 'unknown', JSON.stringify(v));
    assert.ok(UNCHECKABLE_REASONS.has(v.reason), `not in UNCHECKABLE_REASONS: ${v.reason}`);
  }
});

test('isDepartedAuthor is false for null and for every unknown', () => {
  assert.equal(isDepartedAuthor(null), false);
  assert.equal(isDepartedAuthor(undefined), false);
  assert.equal(isDepartedAuthor({ state: 'unknown' }), false);
  assert.equal(isDepartedAuthor({ state: 'current' }), false);
});
