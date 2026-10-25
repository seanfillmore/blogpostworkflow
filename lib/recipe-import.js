// lib/recipe-import.js
// Read a recipe card (schema.org Recipe JSON-LD) from a web page a dish-contest
// competitor pasted, so they do not have to retype their ingredients and steps.
//
// Two halves:
//   extractRecipe(html)   pure parser, no I/O.
//   fetchRecipePage(url)  the server-side fetch. It runs inside the shared, public
//                         seo-dashboard process, on a URL a stranger typed, so it is
//                         the part that has to be right:
//     - http/https only, default ports only, no credentials in the URL;
//     - DNS is resolved HERE and every answer must be a public address (no
//       loopback, private, link-local, CGNAT, multicast, reserved, or IPv4-mapped /
//       NAT64 forms of those). One bad answer refuses the whole name;
//     - the socket is pinned to the validated addresses through a custom `lookup`,
//       so a second DNS answer (rebinding) can never be what we connect to;
//     - every redirect hop goes through the same checks again;
//     - one deadline covers DNS, connect, headers and body;
//     - the body is capped in bytes AFTER decompression (a gzip bomb is too_large).
//
// The address and port checks are injectable (`isAllowedAddress`, `isAllowedPort`)
// only so the tests can reach a loopback test server. Production callers pass
// neither, and the dashboard route passes nothing but the URL.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { promises as dns } from 'node:dns';

export class RecipeImportError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RecipeImportError';
    this.code = code;
  }
}

// ---- text cleaning ----------------------------------------------------------------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  frac12: '½', frac14: '¼', frac34: '¾', frac13: '⅓', frac23: '⅔', frac15: '⅕', frac16: '⅙', frac18: '⅛',
  frac38: '⅜', frac58: '⅝', frac78: '⅞', deg: '°', times: '×', divide: '÷', middot: '·', bull: '•',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å', ccedil: 'ç', iacute: 'í', icirc: 'î',
  iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ocirc: 'ô', ouml: 'ö', otilde: 'õ', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  szlig: 'ß', Eacute: 'É', Ntilde: 'Ñ', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä', frasl: '⁄', minus: '−', shy: '',
};

function decodeOnce(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : whole;
  });
}

/** Decode entities; twice when the first pass left an entity behind (double-encoded `&amp;#39;`). */
export function decodeEntities(s) {
  const once = decodeOnce(String(s));
  return /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/i.test(once) ? decodeOnce(once) : once;
}

const MAX_TEXT = 2000;

/** One line of display text: tags stripped, entities decoded, whitespace collapsed. */
function cleanText(v) {
  if (v == null || typeof v === 'object') return '';
  const s = String(v).replace(/<[^>]*>/g, ' ');
  return decodeEntities(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

/** Several lines: HTML line/block breaks and real newlines split, each cleaned, empties dropped. */
function cleanLines(v) {
  if (v == null || typeof v === 'object') return [];
  return String(v)
    .replace(/<br\s*\/?>|<\/?(?:p|li|div|h[1-6]|tr|ol|ul)\b[^>]*>/gi, '\n')
    .split(/\r?\n|\r/)
    .map(cleanText)
    .filter(Boolean);
}

// ---- JSON-LD ----------------------------------------------------------------------

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LD_TYPE_RE = /\btype\s*=\s*["']?\s*application\/ld\+json/i;

function parseLdBlock(text) {
  const body = text
    .replace(/(?:\/\/[ \t]*|\/\*\s*)?<!\[CDATA\[(?:\s*\*\/)?/g, '')
    .replace(/(?:\/\/[ \t]*|\/\*\s*)?\]\]>(?:\s*\*\/)?/g, '')
    .replace(/<!--|-->/g, '')
    .trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    try {
      // Raw newlines/tabs inside strings are common on hand-built blocks.
      // eslint-disable-next-line no-control-regex
      return JSON.parse(body.replace(/[\u0000-\u001f]+/g, ' '));
    } catch {
      return undefined;
    }
  }
}

function typesOf(node) {
  const t = node && node['@type'];
  if (Array.isArray(t)) return t.map(String);
  return t == null ? [] : [String(t)];
}

const MAX_NODES = 20_000;

/** Depth-first walk over every object in a parsed JSON-LD value, in document order. */
function* objectsIn(root) {
  const stack = [[root, 0]];
  const seen = new Set();
  let visited = 0;
  while (stack.length && visited < MAX_NODES) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 16) continue;
    seen.add(node);
    visited += 1;
    const kids = Array.isArray(node) ? node : Object.values(node);
    if (!Array.isArray(node)) yield node;
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      if (kids[i] && typeof kids[i] === 'object') stack.push([kids[i], depth + 1]);
    }
  }
}

/** ISO 8601 duration (PT6H10M, P0DT1H, PT370M) → whole minutes, else null. Years/months are not durations a recipe means. */
export function parseDurationMinutes(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m || !/\d/.test(v)) return null;
  const [, w, d, h, min, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  const total = w * 7 * 1440 + d * 1440 + h * 60 + min + s / 60;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.max(1, Math.round(total));
}

const MAX_ITEMS = 200;

function collectSteps(node, out, headings, depth = 0) {
  if (node == null || depth > 8 || out.length >= MAX_ITEMS) return;
  if (typeof node === 'string' || typeof node === 'number') {
    for (const line of cleanLines(node)) if (out.length < MAX_ITEMS) out.push(line);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectSteps(item, out, headings, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const types = typesOf(node);
  const isSection = types.includes('HowToSection') || (node.itemListElement != null && node.text == null);
  if (isSection) {
    const heading = cleanText(node.name);
    if (heading) {
      headings.push(out.length);
      out.push(/[:.!?]$/.test(heading) ? heading : `${heading}:`);
    }
    collectSteps(node.itemListElement, out, headings, depth + 1);
    return;
  }
  const text = typeof node.text === 'string' && node.text.trim() ? node.text : node.name;
  collectSteps(typeof text === 'string' ? text : null, out, headings, depth + 1);
}

/**
 * First useful yield string. WP Recipe Maker emits ["2", "2 dozen"]: when the first is a
 * bare number and a later entry spells out that same number with a unit, the unit wins,
 * because "Serves 2" for two dozen cookies would be wrong.
 */
function firstYield(v) {
  const list = (Array.isArray(v) ? v : [v])
    .map((item) => (typeof item === 'number' && Number.isFinite(item) ? String(item) : cleanText(item)))
    .filter(Boolean);
  if (!list.length) return null;
  const first = list[0];
  if (/^\d+$/.test(first)) {
    const spelled = list.find((t) => t.startsWith(`${first} `) && /[a-z]/i.test(t));
    if (spelled) return spelled.slice(0, 80);
  }
  return first.slice(0, 80);
}

function metaSiteName(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/\bproperty\s*=\s*["']?og:site_name\b/i.test(tag)) continue;
    const m = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const name = m && cleanText(m[1] ?? m[2] ?? m[3]);
    if (name) return name.slice(0, 80);
  }
  return null;
}

/**
 * Pull the first schema.org Recipe out of a page's JSON-LD.
 * @returns {{name:string, ingredients:string[], steps:string[], headings:number[], recipeYield:string|null,
 *   totalMinutes:number|null, siteName:string|null} | null}
 *   `headings` lists the indexes in `steps` that are section headings ("For the brine:"), not steps.
 */
export function extractRecipe(html) {
  if (typeof html !== 'string' || !html) return null;
  const parsed = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (!LD_TYPE_RE.test(m[1])) continue;
    const value = parseLdBlock(m[2]);
    if (value !== undefined) parsed.push(value);
  }
  let recipe = null;
  let siteName = null;
  for (const value of parsed) {
    for (const node of objectsIn(value)) {
      const types = typesOf(node);
      if (!recipe && types.includes('Recipe')) recipe = node;
      if (!siteName && (types.includes('WebSite') || types.includes('Organization'))) {
        const n = cleanText(node.name);
        if (n) siteName = n.slice(0, 80);
      }
    }
  }
  if (!recipe) return null;

  const rawIngredients = recipe.recipeIngredient ?? recipe.ingredients;
  const ingredients = (Array.isArray(rawIngredients) ? rawIngredients : rawIngredients == null ? [] : [rawIngredients])
    .flatMap((v) => (typeof v === 'string' && /\n|<br/i.test(v) ? cleanLines(v) : [cleanText(v)]))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

  const steps = [];
  const headings = [];
  collectSteps(recipe.recipeInstructions, steps, headings);
  const realSteps = steps.length - headings.length;
  if (!ingredients.length && realSteps <= 0) return null;

  let totalMinutes = parseDurationMinutes(recipe.totalTime);
  if (totalMinutes == null) {
    const prep = parseDurationMinutes(recipe.prepTime) || 0;
    const cook = parseDurationMinutes(recipe.cookTime) || 0;
    totalMinutes = prep + cook > 0 ? prep + cook : null;
  }

  return {
    name: cleanText(Array.isArray(recipe.name) ? recipe.name[0] : recipe.name).slice(0, 200),
    ingredients,
    steps,
    headings,
    recipeYield: firstYield(recipe.recipeYield ?? recipe.yield),
    totalMinutes,
    siteName: siteName || metaSiteName(html),
  };
}

// ---- address guard ------------------------------------------------------------------

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), size: 2 ** (32 - bits) }));

function isPublicV4Int(n) {
  if (n == null) return false;
  return !V4_BLOCKED.some(({ base, size }) => n >= base && n < base + size);
}

/** Expand an IPv6 address to 8 numbers (an embedded dotted IPv4 tail is folded in), else null. */
function expandIPv6(ip) {
  let s = ip;
  const tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const n = ipv4ToInt(tail[1]);
    if (n == null) return null;
    s = `${s.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest];
  const out = [];
  for (const h of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    out.push(parseInt(h, 16));
  }
  return out;
}

/** True only for a globally routable unicast address. Anything unparsable is NOT public. */
export function isPublicAddress(address) {
  if (typeof address !== 'string') return false;
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = net.isIP(ip);
  if (kind === 4) return isPublicV4Int(ipv4ToInt(ip));
  if (kind !== 6) return false;
  const h = expandIPv6(ip.toLowerCase());
  if (!h) return false;
  const v4At = (i) => h[i] * 65536 + h[i + 1];
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 well-known prefix (64:ff9b::/96): judge the IPv4.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPublicV4Int(v4At(6));
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPublicV4Int(v4At(6));
  // 6to4 (2002::/16) embeds an IPv4 in hextets 1-2.
  if (h[0] === 0x2002) return isPublicV4Int(v4At(1));
  // Only global unicast 2000::/3 is reachable on the internet; that excludes ::, ::1, IPv4-compatible,
  // fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64 and 64:ff9b:1::/48 in one test.
  if ((h[0] & 0xe000) !== 0x2000) return false;
  if (h[0] === 0x2001 && h[1] < 0x0200) return false; // 2001::/23 IETF special purpose (Teredo, ORCHID, ...)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // documentation
  return true;
}

const isDefaultPort = (port) => port === '';

// ---- fetch ---------------------------------------------------------------------------

// The User-Agent is an honest "compatible" crawler string, NOT an impersonated browser,
// and that is measured rather than polite. On 2026-10-25, from Node's TLS stack, a Chrome,
// Safari or Firefox UA was answered with a Cloudflare challenge (403) by all six recipe
// sites tried (dinneratthezoo, allrecipes, simplyrecipes, budgetbytes, sallysbakingaddiction,
// foodnetwork): a browser UA on a non-browser TLS fingerprint is exactly what bot rules
// look for. This string got a 200 from four of the six; the two Dotdash Meredith sites
// refuse every non-browser client and fall to the "couldn't open that page" message.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; DishContestRecipeImport/1.0; +https://vote.realskincare.com/contest/enter)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_URL_LENGTH = 2048;

/** Parse and statically check one URL. Throws bad_url / blocked_url. */
function parseTarget(raw, { isAllowedAddress, isAllowedPort }) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_URL_LENGTH) throw new RecipeImportError('bad_url');
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new RecipeImportError('bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RecipeImportError('bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new RecipeImportError('bad_url');
  if (u.username || u.password) throw new RecipeImportError('blocked_url');
  if (!isAllowedPort(u.port)) throw new RecipeImportError('blocked_url');
  const family = net.isIP(host);
  if (family && !isAllowedAddress(host)) throw new RecipeImportError('blocked_url');
  return { url: u, host, literal: family ? { address: host, family } : null };
}

const defaultLookup = (host) => dns.lookup(host, { all: true, verbatim: true });

/** Resolve a hostname and insist every answer is allowed; one bad answer refuses the name. */
async function resolveAllowed(target, lookup, isAllowedAddress) {
  if (target.literal) return [target.literal];
  let answers;
  try {
    answers = await lookup(target.host);
  } catch (err) {
    if (err instanceof RecipeImportError) throw err;
    throw new RecipeImportError('unreachable');
  }
  const list = (Array.isArray(answers) ? answers : [answers])
    .filter((a) => a && typeof a.address === 'string')
    .map((a) => ({ address: a.address, family: a.family === 6 || net.isIPv6(a.address) ? 6 : 4 }));
  if (!list.length) throw new RecipeImportError('unreachable');
  if (!list.every((a) => isAllowedAddress(a.address))) throw new RecipeImportError('blocked_url');
  return list;
}

function decoderFor(encoding) {
  const e = String(encoding || '').trim().toLowerCase();
  if (!e || e === 'identity') return null;
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return undefined; // unknown: refuse
}

/** One HTTP exchange against pre-validated addresses. Resolves {redirect} or {html}. */
function requestOnce(target, addresses, { signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const fail = (code) => done(reject, new RecipeImportError(signal.aborted ? 'timeout' : code));

    // The ONLY addresses this socket may use are the ones we validated.
    const pinnedLookup = (hostname, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      const opts = typeof options === 'object' && options ? options : {};
      if (opts.all) return callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return callback(null, addresses[0].address, addresses[0].family);
    };

    const { url } = target;
    const mod = url.protocol === 'https:' ? https : http;
    let req;
    try {
      req = mod.request({
        protocol: url.protocol,
        hostname: target.host,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname || '/'}${url.search || ''}`,
        method: 'GET',
        headers: HEADERS,
        agent: false,
        lookup: pinnedLookup,
        signal,
        maxHeaderSize: 32 * 1024,
      });
    } catch {
      return fail('unreachable');
    }

    req.on('error', () => fail('unreachable'));
    req.on('response', (res) => {
      // Settle FIRST: destroying emits 'error'/'aborted', which must not win the race.
      const stop = (code) => {
        fail(code);
        res.destroy();
        req.destroy();
      };
      const status = res.statusCode || 0;
      if (REDIRECTS.has(status) && res.headers.location) {
        done(resolve, { redirect: String(res.headers.location) });
        res.destroy();
        req.destroy();
        return undefined;
      }
      if (status < 200 || status >= 300) return stop('http_error');
      if (!/html/i.test(String(res.headers['content-type'] || ''))) return stop('not_html');
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) return stop('too_large');
      const decoder = decoderFor(res.headers['content-encoding']);
      if (decoder === undefined) return stop('not_html');

      const chunks = [];
      let raw = 0;
      let size = 0;
      const collect = (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          stop('too_large');
          if (decoder) decoder.destroy();
          return undefined;
        }
        return chunks.push(chunk);
      };
      const finish = () => done(resolve, { html: new TextDecoder('utf-8').decode(Buffer.concat(chunks)) });

      res.on('data', (chunk) => {
        raw += chunk.length;
        if (raw > maxBytes) {
          stop('too_large');
          if (decoder) decoder.destroy();
          return undefined;
        }
        if (decoder) return decoder.write(chunk);
        return collect(chunk);
      });
      res.on('error', () => fail('unreachable'));
      res.on('aborted', () => fail('unreachable'));
      if (decoder) {
        decoder.on('data', collect);
        decoder.on('error', () => stop('unreachable'));
        decoder.on('end', finish);
        res.on('end', () => decoder.end());
      } else {
        res.on('end', finish);
      }
      return undefined;
    });
    req.end();
  });
}

/**
 * Fetch a page for recipe import, safely. See the file header for the guarantees.
 * @returns {Promise<{html: string, finalUrl: string}>}
 * @throws {RecipeImportError} bad_url | blocked_url | unreachable | timeout | not_html | too_large | http_error
 */
export async function fetchRecipePage(url, {
  timeoutMs = 8000,
  maxBytes = 3_000_000,
  maxRedirects = 3,
  lookup = defaultLookup,
  isAllowedAddress = isPublicAddress,
  isAllowedPort = isDefaultPort,
} = {}) {
  const guard = { isAllowedAddress, isAllowedPort };
  let target = parseTarget(url, guard); // before any timer, so a bad URL costs nothing

  const controller = new AbortController();
  const { signal } = controller;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new RecipeImportError('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const race = (p) => Promise.race([p, aborted]);

  try {
    for (let hop = 0; ; hop += 1) {
      const addresses = await race(resolveAllowed(target, lookup, isAllowedAddress));
      const out = await race(requestOnce(target, addresses, { signal, maxBytes }));
      if (out.html !== undefined) return { html: out.html, finalUrl: target.url.href };
      if (hop >= maxRedirects) throw new RecipeImportError('unreachable');
      let next;
      try {
        next = new URL(out.redirect, target.url).href;
      } catch {
        throw new RecipeImportError('unreachable');
      }
      target = parseTarget(next, guard);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    if (!signal.aborted) controller.abort(); // tear down anything still open
  }
}

/** Fetch + extract. Throws RecipeImportError('no_recipe') when the page has no usable recipe card. */
export async function importRecipeFromUrl(url, opts = {}) {
  const { html } = await fetchRecipePage(url, opts);
  const recipe = extractRecipe(html);
  if (!recipe) throw new RecipeImportError('no_recipe');
  return recipe;
}
