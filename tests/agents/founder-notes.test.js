import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, runIngest, newsQueryFor } from '../../agents/founder-notes/index.js';
import { loadNotes, loadQuestionSets, saveQuestionSet } from '../../lib/founder-notes-store.js';

// All fixture text is invented. No network calls anywhere in this file.
const NOW = new Date('2026-10-26T15:35:00Z'); // Monday, ISO week 2026-W44
const CREDS = { user: 'founder@example.com', pass: 'x' };

function tmpDir() { return mkdtempSync(join(tmpdir(), 'fn-agent-')); }

function review(i) {
  return {
    reviewer: `Pat Example${i}`, rating: 5, created_at: `2026-10-2${i}T10:00:00Z`,
    body: 'I switched from a drugstore bottle and my skin feels softer than it has in years, honestly very happy.',
  };
}

function sendDeps(dir, over = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      dir,
      creds: CREDS,
      config: { enabled: true, sendVia: 'resend', newsQueries: ['q one', 'q two'] },
      fetchReviews: async () => [review(1), review(2)],
      searchNews: async () => [{ url: 'https://example.com/news', title: 'A news item', content: 'body' }],
      loadCalendar: () => [{ slug: 'up-post', keyword: 'up post', title: 'Up Post', publish_date: '2026-11-06T15:00:00Z' }],
      complete: async () => JSON.stringify(['Q a?', 'Q b?', 'Q c?', 'Q d?']),
      sendMail: async (msg) => { sent.push(msg); return { messageId: '<agent-1@example.com>' }; },
      log: () => {},
      ...over,
    },
  };
}

test('send with no sources is skipped and never mails', async () => {
  const dir = tmpDir();
  try {
    const { sent, deps } = sendDeps(dir, {
      fetchReviews: async () => [], searchNews: async () => [], loadCalendar: () => [],
    });
    const r = await runSend({ now: NOW, apply: true, deps });
    assert.equal(r.status, 'skipped');
    assert.equal(sent.length, 0);
    assert.equal(loadQuestionSets({ dir }).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('send falls back to template questions when the LLM throws', async () => {
  const dir = tmpDir();
  try {
    const { sent, deps } = sendDeps(dir, { complete: async () => { throw new Error('boom'); } });
    const r = await runSend({ now: NOW, apply: true, deps });
    assert.equal(r.status, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(r.questions.length, 4);
    assert.match(r.questions[0].text, /A customer wrote the review below/);
    assert.equal(sent[0].to, CREDS.user);
    assert.match(sent[0].subject, /\[FN-2026-W44\]/);
    const sets = loadQuestionSets({ dir });
    assert.equal(sets.length, 1);
    assert.equal(sets[0].message_id, '<agent-1@example.com>');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('LLM questions are dash-stripped and a wrong count falls back', async () => {
  const dir = tmpDir();
  try {
    const { deps } = sendDeps(dir, { complete: async () => JSON.stringify(['One — two?', 'b', 'c', 'd']) });
    const r = await runSend({ now: NOW, apply: false, deps });
    assert.equal(r.status, 'dry-run');
    assert.equal(r.questions[0].text, 'One, two?');
    const { deps: d2 } = sendDeps(dir, { complete: async () => JSON.stringify(['only one']) });
    const r2 = await runSend({ now: NOW, apply: false, deps: d2 });
    assert.match(r2.questions[0].text, /A customer wrote/);
    assert.equal(loadQuestionSets({ dir }).length, 0, 'dry run writes nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a second send in the same week is skipped', async () => {
  const dir = tmpDir();
  try {
    const { sent, deps } = sendDeps(dir);
    await runSend({ now: NOW, apply: true, deps });
    const r = await runSend({ now: new Date('2026-10-28T10:00:00Z'), apply: true, deps });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /already sent/);
    assert.equal(sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('news query rotates by ISO week and tries the next on empty', async () => {
  const queries = ['a', 'b', 'c'];
  assert.equal(newsQueryFor(queries, '2026-W44', 0), 'c'); // 44 % 3 = 2
  assert.equal(newsQueryFor(queries, '2026-W44', 1), 'a');
  const dir = tmpDir();
  try {
    const asked = [];
    const { deps } = sendDeps(dir, {
      config: { enabled: true, newsQueries: queries },
      searchNews: async (q) => { asked.push(q); return []; },
    });
    await runSend({ now: NOW, apply: false, deps });
    assert.deepEqual(asked, ['c', 'a']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function seedSet(dir) {
  saveQuestionSet({
    week: '2026-W44', sent_at: NOW.toISOString(), message_id: '<agent-1@example.com>',
    subject: 'Founder notes, week of Oct 26 [FN-2026-W44]',
    questions: [
      { index: 1, text: 'What is the story?', source: { type: 'review', ref: 'r1' } },
      { index: 2, text: 'Your take on the lotion news?', source: { type: 'world', ref: 'https://example.com/n' } },
    ],
    replies: [],
  }, { dir });
}

function ingestDeps(dir, messages, over = {}) {
  return {
    dir,
    creds: CREDS,
    fetchReplies: async () => messages,
    complete: async ({ prompt }) => {
      const m = prompt.split('TEXT:\n')[1] ?? '';
      return m.replace(/Jenna/g, 'a customer');
    },
    log: () => {},
    ...over,
  };
}

const LATER = new Date('2026-10-27T16:12:00Z');

test('ingest ignores the question email itself', async () => {
  const dir = tmpDir();
  try {
    seedSet(dir);
    const msgs = [{
      messageId: '<lk3j4h5k.ab12@realskincare.com>', subject: 'Founder notes, week of Oct 26 [FN-2026-W44]',
      text: '1. something', date: LATER.toISOString(), references: [],
    }];
    // isAgentMessageId recognises agent IDs; also the stored ID itself must never file.
    const own = [{ messageId: '<agent-1@example.com>', subject: '[FN-2026-W44]', text: '1. x', date: LATER.toISOString() }];
    const r = await runIngest({ now: LATER, apply: true, deps: ingestDeps(dir, [...msgs, ...own]) });
    assert.equal(r.filed, 0);
    assert.equal(loadNotes({ dir }).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const REPLY = {
  messageId: '<reply-1@example.com>', inReplyTo: '<agent-1@example.com>', references: ['<agent-1@example.com>'],
  subject: 'Re: Founder notes [FN-2026-W44]', text: '1. a story about Jenna\n2. take', date: LATER.toISOString(),
};

test('ingest files one note per numbered answer, redacted', async () => {
  const dir = tmpDir();
  try {
    seedSet(dir);
    const r = await runIngest({ now: LATER, apply: true, deps: ingestDeps(dir, [REPLY]) });
    assert.equal(r.filed, 2);
    assert.deepEqual(r.weeks, ['2026-W44']);
    const notes = loadNotes({ dir });
    assert.equal(notes.length, 2);
    assert.equal(notes[0].id, 'fn-2026-W44-1');
    assert.equal(notes[1].id, 'fn-2026-W44-2');
    assert.equal(notes[0].answer, 'a story about a customer');
    assert.equal(notes[0].answer_raw, 'a story about Jenna');
    assert.equal(notes[0].redaction, 'ok');
    assert.equal(notes[0].question, 'What is the story?');
    assert.deepEqual(notes[0].source, { type: 'review', ref: 'r1' });
    assert.equal(notes[0].gate.editorial, 'ok');
    assert.equal(notes[0].gate.commercial, 'ok');
    assert.ok(Array.isArray(notes[0].uses));
    assert.deepEqual(notes[1].clusters, ['lotion']);
    assert.deepEqual(loadQuestionSets({ dir })[0].replies, ['<reply-1@example.com>']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed redaction keeps the raw answer and marks it failed', async () => {
  const dir = tmpDir();
  try {
    seedSet(dir);
    const r = await runIngest({ now: LATER, apply: true, deps: ingestDeps(dir, [REPLY], { complete: async () => '' }) });
    assert.equal(r.filed, 2);
    const notes = loadNotes({ dir });
    assert.equal(notes[0].redaction, 'failed');
    assert.equal(notes[0].answer, 'a story about Jenna');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ingest twice over the same reply files once', async () => {
  const dir = tmpDir();
  try {
    seedSet(dir);
    await runIngest({ now: LATER, apply: true, deps: ingestDeps(dir, [REPLY]) });
    const r = await runIngest({ now: LATER, apply: true, deps: ingestDeps(dir, [REPLY]) });
    assert.equal(r.filed, 0);
    assert.equal(loadNotes({ dir }).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a second reply continues numbering, general text is filed, dry run writes nothing', async () => {
  const dir = tmpDir();
  try {
    seedSet(dir);
    await runIngest({ now: LATER, apply: true, deps: ingestDeps(dir, [REPLY]) });
    const second = { ...REPLY, messageId: '<reply-2@example.com>', text: 'one more thought\n1. again' };
    const dry = await runIngest({ now: LATER, apply: false, deps: ingestDeps(dir, [REPLY, second]) });
    assert.equal(dry.filed, 2);
    assert.equal(loadNotes({ dir }).length, 2, 'dry run wrote nothing');
    await runIngest({ now: LATER, apply: true, deps: ingestDeps(dir, [REPLY, second]) });
    const notes = loadNotes({ dir });
    assert.equal(notes.length, 4);
    assert.equal(notes[2].id, 'fn-2026-W44-3');
    assert.deepEqual(notes[2].source, { type: 'general', ref: null });
    assert.equal(notes[2].question, '');
    assert.equal(notes[3].id, 'fn-2026-W44-4');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sets older than the expiry window are marked expired and not read', async () => {
  const dir = tmpDir();
  try {
    seedSet(dir);
    let fetched = 0;
    const late = new Date('2026-11-12T16:12:00Z');
    const r = await runIngest({ now: late, apply: true, deps: ingestDeps(dir, [REPLY], { fetchReplies: async () => { fetched++; return [REPLY]; } }) });
    assert.equal(r.filed, 0);
    assert.equal(fetched, 0);
    assert.equal(loadQuestionSets({ dir })[0].expired, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
