import { MailWire, mailDeadline, tlsMailSocket } from './mail-socket.mjs';
import { CONTACT_MAILBOXES } from './mail-templates.mjs';
export function smtpAccounts(env) {
  return [...Object.keys(CONTACT_MAILBOXES), 'noreply'].filter(key => env[`SMTP_${key.toUpperCase()}_PASSWORD`]).map(key => ({ mailbox: key, username: env[`SMTP_${key.toUpperCase()}_USERNAME`] || `${key}@pcln.top`, password: env[`SMTP_${key.toUpperCase()}_PASSWORD`] }));
}
export function smtpReady(env, from = 'noreply@pcln.top') {
  if (env.SMTP_USERNAME && env.SMTP_PASSWORD) return true;
  try { const address = mailboxAddress(from); return smtpAccounts(env).some(account => account.username.toLowerCase() === address || `${account.mailbox}@pcln.top` === address); } catch { return false; }
}
function sendingAccount(env, from) {
  const address = mailboxAddress(from), account = smtpAccounts(env).find(item => item.username.toLowerCase() === address || `${item.mailbox}@pcln.top` === address);
  if (account) return account;
  if (env.SMTP_USERNAME && env.SMTP_PASSWORD) return { username: env.SMTP_USERNAME, password: env.SMTP_PASSWORD };
  throw new Error('SMTP is not configured for this sender');
}
const safe = value => { const text = String(value ?? ''); if (/[\r\n\0]/.test(text)) throw new Error('Invalid mail header'); return text; };
export function mailboxAddress(value) {
  const text = safe(value).trim(), email = text.match(/<([^<>]+)>$/)?.[1] || text;
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(email)) throw new Error('Invalid mail address');
  return email.toLowerCase();
}
function encodedWords(value) {
  const words = []; let part = '';
  for (const character of safe(value)) { if (Buffer.byteLength(part + character) > 42) { words.push(part); part = ''; } part += character; }
  if (part) words.push(part);
  return words.map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}
const b64Lines = value => Buffer.from(String(value ?? '')).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
export function mimeMessage(message) {
  const from = mailboxAddress(message.from), to = (Array.isArray(message.to) ? message.to : [message.to]).map(mailboxAddress);
  if (!to.length || to.length > 5) throw new Error('Invalid recipient count');
  const display = safe(message.from).replace(/<[^<>]+>$/, '').trim();
  const messageId = `<${crypto.randomUUID()}@pcln.top>`, boundary = 'nexa-' + crypto.randomUUID();
  const headers = [`From: ${display ? encodedWords(display) + ' ' : ''}<${from}>`, `To: ${to.map(email => `<${email}>`).join(', ')}`, `Subject: ${encodedWords(message.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0'];
  if (message.reply_to) headers.push(`Reply-To: <${mailboxAddress(message.reply_to)}>`);
  for (const [name, value] of Object.entries(message.headers || {})) {
    if (!['Auto-Submitted', 'X-Auto-Response-Suppress', 'In-Reply-To', 'References'].includes(name)) throw new Error('Unsupported mail header');
    headers.push(`${name}: ${safe(value)}`);
  }
  let body = message.html
    ? `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Lines(message.text)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Lines(message.html)}\r\n--${boundary}--\r\n`
    : `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Lines(message.text)}\r\n`;
  const attachments = message.attachments || [];
  if (!Array.isArray(attachments) || attachments.length > 2) throw new Error('Invalid inline attachment count');
  if (attachments.length) {
    const related = 'nexa-related-' + crypto.randomUUID();
    let parts = `Content-Type: multipart/related; boundary="${related}"\r\n\r\n--${related}\r\n${body}`;
    for (const attachment of attachments) {
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(attachment.filename) || !/^[A-Za-z0-9._@-]{1,100}$/.test(attachment.content_id) || attachment.content_type !== 'image/png' || typeof attachment.content !== 'string' || attachment.content.length > 262144 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content)) throw new Error('Invalid inline mail image');
      parts += `\r\n--${related}\r\nContent-Type: image/png; name="${attachment.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <${attachment.content_id}>\r\nContent-Disposition: inline; filename="${attachment.filename}"\r\n\r\n${attachment.content.match(/.{1,76}/g)?.join('\r\n') || ''}\r\n`;
    }
    body = parts + `\r\n--${related}--\r\n`;
  }
  return { from, to, messageId, data: (headers.join('\r\n') + '\r\n' + body).replace(/(^|\r\n)\./g, '$1..') };
}
export async function smtpSend(env, message, connect = tlsMailSocket) {
  const account = sendingAccount(env, message.from);
  const port = Number(env.SMTP_PORT || 465);
  if (port !== 465) throw new Error('SMTP requires implicit TLS on port 465');
  const mime = mimeMessage(message), username = safe(account.username), password = safe(account.password);
  let wire, socket;
  return mailDeadline(async () => {
    socket = await connect(env.SMTP_HOST || 'smtp.feishu.cn', port); await socket.opened; wire = new MailWire(socket);
    const response = async expected => {
      let code, text = '';
      for (let i = 0; i < 100; i++) {
        const line = await wire.line(), match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match || (code && code !== match[1])) throw new Error('Invalid SMTP response');
        code = match[1]; text += match[3] + '\n';
        if (match[2] === ' ') { if (!expected.includes(Number(code))) throw new Error(`SMTP rejected operation (${code})`); return text; }
      }
      throw new Error('SMTP response exceeded limit');
    };
    const command = async (line, expected) => { await wire.write(line + '\r\n'); return response(expected); };
    try {
      await response([220]);
      const capabilities = await command('EHLO auth.pcln.top', [250]);
      if (/\bAUTH\b[^\n]*\bPLAIN\b/i.test(capabilities)) await command('AUTH PLAIN ' + Buffer.from(`\0${username}\0${password}`).toString('base64'), [235]);
      else if (/\bAUTH\b[^\n]*\bLOGIN\b/i.test(capabilities)) {
        await command('AUTH LOGIN', [334]); await command(Buffer.from(username).toString('base64'), [334]); await command(Buffer.from(password).toString('base64'), [235]);
      } else throw new Error('SMTP server does not offer a supported authentication method');
      await command(`MAIL FROM:<${mime.from}>`, [250]);
      for (const recipient of mime.to) await command(`RCPT TO:<${recipient}>`, [250, 251]);
      await command('DATA', [354]);
      await wire.write(mime.data + '\r\n.\r\n'); await response([250]);
      try { await command('QUIT', [221]); } catch { /* DATA was already accepted. */ }
      return { id: mime.messageId };
    } finally { await wire.close(); }
  }, async () => { try { await socket?.close(); } catch { /* Deadline cleanup. */ } }).finally(async () => { try { await socket?.close(); } catch { /* Also close failed TLS handshakes. */ } });
}
