/**
 * The digest's "Creator submissions to review" section.
 *
 * agents/trybe-review runs at 12:55 UTC, reviews every Trybe submission still
 * waiting on Sean (transcript claims gate + a visual review against the live
 * PDP) and writes its findings into an ordinary digest row. Ordinary rows are
 * collapsed into the "N tasks ran" line, so until 2026-10-04 none of those
 * verdicts ever reached the email: six submissions sat in Trybe, three of them
 * showing the wrong product, and the digest said only "78 tasks ran".
 *
 * This renders the newest trybe-review row's "Awaiting your response" block,
 * one card per submission. Pure: takes the window's rows and an escaper.
 */

const IS_TRYBE = (e) => e.source === 'agents/trybe-review/index.js' || /^Trybe creators:/.test(e.subject || '');
const HEADER = 'Awaiting your response';

/** The newest trybe-review row's awaiting submissions, as { title, lines[] }. */
export function awaitingSubmissions(entries) {
  // Newest trybe-review row that carries the block: a later crash row from the
  // same agent must not blank out the last good review.
  const row = [...entries].filter((e) => IS_TRYBE(e) && String(e.body || '').includes(HEADER)).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
  const body = String(row?.body || '');
  const start = body.indexOf(HEADER);
  if (start < 0) return { row: row || null, items: [] };
  const block = body.slice(start).split(/\n\s*\n/)[0].split('\n').slice(1);
  const items = [];
  for (const line of block) {
    const head = line.match(/^ {2}- (.*)$/);
    if (head) items.push({ title: head[1], lines: [] });
    else if (items.length && line.trim()) items[items.length - 1].lines.push(line.trim());
  }
  return { row, items };
}

export function renderCreatorReviewSection(entries, esc) {
  const { items } = awaitingSubmissions(entries);
  if (!items.length) return '';
  const link = (s) => esc(s).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">view</a>');
  const verdictOf = (it) => (it.lines.find((l) => l.startsWith('Visual:')) || '').match(/Visual:\s*([A-Z ]+)\./)?.[1] || '';
  const needs = items.filter((it) => verdictOf(it) === 'NEEDS CHANGES').length;
  const cards = items.map((it) => {
    const v = verdictOf(it);
    const colour = v === 'LOOKS READY' ? '#166534' : v === 'NEEDS CHANGES' ? '#991b1b' : '#92400e';
    const lines = it.lines.map((l) => {
      const strong = /^(Visual|Suggested note):/.test(l);
      return `<div style="font-size:12px;margin-top:4px;${strong ? `color:${l.startsWith('Visual') ? colour : '#111827'};font-weight:600;` : 'color:#4b5563;'}">${link(l)}</div>`;
    }).join('');
    return `<div class="blocked-post"><div class="title">${esc(it.title)}</div>${lines}</div>`;
  }).join('');
  return `
          <div class="action-required">
            <div class="section-title">&#127916; Creator submissions to review &mdash; ${items.length} waiting${needs ? `, ${needs} need changes` : ''}</div>
            <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">Reviewed this morning against the live product page. Approve, reject or request a revision in Trybe; a suggested note is ready to paste for each one that needs changes.</p>
            ${cards}
          </div>`;
}
