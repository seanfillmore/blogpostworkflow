// lib/inbox-sorter.js
//
// The pure half of agents/inbox-sorter: given where mail already sits in
// Sean's Hushmail folders, decide which new Inbox messages to file where.
// No I/O, so every decision is something a test constructs.
//
// ── Rules are LEARNED from the folders, never written in this repo ─────────────
//
// The repository is public, and the folders name business partners (the 3PL,
// the Brand Registry team, the owner). So there is no sender list here at all:
// a sender whose mail sits in a folder has its future mail filed to that
// folder. Sean dragging a sender into a folder teaches it; nothing to edit.
//
//   by ADDRESS  every address seen in a folder maps to that folder (the folder
//               holding most of its mail, on a tie the most recent).
//   by DOMAIN   a non-freemail domain maps to a folder when at least
//               DOMAIN_SHARE of its mail sits there. That is what catches a new
//               rep at a pitch agency. A freemail domain (gmail.com) never
//               becomes a rule: one newsletter writer on Gmail must not file
//               every customer and creator on Gmail with them.
//   BULK        mail carrying List-Unsubscribe / List-Id / Precedence: bulk
//               from an unknown sender goes to the bulk folder.
//
// ── What it never moves ─────────────────────────────────────────────────────────
//
//   - flagged mail
//   - mail from Sean's own domain (help desk, team, marketing)
//   - any address on the KEEP list: a sender whose filed message Sean moved
//     back to the Inbox. Moving it again tomorrow would be fighting him.
//   - any creator address (agents/creator-outreach reads the Inbox only)

export const DOMAIN_SHARE = 0.9;
export const MIN_DOMAIN_MESSAGES = 3;
export const DEFAULT_BULK_FOLDER = 'Notifications';

export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'hushmail.com',
  'gmx.com', 'mail.com', 'zoho.com', 'att.net', 'comcast.net', 'verizon.net',
]);

/** Folders that are mailbox plumbing, not Sean's filing, and never teach a rule. */
export function isSystemFolder(box) {
  if (box.specialUse) return true; // \Inbox \Sent \Drafts \Junk \Trash \Archive
  return /^(inbox|sent( (messages|items|mail))?|drafts?|junk|spam|trash|deleted( messages| items)?|scheduled|templates|archive)$/i.test(box.path);
}

const domainOf = (addr) => String(addr || '').split('@')[1] || '';

/**
 * @param {Record<string, Array<{from: string, date?: string}>>} filed  folder -> its messages
 * @returns {{byAddress: Map<string,string>, byDomain: Map<string,string>}}
 */
export function learnRules(filed) {
  const addr = new Map(); // address -> Map(folder -> {n, last})
  const dom = new Map(); // domain -> Map(folder -> n)
  for (const [folder, msgs] of Object.entries(filed || {})) {
    for (const m of msgs || []) {
      const a = String(m.from || '').toLowerCase();
      if (!a.includes('@')) continue;
      if (!addr.has(a)) addr.set(a, new Map());
      const slot = addr.get(a).get(folder) || { n: 0, last: '' };
      slot.n += 1;
      if ((m.date || '') > slot.last) slot.last = m.date || '';
      addr.get(a).set(folder, slot);
      const d = domainOf(a);
      if (!dom.has(d)) dom.set(d, new Map());
      dom.get(d).set(folder, (dom.get(d).get(folder) || 0) + 1);
    }
  }
  const byAddress = new Map();
  for (const [a, folders] of addr) {
    const best = [...folders].sort((x, y) => y[1].n - x[1].n || y[1].last.localeCompare(x[1].last))[0];
    byAddress.set(a, best[0]);
  }
  const byDomain = new Map();
  for (const [d, folders] of dom) {
    if (!d || FREEMAIL.has(d)) continue;
    const total = [...folders.values()].reduce((s, n) => s + n, 0);
    const [folder, n] = [...folders].sort((x, y) => y[1] - x[1])[0];
    if (total >= MIN_DOMAIN_MESSAGES && n / total >= DOMAIN_SHARE) byDomain.set(d, folder);
  }
  return { byAddress, byDomain };
}

/**
 * Where one Inbox message should go, or null to leave it.
 * @param {{from: string, flagged?: boolean, bulk?: boolean}} msg
 * @param {{byAddress, byDomain}} rules
 * @param {{ownDomain: string, keep: Set<string>, protect: Set<string>, bulkFolder?: string}} ctx
 * @returns {{folder: string, why: string} | null}
 */
export function decide(msg, rules, { ownDomain, keep = new Set(), protect = new Set(), bulkFolder = DEFAULT_BULK_FOLDER }) {
  const from = String(msg.from || '').toLowerCase();
  const d = domainOf(from);
  if (!from || msg.flagged) return null;
  if (ownDomain && (d === ownDomain || d.endsWith(`.${ownDomain}`))) return null;
  if (keep.has(from) || protect.has(from)) return null;
  if (rules.byAddress.has(from)) return { folder: rules.byAddress.get(from), why: 'sender' };
  if (rules.byDomain.has(d)) return { folder: rules.byDomain.get(d), why: 'domain' };
  if (msg.bulk && bulkFolder) return { folder: bulkFolder, why: 'bulk mail' };
  return null;
}

/** Group decisions by destination folder. */
export function planMoves(messages, rules, ctx) {
  const plan = new Map();
  for (const m of messages) {
    const d = decide(m, rules, ctx);
    if (!d) continue;
    if (!plan.has(d.folder)) plan.set(d.folder, []);
    plan.get(d.folder).push({ ...m, why: d.why });
  }
  return plan;
}

/**
 * Senders Sean pulled back: a message this agent filed (tracked by Message-ID)
 * that is now in the Inbox again. Those senders are never moved again.
 */
export function pulledBack(inboxMessages, movedIds) {
  const out = new Set();
  for (const m of inboxMessages) if (m.messageId && movedIds.has(m.messageId)) out.add(String(m.from).toLowerCase());
  return out;
}
