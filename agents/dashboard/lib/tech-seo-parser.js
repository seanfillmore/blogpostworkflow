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

  const sectionRegex = /###\s*(?:🔴|🟡|⚠️?)\s*(.+?)\s*\((\d+)\)/g;
  let match;
  while ((match = sectionRegex.exec(markdown)) !== null) {
    const name = match[1].trim();
    const count = parseInt(match[2], 10);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const isError = match[0].includes('🔴');
    const severity = isError ? 'error' : 'warning';

    const afterHeader = markdown.slice(match.index + match[0].length);
    const nextSection = afterHeader.search(/\n###\s/);
    const sectionText = nextSection > 0 ? afterHeader.slice(0, nextSection) : afterHeader.slice(0, 2000);

    const rows = [...sectionText.matchAll(/^\|(.+)\|$/gm)]
      .map(m => m[1].split('|').map(c => c.trim()))
      .filter(cols => cols.length >= 1 && !cols[0].includes('---'));
    const items = rows.slice(1).map(cols => ({ url: cols[0] || '', detail: cols.slice(1).join(' | ') })).slice(0, 10);

    categories[slug] = { name, count, severity, items };
    if (severity === 'error') totalErrors += count;
    else totalWarnings += count;
  }

  return { generated_at, summary: { errors: totalErrors, warnings: totalWarnings }, categories };
}
