import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { b64url, unb64url, webauthnUserId } from '../src/webauthn.mjs';
import { encryptSecret } from '../src/totp.mjs';
import { acknowledgeMail, pollInbox } from '../src/mail-inbox.mjs';
import { reserveSmtpSend } from '../src/mail-quota.mjs';
import { migrationStatements } from './sql-statements.mjs';

const origin = 'https://web.test';
const text = value => new TextEncoder().encode(value);
test('email codes and discoverable passkeys use real Worker/D1 authentication', async t => {
  const root = new URL('../', import.meta.url), deliveries = [];
  const modules = ['index.mjs', ...(await readdir(new URL('src/', root), { recursive: true })).filter(f => f.endsWith('.mjs') && f !== 'index.mjs')];
  const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: fileURLToPath(root), modules: modules.map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('src/' + f, root)) })), compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'passwordless' }, bindings: { WEB_ORIGIN: origin, RP_ID: 'web.test', MFA_ENC_KEY: 'private-test-key', RESEND_API_KEY: 'fake-mail-key' }, outboundService: async request => { assert.equal(new URL(request.url).origin, 'https://api.resend.com'); deliveries.push(await request.json()); return Response.json({ id: 'test-delivery' }); } }));
  t.after(() => mf.dispose()); const db = await mf.getD1Database('DB');
  for (const name of (await readdir(new URL('migrations/', root))).filter(f => f.endsWith('.sql')).sort()) {
    const statements = migrationStatements(await readFile(new URL('migrations/' + name, root), 'utf8')); await db.batch(statements.map(s => db.prepare(s)));
  }
  let ip = 1;
  const call = (path, data, source = origin) => mf.dispatchFetch(origin + path, { method: data ? 'POST' : 'GET', headers: { origin: source, 'x-nexa-request': '1', 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${ip++}` }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const addUser = (id, email) => db.prepare("INSERT INTO users(id,name,email,password_hash,confirmed_at,created_at) VALUES(?,?,?,'oauth:test',?,?)").bind(id, id, email, new Date().toISOString(), new Date().toISOString()).run();
  const requestCode = async (id, email) => {
    await addUser(id, email); const response = await call('/auth/v1/login/email/request', { email }); assert.equal(response.status, 200); const issued = await response.json();
    for (let i = 0; i < 100 && !deliveries.some(m => m.to === email); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const mail = deliveries.find(m => m.to === email); assert.ok(mail, 'code email must actually enter the mail transport'); return { ...issued, code: mail.text.match(/\b\d{6}\b/)[0] };
  };
  await t.test('correct email code creates a session and cannot be replayed', async () => {
    const issued = await requestCode('emailuser', 'emailuser@example.com');
    const stored = await db.prepare('SELECT * FROM email_login_challenges WHERE user_id=?').bind('emailuser').first(); assert.notEqual(stored.code_mac, issued.code); assert.ok(!JSON.stringify(stored).includes('emailuser@example.com'));
    const response = await call('/auth/v1/login/email/verify', { challenge: issued.challenge, code: issued.code }); assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await call('/auth/v1/login/email/verify', { challenge: issued.challenge, code: issued.code })).status, 401);
  });
  await t.test('five guesses exhaust a code and changed emails invalidate old codes', async () => {
    const issued = await requestCode('guessuser', 'guessuser@example.com'), wrong = String((Number(issued.code) + 1) % 1000000).padStart(6, '0');
    for (let i = 0; i < 5; i++) assert.equal((await call('/auth/v1/login/email/verify', { challenge: issued.challenge, code: wrong })).status, 401);
    assert.equal((await call('/auth/v1/login/email/verify', { challenge: issued.challenge, code: issued.code })).status, 401);
    const changed = await requestCode('changeduser', 'changed@example.com'); await db.prepare("UPDATE users SET email='new@example.com' WHERE id='changeduser'").run();
    assert.equal((await call('/auth/v1/login/email/verify', { challenge: changed.challenge, code: changed.code })).status, 401);
  });
  await t.test('unknown and ambiguous emails do not disclose or pick accounts', async () => {
    const unknown = await call('/auth/v1/login/email/request', { email: 'unknown@example.com' }); assert.equal(unknown.status, 200); assert.deepEqual(Object.keys(await unknown.json()).sort(), ['challenge', 'expiresIn', 'retryAfter']);
    await addUser('duplicate1', 'duplicate@example.com'); await addUser('duplicate2', 'duplicate@example.com');
    const response = await call('/auth/v1/login/email/request', { email: 'duplicate@example.com' }); assert.equal(response.status, 200); assert.deepEqual(Object.keys(await response.json()).sort(), ['challenge', 'expiresIn', 'retryAfter']);
    assert.equal(deliveries.some(m => ['duplicate@example.com', 'unknown@example.com'].includes(m.to)), false);
  });
  await t.test('email verification preserves enrolled MFA and respects origin and resend limits', async () => {
    const issued = await requestCode('mfauser', 'mfauser@example.com');
    await db.prepare('INSERT INTO mfa_totp(id,user_id,secret,confirmed,created_at) VALUES(?,?,?,1,?)').bind('mfa', 'mfauser', await encryptSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'private-test-key'), new Date().toISOString()).run();
    const response = await call('/auth/v1/login/email/verify', { challenge: issued.challenge, code: issued.code }); assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), false); assert.equal((await response.json()).mfaRequired, true);
    assert.equal((await call('/auth/v1/login/email/request', { email: 'mfauser@example.com' })).status, 429);
    assert.equal((await call('/auth/v1/login/email/request', { email: 'other@example.com' }, 'https://attacker.example')).status, 403);
  });
  await t.test('a verified passkey signs in directly without password, email or TOTP', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), jwk = await crypto.subtle.exportKey('jwk', pair.publicKey), credentialId = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare('INSERT INTO mfa_passkeys(credential_id,user_id,public_key,algorithm,sign_count,created_at) VALUES(?,?,?,-7,0,?)').bind(credentialId, 'mfauser', JSON.stringify(jwk), new Date().toISOString()).run();
    const assertion = async (challenge, flags = 5, assertionOrigin = origin) => {
      const authData = new Uint8Array(37); authData.set(new Uint8Array(await crypto.subtle.digest('SHA-256', text('web.test')))); authData[32] = flags; new DataView(authData.buffer).setUint32(33, 1);
      const clientDataJSON = b64url(text(JSON.stringify({ type: 'webauthn.get', challenge, origin: assertionOrigin, crossOrigin: false })));
      const signed = new Uint8Array(69); signed.set(authData); signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', unb64url(clientDataJSON))), 37);
      return { challenge, credentialId, userHandle: await webauthnUserId('mfauser'), clientDataJSON, authenticatorData: b64url(authData), signature: b64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed))) };
    };
    const options = await (await call('/auth/v1/login/passkey/direct/options', {})).json(); assert.equal(options.userVerification, 'required'); assert.deepEqual(options.allowCredentials, []);
    assert.equal((await call('/auth/v1/login/passkey/direct', await assertion(options.challenge, 1))).status, 401, 'touch without device verification is not sufficient');
    assert.equal((await call('/auth/v1/login/passkey/direct', await assertion(options.challenge, 5, 'https://attacker.example'))).status, 401);
    const good = await assertion(options.challenge), response = await call('/auth/v1/login/passkey/direct', good); assert.equal(response.status, 200); assert.ok(response.headers.has('set-cookie'));
    assert.equal((await call('/auth/v1/login/passkey/direct', good)).status, 401);
    const other = await (await call('/auth/v1/login/passkey/direct/options', {})).json(); assert.equal((await call('/auth/v1/login/passkey/direct', { ...await assertion(other.challenge), userHandle: await webauthnUserId('emailuser') })).status, 401);
  });
  await t.test('SMTP quotas are atomic, independent per sender and shared across the burst window', async () => {
    const now = Date.now();
    const reservations = await Promise.allSettled(Array.from({ length: 103 }, () => reserveSmtpSend({ DB: db }, 'noreply@pcln.top', now)));
    assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 100);
    assert.equal(reservations.filter(result => result.status === 'rejected').length, 3);
    await Promise.all(Array.from({ length: 100 }, () => reserveSmtpSend({ DB: db }, 'support@pcln.top', now)));
    await assert.rejects(reserveSmtpSend({ DB: db }, 'privacy@pcln.top', now), /limit/);
    await reserveSmtpSend({ DB: db }, 'privacy@pcln.top', now + 100001);
    await assert.rejects(reserveSmtpSend({ DB: db }, 'noreply@pcln.top', now + 100001), /limit/);
    await reserveSmtpSend({ DB: db }, 'noreply@pcln.top', now + 86400001);
    const stored = await db.prepare('SELECT * FROM mail_send_reservations LIMIT 1').first();
    assert.ok(!JSON.stringify(stored).includes('@pcln.top'));
    await db.prepare('DELETE FROM mail_send_reservations').run();
  });
  await t.test('automatic receipts are deduplicated, bounded and report uncertain delivery', async () => {
    let sent = 0; const send = async (_env, message) => { assert.equal(message.headers['Auto-Submitted'], 'auto-replied'); sent++; return { id: 'sent' }; };
    for (const mailbox of ['support', 'privacy', 'security', 'legal']) {
      const headers = { from: 'person@example.com', to: `${mailbox}@pcln.top` };
      assert.equal(await acknowledgeMail({ DB: db }, mailbox, headers, send), 'sent');
      assert.equal(await acknowledgeMail({ DB: db }, mailbox, headers, send), 'skipped');
      assert.equal(await acknowledgeMail({ DB: db }, mailbox + '-again', headers, send), 'skipped');
    }
    assert.equal(sent, 4);
    const header = { from: 'other@example.com', to: 'support@pcln.top' };
    assert.equal(await acknowledgeMail({ DB: db }, 'uncertain', header, async () => { throw new Error('socket closed'); }), 'pending');
    assert.equal(await acknowledgeMail({ DB: db }, 'uncertain', header, send), 'skipped'); assert.equal(sent, 4);
  });
  await t.test('IMAP initializes without replying to old messages and only reads new headers', async () => {
    let uidNext = 11, sends = 0; const commands = [];
    function connect() {
      let controller, pending = '', closed = false;
      const emit = value => controller.enqueue(typeof value === 'string' ? text(value) : value);
      return Promise.resolve({ opened: Promise.resolve(), readable: new ReadableStream({ start(c) { controller = c; emit('* OK IMAP test\r\n'); } }), writable: new WritableStream({ write(bytes) {
        pending += new TextDecoder().decode(bytes);
        while (pending.includes('\r\n')) {
          const end = pending.indexOf('\r\n'), line = pending.slice(0, end); pending = pending.slice(end + 2); const [tag, ...rest] = line.split(' '), command = rest.join(' '); commands.push(command);
          if (command.startsWith('LOGIN ')) emit(`${tag} OK login\r\n`);
          else if (command === 'EXAMINE INBOX') emit(`* OK [UIDVALIDITY 42]\r\n* OK [UIDNEXT ${uidNext}]\r\n${tag} OK selected\r\n`);
          else if (command.startsWith('UID SEARCH')) emit(`* SEARCH 10 11\r\n${tag} OK search\r\n`);
          else if (command.startsWith('UID FETCH')) { const headers = text('From: fresh@example.com\r\nTo: support@pcln.top\r\nMessage-ID: <fresh@example.com>\r\n\r\n'); emit(`* 1 FETCH (BODY[HEADER] {${headers.length}}\r\n`); emit(headers); emit(`)\r\n${tag} OK fetch\r\n`); }
          else if (command === 'LOGOUT') emit(`${tag} OK logout\r\n`);
          else throw new Error('Unexpected IMAP command');
        }
      } }), async close() { if (!closed) { closed = true; controller.close(); } } });
    }
    const account = { username: 'inbox@pcln.top', password: 'private-test-password' }, env = { DB: db };
    assert.equal((await pollInbox(env, account, connect, async () => { sends++; return { id: 'receipt' }; })).initialized, true); assert.equal(sends, 0);
    uidNext = 12;
    assert.equal((await pollInbox(env, account, connect, async () => { sends++; return { id: 'receipt' }; })).sent, 1); assert.equal(sends, 1);
    assert.ok(commands.some(command => command.startsWith('UID FETCH 11 (BODY.PEEK[HEADER.FIELDS'))); assert.ok(!commands.some(command => command.startsWith('UID FETCH 10')));
    await db.prepare('UPDATE mail_inbox_state SET updated_at=1').run();
    await pollInbox(env, account, connect, async () => { sends++; return { id: 'receipt' }; }); assert.equal(sends, 1);
    const quiet = await db.prepare('SELECT last_uid,updated_at FROM mail_inbox_state').first();
    assert.equal(quiet.last_uid, 11); assert.ok(quiet.updated_at > 1, 'successful empty polls must keep the cursor active');
  });
});
