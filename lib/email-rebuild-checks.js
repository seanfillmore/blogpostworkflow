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

export function classifyLinks(hrefs) {
  const compliance = [];
  const marketing = [];
  for (const h of hrefs) (COMPLIANCE.test(h) ? compliance : marketing).push(h);
  return { compliance, marketing };
}

export function linkFindings(before, after, { redesign = false } = {}) {
  const problems = [];
  const warnings = [];

  const afterLinks = linksIn(after);
  const lost = linksIn(before).filter((l) => !afterLinks.includes(l));
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
