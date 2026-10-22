/**
 * Founder notes: pure question selection and email rendering. No I/O.
 */
import { stripDashes } from './press-outreach.js';

export const MAX_QUESTIONS = 4;
export const MIN_QUESTIONS = 2;
export const UPCOMING_MIN_DAYS = 7;
export const UPCOMING_MAX_DAYS = 21;

const DAY = 86400000;
const MIN_REVIEW_WORDS = 12;

export function weekId(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // Thursday of this ISO week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const wk = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

export function reviewKey(r) {
  return `${r.created_at}|${r.reviewer}`;
}

export function pickReviews(reviews, { asked = new Set(), max = 2 } = {}) {
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
  const t = (r) => Date.parse(r.created_at) || 0;
  return (reviews || [])
    .filter((r) => words(r.body) >= MIN_REVIEW_WORDS && !asked.has(reviewKey(r)))
    .sort((a, b) => (a.rating === 4) - (b.rating === 4) || t(b) - t(a))
    .slice(0, max);
}

export function pickNews(results, { askedUrls = new Set() } = {}) {
  return (results || []).find((r) => r && r.url && !askedUrls.has(r.url) && String(r.title || '').trim()) || null;
}

export function pickUpcoming(items, { now, asked = new Set(), minDays = UPCOMING_MIN_DAYS, maxDays = UPCOMING_MAX_DAYS } = {}) {
  const lo = now.getTime() + minDays * DAY;
  const hi = now.getTime() + maxDays * DAY;
  return (items || [])
    .map((i) => ({ i, t: Date.parse(i.publish_date) }))
    .filter(({ i, t }) => Number.isFinite(t) && t >= lo && t <= hi && !asked.has(i.slug))
    .sort((a, b) => a.t - b.t)[0]?.i || null;
}

export function buildSources({ reviews = [], news = null, upcoming = null }) {
  const out = reviews.slice(0, 2).map((r) => ({
    type: 'review',
    ref: reviewKey(r),
    context: `${r.reviewer || 'A customer'} (${r.rating} stars) wrote: ${r.body}`,
    reviewer: r.reviewer,
    rating: r.rating,
    body: r.body,
  }));
  if (news) out.push({ type: 'world', ref: news.url, context: `${news.title}\n${news.url}\n${news.content || ''}`.trim(), title: news.title, url: news.url });
  if (upcoming) {
    out.push({
      type: 'upcoming', ref: upcoming.slug,
      context: `Upcoming blog post "${upcoming.title || upcoming.keyword}" (keyword: ${upcoming.keyword || upcoming.slug}), publishing ${upcoming.publish_date || 'soon'}`,
      title: upcoming.title || upcoming.keyword || upcoming.slug,
    });
  }
  return out.slice(0, MAX_QUESTIONS);
}

export function templateQuestion(source) {
  if (source.type === 'review') return 'A customer wrote the review below. What was your reaction, and is there a story behind it you would want shoppers to hear?';
  if (source.type === 'world') return 'This story is in the news. Does it change how you think about what goes into our products, or what you would tell customers?';
  return 'We are about to publish the post below. What do you know about this from running the business that a typical article would miss?';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function mondayOf(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

const oneLine = (v) => stripDashes(String(v ?? '').replace(/\s+/g, ' ').trim());

function reviewLabel(source) {
  const first = String(source.reviewer ?? '').trim().split(/\s+/)[0] || 'A customer';
  const r = Number(source.rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return `(${first})`;
  return `(${first}, ${r} ${r === 1 ? 'star' : 'stars'})`;
}

export function renderEmail({ week, questions, now }) {
  const mon = mondayOf(now);
  const subject = `Founder notes, week of ${MONTHS[mon.getUTCMonth()]} ${mon.getUTCDate()} [FN-${week}]`;
  const blocks = questions.map(({ text, source }, idx) => {
    const lines = [`${idx + 1}. ${stripDashes(text)}`];
    if (source.type === 'review') {
      lines.push('', `   "${oneLine(source.body)}"`, `   ${reviewLabel(source)}`);
    } else if (source.type === 'world') {
      lines.push('', `   ${oneLine(source.title)}`);
      if (source.url) lines.push(`   ${String(source.url).trim()}`);
    } else {
      lines.push('', `   Upcoming post: ${oneLine(source.title)}`);
    }
    return lines.join('\n');
  });
  const textOut = stripDashes(['Reply under each number. Skip any you like.', '', ...blocks.flatMap((b) => [b, ''])].join('\n').trimEnd() + '\n');
  return { subject, text: textOut };
}
