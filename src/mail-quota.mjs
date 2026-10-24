import { digest } from './password.mjs';
import { mailboxAddress } from './smtp.mjs';

// Feishu limits this account to 100 messages per sender/day and 200/100 seconds.
// Rolling windows are conservative across provider time zones. Reserve before
// SMTP because a failed connection may have accepted DATA before disconnecting.
export async function reserveSmtpSend(env, from, now = Date.now()) {
  if (!env.DB) throw new Error('Mail quota storage is not configured');
  const sender = digest(mailboxAddress(from));
  const result = await env.DB.prepare(`INSERT INTO mail_send_reservations(id,sender_hash,created_at)
    SELECT ?,?,? WHERE (SELECT count(*) FROM mail_send_reservations WHERE sender_hash=? AND created_at>?)<100
      AND (SELECT count(*) FROM mail_send_reservations WHERE created_at>?)<200`)
    .bind(crypto.randomUUID(), sender, now, sender, now - 86400000, now - 100000).run();
  if (!result.meta.changes) throw new Error('SMTP sending limit reached');
}
