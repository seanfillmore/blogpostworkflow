import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  PLAN,
  gatePlan,
  targetLabel,
  backupName,
} from '../../scripts/remediate-antiperspirant-product-copy.js';
import { occurrences, replaceAll, classifyBody } from '../../scripts/remediate-live-health-claims.js';
import { findProductCategoryMisnomers, sanitizeProductCategoryTerm } from '../../lib/product-category-terms.js';
import { checkSeoCopy } from '../../lib/seo-copy-health-gate.js';

describe('antiperspirant remediation — plan shape', () => {
  test('every entry carries the fields the runner and the record need', () => {
    assert.ok(PLAN.length > 0);
    for (const e of PLAN) {
      assert.equal(typeof e.id, 'string');
      assert.ok(['article', 'file'].includes(e.target.kind), e.id);
      assert.ok(['title', 'meta'].includes(e.gateSlot), e.id);
      assert.equal(typeof e.before, 'string');
      assert.equal(typeof e.after, 'string');
      assert.ok(e.before.length > 0 && e.after.length > 0, e.id);
      assert.notEqual(e.before, e.after, e.id);
      assert.ok(Number.isInteger(e.expectedOccurrences) && e.expectedOccurrences > 0, e.id);
      assert.ok(Array.isArray(e.mustContain) && e.mustContain.length > 0, e.id);
      assert.ok(['arm-a', 'arm-b', 'arm-a+arm-b', 'judgement'].includes(e.caughtBy), e.id);
      assert.ok(e.why.length > 40, `${e.id} needs a real written reason`);
    }
  });

  test('ids are unique — `--only` must select exactly one entry', () => {
    const ids = PLAN.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every BEFORE actually contains the term this script exists to remove', () => {
    for (const e of PLAN) assert.match(e.before, /antiperspirant/i, e.id);
  });

  test('no AFTER contains the term, anywhere', () => {
    for (const e of PLAN) assert.doesNotMatch(e.after, /antiperspirant/i, e.id);
  });

  test('the em dash in the CTA literals is U+2014, not a transcribed hyphen', () => {
    // The sibling plan was bitten by a U+00A0 transcribed as a space. A literal that
    // LOOKS right and is not is the failure mode here, so the codepoint is pinned.
    const cta = PLAN.filter((e) => e.before.includes('Our pick for'));
    assert.equal(cta.length, 4);
    for (const e of cta) {
      assert.ok(e.before.includes('—'), `${e.id} lost its em dash`);
      assert.ok(e.after.includes('—'), `${e.id} lost its em dash`);
      assert.doesNotMatch(e.before, / /, `${e.id} has a non-breaking space`);
    }
  });
});

describe('antiperspirant remediation — the gates', () => {
  test('every planned rewrite passes the run-time gate', () => {
    const g = gatePlan(PLAN);
    assert.equal(g.ok, true, JSON.stringify(g.failures));
  });

  test('the gate rejects an AFTER that still carries the term', () => {
    const g = gatePlan([{ ...PLAN[0], after: 'Our pick for travel size antiperspirant: X' }]);
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.reason === 'term-survives'));
  });

  test('the gate rejects an AFTER that drops a ranking token', () => {
    const g = gatePlan([{ ...PLAN[0], after: 'Buy this deodorant' }]);
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.reason === 'ranking-token-lost'));
  });

  test('the gate rejects an AFTER that introduces a health claim', () => {
    const e = PLAN[0];
    const g = gatePlan([{ ...e, after: `${e.after} that heals eczema`, mustContain: [] }]);
    assert.equal(g.ok, false);
    assert.ok(g.failures.some((f) => f.reason === 'seo-copy'));
  });

  test('every AFTER is clean under the enforcement rule itself', () => {
    for (const e of PLAN) {
      assert.deepEqual(findProductCategoryMisnomers(e.after), [], e.id);
      assert.equal(checkSeoCopy({ [e.gateSlot]: e.after }).ok, true, e.id);
    }
  });
});

describe('antiperspirant remediation — mirrors', () => {
  test('every article entry has a paired mirror entry with the same rewrite', () => {
    // agents/publisher republishes data/posts/<slug>/content.html over body_html, so an
    // unmirrored live fix is a fix the next republish undoes (the summary_html trap).
    const articles = PLAN.filter((e) => e.target.kind === 'article');
    const mirrors = PLAN.filter((e) => e.target.kind === 'file');
    assert.equal(articles.length, mirrors.length);
    for (const a of articles) {
      const paired = mirrors.filter((m) => m.before === a.before && m.after === a.after);
      assert.equal(paired.length, 1, `${a.id} has no paired mirror entry`);
    }
  });

  test('a mirror path is under data/posts/<slug>/content.html and nowhere else', () => {
    for (const e of PLAN.filter((x) => x.target.kind === 'file')) {
      assert.match(e.target.path, /^data\/posts\/[a-z0-9-]+\/content\.html$/, e.id);
    }
  });

  test('the mirror slug is NOT assumed to equal the live handle', () => {
    // Verified against each mirror's own meta.json.shopify_article_id on the server.
    // aluminum-free-antiperspirant-what-it-is-does-it-work-2 (live) is mirrored at
    // data/posts/aluminum-free-antiperspirant-what-it-is-does-it-work/ — no `-2`.
    const article = PLAN.find((e) => e.id === 'cta-aluminum-free-antiperspirant');
    const mirror = PLAN.find((e) => e.id === 'mirror-aluminum-free-antiperspirant');
    assert.match(article.target.slug, /-2$/);
    assert.doesNotMatch(mirror.target.path, /-2\/content\.html$/);
  });
});

describe('antiperspirant remediation — apply semantics', () => {
  const withBefore = (e, n = 1) => `<div>prefix</div>${Array.from({ length: n }, () => e.before).join('<p>x</p>')}<div>suffix</div>`;

  test('a document holding the expected count applies', () => {
    for (const e of PLAN) {
      assert.equal(classifyBody(withBefore(e), e).action, 'apply', e.id);
    }
  });

  test('a document already rewritten reports already-applied, not drift', () => {
    for (const e of PLAN) {
      const done = withBefore(e).replaceAll(e.before, e.after);
      assert.equal(classifyBody(done, e).action, 'already-applied', e.id);
    }
  });

  test('a document that matches neither reports drift and writes nothing', () => {
    for (const e of PLAN) {
      assert.equal(classifyBody('<p>a completely different article</p>', e).action, 'drift', e.id);
    }
  });

  test('an unexpected occurrence count is drift, never a partial write', () => {
    for (const e of PLAN) {
      assert.equal(classifyBody(withBefore(e, e.expectedOccurrences + 1), e).action, 'drift', e.id);
    }
  });

  test('applying is idempotent — a second pass changes nothing', () => {
    for (const e of PLAN) {
      const once = replaceAll(withBefore(e), e.before, e.after);
      assert.equal(replaceAll(once, e.before, e.after), once, e.id);
      assert.equal(occurrences(once, e.before), 0, e.id);
      assert.equal(occurrences(once, e.after), e.expectedOccurrences, e.id);
    }
  });

  test('the rewrite is a surgical substring swap — surrounding markup survives', () => {
    for (const e of PLAN) {
      const out = replaceAll(withBefore(e), e.before, e.after);
      assert.ok(out.startsWith('<div>prefix</div>'), e.id);
      assert.ok(out.endsWith('<div>suffix</div>'), e.id);
    }
  });
});

describe('antiperspirant remediation — scope discipline', () => {
  test('no entry renames a slug, a handle or a URL', () => {
    for (const e of PLAN) {
      assert.doesNotMatch(e.before, /https?:\/\//, e.id);
      assert.doesNotMatch(e.after, /https?:\/\//, e.id);
      assert.doesNotMatch(e.before, /\/blogs\/|\/products\/|\/collections\//, e.id);
    }
  });

  test('no entry touches an article title, summary or metafield', () => {
    // Those five titles and six excerpts are category references and are the ranking
    // phrase. Only body_html is in scope, and only inside it.
    for (const e of PLAN.filter((x) => x.target.kind === 'article')) {
      assert.equal(e.target.field, 'body_html', e.id);
    }
  });

  test('caughtBy is checked against the code, not trusted as a label', () => {
    // A label claiming coverage the code does not have is the one thing a reader six
    // weeks from now will rely on this plan for, so it is verified rather than believed:
    // any label naming arm-a must actually trip findProductCategoryMisnomers, and
    // `judgement` must actually not.
    for (const e of PLAN) {
      const armAFires = findProductCategoryMisnomers(e.before).length > 0;
      assert.equal(
        armAFires,
        e.caughtBy.includes('arm-a'),
        `${e.id}: caughtBy "${e.caughtBy}" disagrees with Arm A`,
      );
    }
  });

  test('an arm-b entry is a buy-box line the injector regenerates', () => {
    // Arm B is sanitizeProductCategoryTerm inside buildCtaCopy. Claiming it for
    // anything the injector does not generate would be claiming a fix that is not there.
    for (const e of PLAN.filter((x) => x.caughtBy.includes('arm-b'))) {
      assert.ok(e.before.startsWith('Our pick for'), e.id);
      assert.ok(sanitizeProductCategoryTerm(e.before).includes('deodorant'), e.id);
      assert.doesNotMatch(sanitizeProductCategoryTerm(e.before), /antiperspirant/i, e.id);
    }
  });

  test('the buy-box entries are covered by BOTH arms — defence in depth', () => {
    // Arm B stops the generator emitting the line; Arm A blocks it if any other caller
    // ever builds that shape, or if Arm B regresses. Neither alone is the design.
    const cta = PLAN.filter((e) => e.before.startsWith('Our pick for'));
    assert.equal(cta.length, 4);
    for (const e of cta) assert.equal(e.caughtBy, 'arm-a+arm-b', e.id);
  });

  test('a judgement entry says so, and nothing prevents it recurring', () => {
    const borderline = PLAN.filter((e) => e.caughtBy === 'judgement');
    assert.ok(borderline.length > 0);
    for (const e of borderline) {
      assert.deepEqual(findProductCategoryMisnomers(e.before), [], e.id);
    }
    // The reasoning is stated once, on the ARTICLE entry; a mirror entry's `why` names
    // the file it mirrors, which is the useful thing to say about a mirror.
    const articles = borderline.filter((e) => e.target.kind === 'article');
    assert.ok(articles.length > 0);
    for (const e of articles) {
      assert.match(e.why, /BORDERLINE/, `${e.id} must say it is a judgement call`);
    }
  });

  test('at least one entry is a buy-box line — the highest-severity shape', () => {
    assert.ok(PLAN.some((e) => e.before.startsWith('Our pick for')));
  });
});

describe('antiperspirant remediation — helpers', () => {
  test('targetLabel names an article by slug, field and id', () => {
    const e = PLAN.find((x) => x.target.kind === 'article');
    assert.match(targetLabel(e.target), /body_html #\d+/);
  });

  test('targetLabel names a file by its path', () => {
    const e = PLAN.find((x) => x.target.kind === 'file');
    assert.equal(targetLabel(e.target), e.target.path);
  });

  test('backupName is filesystem-safe and unique per entry', () => {
    const names = PLAN.map(backupName);
    assert.equal(new Set(names).size, names.length);
    for (const n of names) assert.match(n, /^[a-z0-9.@_-]+$/i);
  });
});
