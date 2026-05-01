/**
 * Replaces stale year references (2020 through current year - 1) with the
 * current year. Leaves the current year, future years, and pre-2020 years
 * (historical references) untouched.
 *
 * Uses \b boundaries so "year" embedded in a longer digit run (e.g. phone
 * numbers) is not matched.
 *
 * Returns { text, changed } — `changed` is true if any replacement happened.
 */
export function refreshStaleYears(input) {
  if (!input) return { text: '', changed: false };
  const currentYear = new Date().getFullYear();
  const minYear = 2020;
  let changed = false;
  let text = input.replace(/\b(20\d{2})\b/g, (match, yearStr) => {
    const year = parseInt(yearStr, 10);
    if (year >= minYear && year < currentYear) {
      changed = true;
      return String(currentYear);
    }
    return match;
  });
  // Collapse adjacent duplicate years separated by whitespace, e.g. "2026 2026"
  // becomes "2026". Defends against historical corruption from producers that
  // appended the year to fields that already contained one. Doesn't touch
  // ranges like "2024–2026" or differently-spaced "2025/2026".
  const dedupRegex = /\b(20\d{2})\s+\1\b/g;
  if (dedupRegex.test(text)) {
    text = text.replace(/\b(20\d{2})\s+\1\b/g, '$1');
    changed = true;
  }
  return { text, changed };
}
