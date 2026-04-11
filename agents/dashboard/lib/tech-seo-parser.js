// agents/dashboard/lib/tech-seo-parser.js
/**
 * Parse the technical SEO markdown audit report into structured data
 * for the dashboard Technical SEO tab.
 */

export function parseTechSeoReport(markdown) {
  if (!markdown) return null;

  const dateMatch = markdown.match(/\*\*(?:Generated|Run date|Date):\*\*\s*(.+)/i);
  const generated_at = dateMatch ? dateMatch[1].trim() : null;

  const categories = {};
  let totalErrors = 0;
  let totalWarnings = 0;

  // Determine which section (error vs warning) each ### heading falls under
  // by tracking the last ## heading seen
  let currentSeverity = 'warning';
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track ## section headers for severity
    if (/^##\s.*🔴|^##\s.*Error/i.test(line)) { currentSeverity = 'error'; continue; }
    if (/^##\s.*🟡|^##\s.*Warning/i.test(line)) { currentSeverity = 'warning'; continue; }

    // Match ### subsection headers — format: "### N. Category Name — N items/pages"
    const subMatch = line.match(/^###\s*\d+\.\s*(.+?)\s*—\s*(\d+)\s/);
    if (!subMatch) continue;

    const name = subMatch[1].trim();
    const count = parseInt(subMatch[2], 10);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    // Collect items from the section content (until next ### or ##)
    const items = [];
    for (let j = i + 1; j < lines.length && items.length < 10; j++) {
      if (/^##/.test(lines[j])) break;

      // Table rows: | col1 | col2 | ... |
      const tableMatch = lines[j].match(/^\|\s*(.+)\s*\|$/);
      if (tableMatch && !lines[j].includes('---') && !lines[j].includes('PR') && !lines[j].includes('URL')) {
        const cols = tableMatch[1].split('|').map(c => c.trim());
        // Skip the numeric PR column if present — use second column as URL
        const url = cols.find(c => c.startsWith('http') || c.startsWith('/')) || cols[0] || '';
        items.push({ url, detail: cols.filter(c => c !== url).join(' | ') });
      }

      // List items: - URL or - [title](URL)
      const listMatch = lines[j].match(/^-\s+(?:\[.+?\]\()?(https?:\/\/[^\s)]+)/);
      if (listMatch) {
        items.push({ url: listMatch[1], detail: '' });
      }
    }

    categories[slug] = { name, count, severity: currentSeverity, items };
    if (currentSeverity === 'error') totalErrors += count;
    else totalWarnings += count;
  }

  return { generated_at, summary: { errors: totalErrors, warnings: totalWarnings }, categories };
}
