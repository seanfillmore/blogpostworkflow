// lib/internal-link-validation.js
//
// "Is this internal link OK?" — reconciling two checks that disagreed.
//
// The editor runs a LIVE link-health check with `redirect: 'follow'`, which
// correctly reports a 301→200 as healthy. It then ran a SEPARATE sitemap
// membership test that knew nothing about redirects, so a link the first check
// had just proved good was reported as "URL not in sitemap".
//
// That is not academic. The 62→5 collection cleanup left **1,001 links to
// retired collection handles across 162 of 181 live articles** — and they all
// 301 to real destinations (`/collections/natural-bar-soap` →
// `/products/coconut-soap`, `/collections/natural-toothpaste` →
// `/products/coconut-oil-toothpaste`). The buy paths work. But the membership
// test flagged every one, which is what produced **12 of the 17 merge holds** on
// 2026-08-23: the merges were fine and the links resolved, yet the editor held
// them anyway, permanently, because nothing about a legacy handle ever changes.
//
// So: a link the live check proved reachable is NOT a broken link. It may still
// be worth tidying (a redirect hop costs a little equity and latency) — that is
// reported as ADVISORY, which never blocks.

/** Index live link results by href → result. */
export function indexLinkResults(linkResults) {
  const byHref = new Map();
  for (const r of linkResults || []) {
    const href = r?.link?.href ?? r?.href;
    if (href) byHref.set(href, r);
  }
  return byHref;
}

/**
 * Did the live check prove this URL reachable?
 * `ok` already encodes the editor's own tolerances (2xx, plus 403/405 as
 * bot-blocked-but-real). An unpublished-post allowance is deliberately NOT
 * treated as reachable here — that is a scheduling judgement, not evidence the
 * URL resolves today.
 */
export function isLiveReachable(result) {
  if (!result) return false;
  if (result.unpublished) return false;
  return result.ok === true;
}

/**
 * Split internal-link problems into blocking issues and advisory notes.
 *
 * @param {object} args
 * @param {Array} args.candidates  links that failed the sitemap/blog-index test,
 *                                 each `{ type, link }`
 * @param {Map}   args.byHref      from indexLinkResults()
 * @returns {{issues: Array, advisories: Array}}
 *   `issues`     — genuinely unresolvable; these block.
 *   `advisories` — resolve via redirect; reported, never blocking.
 */
export function partitionInternalLinkIssues({ candidates, byHref }) {
  const issues = [];
  const advisories = [];
  for (const c of candidates || []) {
    const href = c?.link?.href;
    if (href && isLiveReachable(byHref?.get(href))) {
      advisories.push({ ...c, reason: 'resolves via redirect to a live page' });
      continue;
    }
    issues.push(c);
  }
  return { issues, advisories };
}
