import { digest } from './password.mjs';
import { MailWire, mailDeadline, tlsMailSocket } from './mail-socket.mjs';
import { smtpAccounts, mailboxAddress } from './smtp.mjs';
import { sendEmail } from './mailer.mjs';
import { CONTACT_MAILBOXES, acknowledgementTemplate } from './mail-templates.mjs';

export function parseMailHeaders(bytes) {
  const text = new TextDecoder().decode(bytes).replace(/\r?\n[ \t]+/g, ' '), headers = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (match) { const name = match[1].toLowerCase(); headers[name] = headers[name] ? headers[name] + ', ' + match[2] : match[2]; }
  }
  return headers;
}
export function replyDestination(headers, mailboxHint) {
  if ((headers['auto-submitted'] && headers['auto-submitted'].trim().toLowerCase() !== 'no') || headers['list-id'] || /\b(bulk|list|junk)\b/i.test(headers.precedence || '') || /\b(all|autoreply)\b/i.test(headers['x-auto-response-suppress'] || '') || headers['return-path']?.trim() === '<>') return null;
  let sender;
  try { sender = mailboxAddress(headers.from || ''); } catch { return null; }
  if (sender.endsWith('@pcln.top') || /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce[^@]*)@/i.test(sender)) return null;
  if (mailboxHint && Object.hasOwn(CONTACT_MAILBOXES, mailboxHint)) return { sender, mailbox: mailboxHint };
  const recipients = [headers.to, headers.cc, headers['delivered-to'], headers['x-original-to']].filter(Boolean).join(', ');
  const addresses = recipients.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}/g) || [];
  for (const address of addresses) {
    const [mailbox, domain] = address.toLowerCase().split('@');
    if (domain === 'pcln.top' && Object.hasOwn(CONTACT_MAILBOXES, mailbox)) return { sender, mailbox };
  }
  return null;
}
export async function acknowledgeMail(env, emailId, headers, send = sendEmail, mailboxHint) {
  const destination = replyDestination(headers, mailboxHint);
  if (!destination) return 'skipped';
  const now = Date.now(), senderHash = digest(destination.sender);
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO mail_auto_replies(email_id,mailbox,sender_hash,created_at)
    SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM mail_auto_replies WHERE sender_hash=? AND mailbox=? AND created_at>?)
      AND (SELECT count(*) FROM mail_auto_replies WHERE created_at>?)<500`).bind(emailId, destination.mailbox, senderHash, now, senderHash, destination.mailbox, now - 86400000, now - 86400000).run();
  if (!inserted.meta.changes) return 'skipped';
  // Reserve before SMTP. An ambiguous network failure is left for manual review,
  // rather than sending duplicate receipts on every cron retry.
  const reference = /^<[^<>\r\n]{1,400}>$/.test(headers['message-id'] || '') ? headers['message-id'] : null;
  const from = `${CONTACT_MAILBOXES[destination.mailbox].name} <${destination.mailbox}@pcln.top>`;
  try {
    const sent = await send(env, {
      from, to: destination.sender, reply_to: `${destination.mailbox}@pcln.top`, ...acknowledgementTemplate(destination.mailbox),
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', ...(reference ? { 'In-Reply-To': reference, References: reference } : {}) }
    });
    await env.DB.prepare("UPDATE mail_auto_replies SET state='sent',reply_id=?,sent_at=? WHERE email_id=?").bind(String(sent.id), Date.now(), emailId).run();
    return 'sent';
  } catch { console.error(JSON.stringify({ mail: 'acknowledgement.pending', mailbox: destination.mailbox })); return 'pending'; }
}
const quoted = value => { const text = String(value); if (/[\r\n\0]/.test(text)) throw new Error('Invalid mailbox credentials'); return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; };
export function inboxAccounts(env) {
  if (env.IMAP_ENABLED !== 'true') return [];
  const named = smtpAccounts(env).filter(account => Object.hasOwn(CONTACT_MAILBOXES, account.mailbox));
  const accounts = env.IMAP_ACCOUNTS ? JSON.parse(env.IMAP_ACCOUNTS) : named.length ? named : env.SMTP_USERNAME && env.SMTP_PASSWORD ? [{ username: env.IMAP_USERNAME || env.SMTP_USERNAME, password: env.IMAP_PASSWORD || env.SMTP_PASSWORD }] : [];
  if (!Array.isArray(accounts) || accounts.length > 4) throw new Error('Invalid inbox configuration');
  return accounts.filter(account => mailboxAddress(account.username) !== 'noreply@pcln.top').map(account => { if (account.mailbox && !Object.hasOwn(CONTACT_MAILBOXES, account.mailbox)) throw new Error('Invalid contact mailbox'); if (!account.password) throw new Error('Missing IMAP password'); quoted(account.password); return account; });
}
export async function pollInbox(env, account, connect = tlsMailSocket, send = sendEmail) {
  const accountHash = digest(account.username.toLowerCase()), now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO mail_inbox_state(account_hash,updated_at) VALUES(?,?)').bind(accountHash, now).run();
  const state = await env.DB.prepare('UPDATE mail_inbox_state SET lock_until=? WHERE account_hash=? AND lock_until<=? RETURNING *').bind(now + 55000, accountHash, now).first();
  if (!state) return { skipped: true };
  let socket, wire, tagIndex = 0;
  const summary = { sent: 0, skipped: 0, pending: 0 };
  try {
    await mailDeadline(async () => {
      const port = Number(env.IMAP_PORT || 993); if (port !== 993) throw new Error('IMAP requires TLS on port 993');
      socket = await connect(env.IMAP_HOST || 'imap.feishu.cn', port); await socket.opened; wire = new MailWire(socket);
      if (!/^\* OK\b/i.test(await wire.line())) throw new Error('IMAP greeting rejected');
      const command = async value => {
        const tag = 'N' + (++tagIndex), lines = [], literals = [];
        await wire.write(`${tag} ${value}\r\n`);
        for (let i = 0; i < 1000; i++) {
          const line = await wire.line();
          if (line.startsWith(tag + ' ')) { if (!line.startsWith(tag + ' OK')) throw new Error('IMAP operation rejected'); return { lines, literals }; }
          if (/^\* BYE\b/i.test(line)) throw new Error('IMAP connection closed');
          lines.push(line);
          const literal = /\{(\d+)\}$/.exec(line); if (literal) literals.push(await wire.bytes(Number(literal[1])));
        }
        throw new Error('IMAP response exceeded limit');
      };
      await command(`LOGIN ${quoted(account.username)} ${quoted(account.password)}`);
      const selected = await command('EXAMINE INBOX'), metadata = selected.lines.join('\n');
      const validity = metadata.match(/\[UIDVALIDITY (\d+)\]/)?.[1], next = Number(metadata.match(/\[UIDNEXT (\d+)\]/)?.[1]);
      if (!validity || !Number.isSafeInteger(next) || next < 1) throw new Error('IMAP UID state unavailable');
      if (state.uid_validity !== validity || state.last_uid === null) {
        await env.DB.prepare('UPDATE mail_inbox_state SET uid_validity=?,last_uid=?,updated_at=? WHERE account_hash=? AND lock_until=?').bind(validity, next - 1, Date.now(), accountHash, now + 55000).run();
        summary.initialized = true; return;
      }
      const search = await command(`UID SEARCH UID ${state.last_uid + 1}:*`);
      const ids = [...new Set(search.lines.filter(line => /^\* SEARCH(?: |$)/.test(line)).flatMap(line => line.slice(8).trim().split(/\s+/).map(Number)))].filter(uid => Number.isSafeInteger(uid) && uid > state.last_uid).sort((a, b) => a - b).slice(0, 5);
      for (const uid of ids) {
        const result = await command(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM TO CC DELIVERED-TO X-ORIGINAL-TO MESSAGE-ID AUTO-SUBMITTED PRECEDENCE LIST-ID X-AUTO-RESPONSE-SUPPRESS RETURN-PATH)])`);
        if (result.literals.length) {
          const outcome = await acknowledgeMail(env, digest(`${accountHash}:${validity}:${uid}`), parseMailHeaders(result.literals[0]), send, account.mailbox);
          summary[outcome]++;
        } else summary.skipped++;
        await env.DB.prepare('UPDATE mail_inbox_state SET last_uid=MAX(last_uid,?),updated_at=? WHERE account_hash=? AND lock_until=? AND uid_validity=?').bind(uid, Date.now(), accountHash, now + 55000, validity).run();
      }
      // A quiet inbox is still active. Keep its cursor through retention cleanup
      // and expose successful polling without storing any message contents.
      await env.DB.prepare('UPDATE mail_inbox_state SET updated_at=? WHERE account_hash=? AND lock_until=? AND uid_validity=?').bind(Date.now(), accountHash, now + 55000, validity).run();
      try { await command('LOGOUT'); } catch { /* Read-only polling has already completed. */ }
    }, async () => { try { await socket?.close(); } catch { /* Deadline cleanup. */ } }, 45000);
    return summary;
  } finally {
    if (wire) await wire.close(); else try { await socket?.close(); } catch { /* Cleanup. */ }
    await env.DB.prepare('UPDATE mail_inbox_state SET lock_until=0 WHERE account_hash=? AND lock_until=?').bind(accountHash, now + 55000).run();
  }
}
export async function runMailInbox(env) {
  const results = [];
  for (const account of inboxAccounts(env)) {
    try { results.push(await pollInbox(env, account)); }
    catch { console.error(JSON.stringify({ mail: 'inbox.poll_failed' })); results.push({ failed: true }); }
  }
  return results;
}
