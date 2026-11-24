// lib/culina-reviews.js
//
// Pure summary of Culina review topics for the monthly report. Input is
// fetchReviewTopics' output; `previous` is last month's saved summary, used to mark
// complaint snippets that are new since then. No I/O.

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// The report forbids em dashes; a customer's dash is shown as a plain hyphen.
const clean = (s) => String(s || '').replace(/[—–]/g, '-').trim();

/**
 * @returns {{ complaints, repeated, praise, asinsWithTopics, asinsFailed }}
 *   complaints: [{ topic, label, asin, mentions, snippets, newSnippets }] most mentions first
 *   repeated:   [{ topic, labels }] complaint topics on 2+ listings (a product or packaging fault, not one listing)
 *   praise:     [{ topic, mentions, listings, snippet }] top positive themes across all listings
 */
export function summarizeReviews(byAsin = {}, labelOf = (a) => a, previous = null) {
  const seen = new Set((previous?.complaints || []).flatMap((c) => (c.snippets || []).map(norm)));
  const complaints = [];
  const praiseMap = new Map();
  const asinsFailed = [];
  let asinsWithTopics = 0;
  for (const [asin, r] of Object.entries(byAsin)) {
    if (r?.error) { asinsFailed.push(asin); continue; }
    if ((r?.negative || []).length || (r?.positive || []).length) asinsWithTopics++;
    for (const t of r?.negative || []) {
      const snippets = t.snippets.map(clean);
      complaints.push({ topic: t.topic, label: labelOf(asin), asin, mentions: t.mentions, snippets,
        newSnippets: previous ? snippets.filter((s) => !seen.has(norm(s))) : [] });
    }
    for (const t of r?.positive || []) {
      const p = praiseMap.get(t.topic) || { topic: t.topic, mentions: 0, listings: 0, snippet: null };
      p.mentions += t.mentions; p.listings += 1; p.snippet ||= clean(t.snippets[0]) || null;
      praiseMap.set(t.topic, p);
    }
  }
  complaints.sort((a, b) => b.mentions - a.mentions || a.topic.localeCompare(b.topic));
  const byTopic = new Map();
  for (const c of complaints) byTopic.set(c.topic, [...(byTopic.get(c.topic) || []), c.label]);
  const repeated = [...byTopic].filter(([, labels]) => new Set(labels).size >= 2)
    .map(([topic, labels]) => ({ topic, labels: [...new Set(labels)] }));
  const praise = [...praiseMap.values()].sort((a, b) => b.mentions - a.mentions || b.listings - a.listings).slice(0, 5);
  return { complaints, repeated, praise, asinsWithTopics, asinsFailed };
}
