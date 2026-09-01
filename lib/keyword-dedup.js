
import { isRejected as sharedIsRejected } from './rejected-keywords.js';// lib/keyword-dedup.js
// Pure dedup helpers shared by the pipeline-prioritizer (and available to any
// agent that injects calendar ideas). Extracted so injection dedup is unit-tested
// in one place rather than re-implemented per agent.

export function slugify(keyword) {
  return String(keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * @param {string} keyword
 * @param {Array<{keyword:string, matchType?:string}>} rejections
 */
// One rule, in lib/rejected-keywords.js. This was a local copy; there were NINE,
// and three of them disagreed about what `exact` means.
export function isRejected(keyword, rejections) {
  return sharedIsRejected(keyword, rejections);
}

/**
 * @param {string} keyword
 * @param {Set<string>} index  exact keywords AND slugs already covered (calendar/briefs/posts)
 */
export function isCovered(keyword, index) {
  if (!index || !index.size) return false;
  const kw = String(keyword).toLowerCase();
  if (index.has(kw)) return true;
  const slug = slugify(keyword);
  if (index.has(slug)) return true;
  if (slug.length < 6) return false;
  for (const entry of index) {
    const e = slugify(entry);
    if (e.length < 6) continue;
    if (e.includes(slug) || slug.includes(e)) return true;
  }
  return false;
}
