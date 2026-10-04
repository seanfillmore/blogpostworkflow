/**
 * Address finder for agents/press-outreach: a writer's PUBLISHED address first,
 * Hunter.io only as a verified-only fallback.
 *
 * Free pass (in order): the author page, the article, the site's /contact,
 * /about and /contact-us, then a Tavily search. A published address is kept as
 * found. Hunter runs only when the free pass finds nothing and fewer than 80%
 * of either monthly allowance (searches, verifications) is spent, and a Hunter
 * address is kept ONLY when the verifier says `valid`. accept_all, webmail,
 * unknown and the rest are rejected: a Hunter-guessed address that bounces
 * costs sender reputation, which a published one never does.
 *
 * All I/O is injected (`fetchPage`, `tavilySearch`, `hunter`), so nothing here
 * calls a real API in tests, and API keys are never logged or returned.
 */

export const FREE_MAIL_DOMAINS = Object.freeze([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
]);

export const HUNTER_USAGE_STOP = 0.8;

const OUTLET_PREFIXES = ['editor', 'editorial', 'hello', 'contact', 'info', 'team', 'partnerships', 'pr'];
const ASSET_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'css', 'js', 'ico', 'woff', 'woff2', 'ttf', 'map']);
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

export function extractEmails(html) {
  if (!html) return [];
  let text = String(html);
  try { text = text.replace(/%40/gi, '@'); } catch { /* keep */ }
  text = text
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');
  const out = new Set();
  for (const m of text.match(EMAIL_RE) || []) {
    const e = m.toLowerCase().replace(/^[.%+-]+/, '').replace(/\.+$/, '');
    const tld = e.split('.').pop();
    if (ASSET_TLDS.has(tld)) continue;
    if (!e.includes('@')) continue;
    out.add(e);
  }
  return [...out];
}

function hostOf(email) { return email.split('@')[1] || ''; }

function nameTokens(name) {
  const t = String(name || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  return { first: t[0] || '', last: t.length > 1 ? t[t.length - 1] : '' };
}

function onDomain(host, domains) {
  return (domains || []).some((d) => host === d || host.endsWith(`.${d}`));
}

export function pickPersonalEmail(emails, { name, domains = [] } = {}) {
  const { first, last } = nameTokens(name);
  if (!first) return null;
  const hits = [];
  for (const e of emails || []) {
    const host = hostOf(e);
    const local = e.split('@')[0];
    const own = onDomain(host, domains);
    if (!own && !FREE_MAIL_DOMAINS.includes(host)) continue;
    const norm = local.replace(/[^a-z]/g, '');
    const nameHit = (first.length >= 3 && norm.includes(first))
      || (last.length >= 3 && norm.includes(last))
      || (last && norm.includes(first[0] + last));
    if (nameHit) hits.push({ e, own });
  }
  hits.sort((a, b) => Number(b.own) - Number(a.own));
  return hits[0]?.e || null;
}

export function pickOutletEmail(emails, domain) {
  const d = String(domain || '').toLowerCase();
  const own = (emails || []).filter((e) => onDomain(hostOf(e), [d]));
  for (const p of OUTLET_PREFIXES) {
    const hit = own.find((e) => e.split('@')[0] === p);
    if (hit) return hit;
  }
  return null;
}

export function hunterBudgetOk(account, stopAt = HUNTER_USAGE_STOP) {
  const r = account?.data?.requests;
  if (!r || account.errors) return false;
  for (const k of ['searches', 'verifications']) {
    const { used, available } = r[k] || {};
    if (!Number.isFinite(used) || !Number.isFinite(available) || available <= 0) return false;
    if (used / available >= stopAt) return false;
  }
  return true;
}

export function hunterClient(apiKey, fetchImpl = fetch) {
  const get = async (path, params = {}) => {
    const qs = new URLSearchParams({ ...params, api_key: apiKey });
    const res = await fetchImpl(`https://api.hunter.io/v2/${path}?${qs}`);
    return res.json();
  };
  return {
    account: () => get('account'),
    finder: ({ domain, first_name, last_name }) => get('email-finder', { domain, first_name, last_name }),
    domainSearch: (domain) => get('domain-search', { domain, limit: '10' }),
    verify: (email) => get('email-verifier', { email }),
  };
}

export function tavilyClient(apiKey, fetchImpl = fetch) {
  return async (query) => {
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
    });
    const j = await res.json();
    return j.results || [];
  };
}

function safeUrl(u) { try { return new URL(u); } catch { return null; } }

function contactUrls(origin) {
  return ['/contact', '/about', '/contact-us'].map((p) => origin + p);
}

export async function findAddress(prospect, { fetchPage, tavilySearch, hunter, budget = {}, today } = {}) {
  const editorial = prospect.source !== 'link-gap' && prospect.person?.name;
  const domain = prospect.domain;
  const domains = [domain];
  const pick = (emails) => (editorial
    ? pickPersonalEmail(emails, { name: prospect.person.name, domains })
    : pickOutletEmail(emails, domain));

  // Free pass.
  const urls = [];
  if (editorial && prospect.person.authorUrl) urls.push(prospect.person.authorUrl);
  if (prospect.targetUrl) urls.push(prospect.targetUrl);
  const origins = new Set();
  for (const u of [prospect.targetUrl, editorial ? prospect.person.authorUrl : null, domain ? `https://${domain}/` : null]) {
    const p = u && safeUrl(u);
    if (p) origins.add(p.origin);
  }
  if (!editorial) for (const o of origins) urls.push(`${o}/`);
  for (const o of origins) urls.push(...contactUrls(o));

  for (const url of [...new Set(urls)]) {
    let page;
    try { page = await fetchPage(url); } catch { continue; }
    if (!page || page.outcome !== 'ok' || !page.html) continue;
    const hit = pick(extractEmails(page.html));
    if (hit) return { address: hit, source: `published:${url}`, verified: true, spentHunter: 0 };
  }

  if (editorial && tavilySearch) {
    let results = [];
    try { results = (await tavilySearch(`"${prospect.person.name}" email ${prospect.publication || domain}`)) || []; } catch { results = []; }
    const { last } = nameTokens(prospect.person.name);
    for (const r of results) {
      const host = safeUrl(r.url)?.hostname.replace(/^www\./, '') || '';
      const ours = onDomain(host, domains) || (last.length >= 3 && host.includes(last));
      if (!ours) continue;
      const hit = pick(extractEmails(r.content));
      if (hit) return { address: hit, source: `published:${r.url}`, verified: true, spentHunter: 0 };
    }
  }

  // Hunter fallback.
  if (!hunter) return { address: null, reason: 'no published address; hunter unavailable' };
  let account;
  try { account = await hunter.account(); } catch { account = null; }
  if (!hunterBudgetOk(account, budget.hunterUsageStop ?? HUNTER_USAGE_STOP)) {
    return { address: null, reason: 'no published address; hunter budget or account unavailable' };
  }

  let spent = 0;
  let candidate = null;
  try {
    spent += 1;
    if (editorial) {
      const { first, last } = nameTokens(prospect.person.name);
      const r = await hunter.finder({ domain, first_name: first, last_name: last });
      candidate = r?.data?.email || null;
    } else {
      const r = await hunter.domainSearch(domain);
      const ranked = (r?.data?.emails || [])
        .filter((e) => e.type === 'generic' || OUTLET_PREFIXES.includes(String(e.value).split('@')[0]))
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      candidate = ranked[0]?.value || null;
    }
  } catch { candidate = null; }
  if (!candidate) return { address: null, reason: 'hunter: no address found', spentHunter: spent };

  let status = 'unknown';
  try {
    spent += 1;
    const v = await hunter.verify(candidate);
    status = v?.data?.status || 'unknown';
  } catch { status = 'unknown'; }
  if (status !== 'valid') return { address: null, reason: `hunter: ${status}`, spentHunter: spent };
  const day = today || new Date().toISOString().slice(0, 10);
  return { address: candidate.toLowerCase(), source: `hunter:verified:${day}`, verified: true, spentHunter: spent };
}
