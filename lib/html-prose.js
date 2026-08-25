/**
 * Prose regions of an HTML body — "where is it safe to rewrite text?"
 *
 * This exists because `agents/internal-linker` answered that question with a
 * regex over the whole `body_html` string and a backwards `lastIndexOf` scan of
 * the preceding 300 characters. That is not a parse, and it silently rewrote
 * text inside `<script type="application/ld+json">` blocks: the injected markup
 * carries unescaped double quotes, which land inside a JSON *string value* and
 * stop the block parsing. Measured live 2026-08-24, 30 of 183 blog article
 * pages carried at least one unparseable JSON-LD block for exactly that reason.
 *
 * The guard here is POSITIVE and structural, not a patched regex: a single
 * left-to-right scan marks every region that is NOT prose, and a replacement is
 * allowed only when its whole span falls outside all of them. A region the
 * scanner does not understand stays protected rather than becoming writable —
 * an unclosed `<script>` protects the rest of the document, an unterminated
 * comment likewise. The failure direction is "we declined to insert a link",
 * never "we corrupted a live page".
 *
 * Off limits, always:
 *   - HTML comments               `<!-- … -->`
 *   - doctype / processing instr. `<!… >`, `<?… >`
 *   - tag markup itself           `<p class="x">`  (so attribute values are safe)
 *   - raw-text element contents   `<script>…</script>`, `<style>…</style>`
 *
 * Off limits by request (`opaqueElements`), meaning the element's CONTENT is
 * not a place to insert anything, even though it is visible prose:
 *   - `a`  — never nest an anchor inside an anchor
 *   - `h1`–`h6` — an internal link does not belong in a heading
 *
 * Pure: no I/O, no config, no model calls.
 */

/** Elements whose content the HTML spec parses as raw text, never as markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/**
 * The default off-limits *contents* for an internal-link style rewrite.
 * `a` is a correctness rule (nested anchors are invalid HTML); the headings are
 * the editorial rule the linker's own prompt already states.
 */
export const DEFAULT_OPAQUE_ELEMENTS = ['a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/** Index just past the `>` that closes the tag starting at `start`. */
function findTagEnd(html, start) {
  let i = start + 1;
  let quote = null;
  while (i < html.length) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i + 1;
    }
    i++;
  }
  return html.length; // unterminated tag — everything after it is protected
}

/** Index of the `<` opening `</name`, searching from `from`; length if absent. */
function findRawTextClose(html, from, name) {
  const re = new RegExp(`</${name}[\\s/>]`, 'i');
  const m = re.exec(html.slice(from));
  return m ? from + m.index : html.length;
}

function normalizeRanges(ranges, length) {
  const kept = ranges
    .filter(([s, e]) => e > s && s < length)
    .map(([s, e]) => [Math.max(0, s), Math.min(length, e)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of kept) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * Every `[start, end)` span of `html` that must not be rewritten.
 * Merged and sorted ascending; spans never overlap.
 */
export function protectedRanges(html, { opaqueElements = DEFAULT_OPAQUE_ELEMENTS } = {}) {
  if (typeof html !== 'string' || html === '') return [];
  const opaque = new Set(opaqueElements.map((s) => s.toLowerCase()));
  const ranges = [];
  const n = html.length;

  // At most one opaque element is tracked at a time. `a` and `h1`–`h6` cannot
  // legally contain themselves, and anything nested inside the tracked element
  // is already covered by its span, so a stack buys nothing.
  let open = null; // { name, contentStart, depth }

  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      const end = close === -1 ? n : close + 3;
      ranges.push([lt, end]);
      i = end;
      continue;
    }

    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = findTagEnd(html, lt);
      ranges.push([lt, end]);
      i = end;
      continue;
    }

    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(html.slice(lt, lt + 80));
    if (!m) {
      // A bare `<` in prose (`a < b`). Not markup; step over it.
      i = lt + 1;
      continue;
    }

    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const tagEnd = findTagEnd(html, lt);
    ranges.push([lt, tagEnd]); // the tag markup itself, attribute values included

    if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
      // Raw text: the content is never markup and never prose. An unclosed
      // <script> protects everything after it, which is the safe direction.
      const close = findRawTextClose(html, tagEnd, name);
      ranges.push([tagEnd, close]);
      i = close;
      continue;
    }

    const selfClosing = html[tagEnd - 2] === '/';
    if (!closing && !selfClosing) {
      if (open && open.name === name) open.depth++;
      else if (!open && opaque.has(name)) open = { name, contentStart: tagEnd, depth: 1 };
    } else if (closing && open && open.name === name) {
      open.depth--;
      if (open.depth === 0) {
        ranges.push([open.contentStart, lt]);
        open = null;
      }
    }

    i = tagEnd;
  }

  // An unclosed opaque element protects the rest of the document.
  if (open) ranges.push([open.contentStart, n]);

  return normalizeRanges(ranges, n);
}

/** True when `[start, end)` lies entirely outside every protected span. */
export function isProse(ranges, start, end) {
  for (const [s, e] of ranges) {
    if (start < e && end > s) return false;
    if (s >= end) break; // ranges are sorted; nothing further can overlap
  }
  return true;
}

/**
 * Replace the FIRST match of `pattern` that falls entirely inside prose.
 *
 * `pattern` is used case-insensitively and globally regardless of its own
 * flags, so the caller cannot accidentally hand over a sticky or single-shot
 * regex. `build(match)` receives the match array and returns the replacement
 * text, which is inserted verbatim — no `$1` expansion, so a replacement can
 * never be re-interpreted as a substitution pattern.
 *
 * Returns `{ html, applied, index }`. When nothing matched in prose the input
 * string is returned unchanged and `applied` is false.
 */
export function replaceFirstInProse(html, pattern, build, opts = {}) {
  if (typeof html !== 'string' || html === '') return { html, applied: false, index: -1 };
  const ranges = protectedRanges(html, opts);
  const flags = pattern.flags.replace(/[gy]/g, '') + 'g';
  const re = new RegExp(pattern.source, flags);

  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    const start = m.index;
    const end = start + m[0].length;
    if (!isProse(ranges, start, end)) continue;
    const replacement = build(m);
    return {
      html: html.slice(0, start) + replacement + html.slice(end),
      applied: true,
      index: start,
    };
  }
  return { html, applied: false, index: -1 };
}
