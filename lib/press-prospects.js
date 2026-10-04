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
  contactsByDomain, splitDomainHits, normalizeDomain, DEFAULT_COOLDOWN_DAYS, PITCHABLE_STATUSES,
} from './press-contacts.js';

const OPEN_DRAFT = new Set(['pending', 'approved']);

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * Why an existing draft stops a new one for the same domain or contact, or
 * null. Pending and approved drafts block while open. A REJECTED draft blocks
 * for DEFAULT_COOLDOWN_DAYS from its rejection (spec §4: the prospect gets a
 * 60-day cooldown and is not re-drafted); with no rejected_at, from creation.
 * A rejection with no parseable date blocks, because unknown is not "long ago".
 */
export function draftBlockReason(d, today) {
  if (!d) return null;
  if (OPEN_DRAFT.has(d.status)) return `a ${d.status} draft already exists (${d.id || 'no id'})`;
  if (d.status !== 'rejected') return null;
  const at = String(d.rejected_at || d.created_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return `a draft was rejected (${d.id || 'no id'}, date unknown)`;
  const days = daysBetween(at, today);
  if (days >= DEFAULT_COOLDOWN_DAYS) return null;
  return `a draft was rejected ${days}d ago (${d.id || 'no id'}), inside ${DEFAULT_COOLDOWN_DAYS}d cooldown`;
}

function openDraftDomains(drafts, today) {
  const map = new Map();
  for (const d of drafts || []) {
    const reason = draftBlockReason(d, today);
    if (!reason) continue;
    const fromUrl = normalizeDomain(d.target_url);
    if (fromUrl && !map.has(fromUrl)) map.set(fromUrl, reason);
    const at = typeof d.to === 'string' ? d.to.split('@')[1] : null;
    const fromTo = normalizeDomain(at);
    if (fromTo && !map.has(fromTo)) map.set(fromTo, reason);
  }
  return map;
}

/** Raw contacts per normalized domain (contactsByDomain drops `kind`). */
function rawContactsByDomain(contacts) {
  const map = new Map();
  for (const c of contacts || []) {
    for (const d of c.domains || []) {
      const key = normalizeDomain(d);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
  }
  return map;
}

export function buildProspects({
  prTargets, linkGap, contacts, existingDrafts, today, want, editorialShare = 0.7, excludeKeys = null,
}) {
  // Keys the caller has given up on (repeated failures). Dropped here, before
  // the queue is truncated to `want`, so dead rows can never crowd out live ones.
  const dead = (key) => Boolean(excludeKeys && excludeKeys.has(key));
  const skipped = [];
  const byDomain = contactsByDomain(contacts);
  const draftDomains = openDraftDomains(existingDrafts, today);

  const editorialRows = (prTargets && prTargets.pitch_targets) || [];
  const editorialDomains = new Set(editorialRows.map((r) => normalizeDomain(r.domain)).filter(Boolean));

  const raw = rawContactsByDomain(contacts);
  const seenEditorial = new Set();
  const editorial = [];
  for (const r of editorialRows) {
    const domain = normalizeDomain(r.domain);
    const drop = (reason) => skipped.push({ domain: domain || r.domain, reason });
    if (!domain) { drop('unparseable domain'); continue; }
    if (seenEditorial.has(domain)) { drop('duplicate domain'); continue; }
    seenEditorial.add(domain);
    if (!r.author || r.author_rejected) { drop('no author to pitch'); continue; }
    if (r.likely_store) { drop('likely a store, not a publisher'); continue; }
    if (r.stale_article) { drop('stale article'); continue; }
    if (r.enrich_fetch !== 'ok') { drop(`byline not verified (enrich_fetch: ${r.enrich_fetch || 'none'})`); continue; }
    const onDomain = raw.get(domain) || [];
    const author = String(r.author).trim().toLowerCase();
    const blocker = onDomain.find((c) => !PITCHABLE_STATUSES.includes(c.status)
      && String(c.name || '').trim().toLowerCase() === author)
      || onDomain.find((c) => c.kind === 'outlet' && c.status === 'do_not_contact');
    if (blocker) { drop(`contact on file: ${blocker.name} (status: ${blocker.status})`); continue; }
    const { pitched } = splitDomainHits(byDomain.get(domain));
    const recent = pitched.find((h) => daysBetween(h.last_pitched, today) < DEFAULT_COOLDOWN_DAYS);
    if (recent) {
      drop(`pitched ${daysBetween(recent.last_pitched, today)}d ago (${recent.name}), inside ${DEFAULT_COOLDOWN_DAYS}d cooldown`);
      continue;
    }
    if (draftDomains.has(domain)) { drop(`${draftDomains.get(domain)} for this domain`); continue; }
    if (dead(`pr-target:${domain}`)) { drop('excluded: repeated failed attempts'); continue; }
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

  const seenGap = new Set();
  const gap = [];
  for (const r of (linkGap && linkGap.opportunities) || []) {
    const domain = normalizeDomain(r.domain);
    const drop = (reason) => skipped.push({ domain: domain || r.domain, reason });
    if (!domain) { drop('unparseable domain'); continue; }
    if (seenGap.has(domain)) { drop('duplicate domain'); continue; }
    seenGap.add(domain);
    if (r.dofollow === false) { drop('nofollow link, no ranking value'); continue; }
    if (byDomain.has(domain)) { drop('domain already in the contact book'); continue; }
    if (editorialDomains.has(domain)) { drop('domain is in the editorial list (editorial wins)'); continue; }
    if (draftDomains.has(domain)) { drop(`${draftDomains.get(domain)} for this domain`); continue; }
    if (dead(`link-gap:${domain}`)) { drop('excluded: repeated failed attempts'); continue; }
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
