/**
 * Parse the case list Travis emails for a Culina inbound shipment.
 *
 * Input is already-unquoted text (lib/hushmail.js rows carry stripQuoted text).
 * Lines starting with ">" are never shipment lines, so a quote that slipped
 * past stripQuoted cannot book.
 *
 * Any line that looks like a shipment (a number plus the word case/cases) but
 * does not parse cleanly makes the whole message 'invalid': nothing is booked
 * from a message we only half understand.
 */

const LINE_RE =
  /^\s*(.+?)\s*\(\s*(\d+)\s*cases?\s*(?:[-–—]|x)?\s*(\d+)\s*(?:units?|unis)\s*\)\s*$/i;

const normName = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function findSku(name, skus) {
  const n = normName(name);
  return skus.find((s) => s.key === n || (s.aliases || []).includes(n));
}

export function parseShipmentEmail(text, skus) {
  const lines = [];
  const problems = [];
  let looksLikeShipment = false;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('>')) continue;
    if (!(/\bcases?\b/i.test(line) && /\d/.test(line))) continue;
    looksLikeShipment = true;

    const m = LINE_RE.exec(line);
    if (!m) {
      problems.push({ raw: line, reason: 'line does not match "<pack> (<n> cases - <m> units)"' });
      continue;
    }
    const sku = findSku(m[1], skus);
    if (!sku) {
      problems.push({ raw: line, reason: `unknown pack "${m[1].trim()}"` });
      continue;
    }
    const cases = Number(m[2]);
    const units = Number(m[3]);
    if (cases < 1) {
      problems.push({ raw: line, reason: 'case count must be at least 1' });
      continue;
    }
    if (cases * sku.units_per_case !== units) {
      problems.push({
        raw: line,
        reason: `unit mismatch for ${sku.key}: ${cases} cases x ${sku.units_per_case} = ${cases * sku.units_per_case}, email says ${units}`,
      });
      continue;
    }
    lines.push({
      key: sku.key, sku: sku.sku, asin: sku.asin,
      cases, units, unitsPerCase: sku.units_per_case, raw: line,
    });
  }

  if (!looksLikeShipment) return { kind: 'none', lines: [], problems: [] };
  if (problems.length) return { kind: 'invalid', lines: [], problems };
  return { kind: 'shipment', lines, problems: [] };
}

export function linesSignature(lines) {
  return lines.map((l) => `${l.sku}:${l.cases}`).sort().join('|');
}
