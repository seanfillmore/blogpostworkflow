/**
 * Prospect queue for agents/press-outreach: which outlets to draft a pitch for
 * today, from the two existing target lists (pr-target-finder's editorial
 * `pitch_targets[]` and the backlink gap's `opportunities[]`).
 *
 * Pure: callers load the files. Every drop is recorded in `skipped` with a
 * reason, so a short queue is never a mystery. Editorial rows win over link-gap
 * rows for the same domain, because an editorial row names a person to pitch.
 */
import {
  contactsByDomain, splitDomainHits, normalizeDomain, DEFAULT_COOLDOWN_DAYS,
} from './press-contacts.js';

const OPEN_DRAFT = new Set(['pending', 'approved']);

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function openDraftDomains(drafts) {
  const set = new Set();
  for (const d of drafts || []) {
    if (!OPEN_DRAFT.has(d.status)) continue;
    const fromUrl = normalizeDomain(d.target_url);
    if (fromUrl) set.add(fromUrl);
    const at = typeof d.to === 'string' ? d.to.split('@')[1] : null;
    const fromTo = normalizeDomain(at);
    if (fromTo) set.add(fromTo);
  }
  return set;
}

export function buildProspects({
  prTargets, linkGap, contacts, existingDrafts, today, want, editorialShare = 0.7,
}) {
  const skipped = [];
  const byDomain = contactsByDomain(contacts);
  const draftDomains = openDraftDomains(existingDrafts);

  const editorialRows = (prTargets && prTargets.pitch_targets) || [];
  const editorialDomains = new Set(editorialRows.map((r) => normalizeDomain(r.domain)).filter(Boolean));

  const editorial = [];
  for (const r of editorialRows) {
    const domain = normalizeDomain(r.domain);
    const drop = (reason) => skipped.push({ domain: domain || r.domain, reason });
    if (!domain) { drop('unparseable domain'); continue; }
    if (!r.author || r.author_rejected) { drop('no author to pitch'); continue; }
    if (r.likely_store) { drop('likely a store, not a publisher'); continue; }
    if (r.stale_article) { drop('stale article'); continue; }
    if (r.enrich_fetch !== 'ok') { drop(`byline not verified (enrich_fetch: ${r.enrich_fetch || 'none'})`); continue; }
    const { pitched } = splitDomainHits(byDomain.get(domain));
    const recent = pitched.find((h) => daysBetween(h.last_pitched, today) < DEFAULT_COOLDOWN_DAYS);
    if (recent) {
      drop(`pitched ${daysBetween(recent.last_pitched, today)}d ago (${recent.name}), inside ${DEFAULT_COOLDOWN_DAYS}d cooldown`);
      continue;
    }
    if (draftDomains.has(domain)) { drop('a pending or approved draft already exists for this domain'); continue; }
    editorial.push({
      key: `pr-target:${domain}`,
      source: 'pr-target',
      domain,
      targetUrl: r.pitch_url || r.top_url || null,
      person: { name: r.author, authorUrl: r.author_url || null },
      publication: r.publication || null,
      competitors: r.competitors || [],
      prompts: r.prompts || [],
      angle: r.angle || null,
      rank: r.score ?? null,
    });
  }

  const gap = [];
  for (const r of (linkGap && linkGap.opportunities) || []) {
    const domain = normalizeDomain(r.domain);
    const drop = (reason) => skipped.push({ domain: domain || r.domain, reason });
    if (!domain) { drop('unparseable domain'); continue; }
    if (r.dofollow === false) { drop('nofollow link, no ranking value'); continue; }
    if (byDomain.has(domain)) { drop('domain already in the contact book'); continue; }
    if (editorialDomains.has(domain)) { drop('domain is in the editorial list (editorial wins)'); continue; }
    if (draftDomains.has(domain)) { drop('a pending or approved draft already exists for this domain'); continue; }
    gap.push({
      key: `link-gap:${domain}`,
      source: 'link-gap',
      domain,
      targetUrl: `https://${domain}/`,
      person: null,
      publication: null,
      competitors: r.competitors || [],
      prompts: [],
      angle: null,
      rank: r.rank ?? null,
    });
  }

  const n = Math.max(0, Math.floor(want) || 0);
  const edTarget = Math.min(n, Math.ceil(n * editorialShare));
  const edTake = Math.min(editorial.length, edTarget);
  const gapTake = Math.min(gap.length, n - edTake);
  // Fill any remaining shortfall on the gap side from leftover editorial rows.
  const edFinal = Math.min(editorial.length, n - gapTake);
  const prospects = [...editorial.slice(0, edFinal), ...gap.slice(0, gapTake)];
  return { prospects, skipped };
}
