# Press Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `agents/press-outreach`, which turns the existing PR and link-gap target lists into personalized pitches that Sean approves. It then sends, follows up, handles replies, ships samples and measures earned links, all from sean@realskincare.com.

**Architecture:**
- **Pure policy modules in `lib/`**, all tested against fake fixtures:
  - `press-contacts` (extended)
  - `press-drafts`
  - `press-outreach`
  - `press-replies`
  - `press-prospects`
  - `contact-finder` (the rules half)
  - `press-pitch`
  - `press-samples`
  - `press-links`
- **One agent, `agents/press-outreach/index.js`, with four modes:**
  - the default (every 30 min): replies, follow-ups, approved sends
  - `--draft` (daily): prospects, addresses, drafts
  - `--check-links` (weekly)
  - `--backfill` (once)
- **Mail** goes through `lib/hushmail.js`: Resend to send, IMAP to read.
- **Approval** happens in a new dashboard **Outreach** tab.

**Tech Stack:**
- Node 22 ESM, `node:test`
- `imapflow` and `mailparser` (already deps), via `lib/hushmail.js`
- Resend HTTPS API
- Hunter.io v2 REST
- Tavily (`TAVILY_API_KEY`, already in `.env`)
- Shopify Admin GraphQL via `lib/shopify.js` (lazy import only)
- the `standard` model tier via `lib/anthropic.js`

**Spec:** `docs/superpowers/specs/2026-10-04-press-outreach-design.md`

## Global Constraints

**Environment and repo rules:**
- Node 22 (`nvm use`). When reading test output, check the `cancelled` count as well as `fail`.
- Never import `@anthropic-ai/sdk`. LLM calls go through `lib/anthropic.js`, and the model id comes from `config/llm-models.js` (`LLM_MODELS.standard`).
- Never import `lib/shopify.js` at module scope (it throws without credentials). Use `await import('./shopify.js')` inside functions.
- Agents use `isDirectRun(import.meta.url)` from `lib/is-direct-run.js`. Importing the agent must not run it.
- **This repo is public.** `data/press/` is gitignored and must stay so. Test fixtures use `example.com` addresses and invented people only.

**Copy rules:**
- No em dashes (`—`) or en dashes (`–`) in any email body or subject. Strip them deterministically, then re-check.
- RSC sells a **deodorant**, never an antiperspirant. Deodorant copy is odor-only, never sweat or wetness.
- Every first pitch carries `If this isn't a fit, just reply "no thanks" and I won't follow up.`
- Every first pitch carries the postal address from `data/brand/brand-kit.json` `postal_address` (`1623 Central Ave STE 201, Cheyenne, WY 82001, United States`), read at runtime and never hardcoded.
- First-pitch copy passes `checkSeoCopyFields(fields)` on the default COMMERCIAL surface (`lib/seo-copy-health-gate.js`).

**Sending rules:**
- A first pitch sends **only** when its draft `status === 'approved'`.
- Send window: 16:00–24:00 UTC, Monday–Friday, at least 10 minutes between sends.
- Daily send cap (first pitches **plus** follow-ups): 10, rising to 25 once 14 days have passed since the first send with no auto-pause.
- Follow-ups: at most 2 per pitch. Gaps are `[5, 7]` days: the first 5 days after the pitch, the second 7 days after the first follow-up (day 12).
- Draft expiry: 14 days pending, then `expired`.
- Auto-pause: a hard-bounce rate above 3% over the last 50 sends, or any complaint. It needs `--resume` to clear.
- Unsure reply classification means **escalate to Sean, send nothing to the writer**.

**Samples, addresses and reporting:**
- Sample orders: $0, tagged `PR Package` and `press-outreach`. The cap is `monthlySampleKits` (default 10) per calendar month, counting every `PR Package` order.
- Hunter: keep an address only when the verifier returns `status: "valid"`. Stop spending at 80% of either monthly allowance.
- Notifications: one deferred `notify()` per run that acted. Escalations use `immediate: true`. `status: 'error'` only when the agent broke.
- Cron is UTC with no `TZ=` prefix. A new line goes in `scripts/setup-cron.sh` **and** the live crontab in the same change. Check `crontab -l` on the server for a free minute first.

## Review Focus

1. **A reply filed outside the Inbox.** inbox-sorter moves mail to folders such as `Cold Pitches`. The agent must still see it and must not send a follow-up. Pinned in Task 2 (`fetchFromAllFolders` reads non-Inbox folders) and Task 6 (a reply anywhere stops follow-ups).
2. **One reply that both accepts the sample and gives the address** (exactly Saleam's 2026-09-25 email). This must go straight to `address_given`, never ask for an address that was already supplied. Pinned in Task 4.
3. **Sean answers a writer himself** from Hushmail while the agent has follow-ups pending. The agent must treat his Sent mail as a touch and send no automatic follow-up on top of it. Pinned in Task 6.
4. **An approved draft whose daily slot never comes** (the cap is full for days). It must not send after its opener has gone stale: approval does not reset the 14-day expiry clock. Pinned in Task 3.
5. **An IMAP outage mid-run.** Follow-ups must be skipped, not sent blind, because silence can't be confirmed. Pinned in Task 6.

---

## File Structure

| File | Responsibility | PR |
|---|---|---|
| `lib/press-contacts.js` (modify) | contact book: new outcomes, new pitch fields, `updatePitch`, `autoFollowUpsDue`, `openPitchByAddress` | 1 |
| `lib/hushmail.js` (modify) | `agent` header option; `fetchFromAllFolders`; `subject` on `fetchSentTo` rows | 1 |
| `lib/press-drafts.js` (create) | draft shape, transitions, expiry, send ordering, atomic store | 1 |
| `lib/press-outreach.js` (create) | config defaults, send window, daily cap ramp, fixed templates, signature, copy checks, auto-pause | 1 |
| `lib/press-replies.js` (create) | reply classification and US address extraction | 1 |
| `agents/press-outreach/index.js` (create) | orchestration: run, `--backfill`, `--resume`, `--test-send`; later `--draft`, `--check-links` | 1–4 |
| `agents/dashboard/routes/press-outreach.js` (create) | draft list, edit, approve, approve-many, reject | 1 |
| `agents/dashboard/public/index.html`, `public/js/dashboard.js` (modify) | Outreach tab | 1 |
| `config/press-outreach.json` (create) | switches and caps | 1 |
| `scripts/setup-cron.sh`, `scripts/backup-snapshots-offsite.sh` (modify) | cron and backup | 1–4 |
| `lib/press-prospects.js` (create) | merge both target lists into a slotted queue | 2 |
| `lib/contact-finder.js` (create) | address extraction rules (pure) plus free and Hunter lookups (injected I/O) | 2 |
| `lib/press-pitch.js` (create) | fact sheet, prompt, opener-quote check, gate wiring | 2 |
| `lib/press-samples.js` (create) | sample planning, cap counting, Shopify draft-order calls | 3 |
| `lib/press-links.js` (create) | link and mention detection | 4 |
| `tests/lib/press-*.test.js`, `tests/lib/contact-finder.test.js`, `tests/agents/press-outreach-*.test.js`, `tests/dashboard/press-outreach-routes.test.js` | tests | 1–4 |

---

# PR 1: sender, follow-ups, replies, approval queue

### Task 1: Extend the contact book

**Files:**
- Modify: `lib/press-contacts.js`
- Test: `tests/lib/press-contacts.test.js` (append)

**Interfaces:**
- Produces:
  - `PITCH_OUTCOMES` gains `'sample-accepted'`, `'escalated'`.
  - `PITCH_SOURCES = ['pr-target','link-gap','manual']`
  - `updatePitch(doc, id, patch, { date }?) -> doc`
  - `autoFollowUpsDue(contacts, nowMs, gaps=[5,7], max=2) -> Array<{contact, pitch, n}>`
  - `openPitchByAddress(contacts) -> Map<email, {contact, pitch}>`
  - `emailOf(contact) -> string|null`
- Validated optional pitch fields:
  - `message_id`, `references`, `subject`, `last_sent_at` (ISO datetime)
  - `follow_ups_sent` (0..2)
  - `source`, `target_url`, `draft_id`, `sample_order`, `escalated_at`
  - `link_earned` and `mention_earned`, each `{url, found_at, dofollow?}`

- [ ] **Step 1: Write the failing tests** (append to `tests/lib/press-contacts.test.js`)

```js
import {
  updatePitch, autoFollowUpsDue, openPitchByAddress, emailOf, PITCH_OUTCOMES, validateContacts,
} from '../../lib/press-contacts.js';

const H = 3_600_000, D = 24 * H;
const book = (pitchOver = {}, contactOver = {}) => ({ contacts: [{
  id: 'jane-doe', name: 'Jane Doe', status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: 'Jane@Example.com', verified: true, source: 'https://example.com/about' }],
  pitches: [{ date: '2026-10-01', concept: 'intro', outcome: 'sent', message_id: '<a@realskincare.com>',
    last_sent_at: '2026-10-01T17:00:00Z', follow_ups_sent: 0, ...pitchOver }],
  ...contactOver,
}] });

test('new outcomes are valid', () => {
  assert.ok(PITCH_OUTCOMES.includes('sample-accepted'));
  assert.ok(PITCH_OUTCOMES.includes('escalated'));
});

test('validation rejects a malformed new field and accepts a good one', () => {
  assert.equal(validateContacts(book()).ok, true);
  assert.equal(validateContacts(book({ follow_ups_sent: 3 })).ok, false);
  assert.equal(validateContacts(book({ source: 'blast' })).ok, false);
  assert.equal(validateContacts(book({ link_earned: { url: 'x' } })).ok, false, 'link_earned needs found_at');
});

test('updatePitch merges onto the latest pitch and re-validates', () => {
  const next = updatePitch(book(), 'jane-doe', { follow_ups_sent: 1, last_sent_at: '2026-10-06T17:00:00Z' });
  assert.equal(next.contacts[0].pitches[0].follow_ups_sent, 1);
  assert.throws(() => updatePitch(book(), 'jane-doe', { outcome: 'nope' }));
  assert.throws(() => updatePitch(book(), 'nobody', {}));
});

test('first follow-up is due 5 days after the pitch, second 7 days after the first', () => {
  const now = Date.parse('2026-10-06T18:00:00Z');
  assert.deepEqual(autoFollowUpsDue(book().contacts, now).map((r) => r.n), [1]);
  assert.equal(autoFollowUpsDue(book().contacts, now - D).length, 0, 'day 4: not yet');
  const after1 = book({ follow_ups_sent: 1, last_sent_at: '2026-10-06T17:00:00Z' }).contacts;
  assert.equal(autoFollowUpsDue(after1, Date.parse('2026-10-12T18:00:00Z')).length, 0);
  assert.deepEqual(autoFollowUpsDue(after1, Date.parse('2026-10-13T18:00:00Z')).map((r) => r.n), [2]);
  const after2 = book({ follow_ups_sent: 2 }).contacts;
  assert.equal(autoFollowUpsDue(after2, Date.parse('2026-12-01T00:00:00Z')).length, 0, 'never a third');
});

test('no automatic follow-up without a thread id, a non-sent outcome, or a non-pitchable contact', () => {
  const now = Date.parse('2026-10-20T18:00:00Z');
  assert.equal(autoFollowUpsDue(book({ message_id: undefined }).contacts, now).length, 0);
  assert.equal(autoFollowUpsDue(book({ outcome: 'replied' }).contacts, now).length, 0);
  assert.equal(autoFollowUpsDue(book({}, { status: 'do_not_contact' }).contacts, now).length, 0);
});

test('openPitchByAddress keys on the lowercased email of contacts whose latest pitch is open', () => {
  const m = openPitchByAddress(book().contacts);
  assert.equal(m.get('jane@example.com').contact.id, 'jane-doe');
  assert.equal(emailOf(book().contacts[0]), 'jane@example.com');
  assert.equal(openPitchByAddress(book({ outcome: 'declined' }).contacts).size, 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/lib/press-contacts.test.js`
Expected: FAIL. `updatePitch` (and the others) are not exported.

- [ ] **Step 3: Implement** in `lib/press-contacts.js`

Replace `PITCH_OUTCOMES` and add the constants:

```js
export const PITCH_OUTCOMES = Object.freeze([
  'sent', 'replied', 'declined', 'bounced', 'samples-sent', 'placed', 'no-response',
  // press-outreach (2026-10-04): the writer said yes to a sample but no order
  // exists yet; and a reply that went to Sean because nothing should answer it
  // automatically.
  'sample-accepted', 'escalated',
]);

// An open pitch is one a reply can still change: follow-ups, a sample, an answer.
export const OPEN_OUTCOMES = Object.freeze(['sent', 'replied', 'sample-accepted', 'escalated', 'samples-sent']);

export const PITCH_SOURCES = Object.freeze(['pr-target', 'link-gap', 'manual']);
export const MAX_FOLLOW_UPS = 2;
export const FOLLOW_UP_GAPS_DAYS = Object.freeze([5, 7]);
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
```

Inside `validateContacts`, in the `(c.pitches || []).forEach(...)` callback, after the `follow_up_due` line, add:

```js
      if (p?.follow_ups_sent != null && !(Number.isInteger(p.follow_ups_sent) && p.follow_ups_sent >= 0 && p.follow_ups_sent <= MAX_FOLLOW_UPS)) errors.push(`${pat}: follow_ups_sent must be 0..${MAX_FOLLOW_UPS}`);
      if (p?.last_sent_at != null && !ISO_DATETIME.test(p.last_sent_at)) errors.push(`${pat}: last_sent_at must be an ISO datetime`);
      if (p?.source != null && !PITCH_SOURCES.includes(p.source)) errors.push(`${pat}: source "${p.source}" not in ${PITCH_SOURCES.join('/')}`);
      if (p?.references != null && !Array.isArray(p.references)) errors.push(`${pat}: references must be an array`);
      for (const k of ['link_earned', 'mention_earned']) {
        const v = p?.[k];
        if (v != null && (typeof v.url !== 'string' || !ISO_DATE.test(String(v.found_at || '').slice(0, 10)))) errors.push(`${pat}: ${k} needs url and found_at`);
      }
```

Append the functions:

```js
/** The contact's email address, lowercased, or null. */
export function emailOf(contact) {
  const ch = (contact?.channels || []).find((c) => c.type === 'email' && c.address);
  return ch ? ch.address.toLowerCase() : null;
}

/** Pure: merge `patch` onto one pitch (latest unless `date` given) and re-validate. */
export function updatePitch(doc, id, patch, { date = null } = {}) {
  const idx = doc.contacts.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`no contact with id "${id}"`);
  const pitches = (doc.contacts[idx].pitches || []).slice();
  if (!pitches.length) throw new Error(`${id} has no pitches to update`);
  const pi = date
    ? pitches.map((p) => p.date).lastIndexOf(date)
    : pitches.reduce((best, p, i) => (best === -1 || p.date >= pitches[best].date ? i : best), -1);
  if (pi === -1) throw new Error(`${id} has no pitch dated ${date}`);
  pitches[pi] = { ...pitches[pi], ...patch };
  const contacts = doc.contacts.slice();
  contacts[idx] = { ...contacts[idx], pitches };
  const next = { ...doc, contacts };
  const v = validateContacts(next);
  if (!v.ok) throw new Error(`that update would make the book invalid: ${v.errors.join('; ')}`);
  return next;
}

/**
 * Pitches owed an automatic follow-up at `nowMs`. Only threadable pitches
 * (a message_id to reply under) whose latest outcome is still `sent`. A pitch
 * Sean sent by hand with no recorded id never gets an automatic follow-up.
 */
export function autoFollowUpsDue(contacts, nowMs, gaps = FOLLOW_UP_GAPS_DAYS, max = MAX_FOLLOW_UPS) {
  const rows = [];
  for (const c of contacts || []) {
    if (!PITCHABLE_STATUSES.includes(c.status) || !emailOf(c)) continue;
    const p = lastPitch(c);
    if (!p || p.outcome !== 'sent' || !p.message_id) continue;
    const n = (p.follow_ups_sent || 0) + 1;
    if (n > max) continue;
    const from = Date.parse(p.last_sent_at || `${p.date}T00:00:00Z`);
    if (nowMs >= from + gaps[n - 1] * 86_400_000) rows.push({ contact: c, pitch: p, n });
  }
  return rows;
}

/** email -> {contact, pitch} for every contact whose latest pitch is still open. */
export function openPitchByAddress(contacts) {
  const m = new Map();
  for (const c of contacts || []) {
    const p = lastPitch(c);
    const e = emailOf(c);
    if (p && e && OPEN_OUTCOMES.includes(p.outcome)) m.set(e, { contact: c, pitch: p });
  }
  return m;
}
```

- [ ] **Step 4: Run the whole file to verify it passes**

Run: `node --test tests/lib/press-contacts.test.js`
Expected: PASS, `# fail 0 # cancelled 0`. The pre-existing tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add lib/press-contacts.js tests/lib/press-contacts.test.js
git commit -m "feat(press-contacts): outreach outcomes, thread fields, auto follow-up schedule"
```

---

### Task 2: Hushmail: agent header, all-folder read, subject on Sent rows

**Files:**
- Modify: `lib/hushmail.js`
- Test: `tests/lib/hushmail-folders.test.js` (create)

**Interfaces:**
- Produces:
  - `sendMail(creds, message, { via, resendKey, agent = 'creator-outreach' })`: the `agent` value becomes the `X-RSC-Agent` header.
  - `composeMessage(creds, { ..., agent })`
  - `fetchFromAllFolders(creds, { senders, since }, { clientImpl, parseImpl }) -> Array<{...same row shape as fetchInboxFrom, folder}>`, skipping `\Sent`, `\Drafts`, `\Trash`.
  - `fetchSentTo` rows gain `subject`.
- **Consumes:** existing `connectImap`, `stripQuoted`, `isEmojiReaction`.

- [ ] **Step 1: Write the failing test**

```js
// tests/lib/hushmail-folders.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFromAllFolders, composeMessage, AGENT_HEADER } from '../../lib/hushmail.js';

function fakeClient(boxes) {
  let current = null;
  return {
    connect: async () => {}, logout: async () => {},
    list: async () => Object.keys(boxes).map((path) => ({ path, name: path, specialUse: boxes[path].special || null })),
    getMailboxLock: async (path) => { current = path; return { release() {} }; },
    async *fetch(q, fields, opts) {
      for (const m of boxes[current].msgs) {
        if (Array.isArray(q) && !q.includes(m.uid)) continue;
        yield { uid: m.uid, envelope: { from: [{ address: m.from }], subject: m.subject, messageId: m.id, date: new Date('2026-10-05') }, source: m.from };
      }
    },
  };
}
const parseImpl = async (from) => ({ messageId: `<${from}>`, text: 'Thanks, happy to try it', subject: 're', date: new Date('2026-10-05'), headers: new Map() });

test('reads filed folders, skips Sent/Drafts/Trash, tags the folder', async () => {
  const client = fakeClient({
    INBOX: { msgs: [] },
    'Cold Pitches': { msgs: [{ uid: 1, from: 'jane@example.com', subject: 'Re: hi', id: '<x>' }] },
    Sent: { special: '\\Sent', msgs: [{ uid: 2, from: 'jane@example.com', subject: 'no', id: '<y>' }] },
    Trash: { special: '\\Trash', msgs: [{ uid: 3, from: 'jane@example.com', subject: 'no', id: '<z>' }] },
  });
  const rows = await fetchFromAllFolders({ user: 'sean@realskincare.com', pass: 'x' },
    { senders: ['Jane@Example.com'], since: new Date('2026-10-01') }, { clientImpl: client, parseImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, 'Cold Pitches');
  assert.equal(rows[0].from, 'jane@example.com');
});

test('composeMessage stamps the agent name it is given', async () => {
  const { raw } = await composeMessage({ user: 'sean@realskincare.com' }, { to: 'a@example.com', subject: 's', text: 't', agent: 'press-outreach' });
  assert.match(raw.toString(), new RegExp(`${AGENT_HEADER}: press-outreach`));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/lib/hushmail-folders.test.js`
Expected: FAIL, `fetchFromAllFolders` is not exported.

- [ ] **Step 3: Implement**

1. In `sendViaSmtp`, `composeMessage` and `sendViaResend`, read the agent name from the message or options and replace each literal `'creator-outreach'` header value with it:
   - `composeMessage(creds, { to, subject, text, inReplyTo, references, fromName = 'Sean at Real Skin Care', agent = 'creator-outreach' })` uses `headers: { [AGENT_HEADER]: agent }`.
   - `sendMail(creds, message, opts)` passes `message.agent ?? opts.agent ?? 'creator-outreach'` through: set `msg.agent` before calling the transport. In `sendViaResend`, the `headers` object uses `[AGENT_HEADER]: msg.agent || 'creator-outreach'`.
   - creator-outreach passes nothing, so its behaviour is unchanged.

2. In `fetchSentTo`, add `subject: msg.envelope.subject || ''` to the pushed row.

3. Refactor the per-mailbox body of `fetchInboxFrom` into a private helper and add the new export:

```js
async function readMailboxFrom(client, path, wanted, since, parse) {
  const out = [];
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const uids = [];
    for await (const msg of client.fetch({ since }, { envelope: true, uid: true })) {
      const from = msg.envelope?.from?.[0]?.address?.toLowerCase();
      if (from && wanted.has(from)) uids.push(msg.uid);
    }
    if (!uids.length) return out;
    for await (const msg of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
      const from = msg.envelope?.from?.[0]?.address?.toLowerCase();
      const parsed = await parse(msg.source);
      out.push({
        messageId: parsed.messageId || msg.envelope.messageId,
        inReplyTo: parsed.inReplyTo || null,
        references: [].concat(parsed.references || []),
        from,
        subject: parsed.subject || msg.envelope.subject || '',
        date: (parsed.date || msg.envelope.date || new Date()).toISOString(),
        text: stripQuoted(parsed.text || ''),
        fullText: String(parsed.text || '').trim(),
        fromName: parsed.from?.value?.[0]?.name || '',
        emojiReaction: isEmojiReaction(parsed),
        autoSubmitted: /auto-(generated|replied|notified)/i.test(String(parsed.headers?.get?.('auto-submitted') || ''))
          || Boolean(parsed.headers?.has?.('x-autoreply') || parsed.headers?.has?.('x-autorespond')),
        folder: path,
      });
    }
  } finally {
    lock.release();
  }
  return out;
}
```

`fetchInboxFrom` keeps its signature and calls `readMailboxFrom(client, 'INBOX', wanted, since, parse)`, then deletes `folder` from each row so its output shape is byte-identical for creator-outreach. Its existing tests must still pass.

```js
const SKIP_SPECIAL = new Set(['\\Sent', '\\Drafts', '\\Trash']);
const SKIP_NAMES = /^(sent( (items|mail))?|drafts?|trash|deleted( items)?)$/i;

/**
 * Mail FROM any of `senders` in EVERY folder except Sent, Drafts and Trash.
 * agents/inbox-sorter files mail out of the Inbox, so a writer's reply can sit
 * in "Cold Pitches"; reading the Inbox alone would read that as silence and
 * send them a follow-up. Read-only, same as fetchInboxFrom.
 */
export async function fetchFromAllFolders(creds, { senders, since }, { clientImpl, parseImpl } = {}) {
  if (!creds) throw new Error('hushmail: no HUSHMAIL_USER / HUSHMAIL_PASSWORD');
  const wanted = new Set((senders || []).map((s) => s.toLowerCase()));
  if (!wanted.size) return [];
  const parse = parseImpl || (await import('mailparser')).simpleParser;
  const client = await connectImap(clientImpl ? () => clientImpl : await imapClientFactory(creds), clientImpl ? { attempts: 1 } : {});
  const out = [];
  try {
    const boxes = await client.list();
    for (const b of boxes) {
      if (SKIP_SPECIAL.has(b.specialUse) || SKIP_NAMES.test(b.name) || b.flags?.has?.('\\Noselect')) continue;
      out.push(...await readMailboxFrom(client, b.path, wanted, since, parse));
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}
```

**Check:** confirm how `fetchInboxFrom` currently obtains `parse` (look at the lines just above the old fetch loop) and reuse the same expression in both functions.

- [ ] **Step 4: Run the new and existing mail tests**

Run: `node --test tests/lib/hushmail-folders.test.js tests/lib/hushmail-connect.test.js tests/lib/creator-outreach.test.js`
Expected: PASS, cancelled 0.

- [ ] **Step 5: Commit**

```bash
git add lib/hushmail.js tests/lib/hushmail-folders.test.js
git commit -m "feat(hushmail): per-agent header, read replies from every folder"
```

---

### Task 3: Drafts: shape, transitions, expiry, send order, store

**Files:**
- Create: `lib/press-drafts.js`
- Test: `tests/lib/press-drafts.test.js`

**Interfaces:**
- Produces:
  - `DRAFTS_DIR = 'data/press/drafts'`
  - `DRAFT_KINDS = ['pitch','bump']`
  - `DRAFT_STATUSES = ['pending','approved','rejected','expired','sent']`
  - `newDraft({ kind, contactId, to, subject, text, inReplyTo?, references?, source?, targetUrl?, openerQuote?, products?, concept, now }) -> draft`
  - `approveDraft(d, { now, edits? }) -> draft`
  - `rejectDraft(d, { now, reason }) -> draft`
  - `markSent(d, { now, messageId, resendId }) -> draft`
  - `expireDrafts(drafts, nowMs, days=14) -> {drafts, expired: draft[]}`
  - `sendOrder(drafts) -> draft[]`
  - `loadDrafts(dir, fsImpl) -> draft[]`
  - `saveDraft(dir, d, fsImpl)`

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/press-drafts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDraft, approveDraft, rejectDraft, markSent, expireDrafts, sendOrder, loadDrafts, saveDraft } from '../../lib/press-drafts.js';

const T0 = Date.parse('2026-10-05T12:00:00Z'), D = 86_400_000;
const mk = (over = {}) => newDraft({ kind: 'pitch', contactId: 'jane-doe', to: 'jane@example.com', subject: 'Hi', text: 'Body', concept: 'intro', now: T0, ...over });

test('new draft is pending with a stable id', () => {
  const d = mk();
  assert.equal(d.status, 'pending');
  assert.match(d.id, /^\d{8}-jane-doe-pitch$/);
});

test('approve applies edits and keeps created_at (expiry is from creation)', () => {
  const d = approveDraft(mk(), { now: T0 + D, edits: { subject: 'Edited' } });
  assert.equal(d.status, 'approved');
  assert.equal(d.subject, 'Edited');
  assert.equal(d.created_at, new Date(T0).toISOString());
  assert.throws(() => approveDraft(markSent(approveDraft(mk(), { now: T0 }), { now: T0, messageId: '<m>' }), { now: T0 }), /sent/);
});

test('reject needs a reason', () => {
  assert.throws(() => rejectDraft(mk(), { now: T0 }));
  assert.equal(rejectDraft(mk(), { now: T0, reason: 'wrong beat' }).status, 'rejected');
});

test('pending AND approved drafts expire 14 days after creation; sent ones never', () => {
  const pending = mk();
  const approved = approveDraft(mk({ contactId: 'b' }), { now: T0 + 13 * D });
  const sent = markSent(approveDraft(mk({ contactId: 'c' }), { now: T0 }), { now: T0, messageId: '<m>' });
  const { drafts, expired } = expireDrafts([pending, approved, sent], T0 + 14 * D + 1);
  assert.deepEqual(expired.map((d) => d.contact_id).sort(), ['b', 'jane-doe']);
  assert.equal(drafts.find((d) => d.contact_id === 'c').status, 'sent');
});

test('send order: approved only, oldest approval first', () => {
  const a = approveDraft(mk({ contactId: 'a' }), { now: T0 + 2 * D });
  const b = approveDraft(mk({ contactId: 'b' }), { now: T0 + D });
  assert.deepEqual(sendOrder([mk({ contactId: 'p' }), a, b]).map((d) => d.contact_id), ['b', 'a']);
});

test('store round-trips through an injected fs, atomically', () => {
  const files = new Map();
  const fsImpl = {
    mkdirSync() {}, readdirSync: () => [...files.keys()].map((k) => k.split('/').pop()),
    readFileSync: (p) => files.get(p), writeFileSync: (p, s) => files.set(p, s),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
  saveDraft('/d', mk(), fsImpl);
  assert.equal(loadDrafts('/d', fsImpl)[0].contact_id, 'jane-doe');
  assert.ok(![...files.keys()].some((k) => k.includes('.tmp')));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/lib/press-drafts.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/press-drafts.js`**

```js
// lib/press-drafts.js
//
// The approval queue for press-outreach. A FIRST pitch (kind "pitch") and a
// late re-open of an old thread (kind "bump") never send without Sean's
// approval; the sender reads only status "approved".
//
// Drafts hold a writer's address, so they live under data/press/ (gitignored,
// in the `press` offsite backup) exactly like the contact book. Never commit one.
//
// Expiry runs from CREATION, not approval: a draft opens with "your piece last
// week", and approving it late does not make that sentence true again.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';

export const DRAFTS_DIR = 'data/press/drafts';
export const DRAFT_KINDS = Object.freeze(['pitch', 'bump']);
export const DRAFT_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'sent']);
export const DEFAULT_EXPIRY_DAYS = 14;
const EDITABLE = ['subject', 'text'];

const iso = (ms) => new Date(ms).toISOString();

export function newDraft({ kind, contactId, to, subject, text, inReplyTo = null, references = [], source = 'manual', targetUrl = null, openerQuote = null, products = [], concept, now = Date.now() }) {
  if (!DRAFT_KINDS.includes(kind)) throw new Error(`draft kind must be ${DRAFT_KINDS.join('/')}`);
  for (const [k, v] of Object.entries({ contactId, to, subject, text, concept })) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`draft needs ${k}`);
  }
  return {
    id: `${iso(now).slice(0, 10).replace(/-/g, '')}-${contactId}-${kind}`,
    kind, contact_id: contactId, to: to.toLowerCase(), subject, text,
    in_reply_to: inReplyTo, references, source, target_url: targetUrl, opener_quote: openerQuote,
    products, concept, status: 'pending', created_at: iso(now),
  };
}

function editable(d, verb) {
  if (d.status === 'sent') throw new Error(`cannot ${verb} a draft that was already sent`);
  if (d.status === 'expired') throw new Error(`cannot ${verb} an expired draft`);
}

export function approveDraft(d, { now = Date.now(), edits = {} } = {}) {
  editable(d, 'approve');
  const patch = {};
  for (const k of EDITABLE) if (typeof edits[k] === 'string' && edits[k].trim()) patch[k] = edits[k];
  return { ...d, ...patch, edited: Object.keys(patch).length > 0 || d.edited === true, status: 'approved', approved_at: iso(now) };
}

export function rejectDraft(d, { now = Date.now(), reason } = {}) {
  editable(d, 'reject');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('a rejection needs a reason');
  return { ...d, status: 'rejected', rejected_at: iso(now), rejected_reason: reason.trim() };
}

export function markSent(d, { now = Date.now(), messageId, resendId = null }) {
  if (d.status !== 'approved') throw new Error('only an approved draft can be sent');
  return { ...d, status: 'sent', sent_at: iso(now), message_id: messageId, resend_id: resendId };
}

export function expireDrafts(drafts, nowMs, days = DEFAULT_EXPIRY_DAYS) {
  const expired = [];
  const out = drafts.map((d) => {
    if (!['pending', 'approved'].includes(d.status)) return d;
    if (nowMs - Date.parse(d.created_at) <= days * 86_400_000) return d;
    const e = { ...d, status: 'expired', expired_at: iso(nowMs) };
    expired.push(e);
    return e;
  });
  return { drafts: out, expired };
}

export function sendOrder(drafts) {
  return drafts.filter((d) => d.status === 'approved')
    .sort((a, b) => a.approved_at.localeCompare(b.approved_at) || a.id.localeCompare(b.id));
}

export function loadDrafts(dir = DRAFTS_DIR, fsImpl = nodeFs) {
  let names = [];
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fsImpl.readFileSync(join(dir, n), 'utf8')));
}

export function saveDraft(dir = DRAFTS_DIR, d, fsImpl = nodeFs) {
  fsImpl.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${d.id}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fsImpl.renameSync(tmp, path);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/lib/press-drafts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/press-drafts.js tests/lib/press-drafts.test.js
git commit -m "feat(press-drafts): approval queue with expiry from creation"
```

---

### Task 4: Reply classification and address extraction

**Files:**
- Create: `lib/press-replies.js`
- Test: `tests/lib/press-replies.test.js`

**Interfaces:**
- Produces:
  - `extractUsAddress(text) -> {lines: string[], zip: string}|null`
  - `classifyReply(msg) -> { kind, reason, address? }`, where `kind` is one of `'ignore' | 'opt-out' | 'decline' | 'sample-yes' | 'address-given' | 'escalate'`
  - `classifyReply(msg, { awaitingAddress: true })` treats a bare address as `address-given`
  - `REPLY_KINDS`
- `msg` is the row shape from `fetchFromAllFolders` (`text` is quote-stripped, plus `emojiReaction` and `autoSubmitted`).

Order matters. The rules run in this order and the first match wins:

1. An auto-reply or emoji reaction is `ignore`.
2. An escalation trigger (money, terms, claims, anger, a question) is `escalate`, **even if it also contains a yes**.
3. An opt-out.
4. A decline.
5. A sample yes, which becomes `address-given` if an address is present.
6. A bare address while awaiting one is `address-given`.
7. Anything else is `escalate`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/press-replies.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, extractUsAddress } from '../../lib/press-replies.js';

const m = (text, over = {}) => ({ text, emojiReaction: false, autoSubmitted: false, ...over });

// Paraphrase of the real 2026-09-25 reply shape (invented address).
const YES_WITH_ADDRESS = `Hi Sean,\n\nThanks so much for reaching out. I'd love to sample the soap and body cream.\n\nHere is my shipping address:\n12 Example Road, Apt 3B\nSpringfield, IL 62704\n\nLooking forward to testing these out!`;

test('a yes that carries the address goes straight to address-given', () => {
  const r = classifyReply(m(YES_WITH_ADDRESS));
  assert.equal(r.kind, 'address-given');
  assert.equal(r.address.zip, '62704');
  assert.deepEqual(r.address.lines, ['12 Example Road, Apt 3B', 'Springfield, IL 62704']);
});

test('a yes with no address is sample-yes', () => {
  assert.equal(classifyReply(m("Sure, I'd love to try them!")).kind, 'sample-yes');
});

test('decline and opt-out', () => {
  assert.equal(classifyReply(m("I'm going to pass at this time, at max capacity.")).kind, 'decline');
  assert.equal(classifyReply(m('No thanks.')).kind, 'opt-out');
  assert.equal(classifyReply(m('Please remove me from your list')).kind, 'opt-out');
});

test('money, terms, claims or a question escalate even alongside a yes', () => {
  for (const t of [
    "Happy to try it! What's your rate for a sponsored placement?",
    'Love to. Do you have an affiliate program?',
    'Does the deodorant stop sweating?',
    'Is it safe for eczema?',
    'Can you send hi-res photos?',
    'This is the third email, stop spamming me',
  ]) assert.equal(classifyReply(m(t)).kind, 'escalate', t);
});

test('unclassifiable means escalate, never a guess', () => {
  assert.equal(classifyReply(m('Interesting, let me think about it.')).kind, 'escalate');
});

test('auto-replies and emoji reactions are ignored', () => {
  assert.equal(classifyReply(m('I am out of office', { autoSubmitted: true })).kind, 'ignore');
  assert.equal(classifyReply(m('Jane reacted via Gmail', { emojiReaction: true })).kind, 'ignore');
});

test('a bare address only counts when we asked for one', () => {
  const t = '12 Example Road\nSpringfield, IL 62704';
  assert.equal(classifyReply(m(t), { awaitingAddress: true }).kind, 'address-given');
  assert.equal(classifyReply(m(t)).kind, 'escalate');
});

test('two addresses is ambiguous', () => {
  assert.equal(extractUsAddress('1 A St\nX, NY 10001\nor\n2 B St\nY, CA 90001'), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/lib/press-replies.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/press-replies.js`**

```js
// lib/press-replies.js
//
// What a writer's reply means, decided by rules a person can read. The one
// rule that matters most: when in doubt, ESCALATE. An escalated reply reaches
// Sean in minutes and nothing goes back to the writer, which costs a little
// speed. A wrong automatic answer to a journalist costs the relationship.
//
// Escalation triggers are checked BEFORE yes/no: "Happy to! What's your rate?"
// is a money conversation, not a sample request.

export const REPLY_KINDS = Object.freeze(['ignore', 'opt-out', 'decline', 'sample-yes', 'address-given', 'escalate']);

const ESCALATE = [
  [/\b(rate|rates|fee|fees|pricing|price|cost|paid|pay|sponsor\w*|budget|invoice|commission|affiliate|media kit|rate card)\b/i, 'money or terms'],
  [/\b(contract|agreement|exclusiv\w*|usage rights|license|whitelist\w*)\b/i, 'terms'],
  [/\b(sweat\w*|antiperspirant|eczema|psoriasis|acne|rash|allerg\w*|safe (for|during)|pregnan\w*|cure|heal\w*|treat\w*|fda|cavit\w*|enamel)\b/i, 'health or claim question'],
  [/\b(spam\w*|stop emailing|harass\w*|annoy\w*|unprofessional|report you)\b/i, 'complaint'],
  [/\b(published|went live|featured you|included you|link to your|piece is up|article is up)\b/i, 'feature confirmed'],
  [/\?/, 'a question needs a real answer'],
];
const OPT_OUT = /^\s*(no,? thanks?|no thank you)[.!]?\s*$|\b(unsubscribe|remove me|take me off|do not (contact|email)|don'?t (contact|email) me)\b/i;
const DECLINE = /\b(pass(ing)? (on|at) this|i'?ll pass|going to pass|not a (good )?fit|not interested|no longer (covering|writing)|at (max|full) capacity|not taking (on )?(new )?(brands|pitches|products))\b/i;
const YES = /\b(i'?d love to|love to (try|test|sample)|happy to (try|test|sample|take)|sure[,!.]|yes[,!.]|send (it|them|some|me)|would love (some|to))\b/i;

const STREET = /^\s*\d{1,6}\s+[A-Za-z0-9.' -]+(,\s*(apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+)?\s*$/i;
const CITY_ZIP = /^\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s+(\d{5})(-\d{4})?\s*$/;

/** A single US street + city/state/ZIP pair, or null when absent or ambiguous. */
export function extractUsAddress(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hits = [];
  for (let i = 1; i < lines.length; i++) {
    const z = lines[i].match(CITY_ZIP);
    if (z && STREET.test(lines[i - 1])) hits.push({ lines: [lines[i - 1], lines[i]], zip: z[1] });
  }
  return hits.length === 1 ? hits[0] : null;
}

export function classifyReply(msg, { awaitingAddress = false } = {}) {
  if (msg.autoSubmitted) return { kind: 'ignore', reason: 'auto-reply' };
  if (msg.emojiReaction) return { kind: 'ignore', reason: 'emoji reaction' };
  const text = String(msg.text || '');
  const address = extractUsAddress(text);
  // An address line is not a question; strip it before the "?" rule looks.
  const scan = address ? text.replace(address.lines[0], '').replace(address.lines[1], '') : text;
  for (const [re, reason] of ESCALATE) if (re.test(scan)) return { kind: 'escalate', reason };
  if (OPT_OUT.test(text)) return { kind: 'opt-out', reason: 'asked not to be contacted' };
  if (DECLINE.test(text)) return { kind: 'decline', reason: 'declined' };
  if (YES.test(text)) return address ? { kind: 'address-given', reason: 'accepted with address', address } : { kind: 'sample-yes', reason: 'accepted' };
  if (address && awaitingAddress) return { kind: 'address-given', reason: 'sent the address we asked for', address };
  return { kind: 'escalate', reason: 'could not classify with confidence' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/lib/press-replies.test.js`
Expected: PASS. If a real-world phrasing in the tests fails, widen the pattern in the direction of **escalate**, never toward an automatic reply.

- [ ] **Step 5: Commit**

```bash
git add lib/press-replies.js tests/lib/press-replies.test.js
git commit -m "feat(press-replies): rule-based reply classification, escalate by default"
```

---

### Task 5: Outreach policy: window, cap ramp, templates, copy checks, auto-pause

**Files:**
- Create: `lib/press-outreach.js`
- Create: `config/press-outreach.json`
- Test: `tests/lib/press-outreach.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_CONFIG`
  - `inSendWindow(nowMs) -> bool`
  - `dailyCap(config, state, nowMs) -> number`
  - `signature(postalAddress) -> string`
  - `stripDashes(s) -> string`
  - `followUpText({ firstName, n }) -> string`
  - `bumpText({ firstName, originalSubject }) -> string`
  - `askAddressText({ firstName }) -> string`
  - `OPT_OUT_LINE`
  - `checkOutgoingCopy({ subject, text, kind }) -> { ok, problems: string[] }`
  - `shouldPause(sends) -> { pause: bool, reason }`
  - `firstName(contact) -> string`
- `state` shape (`data/press/outreach-state.json`):

```js
{
  first_sent_at, paused: { at, reason } | null,
  sends: [{ at, contact_id, kind, message_id, resend_id, last_event }],
  processed: [messageId], escalated: { [contactId]: { at, message_id } },
}
```

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/press-outreach.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, inSendWindow, dailyCap, signature, stripDashes, followUpText, bumpText,
  askAddressText, checkOutgoingCopy, shouldPause, OPT_OUT_LINE, firstName,
} from '../../lib/press-outreach.js';

const ADDR = '1 Example Way, Testville, WY 00000, United States';

test('send window is 16-24 UTC on weekdays', () => {
  assert.equal(inSendWindow(Date.parse('2026-10-05T16:00:00Z')), true);  // Monday
  assert.equal(inSendWindow(Date.parse('2026-10-05T15:59:00Z')), false);
  assert.equal(inSendWindow(Date.parse('2026-10-05T23:59:00Z')), true);
  assert.equal(inSendWindow(Date.parse('2026-10-10T18:00:00Z')), false); // Saturday
});

test('cap is 10 until 14 clean days after the first send, then 25; never ramps while paused', () => {
  const t = Date.parse('2026-10-20T18:00:00Z');
  assert.equal(dailyCap(DEFAULT_CONFIG, {}, t), 10);
  assert.equal(dailyCap(DEFAULT_CONFIG, { first_sent_at: '2026-10-07T17:00:00Z' }, t), 10);
  assert.equal(dailyCap(DEFAULT_CONFIG, { first_sent_at: '2026-10-05T17:00:00Z' }, t), 25);
  assert.equal(dailyCap(DEFAULT_CONFIG, { first_sent_at: '2026-10-01T17:00:00Z', paused: { at: 'x' } }, t), 0);
});

test('signature carries the postal address; templates carry no dashes', () => {
  assert.match(signature(ADDR), /1 Example Way/);
  for (const s of [followUpText({ firstName: 'Jane', n: 1 }), followUpText({ firstName: 'Jane', n: 2 }), bumpText({ firstName: 'Jane', originalSubject: 'X' }), askAddressText({ firstName: 'Jane' })]) {
    assert.doesNotMatch(s, /[—–]/);
    assert.ok(s.split(/\s+/).length <= 70, 'follow-ups stay short');
  }
  assert.equal(stripDashes('a — b – c'), 'a, b, c');
});

test('first pitch must carry the opt-out line and the address, and pass the claim gate', () => {
  const good = `Hi Jane,\n\nShort pitch.\n\n${OPT_OUT_LINE}\n\n${signature(ADDR)}`;
  assert.equal(checkOutgoingCopy({ subject: 'A coconut body cream', text: good, kind: 'pitch' }).ok, true);
  assert.match(checkOutgoingCopy({ subject: 's', text: 'no lines', kind: 'pitch' }).problems.join(), /opt-out/);
  assert.match(checkOutgoingCopy({ subject: 'Our natural antiperspirant', text: good, kind: 'pitch' }).problems.join(), /product-category|antiperspirant/);
  assert.match(checkOutgoingCopy({ subject: 'Heals eczema', text: good, kind: 'pitch' }).problems.join(), /eczema|heal/i);
  assert.match(checkOutgoingCopy({ subject: 'a — b', text: good, kind: 'pitch' }).problems.join(), /dash/);
  assert.equal(checkOutgoingCopy({ subject: 'x'.repeat(71), text: good, kind: 'pitch' }).ok, false);
});

test('auto-pause on >3% bounces over the last 50, or any complaint', () => {
  const sends = (bounced, complained = 0) => Array.from({ length: 50 }, (_, i) => ({ last_event: i < bounced ? 'bounced' : i < bounced + complained ? 'complained' : 'delivered' }));
  assert.equal(shouldPause(sends(1)).pause, false);
  assert.equal(shouldPause(sends(2)).pause, true);  // 4%
  assert.equal(shouldPause(sends(0, 1)).pause, true);
  assert.equal(shouldPause([{ last_event: 'bounced' }]).pause, false, 'fewer than 20 sends: rate not judged');
  assert.equal(shouldPause([{ last_event: 'complained' }]).pause, true, 'a complaint always pauses');
});

test('firstName falls back to "there" for an outlet record', () => {
  assert.equal(firstName({ name: 'Jane Doe', kind: 'journalist' }), 'Jane');
  assert.equal(firstName({ name: 'Example Magazine', kind: 'outlet' }), 'there');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/lib/press-outreach.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/press-outreach.js` and `config/press-outreach.json`**

```js
// lib/press-outreach.js
//
// Policy for agents/press-outreach: when mail may go out, how much, what the
// fixed messages say, and what every outgoing message must pass. Pure; the
// agent supplies time, state and config.
//
// The daily cap is a DOMAIN-REPUTATION limit, not a volume target. Cold mail
// from realskincare.com shares a sender reputation with Klaviyo and order
// email, so volume ramps only after two clean weeks, and any complaint stops
// everything until a human resumes it.

import { checkSeoCopyFields } from './seo-copy-health-gate.js';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  sendVia: 'resend',
  queueTarget: 25,
  dailySendCap: 10,
  dailySendCapRamped: 25,
  rampAfterDays: 14,
  editorialShare: 0.7,
  monthlySampleKits: 10,
  draftExpiryDays: 14,
  hunterUsageStop: 0.8,
  minGapMinutes: 10,
});

export const OPT_OUT_LINE = 'If this isn\'t a fit, just reply "no thanks" and I won\'t follow up.';
const SUBJECT_MAX = 70;
const PITCH_MAX_WORDS = 150;

export function inSendWindow(nowMs) {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  return day >= 1 && day <= 5 && d.getUTCHours() >= 16;
}

export function dailyCap(config, state, nowMs) {
  if (state?.paused) return 0;
  const first = state?.first_sent_at ? Date.parse(state.first_sent_at) : null;
  if (first && nowMs - first >= config.rampAfterDays * 86_400_000) return config.dailySendCapRamped;
  return config.dailySendCap;
}

export function signature(postalAddress) {
  return ['Sean', 'Real Skin Care', 'realskincare.com', postalAddress].join('\n');
}

export function stripDashes(s) {
  return String(s).replace(/\s*[—–]\s*/g, ', ');
}

export function firstName(contact) {
  if (contact?.kind === 'outlet') return 'there';
  const f = String(contact?.name || '').trim().split(/\s+/)[0];
  return f || 'there';
}

export function followUpText({ firstName: n, n: which }) {
  return which === 1
    ? `Hi ${n},\n\nJust floating this back up in case it got buried. Happy to send samples whenever suits you, and no worries at all if it's not a fit.\n\nSean`
    : `Hi ${n},\n\nLast note from me on this one. If samples would ever be useful for a future piece, just reply and I'll get them out to you.\n\nThanks,\nSean`;
}

export function bumpText({ firstName: n }) {
  return `Hi ${n},\n\nBumping this in case it got buried a couple of weeks back. The offer of samples still stands, and no worries at all if the timing isn't right.\n\nSean`;
}

export function askAddressText({ firstName: n }) {
  return `Hi ${n},\n\nWonderful, thank you! What's the best mailing address to send them to? I'll get them out right away and send tracking once they ship.\n\nSean`;
}

/** Everything an outgoing message must pass. Fixed templates are checked once in tests. */
export function checkOutgoingCopy({ subject, text, kind }) {
  const problems = [];
  if (/[—–]/.test(subject) || /[—–]/.test(text)) problems.push('contains an em or en dash');
  if (String(subject).length > SUBJECT_MAX) problems.push(`subject over ${SUBJECT_MAX} characters`);
  if (kind === 'pitch') {
    if (!text.includes(OPT_OUT_LINE)) problems.push('missing the opt-out line');
    if (!/\b\d{5}\b/.test(text.split(OPT_OUT_LINE)[1] || '')) problems.push('missing the postal address in the signature');
    const body = text.split(OPT_OUT_LINE)[0];
    if (body.trim().split(/\s+/).length > PITCH_MAX_WORDS) problems.push(`body over ${PITCH_MAX_WORDS} words`);
  }
  const gate = checkSeoCopyFields({ subject, body: text });
  for (const b of gate.blocking) problems.push(`${b.category}: "${b.match}" (${b.why})`);
  return { ok: problems.length === 0, problems };
}

export function shouldPause(sends) {
  const recent = (sends || []).slice(-50);
  if (recent.some((s) => s.last_event === 'complained')) return { pause: true, reason: 'a recipient marked our email as spam' };
  if (recent.length < 20) return { pause: false, reason: null };
  const bounced = recent.filter((s) => s.last_event === 'bounced').length;
  const rate = bounced / recent.length;
  return rate > 0.03
    ? { pause: true, reason: `${bounced} of the last ${recent.length} sends bounced (${(rate * 100).toFixed(1)}%)` }
    : { pause: false, reason: null };
}
```

`config/press-outreach.json`:

```json
{
  "_note": "agents/press-outreach. enabled:false stops every email. Defaults live in lib/press-outreach.js DEFAULT_CONFIG; any key here overrides it.",
  "enabled": true
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/lib/press-outreach.test.js`
Expected: PASS. If the claim-gate assertions fail, read `findSeoCopyClaims`'s categories in `lib/seo-copy-health-gate.js` and assert on the category it actually returns. Do not weaken the check.

- [ ] **Step 5: Commit**

```bash
git add lib/press-outreach.js config/press-outreach.json tests/lib/press-outreach.test.js
git commit -m "feat(press-outreach): send window, cap ramp, fixed templates, copy checks, auto-pause"
```

---

### Task 6: The agent run: replies, escalations, follow-ups, approved sends

**Files:**
- Create: `agents/press-outreach/index.js`
- Test: `tests/agents/press-outreach-run.test.js`

**Interfaces:**
- Consumes:
  - Tasks 1–5
  - `notify` from `lib/notify.js`
  - `hushmailCredentials`, `sendMail`, `fetchFromAllFolders`, `fetchSentTo`, `isTransientNetworkError` from `lib/hushmail.js`
- Produces:
  - `runPressOutreach({ apply, now, config, book, state, drafts, readReplies, readSent, send, saveBook, saveState, saveDraft, escalate, onAddress, postalAddress, log })`
  - It returns `{ replies, escalations, followUps, sent, skipped, expired, paused, imapDown }`.
  - Exported pure helper `escalationEmail(contact, msg, reason)`.
- `onAddress(contact, pitch, address)` is a no-op in PR 1. It records `sample-accepted` plus the address on the pitch and escalates to Sean ("address received, create the PR Package order"). PR 3 replaces it with automatic ordering.

**Run order inside `runPressOutreach`:**

1. **Expire drafts.** Save each expired one.
2. **Read mail.** For every address in `openPitchByAddress(book.contacts)`, read replies with `readReplies({ senders, since: now - 45d })` and Sean's sent mail with `readSent(...)`.
   - On a transient IMAP error: set `imapDown = true`, skip steps 3–5 entirely, and still allow step 6 (first pitches do not depend on silence).
3. **Sean's hand-sent mail.** A Sent-folder message to a contact, newer than the pitch's `last_sent_at`, counts as a touch:
   - set `last_sent_at` to its date
   - if that contact is escalated, clear `state.escalated[id]` and set the outcome to `'replied'`
   - set `follow_ups_sent` to `MAX_FOLLOW_UPS`, so no automatic follow-up lands on top of Sean's own conversation
4. **Each unprocessed reply** (`state.processed` does not include `messageId`), oldest first:
   - **Escalated contact.** Forward it to Sean (`escalate`), mark it processed, and stop: while escalated, every message goes to Sean.
   - Otherwise classify with `classifyReply(msg, { awaitingAddress: pitch.outcome === 'sample-accepted' })`:
     - `ignore`: mark it processed.
     - `opt-out`: contact status becomes `do_not_contact`, outcome `declined`. Send nothing.
     - `decline`: outcome becomes `declined`. Send nothing.
     - `sample-yes`: send `askAddressText` threaded under the reply. Outcome becomes `sample-accepted`. Counts toward the cap; if the cap is spent, leave the message unprocessed so it retries next run.
     - `address-given`: call `onAddress`.
     - `escalate`: outcome becomes `escalated`, set `state.escalated[id]`, call `escalate(contact, msg, reason)` (immediate notify). Send nothing to the writer.
   - Mark processed and save both the book and the state after **each** reply.
5. **Follow-ups**, only if `!imapDown`, `inSendWindow` holds and the cap remains. For each row of `autoFollowUpsDue(book.contacts, now)`, oldest pitch first:
   - send `followUpText` threaded (`inReplyTo` set to the pitch's `message_id`, `references` to its references plus that id), with subject `Re: <pitch.subject>`
   - then set `follow_ups_sent` to `n` and `last_sent_at` to now, and save
6. **Approved drafts**, if in the window, not paused and the cap remains. For each draft in `sendOrder(drafts)`:
   - Re-run `checkOutgoingCopy` (a dashboard edit could have broken it). A failure sets the draft back to `pending` with `gate_problems` and skips it.
   - Send it. A `bump` threads under its `in_reply_to`.
   - Save it as sent with `markSent`.
   - For a `pitch`: `recordPitch` with `{ date, concept, products, channel: 'email', subject, outcome: 'sent', message_id, references: [], last_sent_at, follow_ups_sent: 0, source, target_url, draft_id }`.
   - For a `bump`: `updatePitch` sets `follow_ups_sent: 1` and `last_sent_at`.
   - Set `state.first_sent_at` if unset.
7. **Spacing and bookkeeping.**
   - Never two sends in the same run less than `minGapMinutes` apart: one send per run is the simplest correct rule, because cron runs every 30 minutes. Implement it as "at most `ceil(30 / minGapMinutes)` sends per run". Each send appends to `state.sends` (`{at, contact_id, kind, message_id, resend_id, last_event: 'sent'}`).
   - **Cap accounting:** sends where `state.sends[].at` falls on today's UTC date, counted before each send.

- [ ] **Step 1: Write the failing tests** (`tests/agents/press-outreach-run.test.js`)

All I/O is injected, using `example.com` people. Build a helper `world()` that returns a book with three contacts, all with `message_id` set:
- **jane:** pitched `2026-10-01T17:00Z`, outcome `sent`
- **sam:** pitched with outcome `sent`
- **lee:** outcome `escalated`, `state.escalated.lee` set

`send` records its calls and returns `{ messageId: '<n@realskincare.com>', resendId: 'r' }`. `now` is `2026-10-06T18:00:00Z` (Monday, in the window).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPressOutreach } from '../../agents/press-outreach/index.js';
import { newDraft, approveDraft } from '../../lib/press-drafts.js';

const NOW = Date.parse('2026-10-06T18:00:00Z');
const contact = (id, pitchOver = {}, over = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }],
  pitches: [{ date: '2026-10-01', concept: 'intro', outcome: 'sent', subject: 'Coconut cream', message_id: `<${id}@realskincare.com>`, last_sent_at: '2026-10-01T17:00:00Z', follow_ups_sent: 0, ...pitchOver }],
  ...over,
});
function world({ replies = [], sent = [], drafts = [], state = {}, imapError = null } = {}) {
  const calls = { send: [], escalate: [], addresses: [] };
  const book = { contacts: [contact('jane'), contact('sam'), contact('lee', { outcome: 'escalated' })] };
  const st = { sends: [], processed: [], escalated: { lee: { at: '2026-10-02T00:00:00Z' } }, ...state };
  const opts = {
    apply: true, now: NOW, config: { enabled: true, sendVia: 'resend', dailySendCap: 10, dailySendCapRamped: 25, rampAfterDays: 14, draftExpiryDays: 14, minGapMinutes: 10 },
    book, state: st, drafts, postalAddress: '1 Example Way, Testville, WY 00000',
    readReplies: async () => { if (imapError) throw imapError; return replies; },
    readSent: async () => sent,
    send: async (m) => { calls.send.push(m); return { messageId: `<s${calls.send.length}@realskincare.com>`, resendId: 'r' }; },
    saveBook: (b) => { opts.book = b; }, saveState: () => {}, saveDraft: () => {},
    escalate: async (c, msg, reason) => { calls.escalate.push({ id: c.id, reason }); },
    onAddress: async (c, p, a) => { calls.addresses.push({ id: c.id, zip: a.zip }); },
    log: () => {},
  };
  return { opts, calls };
}
const reply = (from, text, id = `<r-${from}>`) => ({ from: `${from}@example.com`, messageId: id, text, date: '2026-10-05T10:00:00Z', emojiReaction: false, autoSubmitted: false, folder: 'Cold Pitches' });

test('a reply in a filed folder stops that contact\'s follow-up', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'm going to pass at this time.")] });
  await runPressOutreach(opts);
  assert.equal(opts.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'declined');
  assert.deepEqual(calls.send.map((m) => m.to), ['sam@example.com'], 'only sam gets the day-5 follow-up');
  assert.equal(calls.send[0].inReplyTo, '<sam@realskincare.com>');
  assert.equal(calls.send[0].subject, 'Re: Coconut cream');
});

test('yes plus address goes to onAddress, never asks for the address again', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them!\n\n12 Example Road\nSpringfield, IL 62704")] });
  await runPressOutreach(opts);
  assert.deepEqual(calls.addresses, [{ id: 'jane', zip: '62704' }]);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
});

test('escalate sends nothing to the writer; an escalated contact\'s next mail goes to Sean', async () => {
  const { opts, calls } = world({ replies: [reply('sam', 'What is your rate for a feature?'), reply('lee', 'Thanks!')] });
  await runPressOutreach(opts);
  assert.deepEqual(calls.escalate.map((e) => e.id).sort(), ['lee', 'sam']);
  assert.ok(!calls.send.some((m) => ['sam@example.com', 'lee@example.com'].includes(m.to)));
});

test('Sean writing to a contact himself counts as a touch: no automatic follow-up', async () => {
  const { opts, calls } = world({ sent: [{ to: ['sam@example.com'], date: '2026-10-05T12:00:00Z', messageId: '<hand>', subject: 'Re: Coconut cream' }] });
  await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'sam@example.com'));
});

test('IMAP down: no follow-ups, but approved first pitches still go', async () => {
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const d = approveDraft(newDraft({ kind: 'pitch', contactId: 'new', to: 'new@example.com', subject: 'Hi', text: `Hi.\n\nIf this isn't a fit, just reply "no thanks" and I won't follow up.\n\nSean\nReal Skin Care\nrealskincare.com\n1 Example Way, Testville, WY 00000`, concept: 'intro', now: NOW - 3600e3 }), { now: NOW - 1800e3 });
  const { opts, calls } = world({ imapError: err, drafts: [d] });
  opts.book.contacts.push({ id: 'new', name: 'New Example', status: 'active', domains: ['example.com'], channels: [{ type: 'email', address: 'new@example.com', verified: true, source: 'https://example.com' }], pitches: [] });
  const r = await runPressOutreach(opts);
  assert.equal(r.imapDown, true);
  assert.deepEqual(calls.send.map((m) => m.to), ['new@example.com']);
});

test('outside the window or paused: nothing sends', async () => {
  const sat = world(); sat.opts.now = Date.parse('2026-10-10T18:00:00Z');
  await runPressOutreach(sat.opts);
  assert.equal(sat.calls.send.length, 0);
  const paused = world({ state: { paused: { at: 'x', reason: 'complaint' } } });
  await runPressOutreach(paused.opts);
  assert.equal(paused.calls.send.length, 0);
});

test('dry run sends and saves nothing', async () => {
  const { opts, calls } = world();
  let saved = false; opts.apply = false; opts.saveBook = () => { saved = true; };
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 0);
  assert.equal(saved, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/agents/press-outreach-run.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `agents/press-outreach/index.js`**

The file has these parts:

- A header docstring (usage, modes, cron, off switch, state paths, the privacy note).
- `loadEnv`, copied from `agents/creator-outreach/index.js` (the same 12 lines).
- `loadConfig()`, merging `DEFAULT_CONFIG` with `config/press-outreach.json`.
- `readState()` / `writeState()`, atomic, at `data/press/outreach-state.json`.
- `readBook()` / `writeBook(doc)`:
  - Read: `loadContacts(PRESS_CONTACTS_PATH, { readFile: (p) => readFileSync(join(ROOT, p), 'utf8') })`.
  - Write: first copy the current file to `data/press/backups/contacts-<stamp>.json` (create the dir), then write temp + rename after `validateContacts(doc).ok`. Throw if invalid.
- `runPressOutreach(...)`, implementing the run order above. In dry run (`apply: false`), `send`, `saveBook`, `saveState`, `saveDraft` and `escalate` are replaced by functions that only log what would happen.
- `escalationEmail(contact, msg, reason)`:
  - Returns `{ subject: 'Press outreach: <name> needs your reply', body }`.
  - The body includes the reason, the outlet, the pitch subject, the writer's full message (`msg.fullText`), and "Reply to them from Hushmail. Your reply is detected automatically and the agent picks the thread back up."
- `renderSummary(run, { apply })`: one deferred digest row with the counts.
  - It also lists the 5 oldest pending drafts as "N pitches waiting for approval: <dashboard URL>/#outreach".
  - Read the dashboard URL from the `DASHBOARD_URL` env var or `config/site.json` if present; otherwise print the path only.
- `main()`:
  - `--test-send <addr>`: one email through `sendMail(..., { agent: 'press-outreach' })`.
  - `--resume`: clears `state.paused`.
  - `--backfill` (Task 8).
  - The default run takes a lock file at `data/press/.lock`, the same 25-minute staleness rule as creator-outreach.
  - It refuses with `--apply` when the book is unavailable (`notify` with `status: 'error'`, once per day via a dated marker file, the same pattern as creator-outreach's missing-state refusal).
  - After sending, it refreshes Resend events: for up to 20 `state.sends` entries with `last_event: 'sent'` and `at` older than 1 hour, `GET https://api.resend.com/emails/<resend_id>` with `Authorization: Bearer RESEND_API_KEY`, then set `last_event` from the response `last_event`. Then `shouldPause(state.sends)`; on pause, set `state.paused` and `notify({ immediate: true, status: 'info', subject: 'Press outreach PAUSED', body: reason + ' Run node agents/press-outreach/index.js --resume after checking Resend.' })`.
- The `isDirectRun` guard, with the same transient-IMAP streak handling as creator-outreach (import `transientStreak` and `TRANSIENT_ESCALATE_AFTER` from `agents/creator-outreach/index.js`, never copy them; give press-outreach its own streak file at `data/press/.transient-failures.json`).

**Sends go through** `send = (m) => sendMail(creds, { ...m, agent: 'press-outreach' }, { via: config.sendVia, resendKey: env.RESEND_API_KEY, agent: 'press-outreach' })`.

**Replies go through** `readReplies = (q) => fetchFromAllFolders(creds, q)`. Sean's sent mail goes through `readSent = (q) => fetchSentTo(creds, { recipients: q.senders, since: q.since })`.

**`postalAddress`** comes from `JSON.parse(readFileSync('data/brand/brand-kit.json')).postal_address`. If it is missing, refuse to send first pitches (bumps and follow-ups don't need it) and say so in the summary.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/agents/press-outreach-run.test.js`
Expected: PASS, cancelled 0.

- [ ] **Step 5: Add the source-scan safety test** (append to the same file)

```js
import { readFileSync } from 'node:fs';
test('source: first pitches send only when approved, never via the Gmail connector', () => {
  const src = readFileSync(new URL('../../agents/press-outreach/index.js', import.meta.url), 'utf8');
  assert.match(src, /sendOrder\(/, 'first pitches come from sendOrder (approved only)');
  assert.doesNotMatch(src, /claude_ai_Gmail|gmail\.googleapis/i);
  assert.match(src, /agent: 'press-outreach'/);
});
```

Run: `node --test tests/agents/press-outreach-run.test.js`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agents/press-outreach/index.js tests/agents/press-outreach-run.test.js
git commit -m "feat(press-outreach): agent run, replies, escalation, follow-ups, approved sends"
```

---

### Task 7: Dashboard Outreach tab

**Files:**
- Create: `agents/dashboard/routes/press-outreach.js`
- Modify: `agents/dashboard/index.js` (import and spread the routes next to `ideasRoutes`)
- Modify: `agents/dashboard/public/index.html` (tab pill + panel)
- Modify: `agents/dashboard/public/js/dashboard.js` (add `renderOutreachTab`, hooked into `switchTab`)
- Test: `tests/dashboard/press-outreach-routes.test.js`

**Interfaces:**
- Consumes: `loadDrafts`, `saveDraft`, `approveDraft`, `rejectDraft` (Task 3); `checkOutgoingCopy` (Task 5); `readJsonBody`, `respondJson` from `agents/dashboard/lib/responses.js`.
- Routes, all reading the drafts dir as `join(ctx.ROOT, DRAFTS_DIR)` so tests can point `ctx.ROOT` at a temp dir:

| Route | Behaviour |
|---|---|
| `GET /api/press/drafts` | `{ ok, drafts }`: pending and approved only, newest first, each with its `gate` check (`checkOutgoingCopy`) |
| `PATCH /api/press/drafts/:id` | body `{subject?, text?}`; dashes stripped, re-gated; a failing gate saves the edit but answers `{ ok:false, problems }` with 422 |
| `POST /api/press/drafts/:id/approve` | refuses (422) when the gate fails |
| `POST /api/press/drafts/approve` | body `{ ids: [] }`, approve many; returns per-id results |
| `POST /api/press/drafts/:id/reject` | body `{ reason }` |

- [ ] **Step 1: Write the failing route test**

Follow the shape of `tests/dashboard/ideas`-style tests: call the route handlers directly with fake `req`/`res`. Look at `tests/dashboard/ad-brief-routes.test.js` for the existing harness and reuse its fake request/response helpers. Cases:
1. GET lists a pending draft from a temp `ctx.ROOT`.
2. Approving a draft whose text has no opt-out line returns 422 and leaves it pending.
3. Approving a good draft sets `status: 'approved'`.
4. Reject without a reason returns 400.
5. Approve-many approves the good ids and reports the bad one.
6. PATCH with an em dash stores a dash-free text.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/dashboard/press-outreach-routes.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the route module**

Model it on `agents/dashboard/routes/ideas.js`: an exported default array of `{ method, match, handler }`, async handlers wrapped in try/catch, and bodies read with `readJsonBody`. Ids are validated with `/^[0-9]{8}-[a-z0-9-]+-(pitch|bump)$/` before any file access. A bad id returns 400, which prevents path traversal.

- [ ] **Step 4: Implement the UI**

- In `index.html`, next to the Ideas pill: `<button class="tab-pill" onclick="switchTab('outreach',this)" id="pill-outreach">Outreach</button>`, plus a panel `<div id="tab-outreach" class="tab-panel"><div id="outreach-panel"></div></div>`.
- In `dashboard.js`:
  - `switchTab` gains `if (name === 'outreach') renderOutreachTab();`
  - Each draft renders as a card: To, outlet/target URL (link), the opener quote, an editable subject input and body textarea, the gate problems in red, and Approve / Reject buttons.
  - A top bar has "Approve all clean" (POSTs the ids with no gate problems to `/api/press/drafts/approve`) and a count of pending drafts.
  - Reject prompts for a reason with `prompt()`.
  - Escape all text with the file's existing HTML-escape helper (find it with `grep -n "function esc" agents/dashboard/public/js/dashboard.js`). Never interpolate a writer's text unescaped.
  - Opening `/#outreach` selects the tab: on load, `if (location.hash === '#outreach') switchTab('outreach', document.getElementById('pill-outreach'))`.

- [ ] **Step 5: Run the tests and smoke-test locally**

Run: `node --test tests/dashboard/press-outreach-routes.test.js tests/dashboard/router-guard.test.js tests/dashboard/static.test.js`. Expected: PASS.

Then start the dashboard locally (`node agents/dashboard/index.js`), drop one fake draft JSON into `data/press/drafts/`, open `http://localhost:4242/#outreach`, and approve, edit and reject it. Delete the fake draft afterwards.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/routes/press-outreach.js agents/dashboard/index.js agents/dashboard/public/index.html agents/dashboard/public/js/dashboard.js tests/dashboard/press-outreach-routes.test.js
git commit -m "feat(dashboard): Outreach tab to approve, edit and reject pitch drafts"
```

---

### Task 8: Backfill the September campaign, cron, backup, privacy test, ship PR 1

**Files:**
- Modify: `agents/press-outreach/index.js` (the `--backfill` mode)
- Modify: `scripts/setup-cron.sh`
- Modify: `scripts/backup-snapshots-offsite.sh`
- Modify: `tests/repo/press-contacts-private.test.js`
- Test: `tests/agents/press-outreach-backfill.test.js`

**Interfaces:**
- Produces `planBackfill({ book, sentCopies, replies, now, postalAddress }) -> { patches: [{id, patch}], drafts: draft[], notes: string[] }`, pure and exported.

The backfill does three things:
1. **Thread ids.** For every contact whose latest pitch is `outcome: 'sent'` with an email channel and no `message_id`, find the Sent copy (`fetchSentTo` rows matched on recipient and the pitch's subject, case-insensitive) and patch in `message_id`, `subject` and `last_sent_at`. A pitch with no Sent copy is listed in `notes` and gets no follow-up.
2. **Existing replies.** Run every reply since the pitch date through `classifyReply`, without acting. Report each with its classification in `notes`, and patch only `decline` and `opt-out` automatically. Everything else is listed for Sean.
   - **Known case:** Saleam Singleton's sample shipped by hand as #2373. The backfill CLI sets that explicitly with `--set <contact-id>=samples-sent:#2373`, applied as `updatePitch(..., { outcome: 'samples-sent', sample_order: '#2373' })`.
3. **Bump drafts.** For each pitch still `sent`, with a `message_id`, and older than 12 days, create one `bump` draft (`bumpText`, subject `Re: <subject>`, `inReplyTo` set to `message_id`). Bumps wait for Sean's approval in the Outreach tab.

- [ ] **Step 1: Write the failing test** for `planBackfill`:
1. A sent pitch with a matching Sent copy gets a `message_id` patch and a bump draft.
2. A pitch with no Sent copy gets a note and no draft.
3. A decline reply patches `declined` and makes no draft.
4. A yes reply is reported in notes, not patched.

- [ ] **Step 2: Run to verify failure, implement `planBackfill` and the `--backfill [--apply] [--set id=outcome:order]` CLI, then run to verify it passes**

Run: `node --test tests/agents/press-outreach-backfill.test.js`. Expected: PASS.

- [ ] **Step 3: Extend the privacy test** in `tests/repo/press-contacts-private.test.js`

Add assertions that `git check-ignore data/press/drafts/x.json` and `data/press/outreach-state.json` both succeed (are ignored) and that `git ls-files data/press` is empty. Copy the existing test's mechanism for running git.

- [ ] **Step 4: Backup**

In `scripts/backup-snapshots-offsite.sh` set 3 (`press`), change the tar to include the drafts dir and the state file when present. **Check that each path exists before adding it** to the tar arguments, so a missing drafts dir does not fail the backup:

```bash
PRESS_PATHS=("$PRESS_BOOK")
[ -d "$ROOT/data/press/drafts" ] && PRESS_PATHS+=("data/press/drafts")
[ -f "$ROOT/data/press/outreach-state.json" ] && PRESS_PATHS+=("data/press/outreach-state.json")
tar czf "$press_archive" -C "$ROOT" "${PRESS_PATHS[@]}"
```

Update that set's header comment to name the two new paths.

- [ ] **Step 5: Cron**

On the server, run `crontab -l | grep -vE '^\s*#'` and confirm minutes `5,35` are not used by another `*/30`-style job (creator-outreach runs on `*/30`, i.e. `:00` and `:30`). Then add to `scripts/setup-cron.sh`, next to `CREATOR_OUTREACH`, and add `$PRESS_OUTREACH` to the install list:

```bash
# Press outreach: replies, follow-ups and Sean-approved pitches (agents/press-outreach).
# Offset to :05/:35 so it never shares an IMAP login minute with creator-outreach.
PRESS_OUTREACH="5,35 * * * * cd \"$PROJECT_DIR\" && $NODE agents/press-outreach/index.js --apply >> data/reports/scheduler/press-outreach.log 2>&1"
```

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -15`
Expected: `# fail 0`, `# cancelled 0`.

- [ ] **Step 7: Commit, open the PR, merge, deploy, run the backfill on the server**

```bash
git add -A agents/press-outreach scripts/setup-cron.sh scripts/backup-snapshots-offsite.sh tests
git commit -m "feat(press-outreach): backfill September campaign, cron, backup"
git push -u origin HEAD && gh pr create --title "press-outreach PR 1: sender, follow-ups, replies, approval queue" --body "<summary of tasks 1-8, test results>"
```

After merge, deploy (see "The stash dance is RETIRED" in CLAUDE.md for the gated deploy) and restart `seo-dashboard`. Then on the server:

```bash
node agents/press-outreach/index.js --test-send fillmoreecommercesolutions@gmail.com     # confirm delivery + Sent copy
node agents/press-outreach/index.js --backfill                                        # read the plan
node agents/press-outreach/index.js --backfill --apply --set saleam-singleton=samples-sent:#2373
node agents/press-outreach/index.js                                                   # dry run: expect 0 sends, bumps pending
```

Confirm the contact id with `node scripts/press-contacts.mjs` before using `--set`. Then install the cron line live (`crontab -e` or re-run `scripts/setup-cron.sh`) and run the mirror diff from CLAUDE.md.

**Verify live:** bump drafts appear at `/#outreach`; the next `:05`/`:35` run logs "N pitches waiting". After Sean approves one, it sends inside the window and the contact book shows `follow_ups_sent: 1`.

---

# PR 2: prospect queue, address finder, drafting

### Task 9: Prospect queue

**Files:**
- Create: `lib/press-prospects.js`
- Test: `tests/lib/press-prospects.test.js`

**Interfaces:**
- Consumes:
  - `pr-targets/latest.json` `pitch_targets[]` rows, with fields `domain`, `pitch_url`, `top_url`, `author`, `author_url`, `publication`, `author_rejected`, `stale_article`, `likely_store`, `angle`, `competitors`, `prompts`, `score`, `enrich_fetch`, `already_contacted`
  - `data/backlinks/opportunities.json` `{ opportunities: [{ domain, rank, dofollow, competitors, score }] }`
  - `eligibleFor`, `contactsByDomain`, `splitDomainHits`, `normalizeDomain` (Task 1)
- Produces:
  - `buildProspects({ prTargets, linkGap, contacts, existingDrafts, today, want, editorialShare=0.7 }) -> { prospects: Prospect[], skipped: [{domain, reason}] }`
  - `Prospect = { key, source: 'pr-target'|'link-gap', domain, targetUrl, person: {name, authorUrl}|null, publication, competitors, prompts, angle, rank }`

**Rules:**
- **Editorial rows are dropped when:**
  - `author` is falsy or `author_rejected` is set (no person to pitch)
  - `likely_store`
  - `stale_article`
  - `enrich_fetch !== 'ok'`
  - the domain has a **pitched** contact (`splitDomainHits(...).pitched.length`) whose last pitch is inside the 60-day cooldown
  - a pending or approved draft already exists for that domain
- **Link-gap rows are dropped when:**
  - `dofollow === false`
  - the domain is already in the book
  - the same domain is in the editorial list (editorial wins)
- **Fill:** `ceil(want * editorialShare)` editorial, the rest link-gap, each in its source order. A shortfall on either side is filled from the other.
- **Every drop gets a reason** in `skipped`, so a short queue is never a mystery.

- [ ] **Step 1: Write the failing tests.** Fixtures: 4 editorial rows (one with no author, one stale, one on a domain pitched 10 days ago, one good) and 3 link-gap rows (one nofollow, one overlapping an editorial domain, one good). Then assert:
  1. `buildProspects({ want: 2 })` returns the good editorial row first, then the good link-gap row.
  2. Each dropped row appears in `skipped` with a reason containing `no author`, `stale`, `pitched`, `nofollow` or `editorial` respectively.
  3. With `want: 5` the result is 2 (no padding).
- [ ] **Step 2: Run to verify failure.** Run: `node --test tests/lib/press-prospects.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the rules above as `buildProspects`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** with message `feat(press-prospects): slotted prospect queue from both target lists`.

---

### Task 10: Address finder

**Files:**
- Create: `lib/contact-finder.js`
- Test: `tests/lib/contact-finder.test.js`

**Interfaces:**
- Produces, pure:
  - `extractEmails(html) -> string[]`: from `mailto:` and text, deobfuscating `name [at] domain [dot] com`, lowercased, deduped
  - `pickPersonalEmail(emails, { name, domains }) -> string|null`: keeps a local part containing the first or last name (or first initial + last name), on one of `domains` or a free-mail domain
  - `pickOutletEmail(emails, domain) -> string|null`: for link-gap sites only; prefers `editor|editorial|hello|contact|info|team|partnerships|pr` on the site's own domain
- Produces, with I/O:
  - `findAddress(prospect, { fetchPage, tavilySearch, hunter, budget }) -> { address, source, verified, spentHunter } | { address: null, reason }`
  - `hunterClient(apiKey, fetchImpl) -> { account(), finder({domain, first_name, last_name}), domainSearch(domain), verify(email) }`
  - `hunterBudgetOk(account, stopAt=0.8) -> bool`

**Free pass, in order:**
1. `fetchPage(person.authorUrl)`
2. `fetchPage(targetUrl)`
3. the outlet or personal site's `/contact`, `/about`, `/contact-us` (link-gap: the site root and these)
4. `tavilySearch('"<name>" email <publication>')`, keeping results whose URL host is the outlet's domain or a page owned by the person (host contains their last name)

Then `pickPersonalEmail` for editorial prospects, or `pickOutletEmail` for link-gap ones. A free hit returns `source: 'published:<url>', verified: true`.

**Hunter fallback**, only if the free pass finds nothing and `hunterBudgetOk` holds:
- editorial: `finder` using the publication's domain and the split name
- link-gap: `domainSearch`, taking the highest-`confidence` generic or editorial address

Then `verify`. **Only `data.status === 'valid'` passes**, returning `source: 'hunter:verified:<YYYY-MM-DD>'`. Every other status returns `{ address: null, reason: 'hunter: <status>' }`.

**Hunter endpoints:**
- `GET https://api.hunter.io/v2/account?api_key=K`
- `.../email-finder?domain=&first_name=&last_name=&api_key=K`
- `.../domain-search?domain=&limit=10&api_key=K`
- `.../email-verifier?email=&api_key=K`

Responses are `{ data, errors? }`. `account().data.requests.searches|verifications.{used,available}`, as measured live on 2026-10-04.

- [ ] **Step 1: Write the failing tests:**
  1. `extractEmails` finds `mailto:Jane@Example.com`, `jane [at] example [dot] com`, and ignores `image@2x.png`.
  2. `pickPersonalEmail` picks `jane.doe@example.com` over `ads@example.com` for Jane Doe.
  3. `findAddress` returns the free hit without calling Hunter (the stub throws if called).
  4. It falls back to Hunter and accepts `valid`.
  5. It rejects `accept_all`.
  6. It does not call Hunter when `account` shows 800 of 1000 used.
  7. A `fetchPage` that returns `{ outcome: 'blocked' }` falls through to the next source rather than failing.
- [ ] **Step 2: Run to verify failure.** Run: `node --test tests/lib/contact-finder.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** `fetchPage` is injected; the agent passes `(url) => fetchWithOutcome(url)` from `lib/fetch-pool.js`. A result is usable only when `outcome === 'ok'`. `tavilySearch` is `POST https://api.tavily.com/search` with `{ api_key, query, max_results: 5 }`, returning `results[].{url, content}`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** with message `feat(contact-finder): published addresses first, Hunter verified-only fallback`.

---

### Task 11: Pitch drafting

**Files:**
- Create: `lib/press-pitch.js`
- Test: `tests/lib/press-pitch.test.js`

**Interfaces:**
- Consumes:
  - `gateGeneratedCopy` from `lib/seo-copy-gate-loop.js`
  - `SEO_COPY_COMPLIANCE_RULE` from `lib/seo-copy-health-gate.js`
  - `OPT_OUT_LINE`, `signature`, `stripDashes`, `checkOutgoingCopy` (Task 5)
- Produces:
  - `buildFactSheet(catalog, brandKit) -> string`: plain-language facts per product, drawn only from `data/brand/product-catalog.json` (names, key ingredients, ingredient counts as stated there) and `brand-kit.json` (handmade in small batches, made in the USA, family business). No other facts.
  - `pickProducts(prospect) -> string[]` from `PRODUCTS`, matching the prospect's prompts and angle (lotion, cream, soap, deodorant, toothpaste, lip balm keywords), at most 2, defaulting to `['lotion','soap']`.
  - `pitchPrompt({ prospect, articleText, factSheet, products }) -> string`
  - `quoteAppears(quote, articleText) -> bool`: normalized (lowercase, collapsed whitespace, curly quotes straightened), length 12 to 200
  - `draftPitch({ prospect, articleText, factSheet, generate, postalAddress, contact }) -> { ok, draft?: {subject, text, openerQuote, products}, reason? }`

**The prompt asks the model for JSON** `{ "subject": "...", "opener_quote": "...", "body": "..." }` and states these rules:
- `opener_quote` is copied verbatim from the article, 12–200 characters.
- The body's first sentence references that detail specifically.
- One product angle, chosen for this page.
- At most 120 words in the body.
- Offer to send samples.
- No em dashes.
- Only facts from the fact sheet.
- Never "antiperspirant"; deodorant is odor-only.
- `SEO_COPY_COMPLIANCE_RULE` is included verbatim.
- For link-gap prospects: name the page that links to `<competitors>` and suggest Real Skin Care as an addition.

**`draftPitch`:**
1. Calls `gateGeneratedCopy(generate, { extract: (r) => ({ subject: r.subject, body: r.body }), required: ['subject','body'], extraChecks: [quoteCheck] })`, where `quoteCheck = { check: (f) => quoteAppears(lastResult.opener_quote, articleText) ? [] : [{ field: 'opener', category: 'fabricated-opener', why: 'opener_quote not found in the article', match: '(quote)' }], constraint: () => 'Your opener_quote does not appear in the article. Copy a sentence or phrase from it exactly.' }`. Capture `lastResult` in a closure around `generate`.
2. If ok: `text = stripDashes(body) + '\n\n' + OPT_OUT_LINE + '\n\n' + signature(postalAddress)`, with a greeting `Hi <firstName>,` prepended.
3. Run `checkOutgoingCopy({ subject, text, kind: 'pitch' })`. A failure returns `{ ok: false, reason }`.

- [ ] **Step 1: Write the failing tests:**
  1. `quoteAppears` is true for a phrase with curly quotes against straight-quoted text, and false for a paraphrase.
  2. With a stub `generate` returning a fabricated quote twice, `draftPitch` returns `ok: false` with a reason mentioning `fabricated-opener` and **made two calls**.
  3. With a stub returning a real quote and "our natural antiperspirant" on the first call and clean copy on the second, it returns ok on attempt 2.
  4. The final text ends with the opt-out line and the signature, and has no em dash.
  5. `buildFactSheet` contains no word absent from the catalog or brand kit inputs. Use small fake `catalog` and `brandKit` objects in the test.
- [ ] **Step 2: Run to verify failure.** Run: `node --test tests/lib/press-pitch.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** with message `feat(press-pitch): personalized drafts with verified opener quote and claim gates`.

---

### Task 12: The `--draft` mode, daily cron, ship PR 2

**Files:**
- Modify: `agents/press-outreach/index.js`
- Modify: `scripts/setup-cron.sh`
- Test: `tests/agents/press-outreach-draft.test.js`

**Interfaces:**
- Produces `runDrafting({ apply, now, config, book, drafts, prTargets, linkGap, findAddress, fetchArticle, draftPitch, saveDraft, saveBook, log }) -> { drafted, noAddress, failed, skipped }`

**Flow:**
1. `want = config.queueTarget - pendingCount` (pending plus approved-unsent). If `want <= 0`, do nothing.
2. `buildProspects`.
3. For each prospect, until `want` drafts have been made or prospects run out:
   1. `findAddress`. With no address:
      - **editorial:** upsert a contact with status `unverified` and no email channel (id is a kebab-case of the name, suffixed `-<domain-stem>` on collision), add a note naming the manual channel to try, and count it in `noAddress`
      - **link-gap:** record it in `skipped`
   2. `fetchArticle(targetUrl)`. Strip tags to text. A failed fetch counts as failed and the prospect is retried next day: track `state.draft_attempts[key]` and skip after 2.
   3. `draftPitch`. A failure is recorded with its reason.
   4. On success: upsert the contact (status `active`, the email channel with `verified: true, source`, `domains`, `kind: 'journalist'` or `'outlet'`, `outlets: [publication]`), then `saveDraft(newDraft({ kind: 'pitch', ... }))`.
4. **Digest:** one deferred notify with the counts and "N pitches waiting for approval".

**Cron:** check `crontab -l` for a free minute; 14:10 UTC is the proposal, after pr-target-finder's Sunday run and before the 16:00 send window opens. Add:

```bash
PRESS_OUTREACH_DRAFT="10 14 * * * cd \"$PROJECT_DIR\" && $NODE agents/press-outreach/index.js --draft --apply >> data/reports/scheduler/press-outreach-draft.log 2>&1"
```

- [ ] **Step 1: Write the failing orchestration test** with all I/O stubbed:
  1. With `queueTarget: 3` and 1 pending draft, exactly 2 drafts are made.
  2. A prospect with no address creates an `unverified` contact and no draft.
  3. A failed article fetch drafts nothing for that prospect.
  4. Dry run saves nothing.
- [ ] **Step 2: Run, implement, run to pass.** Run: `node --test tests/agents/press-outreach-draft.test.js`.
- [ ] **Step 3: Live test on ONE prospect before enabling cron** (Development Rule 4). On the server, run `node agents/press-outreach/index.js --draft --apply --limit 1`; add a `--limit` option that overrides `want`. Open `/#outreach`, read the draft, and confirm:
  - the opener quote really is on the target page
  - facts are correct
  - there are no dashes
  - the address source is shown
  
  Fix anything wrong before continuing.
- [ ] **Step 4: Full suite, commit, PR, merge, deploy, install the cron line live, run the mirror diff.**

```bash
npm test 2>&1 | tail -15
git add -A lib agents/press-outreach scripts/setup-cron.sh tests
git commit -m "feat(press-outreach): daily drafting from both target lists"
```

---

# PR 3: samples

### Task 13: Automatic sample orders

**Files:**
- Create: `lib/press-samples.js`
- Modify: `agents/press-outreach/index.js` (replace the PR 1 `onAddress`; add the tracking email)
- Modify: `config/press-outreach.json` (add `sampleVariants`)
- Test: `tests/lib/press-samples.test.js`

**Interfaces:**
- Produces:
  - `SAMPLE_TAGS = ['PR Package','press-outreach']`
  - `countMonthKits(orders, nowMs) -> number`: orders tagged `PR Package` created this UTC calendar month, not cancelled
  - `planSample({ pitch, address, config, monthKits }) -> { ok, lines: [{variantId, quantity}], reason? }`
  - `buildDraftOrderInput({ contact, pitch, address, lines }) -> object`
  - `createSampleOrder(input, { graphql }) -> { name }`
  - `fetchPrPackageOrders({ sinceDays, graphql }) -> orders`
  - `trackingText({ firstName, url }) -> string`

**Behaviour:**
- **`sampleVariants`** in config maps a `PRODUCTS` key to one Shopify variant GID. The entries are filled by looking them up. On the server:

  ```bash
  node -e "const {shopifyGraphQL}=await import('./lib/shopify.js');const r=await shopifyGraphQL('{products(first:50){nodes{title variants(first:20){nodes{id title}}}}}');console.log(JSON.stringify(r.products?.nodes||r.data.products.nodes,null,1))" --input-type=module
  ```

  Map `lotion`, `body-cream`, `soap`, `hand-soap`, `deodorant`, `toothpaste`, `lip-balm` to the **Pure Unscented** (or base) variant. Commit only GIDs, never addresses.
- **`planSample` refuses when:**
  - `monthKits >= config.monthlySampleKits` (reason `over monthly cap`)
  - a pitch product has no `sampleVariants` entry (reason `no variant mapped for X`)
- **On refusal** the agent escalates to Sean with the reason and the address.
- **Order creation:**
  - `buildDraftOrderInput`: line items at a 100% `appliedDiscount` (`{ valueType: 'PERCENTAGE', value: 100, title: 'PR sample' }`), `shippingAddress` built from the parsed address, `tags: SAMPLE_TAGS`, and the note `press-outreach: <contact.id> / <pitch.concept>`.
  - `createSampleOrder` runs `draftOrderCreate`, then `draftOrderComplete(id, paymentPending: false)`.
  - Throw on `userErrors`.
  - **First validate both mutations** with the Shopify dev MCP (`mcp__shopify-dev__validate`) against API version `2026-07` from `lib/shopify-api-version.js`.
- **Parsing the address:** split the address into `address1`/`address2` on `, Apt|Unit|Suite|#`, and the city line into `city`, `provinceCode` and `zip`. `firstName`/`lastName` come from the contact name, `countryCode: 'US'`.
- **After the order:** record `outcome: 'samples-sent'` and `sample_order: <name>`, then send a short thanks ("They're on the way; I'll send tracking as soon as it ships"), threaded.
- **Tracking:** each run (in the window, under the cap), find contacts with `samples-sent`, a `sample_order` and no `tracking_sent_at`. Look the order up (`orders(query: "name:#NNNN")`, as in `lib/trybe-sample-orders.js`), and once a fulfillment has `trackingInfo.url`, send `trackingText` and record `tracking_sent_at`.
- **Day-21 check-in:** 21 days after `deliveredAt`, send one check-in if there is no reply since the tracking email: "Hope you've had a chance to try them. If photos or details would help with anything you're writing, just reply." Then record `checkin_sent_at`. Add `tracking_sent_at` and `checkin_sent_at` to the validated optional ISO datetime fields in Task 1's validator.
- **Revenue exclusion test:** in `tests/lib/press-samples.test.js`, import the function in the Shopify snapshot collector that sets `countsAsRevenue` (find it with `grep -rn "countsAsRevenue" lib agents --include='*.js' | grep -v test`) and assert that a $0 order tagged `PR Package` gets `countsAsRevenue: false`. If that logic lives in an agent that cannot be imported, add a source-scan assertion instead and say so in the test.

- [ ] **Step 1: Write the failing tests:**
  1. Cap counting ignores last month's and cancelled orders.
  2. `planSample` refuses over the cap and for an unmapped product.
  3. The draft-order input has the tags, a 100% discount and the parsed address (`12 Example Road`, `Apt 3B`, `Springfield`, `IL`, `62704`).
  4. `createSampleOrder` throws on `userErrors`.
  5. `trackingText` has no dash.
  6. The countsAsRevenue assertion.
- [ ] **Step 2: Run to verify failure, implement, run to pass.** Run: `node --test tests/lib/press-samples.test.js`.
- [ ] **Step 3: Live test once** with Sean's consent, using a real accepted sample when one arrives: watch the first order get created (dry run first, then `--apply`), confirm the order in Shopify admin shows $0, both tags and the right address, and confirm the next day's snapshot records it with `countsAsRevenue: false`.
- [ ] **Step 4: Full suite, commit, PR, merge, deploy.** Commit message: `feat(press-outreach): automatic $0 PR Package sample orders with tracking`.

---

# PR 4: link measurement

### Task 14: Link and mention detection plus the weekly funnel

**Files:**
- Create: `lib/press-links.js`
- Modify: `agents/press-outreach/index.js` (`--check-links`)
- Modify: `scripts/setup-cron.sh`
- Test: `tests/lib/press-links.test.js`

**Interfaces:**
- Produces:
  - `findOurPresence(html, { domain = 'realskincare.com', brand = 'Real Skin Care' }) -> { linked: bool, dofollow: bool|null, href: string|null, mentioned: bool }`. Anchors whose `href` host is `realskincare.com` or `www.realskincare.com` count as linked; a `rel` containing `nofollow`, `sponsored` or `ugc` makes `dofollow` false. A mention is a case-insensitive "Real Skin Care" outside our own links.
  - `linkCandidates(contacts, nowMs) -> [{contact, pitch, urls}]`: pitches with outcome in `replied | samples-sent | sample-accepted | escalated | placed`, last touch within 120 days, no `link_earned` yet. The URLs are the pitch's `target_url` plus the contact's `author_url` page, if recorded.
  - `funnel(contacts, drafts, nowMs) -> { last28: {...}, allTime: {...} }`, counting drafted, approved, sent, replied, samples, links and mentions.

**Behaviour of `--check-links`, weekly:**
1. Fetch each candidate URL through `runPool` and `fetchWithOutcome` (concurrency 6, 1 per host).
2. On the author page, also follow the 10 most recent article links on the outlet's own domain and check those.
3. Record `link_earned: { url, found_at, dofollow }` or `mention_earned`, and set the outcome to `placed` on a link.
4. Join backlink-monitor's newest snapshot in `data/backlinks/snapshots/`: any referring domain new since the previous snapshot that matches a contacted domain is listed in the digest as a possible earned link to confirm by hand.
   - **As built (ruling, 2026-10-04): dropped.** `data/backlinks/snapshots/` holds only COUNTS (`referringDomains`), never the domain list, so there is nothing to join. Replaced by an unattributed delta: the digest prints the site-wide referring-domain change between the two newest snapshots as context, explicitly "not attributed to outreach" (`referringDomainsChange` in `lib/press-links.js`).
5. Send one deferred notify with the funnel line, every new link (immediately worth celebrating, but deferred is fine), and the fetch outcome tally (`renderOutcomeTally`).

**Cron:** check `crontab -l` for a free slot first. Proposed:

```bash
PRESS_OUTREACH_LINKS="20 14 * * 1 cd \"$PROJECT_DIR\" && $NODE agents/press-outreach/index.js --check-links --apply >> data/reports/scheduler/press-outreach-links.log 2>&1"
```

- [ ] **Step 1: Write the failing tests:**
  1. `findOurPresence` handles a dofollow link, a `rel="nofollow sponsored"` link, a plain-text mention, and a page linking to `notrealskincare.com` (which is not ours).
  2. `linkCandidates` excludes a declined pitch and one 121 days old.
  3. `funnel` counts correctly on a small fixture.
- [ ] **Step 2: Run to verify failure, implement, run to pass.** Run: `node --test tests/lib/press-links.test.js`.
- [ ] **Step 3: Live dry run on the server** (`--check-links` without `--apply`), reading the candidate list and the outcome tally.
- [ ] **Step 4: Full suite, commit, PR, merge, deploy, install cron, mirror diff.** Commit message: `feat(press-outreach): weekly earned-link check and outreach funnel`.

### Task 15: Documentation

**Files:**
- Modify: `CLAUDE.md` (a concise "Press outreach" paragraph in the Architecture section)
- Modify: `agents/press-outreach/index.js` (final header docstring)

- [ ] **Step 1: Write the CLAUDE.md paragraph.** Cover:
  - what the agent does, its four modes and the cron times
  - that first pitches need Sean's approval in the Outreach tab
  - escalate-by-default
  - the daily cap ramp and auto-pause, with `--resume`
  - `PR Package` samples and the monthly cap
  - the gitignored paths (`data/press/drafts/`, `data/press/outreach-state.json`) and that they are backed up
  - the off switch

  Keep it under 25 lines.
- [ ] **Step 2: Commit** in the last PR with message `docs: press-outreach in CLAUDE.md`.
