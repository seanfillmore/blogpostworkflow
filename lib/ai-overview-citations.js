/**
 * Does Google cite realskincare.com in the AI Overview for questions this store
 * already earns impressions for?
 *
 * WHY THIS IS A SECOND MEASUREMENT AND NOT A CHANGE TO AN EXISTING ONE.
 * `agents/ai-citation-tracker` reports ~2% mention (4 of 180) and that is a real
 * measurement of a DIFFERENT thing: 75 branded and category prompts run against
 * LLM APIs, at n=1 per prompt x engine cell. It cannot answer "does the Google
 * AI Overview cite us for a query we rank for", and the two answers appear to
 * diverge sharply — of 8 queries pulled ad hoc on 2026-09-06, realskincare.com
 * was a cited source in 4. Eight queries is not a rate, which is what this
 * measures. Two questions, two scripts, for the same reason sources A and B stay
 * distinct in `lib/cluster-hold.js`.
 *
 * THREE PROPERTIES OF THE LIVE API THAT DECIDE THE ARITHMETIC, each established
 * by calling it rather than by reading the docs (2026-09-06):
 *
 * 1. `domain` carries a `www.` prefix — the live value is `www.realskincare.com`.
 *    An equality test against `realskincare.com` returns zero citations forever,
 *    and a zero is exactly what this measurement is trying to rule in or out.
 * 2. References appear at BOTH the `ai_overview` item level and inside each
 *    `ai_overview_element`. On both live pulls the top-level array was the
 *    complete union, but relying on that is a guess; both are unioned.
 * 3. `asynchronous_ai_overview: true` means Google loaded the overview
 *    asynchronously. On a PLAIN request that arrives as `markdown: null`,
 *    `items: null`, `references: null` — no measurement at all, and folding it
 *    into the denominator would manufacture a false zero. Pass
 *    `load_async_ai_overview: true` on the request and the SAME item comes back
 *    with its content, flag still `true`. **So the flag is not the test.**
 *    RESOLVED means the content was delivered; a run that measured this by the
 *    flag would discard 46% of a live sample that was, in fact, readable — and
 *    the unreadable ones are not random, they are the toothpaste and long-tail
 *    questions, so discarding them biases the rate rather than thinning it.
 *
 * AND ONE PROPERTY OF THE RESULT worth stating before anyone reads a number off
 * this: on the second live probe, `realskincare.com` was cited in the AI
 * Overview for "is coconut oil a good moisturizer" while being ABSENT from the
 * organic top 10. Overview citation is not a function of organic rank, so the
 * two are recorded side by side and neither is derived from the other.
 *
 * Pure: no network, no filesystem, no env. `scripts/measure-ai-overview-citations.mjs`
 * does the calling and the writing. `lib/dataforseo.js` throws at import without
 * credentials, so pure logic living there could not be tested at all — the same
 * split that put `lib/shopify-api-version.js` in its own module.
 */

/**
 * Reduce an API `domain` (or a full URL) to a comparable host.
 *
 * `www` is the ONLY subdomain stripped. `health.clevelandclinic.org` is a
 * different host from `clevelandclinic.org` and must stay one, or the cited-
 * domain tally silently merges publishers.
 */
export function normalizeDomain(value) {
  let s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('://')) {
    try { s = new URL(s).hostname; } catch { /* fall through to the raw string */ }
  }
  s = s.replace(/\/.*$/, '').replace(/\.$/, '');
  return s.replace(/^www\./, '');
}

/**
 * Read the AI Overview out of a `/serp/google/organic/live/advanced` items array.
 *
 * Returns a record for EVERY case rather than null for the absent ones, because
 * "no overview", "an overview that did not resolve" and "an overview citing
 * nobody we care about" are three different findings and the caller has to be
 * able to count them separately.
 */
export function extractAiOverview(items) {
  const aio = (items ?? []).find((i) => i && i.type === 'ai_overview');
  if (!aio) return { present: false, asynchronous: false, resolved: false, text: '', references: [], domains: [] };

  const asynchronous = aio.asynchronous_ai_overview === true;
  // CONTENT DELIVERED, not the async flag — see (3) in the header. An overview
  // that really cites nobody arrives as an empty ARRAY and is resolved; one that
  // was never loaded arrives as `null` on all three and is not.
  const resolved = aio.items != null || aio.references != null || aio.markdown != null;

  const elements = Array.isArray(aio.items) ? aio.items : [];
  const text = elements
    .map((el) => [el?.title, el?.text].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('\n');

  // Union of both reference locations, deduped on the normalized domain+url so
  // one source cited in three elements counts once per overview.
  const raw = [
    ...(Array.isArray(aio.references) ? aio.references : []),
    ...elements.flatMap((el) => (Array.isArray(el?.references) ? el.references : [])),
  ];
  const seen = new Set();
  const references = [];
  for (const ref of raw) {
    const domain = normalizeDomain(ref?.domain || ref?.url);
    if (!domain) continue;
    const key = `${domain}|${ref?.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      domain,
      raw_domain: ref?.domain ?? null,
      source: ref?.source ?? null,
      url: ref?.url ?? null,
      title: ref?.title ?? null,
    });
  }

  const domains = [...new Set(references.map((r) => r.domain))];
  return { present: true, asynchronous, resolved, text, references, domains };
}

/** Our best organic position on this SERP, or null when we are not on it. */
export function organicRankOf(items, domain) {
  const target = normalizeDomain(domain);
  const ranks = (items ?? [])
    .filter((i) => i && i.type === 'organic' && normalizeDomain(i.domain || i.url) === target)
    .map((i) => Number(i.rank_group))
    .filter((n) => Number.isFinite(n));
  return ranks.length ? Math.min(...ranks) : null;
}

/**
 * Collapse N runs of one query into a rate with its denominator attached.
 *
 * TWO DENOMINATORS, deliberately, because they answer different questions.
 * `overview_rate` is over ALL runs — how often Google shows an overview here at
 * all. `citation_rate` is over runs that RESOLVED one — given an overview, how
 * often are we in it. Rating citations over all runs would blend "Google shows
 * no overview for this query" into "Google shows one and ignores us", and only
 * the second is a content problem we could act on.
 *
 * A rate with no denominator behind it is `null`, never 0: "measured, never
 * cited" and "never measured" must not render the same, which is the same rule
 * that makes a disarmed cluster gate say so instead of reporting a clean run.
 */
export function summarizeQueryRuns(runs, targetDomain) {
  const target = normalizeDomain(targetDomain);
  const list = runs ?? [];
  // Keyed on whether the content arrived, NOT on the async flag: with
  // `load_async_ai_overview` set, an asynchronous overview is fully readable.
  const resolved = list.filter((r) => r?.present && r?.resolved);
  const unresolved = list.filter((r) => r?.present && !r?.resolved);
  const cited = resolved.filter((r) => (r.domains ?? []).some((d) => normalizeDomain(d) === target));
  const ranks = list.map((r) => r?.organic_rank).filter((n) => Number.isFinite(n));

  return {
    runs: list.length,
    overviews_present: list.filter((r) => r?.present).length,
    overviews_resolved: resolved.length,
    overviews_unresolved: unresolved.length,
    cited_runs: cited.length,
    overview_rate: list.length ? list.filter((r) => r?.present).length / list.length : null,
    citation_rate: resolved.length ? cited.length / resolved.length : null,
    ever_cited: cited.length > 0,
    organic_rank: ranks.length ? Math.min(...ranks) : null,
  };
}

/** How many of a query's resolved overviews cited each domain. */
export function tallyCitedDomains(runs) {
  const tally = {};
  for (const run of runs ?? []) {
    if (!run?.present || run?.asynchronous) continue;
    for (const domain of new Set((run.domains ?? []).map(normalizeDomain))) {
      if (!domain) continue;
      tally[domain] = (tally[domain] ?? 0) + 1;
    }
  }
  return tally;
}

/**
 * Roll every query up into the headline numbers.
 *
 * Reported TWO ways on purpose. By query ("we are cited for 12 of 27 questions")
 * is what a human means by a citation rate; by run ("36 of 81 overviews") is the
 * honest n, and the two diverge whenever a query is cited inconsistently — which
 * is precisely the non-determinism this task exists to measure rather than
 * assume away.
 *
 * The feed's withheld classes (`competitor-fact`, `diy` — see
 * `lib/merchant-qa.js`) are broken out rather than dropped. Whether Google cites
 * us on "how to make natural moisturizer" is a real finding, but a DIY recipe
 * query is not commercial demand and must not be averaged into a rate somebody
 * will quote as a commercial one.
 */
export function summarizeReport(queries) {
  const all = queries ?? [];

  const bucket = (rows) => {
    const measurable = rows.filter((q) => (q.summary?.overviews_resolved ?? 0) > 0);
    const everCited = measurable.filter((q) => q.summary?.ever_cited);
    const totalRuns = rows.reduce((n, q) => n + (q.summary?.runs ?? 0), 0);
    const resolvedRuns = rows.reduce((n, q) => n + (q.summary?.overviews_resolved ?? 0), 0);
    const citedRuns = rows.reduce((n, q) => n + (q.summary?.cited_runs ?? 0), 0);
    return {
      queries: rows.length,
      queries_measurable: measurable.length,
      queries_ever_cited: everCited.length,
      citation_rate_by_query: measurable.length ? everCited.length / measurable.length : null,
      total_runs: totalRuns,
      resolved_runs: resolvedRuns,
      cited_runs: citedRuns,
      citation_rate_by_run: resolvedRuns ? citedRuns / resolvedRuns : null,
      overview_rate_by_run: totalRuns ? rows.reduce((n, q) => n + (q.summary?.overviews_present ?? 0), 0) / totalRuns : null,
      unresolved_runs: rows.reduce((n, q) => n + (q.summary?.overviews_unresolved ?? 0), 0),
    };
  };

  const commercialRows = all.filter((q) => !q.withheld);
  const withheldRows = all.filter((q) => q.withheld);

  const domainTotals = {};
  for (const q of all) {
    for (const [domain, n] of Object.entries(q.cited_domains ?? {})) {
      domainTotals[domain] = (domainTotals[domain] ?? 0) + n;
    }
  }
  const top_cited_domains = Object.entries(domainTotals)
    .map(([domain, overviews]) => ({ domain, overviews }))
    .sort((a, b) => b.overviews - a.overviews || a.domain.localeCompare(b.domain));

  return {
    ...bucket(all),
    top_cited_domains,
    commercial: bucket(commercialRows),
    withheld: bucket(withheldRows),
  };
}

const pct = (rate, n, d) => (rate === null || rate === undefined ? `— (n=0)` : `${(rate * 100).toFixed(1)}% (${n}/${d})`);

/** The human summary. Every rate carries its n, because a rate without one is the defect being fixed. */
export function renderMarkdown({ generated_at, target_domain, runs_per_query, report, queries, cost, notes = [] }) {
  const L = [];
  L.push(`# AI Overview citation rate — ${target_domain}`);
  L.push('');
  L.push(`Generated ${generated_at} · ${runs_per_query} run(s) per query${cost != null ? ` · DataForSEO cost $${cost.toFixed(3)}` : ''}`);
  L.push('');
  L.push('**Rates carry their denominator.** `citation_rate` is over runs that returned a');
  L.push('RESOLVED overview, not over all runs — a query where Google shows no overview was');
  L.push('never a chance to be cited. An `asynchronous_ai_overview` is excluded for the same');
  L.push('reason: its content was not delivered, so it is no measurement rather than a zero.');
  L.push('');
  L.push('## Headline');
  L.push('');
  L.push('| | commercial | withheld (diy / competitor-fact) | all |');
  L.push('|---|--:|--:|--:|');
  for (const [label, key] of [['queries', 'queries'], ['queries with an overview', 'queries_measurable'], ['queries ever citing us', 'queries_ever_cited']]) {
    L.push(`| ${label} | ${report.commercial[key]} | ${report.withheld[key]} | ${report[key]} |`);
  }
  L.push(`| **cited rate, by query** | ${pct(report.commercial.citation_rate_by_query, report.commercial.queries_ever_cited, report.commercial.queries_measurable)} | ${pct(report.withheld.citation_rate_by_query, report.withheld.queries_ever_cited, report.withheld.queries_measurable)} | ${pct(report.citation_rate_by_query, report.queries_ever_cited, report.queries_measurable)} |`);
  L.push(`| **cited rate, by run** | ${pct(report.commercial.citation_rate_by_run, report.commercial.cited_runs, report.commercial.resolved_runs)} | ${pct(report.withheld.citation_rate_by_run, report.withheld.cited_runs, report.withheld.resolved_runs)} | ${pct(report.citation_rate_by_run, report.cited_runs, report.resolved_runs)} |`);
  L.push(`| overview shown, by run | ${pct(report.commercial.overview_rate_by_run, '', '')} | ${pct(report.withheld.overview_rate_by_run, '', '')} | ${pct(report.overview_rate_by_run, '', '')} |`);
  L.push('');
  if (report.unresolved_runs) {
    L.push(`${report.unresolved_runs} run(s) returned an overview whose content did not resolve and are excluded from every citation denominator above.`);
    L.push('');
  }

  L.push('## Per query');
  L.push('');
  L.push('| question | GSC imp | cited | overview | our organic rank | withheld |');
  L.push('|---|--:|--:|--:|--:|---|');
  for (const q of queries ?? []) {
    const s = q.summary ?? {};
    L.push(`| ${q.query} | ${q.impressions ?? ''} | ${s.cited_runs ?? 0}/${s.overviews_resolved ?? 0} | ${s.overviews_present ?? 0}/${s.runs ?? 0} | ${s.organic_rank ?? '—'} | ${q.withheld ?? ''} |`);
  }
  L.push('');

  L.push('## Who else is cited');
  L.push('');
  L.push('| domain | overviews citing it |');
  L.push('|---|--:|');
  for (const d of (report.top_cited_domains ?? []).slice(0, 25)) {
    L.push(`| ${d.domain} | ${d.overviews} |`);
  }
  L.push('');

  if (notes.length) {
    L.push('## Notes');
    L.push('');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }
  return L.join('\n');
}
