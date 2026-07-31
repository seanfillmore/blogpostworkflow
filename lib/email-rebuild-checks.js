/**
 * Link checks for Klaviyo email rebuilds.
 *
 * Split out from scripts/verify-email-rebuild.mjs because a redesign and a restyle
 * disagree about what "no link is lost" means:
 *
 *   - A RESTYLE preserves copy, so it must preserve every link too. Any drop is a defect.
 *   - A REDESIGN is governed by data/brand/email-format-matrix.md, which mandates one ask
 *     per objective and at most two destinations. Several live templates carry 10-11
 *     links, so a correct redesign *deliberately* drops most of them. Failing that would
 *     push the rebuild toward keeping all 11 — the opposite of the rule.
 *
 * What no mode may drop is the compliance set: unsubscribe (CAN-SPAM), preference
 * management, and policy pages.
 */

const COMPLIANCE = /unsubscribe|manage_preferences|preferences_?center|\/policies\/|privacy|terms/i;

export const linksIn = (s) =>
  [...new Set([...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))].sort();

export const tagsIn = (s) => (s.match(/\{%[^%]*%\}|\{\{[^}]*\}\}/g) ?? []).sort();

// {% unsubscribe %} and {% unsubscribe_link %} are the same destination — swapping the
// former for the latter is the documented repair, not a dropped tag or link.
const canonical = (s) => s.replace(/\{%\s*unsubscribe(_link)?\s*%\}/, '{% unsubscribe %}');

export function tagFindings(before, after) {
  const problems = [];
  const afterTags = tagsIn(after).map(canonical);
  const lost = tagsIn(before).filter((t) => !afterTags.includes(canonical(t)));
  if (lost.length) problems.push(`Klaviyo tags dropped: ${lost.join(', ')}`);
  return { problems };
}

export function classifyLinks(hrefs) {
  const compliance = [];
  const marketing = [];
  for (const h of hrefs) (COMPLIANCE.test(h) ? compliance : marketing).push(h);
  return { compliance, marketing };
}

/**
 * `{% unsubscribe %}` expands to a complete <a> element, not a URL. Inside an href it
 * nests an anchor within an attribute, so the browser closes the outer tag early and the
 * rest of the footer markup leaks into the email as visible text. Klaviyo's tag for the
 * bare URL is `{% unsubscribe_link %}`.
 *
 * All 22 live RSC templates shipped with the wrong one, so this is inherited breakage
 * rather than something a rebuild introduced — but no rebuild should carry it forward.
 *
 * https://help.klaviyo.com/hc/en-us/articles/115006054267
 */
export function unsubscribeFindings(html) {
  const problems = [];
  if (/href="\{%\s*unsubscribe\s*%\}"/.test(html)) {
    problems.push(
      'href="{% unsubscribe %}" renders an <a> inside an attribute and leaks raw markup — use {% unsubscribe_link %}',
    );
  }
  return { problems };
}

export function linkFindings(before, after, { redesign = false } = {}) {
  const problems = [];
  const warnings = [];

  const afterLinks = linksIn(after).map(canonical);
  const lost = linksIn(before).filter((l) => !afterLinks.includes(canonical(l)));
  const { compliance, marketing } = classifyLinks(lost);

  if (compliance.length) {
    problems.push(`compliance links dropped (CAN-SPAM): ${compliance.join(', ')}`);
  }

  if (marketing.length) {
    if (redesign) {
      warnings.push(`links dropped (redesign — confirm intended): ${marketing.join(', ')}`);
    } else {
      problems.push(`links dropped: ${marketing.join(', ')}`);
    }
  }

  return { problems, warnings };
}
