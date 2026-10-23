import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { digest } from '../src/password.mjs';

test('Bilibili binding verifies trusted profiles and atomically consumes session-bound challenges', async t => {
  const root = new URL('../', import.meta.url), profiles = new Map();
  let beforeRead, calls = 0, restricted = false;
  const modules = ['index.mjs', ...(await readdir(new URL('src/', root))).filter(file => file.endsWith('.mjs') && file !== 'index.mjs')];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modulesRoot: fileURLToPath(root), modules: modules.map(file => ({ type: 'ESModule', path: fileURLToPath(new URL('src/' + file, root)) })),
    compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'bilibili-binding-test' },
    bindings: { WEB_ORIGIN: 'https://web.test', BILIBILI_BINDING_ENABLED: 'true', BILIBILI_VERIFIER_TOKEN: 'test-verifier-token-that-is-long-enough' },
    serviceBindings: { BILIBILI_VERIFIER: async request => {
      calls++;
      assert.equal(request.headers.get('authorization'), 'Bearer test-verifier-token-that-is-long-enough');
      const input = await request.json();
      assert.deepEqual(Object.keys(input).sort(), ['requestId', 'uid']);
      if (beforeRead) await beforeRead(input);
      if (restricted) return Response.json({ code: 'provider_restricted' }, { status: 503 });
      return Response.json({ uid: input.uid, requestId: input.requestId, source: 'cloudflare-browser', name: '测试B站用户', signature: '', level: 6, followers: 123, checkedAt: new Date().toISOString(), ...profiles.get(input.uid) });
    } }
  }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB');
  for (const file of (await readdir(new URL('migrations/', root))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(new URL('migrations/' + file, root), 'utf8')).replace(/--[^\n]*/g, '').split(';').map(value => value.trim()).filter(Boolean);
    await DB.batch(sql.map(value => DB.prepare(value)));
  }
  async function user(id) {
    const stamp = new Date().toISOString(), token = 'session-' + id;
    await DB.prepare("INSERT INTO users(id,name,user_handle,password_hash,confirmed_at,created_at) VALUES(?,?,?,'oauth:test',?,?)").bind(id, id, 'user_' + id, stamp, stamp).run();
    await DB.prepare("INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,'console',?)").bind(digest(token), id, Date.now() + 3600000).run();
    await DB.prepare("INSERT INTO terms_acceptances(user_id,policy_id,accepted_at) VALUES(?,'terms-1.1',?)").bind(id, stamp).run();
    return { id, token };
  }
  const call = (who, path, method = 'POST', data = {}) => mf.dispatchFetch('https://web.test/auth/v1/connections/bilibili' + path, { method, headers: { origin: 'https://web.test', 'x-nexa-request': '1', authorization: 'Bearer ' + who.token, 'content-type': 'application/json' }, ...(method === 'DELETE' || method === 'GET' ? {} : { body: JSON.stringify(data) }) });
  const create = async (who, uid) => {
    const response = await call(who, '/challenges', 'POST', { uid });
    assert.equal(response.status, 201, await response.clone().text());
    const challenge = await response.json();
    profiles.set(uid, { signature: challenge.signature });
    return challenge;
  };
  const verify = (who, challenge, data = {}) => call(who, `/challenges/${challenge.id}/verify`, 'POST', data);
  const bound = id => DB.prepare("SELECT * FROM external_connections WHERE user_id=? AND provider='bilibili'").bind(id).first();

  await t.test('valid fresh signature binds once and stores only its hash in the challenge', async () => {
    const who = await user('normal'), challenge = await create(who, '123');
    assert.ok(challenge.signature.includes('@user_normal'));
    assert.ok(challenge.signature.length <= 70);
    const saved = await DB.prepare('SELECT * FROM bilibili_binding_challenges WHERE id=?').bind(challenge.id).first();
    assert.equal(saved.expected_hash, digest(challenge.signature));
    assert.ok(!JSON.stringify(saved).includes(challenge.signature));
    const result = await verify(who, challenge);
    assert.equal(result.status, 200, await result.clone().text());
    assert.deepEqual(await result.json(), { verified: true, uid: '123' });
    const connection = await bound(who.id);
    assert.equal(connection.subject, '123'); assert.equal(connection.profile_level, 6); assert.equal(connection.followers, 123);
    const previousCalls = calls;
    assert.equal((await verify(who, challenge)).status, 409); assert.equal(calls, previousCalls);
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM auth_audit WHERE actor=? AND action='bilibili.linked'").bind(who.id).first()).n, 1);
  });
  await t.test('client supplied proof JSON, other accounts and other sessions cannot complete a challenge', async () => {
    const owner = await user('owner'), attacker = await user('attacker'), challenge = await create(owner, '234');
    const previousCalls = calls;
    assert.equal((await verify(owner, challenge, { verified: true, uid: '234', signature: challenge.signature })).status, 422);
    assert.equal((await verify(attacker, challenge)).status, 409);
    await DB.prepare("INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,'console',?)").bind(digest('different-session'), owner.id, Date.now() + 3600000).run();
    assert.equal((await verify({ ...owner, token: 'different-session' }, challenge)).status, 409);
    assert.equal(calls, previousCalls); assert.equal(await bound(owner.id), null);
  });
  await t.test('new challenges, cancellation and expiry invalidate previous attempts', async () => {
    const who = await user('lifecycle'), first = await create(who, '345'), second = await create(who, '345');
    assert.notEqual(first.signature, second.signature);
    assert.equal((await verify(who, first)).status, 409);
    assert.equal((await call(who, '/challenges/' + second.id, 'DELETE')).status, 204);
    assert.equal((await verify(who, second)).status, 409);
    const third = await create(who, '345');
    await DB.prepare('UPDATE bilibili_binding_challenges SET expires_at=? WHERE id=?').bind(Date.now() - 1, third.id).run();
    assert.equal((await verify(who, third)).status, 409); assert.equal(await bound(who.id), null);
  });
  await t.test('incorrect signatures have five attempts and cannot be self-asserted', async () => {
    const who = await user('attempts'), challenge = await create(who, '456');
    profiles.set('456', { signature: 'a copied or different public signature' });
    for (let n = 0; n < 5; n++) assert.equal((await verify(who, challenge)).status, 422);
    assert.equal((await verify(who, challenge)).status, 429); assert.equal(await bound(who.id), null);
  });
  await t.test('wrong UID and stale trusted-service results never grant a binding', async () => {
    const who = await user('wrongprofile'), challenge = await create(who, '567');
    profiles.set('567', { signature: challenge.signature, uid: '999' });
    assert.equal((await verify(who, challenge)).status, 502);
    profiles.set('567', { signature: challenge.signature, checkedAt: '2020-01-01T00:00:00.000Z' });
    assert.equal((await verify(who, challenge)).status, 502);
    assert.equal(await bound(who.id), null);
  });
  await t.test('logout while the upstream request is running prevents the final write', async () => {
    const who = await user('logout'), challenge = await create(who, '678');
    beforeRead = async () => { await DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(who.id).run(); };
    try { assert.equal((await verify(who, challenge)).status, 409); }
    finally { beforeRead = null; }
    assert.equal(await bound(who.id), null);
  });
  await t.test('cancellation while reading and concurrent finalization cannot bypass state or uniqueness', async () => {
    const cancelled = await user('cancelrace'), cancelledChallenge = await create(cancelled, '789');
    beforeRead = async () => { await DB.prepare("UPDATE bilibili_binding_challenges SET state='revoked' WHERE id=?").bind(cancelledChallenge.id).run(); };
    try { assert.equal((await verify(cancelled, cancelledChallenge)).status, 409); }
    finally { beforeRead = null; }
    assert.equal(await bound(cancelled.id), null);
    const who = await user('concurrent'), challenge = await create(who, '890');
    const results = await Promise.all([verify(who, challenge), verify(who, challenge)]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
    const other = await user('occupied');
    assert.equal((await call(other, '/challenges', 'POST', { uid: '890' })).status, 409);
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM auth_audit WHERE actor=? AND action='bilibili.linked'").bind(who.id).first()).n, 1);
    assert.equal((await call(who, '', 'DELETE')).status, 204);
    assert.equal(await bound(who.id), null);
    assert.equal((await verify(who, challenge)).status, 409);
  });
  await t.test('provider restriction applies a shared cooldown without automatic retries', async () => {
    const who = await user('restricted'), challenge = await create(who, '901');
    restricted = true; const previousCalls = calls;
    assert.equal((await verify(who, challenge)).status, 503);
    restricted = false;
    assert.equal((await verify(who, challenge)).status, 503);
    assert.equal(calls, previousCalls + 1); assert.equal(await bound(who.id), null);
  });
});
