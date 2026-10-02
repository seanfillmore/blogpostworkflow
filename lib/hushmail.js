// lib/hushmail.js
//
// Sends and reads mail as sean@realskincare.com through Hushmail's standard
// mail servers, so creator outreach comes from Sean's real address and every
// reply lands in his real inbox.
//
//   SMTP  smtp.hushmail.com:465  SSL     send
//   IMAP  imap.hushmail.com:993  SSL     read the inbox
//
// Verified against help.hushmail.com 2026-10-02. Two things that are easy to
// get wrong:
//
//  - The plan must include "Desktop Access". Without it the servers refuse the
//    login, which looks exactly like a wrong password.
//  - With two-step verification on, the PASSWORD is "<password> <20-char code>"
//    (the code from Preferences > Security, spaces included). Mail programs have
//    no way to enter a rotating code, so Hushmail issues this fixed one.
//
// Hushmail saves its own encrypted copy of anything sent over SMTP to the Sent
// folder. Mail to a non-Hushmail address goes out unencrypted, like any
// ordinary email.
//
// ── THE PRODUCTION SERVER CANNOT USE SMTP, so it sends through RESEND ──────────
//
// DigitalOcean blocks outbound 465 and 587 on the droplet (verified 2026-10-02:
// both time out; IMAP 993 is open). So `sendMail` has two transports:
//
//   via 'smtp'    Hushmail SMTP. Works from a Mac, not from the server.
//   via 'resend'  Resend's HTTPS API, From sean@realskincare.com. The domain is
//                 verified in Resend (DKIM on resend._domainkey, return path on
//                 send.realskincare.com), so DMARC aligns on DKIM. Replies still
//                 come to Hushmail because the From address is Sean's.
//
// Over Resend nothing lands in Hushmail's Sent folder by itself, so the exact
// RFC 822 message (same Message-ID) is APPENDED to Sent over IMAP. That append
// is the one write this module makes to the mailbox, and it only ever adds a
// copy of mail Sean's address genuinely sent. A failed append is reported, never
// fatal: the creator already has the email.
//
// READING NEVER CHANGES THE MAILBOX. Messages are fetched with BODY.PEEK, so
// nothing is marked read, moved, flagged or deleted. This is Sean's whole
// inbox, not a dedicated one; what has been handled is tracked in the caller's
// own state file, keyed by Message-ID, never by touching his mail.

export const SMTP_HOST = 'smtp.hushmail.com';
export const SMTP_PORT = 465;
export const IMAP_HOST = 'imap.hushmail.com';
export const IMAP_PORT = 993;

/** The credentials, or null when they are not configured on this machine. */
export function hushmailCredentials(env = {}) {
  const user = env.HUSHMAIL_USER || process.env.HUSHMAIL_USER;
  const pass = env.HUSHMAIL_PASSWORD || process.env.HUSHMAIL_PASSWORD;
  return user && pass ? { user, pass } : null;
}

/**
 * Send one plain-text message. Threading headers are set when replying so the
 * creator sees one conversation.
 * @returns {Promise<{messageId: string, sentCopy?: string}>}
 */
export async function sendMail(creds, message, opts = {}) {
  if (!creds) throw new Error('hushmail: no HUSHMAIL_USER / HUSHMAIL_PASSWORD');
  if (!message.to || !message.subject || !message.text) throw new Error('hushmail: to, subject and text are required');
  if (opts.via === 'resend') return sendViaResend(creds, message, opts);
  return sendViaSmtp(creds, message, opts);
}

async function sendViaSmtp(creds, { to, subject, text, inReplyTo, references, fromName = 'Sean at Real Skin Care' }, { transportImpl } = {}) {
  const transport = transportImpl || (await import('nodemailer')).default.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true, auth: { user: creds.user, pass: creds.pass },
  });
  const info = await transport.sendMail({
    from: { name: fromName, address: creds.user },
    to,
    subject,
    text,
    ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
  });
  return { messageId: info.messageId };
}

/** The exact message, as RFC 822 bytes, with a Message-ID we choose. */
export async function composeMessage(creds, { to, subject, text, inReplyTo, references, fromName = 'Sean at Real Skin Care' }) {
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
  const domain = creds.user.split('@')[1];
  const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${domain}>`;
  const raw = await new MailComposer({
    from: { name: fromName, address: creds.user }, to, subject, text, messageId,
    ...(inReplyTo ? { inReplyTo, references: references || inReplyTo } : {}),
  }).compile().build();
  return { raw, messageId };
}

async function sendViaResend(creds, msg, { resendKey, fetchImpl = fetch, appendSent = appendToSent } = {}) {
  if (!resendKey) throw new Error('hushmail: via resend needs RESEND_API_KEY');
  const { raw, messageId } = await composeMessage(creds, msg);
  const headers = { 'Message-ID': messageId };
  if (msg.inReplyTo) {
    headers['In-Reply-To'] = msg.inReplyTo;
    headers.References = msg.references || msg.inReplyTo;
  }
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${msg.fromName || 'Sean at Real Skin Care'} <${creds.user}>`,
      to: [msg.to], subject: msg.subject, text: msg.text, reply_to: creds.user, headers,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`resend: HTTP ${res.status}: ${body.slice(0, 200)}`);
  let sentCopy = 'saved to Sent';
  try { await appendSent(creds, raw); } catch (err) { sentCopy = `NOT saved to Sent: ${err.message}`; }
  return { messageId, resendId: JSON.parse(body).id, sentCopy };
}

/** Add a copy to the mailbox's Sent folder (found by its \\Sent special-use flag). */
export async function appendToSent(creds, raw, { clientImpl } = {}) {
  const client = clientImpl || new (await import('imapflow')).ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: creds.user, pass: creds.pass }, logger: false,
  });
  await client.connect();
  try {
    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^sent( (items|mail))?$/i.test(b.name));
    if (!sent) throw new Error('no Sent folder found');
    await client.append(sent.path, raw, ['\\Seen']);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Inbox messages FROM any of `senders`, received on or after `since`.
 * Read-only: BODY.PEEK via imapflow's `source` fetch, no flag changes.
 *
 * @param {{user, pass}} creds
 * @param {{senders: string[], since: Date}} q
 * @returns {Promise<Array<{messageId, inReplyTo, references, from, subject, date, text}>>}
 */
export async function fetchInboxFrom(creds, { senders, since }, { clientImpl, parseImpl } = {}) {
  if (!creds) throw new Error('hushmail: no HUSHMAIL_USER / HUSHMAIL_PASSWORD');
  const wanted = new Set((senders || []).map((s) => s.toLowerCase()));
  if (!wanted.size) return [];
  const client = clientImpl || new (await import('imapflow')).ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: creds.user, pass: creds.pass }, logger: false,
  });
  const parse = parseImpl || (await import('mailparser')).simpleParser;
  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      // Headers first, bodies only for creator mail: the inbox holds thousands of
      // messages and this runs every 30 minutes.
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
          autoSubmitted: /auto-(generated|replied|notified)/i.test(String(parsed.headers?.get?.('auto-submitted') || ''))
            || Boolean(parsed.headers?.has?.('x-autoreply') || parsed.headers?.has?.('x-autorespond')),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

/** Drop the quoted history under a reply, so only the new words are judged. */
export function stripQuoted(text) {
  const lines = String(text).split(/\r?\n/);
  const cut = lines.findIndex((l) => /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From:\s/.test(l));
  return (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => !l.startsWith('>')).join('\n').trim();
}
