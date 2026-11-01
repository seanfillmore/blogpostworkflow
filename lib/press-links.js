/**
 * Earned-link and mention detection for press outreach, plus the weekly funnel.
 *
 * Pure except for the injected fetcher: nothing here touches the network, the
 * disk or the contact book on its own. agents/press-outreach (--check-links)
 * supplies `fetchPage` (lib/fetch-pool.js's fetchWithOutcome), the lock and the
 * book writes.
 *
 * A page we could not READ (blocked, timeout, rate limit) is never evidence that
 * a link is absent: only outcome 'ok' is judged, and everything else is counted
 * so the digest can say "N pages not checked" instead of "no link found".
 */
import { runPool, hostGroup, tallyOutcomes } from './fetch-pool.js';
import { lastPitch, normalizeDomain, updatePitch } from './press-contacts.js';

export const OUR_DOMAIN = 'realskincare.com';
export const OUR_BRAND = 'Real Skin Care';
export const LINK_CANDIDATE_OUTCOMES = Object.freeze(['replied', 'samples-sent', 'sample-accepted', 'escalated', 'placed']);
export const CANDIDATE_WINDOW_DAYS = 120;
export const ARTICLE_LINKS_PER_AUTHOR_PAGE = 10;
const DAY = 86_400_000;

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decode(m[1] ?? m[2] ?? m[3]) : null;
};
const hostOf = (href, base = null) => {
  try { return new URL(href, base || undefined).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};

/**
 * Does this page link to us, and does it merely mention us?
 * Linked = an anchor whose href host is exactly the domain or its www form
 * (notrealskincare.com is not ours). Not dofollow when rel has nofollow,
 * sponsored or ugc. A mention is the brand name, case-insensitive, outside our
 * own links and outside script/style.
 */
export function findOurPresence(html, { domain = OUR_DOMAIN, brand = OUR_BRAND } = {}) {
  const page = String(html || '');
  const ours = normalizeDomain(domain);
  let linked = false;
  let dofollow = null;
  let href = null;
  for (const m of page.matchAll(ANCHOR)) {
    const h = attr(m[1], 'href');
    if (!h || hostOf(h) !== ours || !/^(https?:)?\/\//i.test(h.trim())) continue;
    const rel = String(attr(m[1], 'rel') || '').toLowerCase().split(/\s+/);
    const follow = !rel.some((r) => ['nofollow', 'sponsored', 'ugc'].includes(r));
    // The first link found names the href; a later dofollow one upgrades the verdict.
    if (!linked) { linked = true; href = h.trim(); dofollow = follow; } else if (follow && !dofollow) { dofollow = true; href = h.trim(); }
  }
  const prose = page
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(ANCHOR, (all, attrs, inner) => {
      const h = attr(attrs, 'href');
      return h && hostOf(h) === ours ? ' ' : inner;
    })
    .replace(/<[^>]*>/g, ' ');
  // The brand match is case-sensitive on purpose ("real skin care" in lower case is the
  // phrase, not the brand). The routine/regimen/tips exclusion is NOT: a title-case
  // "The Real Skin Care Routine" is still the phrase.
  const words = String(brand).trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const mentioned = new RegExp(`(?<![A-Za-z0-9])${words}(?![A-Za-z0-9])(?!\\s+(?:[Rr]outines?|[Rr]egimens?|[Tt]ips)\\b)`).test(decode(prose));
  return { linked, dofollow, href, mentioned };
}

/** Same-domain article links from an author page, in page order, at most `limit`, never the page itself. */
export function articleLinks(html, pageUrl, limit = ARTICLE_LINKS_PER_AUTHOR_PAGE) {
  const pageHost = hostOf(pageUrl);
  const self = (() => { try { const u = new URL(pageUrl); return u.origin + u.pathname.replace(/\/$/, ''); } catch { return null; } })();
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(ANCHOR)) {
    const h = attr(m[1], 'href');
    if (!h || /^(#|mailto:|javascript:|tel:)/i.test(h.trim())) continue;
    let u;
    try { u = new URL(h, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.toLowerCase().replace(/^www\./, '') !== pageHost) continue;
    const clean = u.origin + u.pathname.replace(/\/$/, '');
    // A bare section or the home page is navigation, not an article.
    if (clean === self || u.pathname.split('/').filter(Boolean).length < 2 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(u.origin + u.pathname + u.search);
    if (out.length >= limit) break;
  }
  return out;
}

const touchMs = (p) => Date.parse(p.last_sent_at || `${p.date}T00:00:00Z`);

/**
 * Pitches worth checking for a link: the writer engaged (replied through placed),
 * the last touch is within 120 days, and no link is recorded yet. `authorUrlOf`
 * (contact, pitch) may supply an author page the book does not hold.
 * @returns {{contact: object, pitch: object, urls: string[]}[]}
 */
export function linkCandidates(contacts, nowMs, { authorUrlOf = null } = {}) {
  const out = [];
  for (const contact of contacts || []) {
    const pitch = lastPitch(contact);
    if (!pitch || !LINK_CANDIDATE_OUTCOMES.includes(pitch.outcome) || pitch.link_earned) continue;
    const t = touchMs(pitch);
    if (!Number.isFinite(t) || nowMs - t > CANDIDATE_WINDOW_DAYS * DAY) continue;
    // An author page is only followed on the contact's own outlet domain (or a subdomain of it).
    const ownHost = (u) => {
      const h = hostOf(u);
      return Boolean(h) && (contact.domains || []).some((d) => { const n = normalizeDomain(d); return n && (h === n || h.endsWith(`.${n}`)); });
    };
    const authors = [contact.author_url, authorUrlOf?.(contact, pitch)].filter((u) => typeof u === 'string' && ownHost(u));
    const urls = [...new Set([pitch.target_url, ...authors].filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))];
    if (urls.length) out.push({ contact, pitch, urls });
  }
  return out;
}

/** Counts for the digest's funnel line, over the last 28 days and all time. */
export function funnel(contacts, drafts, nowMs) {
  const since = nowMs - 28 * DAY;
  const within = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= since; };
  const mk = () => ({ drafted: 0, approved: 0, sent: 0, replied: 0, samples: 0, links: 0, mentions: 0 });
  const all = mk();
  const recent = mk();
  const bump = (key, ts) => { all[key] += 1; if (ts && within(ts)) recent[key] += 1; };
  for (const d of drafts || []) {
    if (d.kind && d.kind !== 'pitch') continue;
    bump('drafted', d.created_at);
    if (d.approved_at) bump('approved', d.approved_at);
    if (d.status === 'sent') bump('sent', d.sent_at);
  }
  for (const c of contacts || []) {
    for (const p of c.pitches || []) {
      const ts = p.last_sent_at || `${p.date}T00:00:00Z`;
      if (['replied', 'samples-sent', 'sample-accepted', 'escalated', 'placed', 'declined'].includes(p.outcome)) bump('replied', ts);
      if (p.sample_order || ['samples-sent', 'sample-accepted'].includes(p.outcome)) bump('samples', ts);
      if (p.link_earned) bump('links', p.link_earned.found_at);
      if (p.mention_earned) bump('mentions', p.mention_earned.found_at);
    }
  }
  return { last28: recent, allTime: all };
}

export function renderFunnel(f) {
  const line = (label, x) => `${label}: ${x.drafted} drafted · ${x.approved} approved · ${x.sent} sent · ${x.replied} replied · ${x.samples} samples · ${x.links} links · ${x.mentions} mentions`;
  return [line('Last 28 days', f.last28), line('All time', f.allTime)].join('\n');
}

/** referringDomains change between the two newest backlink snapshots, or null. Context only. */
export function referringDomainsChange(snapshots) {
  const rows = (snapshots || []).filter((s) => Number.isFinite(s?.referringDomains)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (rows.length < 2) return null;
  const [prev, cur] = rows.slice(-2);
  return { from: prev.referringDomains, to: cur.referringDomains, delta: cur.referringDomains - prev.referringDomains, prevDate: prev.date, date: cur.date };
}

/**
 * Write findings onto a book, judged against THAT book's pitches: the weekly
 * check fetches against a snapshot without the lock, then applies to a fresh
 * re-read under it. A finding is applied only while the contact's latest pitch
 * is still the one checked (same date) and still wants it: a link only when
 * none is recorded and the outcome is still a link candidate; a mention only
 * when neither a link nor a mention is recorded. A sample in flight keeps its
 * stage so tracking and the check-in still run; anything else becomes placed.
 * @returns {{book: object, applied: object[], dropped: {finding: object, reason: string}[]}}
 */
export function applyLinkFindings(book, found) {
  let next = book;
  const applied = [];
  const dropped = [];
  for (const f of found || []) {
    const contact = (next.contacts || []).find((c) => c.id === f.id);
    const pitch = contact && lastPitch(contact);
    const drop = (reason) => dropped.push({ finding: f, reason });
    if (!pitch) { drop('contact or pitch no longer in the book'); continue; }
    if (f.pitch_date && pitch.date !== f.pitch_date) { drop('a newer pitch was recorded since the check'); continue; }
    if (f.kind === 'link') {
      if (pitch.link_earned) { drop('link already recorded'); continue; }
      if (!LINK_CANDIDATE_OUTCOMES.includes(pitch.outcome)) { drop(`outcome is now ${pitch.outcome}`); continue; }
      const keep = ['sample-accepted', 'samples-sent'].includes(pitch.outcome);
      const link = { url: f.url, found_at: f.found_at, dofollow: f.dofollow };
      next = updatePitch(next, f.id, { link_earned: link, ...(keep ? {} : { outcome: 'placed' }) });
    } else {
      if (pitch.link_earned || pitch.mention_earned) { drop('coverage already recorded'); continue; }
      next = updatePitch(next, f.id, { mention_earned: { url: f.url, found_at: f.found_at } });
    }
    applied.push(f);
  }
  return { book: next, applied, dropped };
}

/**
 * Check every candidate. Fetches candidate URLs, then up to 10 recent article
 * links from each author page, through the pool (6 wide, 1 per host).
 * Returns the updated book, what was found, and the outcome tally.
 */
export async function checkLinks({ book, nowMs, fetchPage, authorUrlOf = null, concurrency = 6, perHost = 1, domain = OUR_DOMAIN, brand = OUR_BRAND }) {
  const candidates = linkCandidates(book.contacts, nowMs, { authorUrlOf });
  const outcomes = [];
  const found = [];
  if (!candidates.length) return { book, candidates, found, outcomes, tally: {} };
  const fetchAll = async (urls) => {
    const res = await runPool(urls, async (u) => fetchPage(u), { concurrency, perHost, keyOf: (u) => hostGroup(u) });
    return res.map((r) => { const o = r?.error ? { outcome: 'network-error', html: null } : r; outcomes.push(o.outcome); return o; });
  };
  const jobs = [...new Set(candidates.flatMap((c) => c.urls))];
  const pages = new Map();
  (await fetchAll(jobs)).forEach((r, i) => pages.set(jobs[i], r));
  // Author pages (any candidate URL that is not the pitched article) lead to the outlet's recent articles.
  const extra = new Map();
  for (const c of candidates) {
    const authorPages = c.urls.filter((u) => u !== c.pitch.target_url);
    for (const u of authorPages) {
      const p = pages.get(u);
      if (p?.outcome === 'ok') for (const l of articleLinks(p.html, u)) if (!pages.has(l)) extra.set(l, true);
    }
  }
  const extraUrls = [...extra.keys()];
  if (extraUrls.length) (await fetchAll(extraUrls)).forEach((r, i) => pages.set(extraUrls[i], r));

  const stamp = new Date(nowMs).toISOString();
  for (const c of candidates) {
    const toCheck = [...c.urls];
    for (const u of c.urls.filter((x) => x !== c.pitch.target_url)) {
      const p = pages.get(u);
      if (p?.outcome === 'ok') toCheck.push(...articleLinks(p.html, u));
    }
    let link = null;
    let mention = null;
    for (const url of [...new Set(toCheck)]) {
      const p = pages.get(url);
      if (p?.outcome !== 'ok') continue;
      const pres = findOurPresence(p.html, { domain, brand });
      if (pres.linked && (!link || (pres.dofollow && !link.dofollow))) link = { url, found_at: stamp, dofollow: pres.dofollow };
      else if (pres.mentioned && !pres.linked && !mention) mention = { url, found_at: stamp };
    }
    // pitch_date names WHICH pitch the finding belongs to, so applying it to a
    // re-read book can refuse a pitch that changed in between.
    const who = { id: c.contact.id, name: c.contact.name, pitch_date: c.pitch.date };
    if (link) found.push({ ...who, kind: 'link', ...link });
    else if (mention && !c.pitch.mention_earned) found.push({ ...who, kind: 'mention', ...mention });
  }
  const { book: next } = applyLinkFindings(book, found);
  return { book: next, candidates, found, outcomes, tally: tallyOutcomes(outcomes) };
}
