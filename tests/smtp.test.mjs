import test from 'node:test';
import assert from 'node:assert/strict';
import { smtpSend, mimeMessage, smtpReady, smtpAccounts } from '../src/smtp.mjs';
import { mailDeadline } from '../src/mail-socket.mjs';
import { CONTACT_MAILBOXES, acknowledgementTemplate, loginCodeTemplate } from '../src/mail-templates.mjs';
import { parseMailHeaders, replyDestination, inboxAccounts } from '../src/mail-inbox.mjs';
import { notificationTemplate } from '../src/mail-layout.mjs';
import { createHash } from 'node:crypto';

const config = { SMTP_USERNAME: 'sender@pcln.top', SMTP_PASSWORD: 'private-client-password' };
function server({ authCode = 235, dataCode = 250 } = {}) {
  let controller, buffer = '', collecting = false, delivered = '', closed = false;
  const commands = [];
  const emit = text => { const bytes = new TextEncoder().encode(text); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); };
  const socket = {
    opened: Promise.resolve(), readable: new ReadableStream({ start(c) { controller = c; emit('220 mail.test ESMTP\r\n'); } }),
    writable: new WritableStream({ write(bytes) {
      buffer += new TextDecoder().decode(bytes);
      if (collecting) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; delivered = buffer.slice(0, end); buffer = buffer.slice(end + 5); collecting = false; emit(`${dataCode} message status\r\n`); }
      while (!collecting && buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2); commands.push(line);
        if (line.startsWith('EHLO ')) emit('250-mail.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 500000\r\n');
        else if (line.startsWith('AUTH PLAIN ')) emit(`${authCode} authentication status\r\n`);
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) emit('250 OK\r\n');
        else if (line === 'DATA') { collecting = true; emit('354 continue\r\n'); }
        else if (line === 'QUIT') emit('221 goodbye\r\n');
        else throw new Error('Unexpected SMTP command');
      }
    } }),
    async close() { if (!closed) { closed = true; controller.close(); } }
  };
  return { socket, commands, message: () => delivered, closed: () => closed };
}
test('SMTP authenticates over TLS and delivers a correctly encoded code email', async () => {
  const fixture = server();
  const result = await smtpSend(config, { from: 'Nexa Cloud <noreply@pcln.top>', to: 'customer@example.com', ...loginCodeTemplate('123456') }, async (host, port) => { assert.equal(host, 'smtp.feishu.cn'); assert.equal(port, 465); return fixture.socket; });
  assert.match(result.id, /@pcln\.top>$/);
  assert.equal(Buffer.from(fixture.commands.find(c => c.startsWith('AUTH PLAIN ')).slice(11), 'base64').toString(), '\0sender@pcln.top\0private-client-password');
  assert.ok(fixture.commands.includes('RCPT TO:<customer@example.com>'));
  assert.match(fixture.message(), /multipart\/alternative/);
  assert.match(fixture.message(), /Content-Transfer-Encoding: base64/);
  assert.ok(!fixture.message().includes(config.SMTP_PASSWORD));
  assert.equal(fixture.closed(), true);
});
test('SMTP rejects authentication failures, delivery failures and injected headers', async () => {
  for (const options of [{ authCode: 535 }, { dataCode: 451 }]) { const fixture = server(options); await assert.rejects(smtpSend(config, { from: 'support@pcln.top', to: 'person@example.com', subject: 'Receipt', text: 'hello' }, async () => fixture.socket), /SMTP rejected/); assert.ok(fixture.closed()); }
  assert.throws(() => mimeMessage({ from: 'support@pcln.top', to: 'victim@example.com\r\nBcc: attacker@example.com', subject: 'x' }), /header/);
  assert.throws(() => mimeMessage({ from: 'support@pcln.top', to: 'person@example.com', subject: 'hello\r\nBcc: attacker@example.com' }), /header/);
  await assert.rejects(smtpSend({ ...config, SMTP_PORT: '25' }, { from: 'noreply@pcln.top', to: 'person@example.com', subject: 'Test', text: 'Test' }), /TLS/);
});
test('mail deadlines close a stalled connection', async () => {
  let closed = false;
  await assert.rejects(mailDeadline(() => new Promise(() => {}), async () => { closed = true; }, 20), /timed out/);
  assert.equal(closed, true);
});
test('contact templates and loop protection cover all four addresses', () => {
  assert.deepEqual(Object.keys(CONTACT_MAILBOXES), ['support', 'privacy', 'security', 'legal']);
  for (const key of Object.keys(CONTACT_MAILBOXES)) { const template = acknowledgementTemplate(key); assert.ok(template.text.includes('自动')); assert.ok(template.html); assert.deepEqual(replyDestination({ from: 'Person <person@example.com>', to: `Nexa <${key}@pcln.top>` }), { mailbox: key, sender: 'person@example.com' }); }
  for (const headers of [{ 'auto-submitted': 'auto-replied' }, { precedence: 'bulk' }, { 'list-id': '<list.example>' }, { 'return-path': '<>' }, { from: 'noreply@example.com' }, { from: 'support@pcln.top' }, { to: 'support@pcln.top.attacker.example' }]) assert.equal(replyDestination({ from: 'person@example.com', to: 'support@pcln.top', ...headers }), null);
  const parsed = parseMailHeaders(new TextEncoder().encode('From: Person <person@example.com>\r\nTo: Nexa\r\n <privacy@pcln.top>\r\nAuto-Submitted: no\r\n\r\n'));
  assert.equal(replyDestination(parsed).mailbox, 'privacy');
});
test('five independent SMTP accounts select their own credentials and noreply never polls IMAP', async () => {
  const env = { IMAP_ENABLED: 'true' };
  const roles = ['support', 'privacy', 'security', 'legal', 'noreply'];
  for (const role of roles) env[`SMTP_${role.toUpperCase()}_PASSWORD`] = 'private-' + role;
  assert.equal(smtpReady(env), true);
  assert.equal(smtpReady({ SMTP_SUPPORT_PASSWORD: 'support-only' }), false, 'system mail needs the independent noreply account');
  assert.equal(smtpAccounts(env).length, 5);
  assert.deepEqual(inboxAccounts(env).map(a => a.mailbox), ['support', 'privacy', 'security', 'legal']);
  for (const role of roles) {
    const fixture = server();
    await smtpSend(env, { from: `NexaMC <${role}@pcln.top>`, to: 'person@example.com', subject: 'Test', text: 'Test' }, async () => fixture.socket);
    const credentials = Buffer.from(fixture.commands.find(c => c.startsWith('AUTH PLAIN ')).slice(11), 'base64').toString();
    assert.equal(credentials, `\0${role}@pcln.top\0private-${role}`);
  }
});
test('all email classes render branded HTML with the official NexaMC icon embedded by CID', () => {
  const templates = [loginCodeTemplate('654321'), ...Object.keys(CONTACT_MAILBOXES).map(acknowledgementTemplate), notificationTemplate('Account notification', '<untrusted> & text')];
  for (const template of templates) {
    assert.match(template.html, /^<!doctype html>/);
    assert.match(template.html, /cid:nexamc-logo@pcln\.top/);
    assert.match(template.html, /alt="NexaMC"/);
    assert.equal(template.attachments.length, 1);
    const png = Buffer.from(template.attachments[0].content, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(createHash('sha256').update(png).digest('hex'), '231d6bf3c99df3ca1a7330f12735713df226378837436e8c6811c0a4d8f17728');
    const mime = mimeMessage({ from: 'noreply@pcln.top', to: 'person@example.com', subject: 'Test', ...template });
    assert.match(mime.data, /multipart\/related/);
    assert.match(mime.data, /Content-ID: <nexamc-logo@pcln\.top>/);
    assert.ok(mime.data.includes(template.attachments[0].content.match(/.{1,76}/g).join('\r\n')));
  }
  assert.ok(templates.at(-1).html.includes('&lt;untrusted&gt; &amp; text'));
  assert.ok(!templates.at(-1).html.includes('<untrusted>'));
});
