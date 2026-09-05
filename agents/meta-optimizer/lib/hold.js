/**
 * $0-cluster hold for meta-optimizer's candidate pick list.
 *
 * Split out of index.js for the same reason lib/sort.js and lib/grounding.js
 * are: that index calls loadEnv() and can process.exit at import time, so a pure
 * selector living there is not testable.
 *
 * WHY THIS AGENT NEEDED GATING. Its weekly cron is `--apply --limit 5`, and the
 * cap is spent in `sortByValidation` order — Amazon-validated first, then by
 * impressions. On the real 2026-08-23 pool that put FOUR of the five slots in
 * the one held cluster and left the site's biggest CTR opportunity fifth, only
 * just inside the cap. The hold therefore has to be applied to the pick list
 * BEFORE the cap, exactly as blocked-post-resolver does, or held candidates go
 * on eating an earning cluster's budget while being "skipped".
 *
 * WHAT IS DELIBERATELY NOT GATED: `runRefreshStaleYears`. A hold pauses
 * unattended LLM/refresh spend; that pass makes no model call, and leaving
 * "2025" in the title of a live indexed page degrades the page — which a hold
 * is explicitly not allowed to do.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { partitionHeld } from '../../../lib/cluster-hold.js';
import { orderByEfficiency } from '../../../lib/cluster-efficiency.js';
import { handleFromUrl } from '../../../lib/posts.js';

/**
 * Split low-CTR candidates into what runs and what is held.
 *
 * Clustering is attempted on the QUERY first, because that is what seo-impact
 * attributes revenue on, then on the page the rewrite would land on — a query
 * like "best options for 2026" names no cluster while its page plainly does.
 *
 * THE EFFICIENCY RANKING RIDES ALONG, in the same place and for the same reason.
 * The hold answers WHETHER a query may be spent on and fires almost never now
 * that every category RSC sells, sells; the ranking answers which five of the
 * ~20 survivors the weekly cap actually reaches. On the 2026-08-23 pool the cap
 * is spent in `sortByValidation` order, which is blind to what a cluster earns —
 * the same defect the hold fixed for $0 clusters, one step milder. It DEMOTES,
 * it never drops: `orderByEfficiency` reserves the last in-cap slot for the
 * lowest-ranked cluster present, and a run with no usable ranking returns the
 * candidate list in exactly the order `sortByValidation` built it.
 *
 * @param {Array<{keyword:string}>} candidates
 * @param {object} hold from loadClusterHold/buildClusterHold
 * @param {{includeHeld?:boolean, pageForKeyword?:(kw:string)=>string|null,
 *          ranking?:object, limit?:number|null}} opts
 * @returns {{kept:Array, held:Array, overridden:Array, efficiency:object|null}}
 */
export function holdMetaCandidates(candidates, hold, {
  includeHeld = false, pageForKeyword = () => null, ranking = null, limit = null,
} = {}) {
  const describe = (c) => {
    const url = pageForKeyword(c?.keyword) || null;
    // `slug` is what dedupeHeld collapses on, so several held queries that
    // point at one page count as one held page in the digest — the number an
    // operator reads as "how much is this hold withholding".
    return { keyword: c?.keyword, url, slug: url ? handleFromUrl(url) : null };
  };
  const out = partitionHeld(candidates, hold, { includeHeld, describe });
  if (!ranking) return { ...out, efficiency: null };
  const efficiency = orderByEfficiency(out.kept, ranking, { limit, describe });
  return { ...out, kept: efficiency.items, efficiency };
}

/**
 * THE OTHER DO-NOT-TOUCH LIST: the CTR program's holdout cohort.
 *
 * `agents/ctr-program` splits the ranked pages into a treatment arm it wants
 * rewritten and a matched HOLDOUT arm that must not be, because the holdout is
 * the only thing that separates "the rewrite worked" from "the whole blog corpus
 * drifted upward again". Blog-wide CTR went 0.166% → 0.505% across six
 * consecutive 28-day blocks ending 2026-08-21 with nobody touching most of those
 * pages; without a control, every one of those blocks looks like a win.
 *
 * A single rewritten holdout page does not degrade the measurement a little — it
 * removes the control for the whole wave, and there is no way to reconstruct it
 * afterwards. So this filter runs on the pick list alongside the cluster hold,
 * before the cap, and it FAILS OPEN: no wave file, an unreadable wave file, or a
 * wave with no holdout means no exclusions, exactly as before this existed. A
 * planner that has not run must not be able to stop the optimiser working.
 *
 * @param {Array<{keyword:string}>} candidates
 * @param {{root:string, pageForKeyword?:(kw:string)=>string|null}} opts
 * @returns {{kept:Array, excluded:Array<{keyword:string, url:string}>}}
 */
export function excludeHoldout(candidates, { root, pageForKeyword = () => null } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  let holdout = [];
  try {
    const p = join(root ?? '.', 'data', 'reports', 'ctr-program', 'wave.json');
    if (!existsSync(p)) return { kept: list, excluded: [] };
    const wave = JSON.parse(readFileSync(p, 'utf8'));
    holdout = Array.isArray(wave?.holdout) ? wave.holdout : [];
  } catch {
    return { kept: list, excluded: [] };
  }
  if (holdout.length === 0) return { kept: list, excluded: [] };

  // Match on the article handle, not the full URL: the wave is built from GSC
  // page rows (www host) and candidates resolve through the blog index, which
  // has been known to carry the myshopify host. Comparing whole URLs would
  // silently match nothing, which is the failure mode that looks like success.
  const handles = new Set(holdout.map((h) => String(h?.url || '').split('/').pop()).filter(Boolean));

  const kept = []; const excluded = [];
  for (const c of list) {
    const url = pageForKeyword(c?.keyword) || null;
    const handle = url ? String(url).split('/').pop() : null;
    if (handle && handles.has(handle)) excluded.push({ keyword: c?.keyword, url });
    else kept.push(c);
  }
  return { kept, excluded };
}

/**
 * THE OTHER HALF OF THE WAVE, AND IT WAS MISSING ENTIRELY.
 *
 * `excludeHoldout` above enforces what must NOT be rewritten. Nothing enforced
 * what must BE rewritten — `wave.treatment` was read by no code anywhere, even
 * though `writeWave`'s own comment calls the two lists "what to rewrite, and
 * what it must refuse to rewrite".
 *
 * Measured on production 2026-09-05 against the wave planned 2026-08-31: of the
 * five weekly slots, two went to the `individual` pages (correct — those take
 * the ordinary per-page path), two went to pages the wave had explicitly
 * DEFERRED, and exactly ONE landed in the treatment arm. **1 of 10.**
 *
 * That was structural, not bad luck. Candidates come from `gsc-opportunity`'s
 * top-20 low-CTR QUERIES; the wave designates PAGES. Only 1 of the 10 treatment
 * pages was reachable from that list at all, so no amount of reordering could
 * have treated the arm — which is why this also SYNTHESISES a candidate for a
 * designated page that has no query in the list. 9 of the 10 sit in the
 * quick-win pool the optimiser already fetches; they just never survive into
 * the top-20.
 *
 * ORDERING: designated work goes FIRST, ahead of the cluster-efficiency sort.
 * That is not a bypass of the efficiency rule — `agents/ctr-program` built the
 * treatment arm with `lib/ctr-opportunity.js`, which ranks by recoverable
 * clicks × what the cluster earns, reusing `lib/cluster-efficiency.js`'s own
 * ordinals. The arm is ALREADY efficiency-ordered. Re-sorting it by cluster a
 * second time is what displaced it out of the cap.
 *
 * `individual` is prioritised alongside `treatment` because those pages are the
 * wave's other half — powered enough to test alone, so they take the ordinary
 * per-page A/B path. Both are the program's work; everything else is filler.
 *
 * FAILS OPEN, exactly like `excludeHoldout`: no wave file, an unreadable one,
 * or an empty treatment arm leaves the list exactly as it came in. A planner
 * that has not run must never stop the optimiser working.
 *
 * @param {Array<{keyword:string}>} candidates already holdout-filtered
 * @param {object} opts
 * @param {string} opts.root
 * @param {(kw:string)=>string|null} opts.pageForKeyword
 * @param {Array<{keyword:string,url:string,impressions?:number,ctr?:number}>} [opts.pool]
 *   the quick-win pool, used to synthesise a candidate for a designated page
 *   that no candidate query points at.
 * @returns {{ordered:Array, designated:Array<{keyword:string,url:string,arm:string,synthesised:boolean}>}}
 */
export function prioritiseTreatment(candidates, { root, pageForKeyword = () => null, pool = [] } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  let wave = null;
  try {
    const p = join(root ?? '.', 'data', 'reports', 'ctr-program', 'wave.json');
    if (!existsSync(p)) return { ordered: list, designated: [] };
    wave = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { ordered: list, designated: [] };
  }

  const handle = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
  // Order matters: the wave lists treatment in its own ranked order, and
  // `individual` pages are the highest-traffic pages on the site, so they lead.
  const designatedOrder = [];
  const armOf = new Map();
  for (const [arm, key] of [['individual', 'individual'], ['treatment', 'treatment']]) {
    for (const p of Array.isArray(wave?.[key]) ? wave[key] : []) {
      const h = handle(p?.url);
      if (!h || armOf.has(h)) continue;
      armOf.set(h, arm);
      designatedOrder.push(h);
    }
  }
  if (designatedOrder.length === 0) return { ordered: list, designated: [] };

  // ONE CANDIDATE PER PAGE. The cap is a budget of PAGES — a rewrite mutates a
  // page, not a query — and this list is QUERIES, several of which routinely
  // land on the same page. Simulated against the live wave, `toothpaste-without-
  // sls-what-to-know-best-options` took TWO of the five slots, halving the
  // wave's weekly throughput for no second effect. Keep the page's biggest
  // query, the same rule the synthesis below uses.
  const rank = new Map(designatedOrder.map((h, i) => [h, i]));
  const bestForPage = new Map();
  const rest = [];
  const dupes = [];
  for (const c of list) {
    const h = handle(pageForKeyword(c?.keyword));
    if (!h || !rank.has(h)) { rest.push(c); continue; }
    const prev = bestForPage.get(h);
    if (!prev) { bestForPage.set(h, c); continue; }
    // The loser is DEMOTED TO THE VERY END, not merely behind its twin: sitting
    // next in line it still lands inside a cap of five, which is the whole
    // defect. It is never DROPPED, though — the page it points at is being
    // rewritten anyway, and this repo does not make candidates disappear.
    if ((c?.impressions ?? 0) > (prev?.impressions ?? 0)) { bestForPage.set(h, c); dupes.push(prev); }
    else dupes.push(c);
  }
  const covered = new Set(bestForPage.keys());
  const first = [...bestForPage.values()]
    .sort((a, b) => rank.get(handle(pageForKeyword(a.keyword))) - rank.get(handle(pageForKeyword(b.keyword))));

  // Synthesise a candidate for each designated page no query reached. Pick the
  // page's highest-impression query from the pool: that is the query most of
  // its traffic is actually earned on, so the rewrite is judged against the
  // demand it really has rather than a long-tail phrase.
  const synthetic = [];
  const byHandle = new Map();
  for (const row of Array.isArray(pool) ? pool : []) {
    const h = handle(row?.url);
    if (!h || !rank.has(h) || covered.has(h)) continue;
    const prev = byHandle.get(h);
    if (!prev || (row?.impressions ?? 0) > (prev.impressions ?? 0)) byHandle.set(h, row);
  }
  // A synthesised candidate must not reuse a keyword an existing candidate
  // already carries: the A/B tracker keys on keyword, and two rows sharing one
  // are indistinguishable in it. The page still gets treated on a later wave
  // through its own next-biggest query.
  const usedKeywords = new Set(list.map((c) => c?.keyword).filter(Boolean));
  for (const h of designatedOrder) {
    const row = byHandle.get(h);
    if (!row || usedKeywords.has(row.keyword)) continue;
    usedKeywords.add(row.keyword);
    synthetic.push({ ...row, from_wave: armOf.get(h) });
  }

  const ordered = [...first, ...synthetic, ...rest, ...dupes];
  const designated = [...first.map((c) => ({ keyword: c.keyword, url: pageForKeyword(c.keyword), synthesised: false })),
    ...synthetic.map((c) => ({ keyword: c.keyword, url: c.url, synthesised: true }))]
    .map((d) => ({ ...d, arm: armOf.get(handle(d.url)) || 'unknown' }));

  return { ordered, designated };
}
