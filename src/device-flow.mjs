import { randomBytes, createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const code = value => typeof value === 'string' ? value.toUpperCase().replace(/[- ]/g, '') : '';
const client = 'nexacl';
// Device authorization identifies an authorized client session, not attested hardware.
export async function deviceFlow(request, env, { body, user, rateLimit, fail, json }) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/auth/v1/device')) return null;
  const now = Date.now(), db = env.DB;
  const reply = (data, status = 200) => json(env, data, status);
  const error = (name, status = 400) => reply({ error: name }, status);
  if (request.method !== 'POST') fail(405, '方法不支持');
  const input = await body(request);
  if (path === '/auth/v1/device/authorize') {
    if (input.client_id !== client) return error('invalid_client');
    await rateLimit(env, 'device-start:' + hash(request.headers.get('cf-connecting-ip') || 'unknown'), 10, 600000, '设备登录请求过于频繁');
    const deviceCode = randomBytes(32).toString('base64url');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const userCode = [...randomBytes(8)].map(n => alphabet[n % alphabet.length]).join('');
    await db.batch([
      db.prepare('DELETE FROM device_authorizations WHERE expires<=?').bind(now),
      db.prepare('INSERT INTO device_authorizations(device_hash,code_hash,expires,next_poll) VALUES(?,?,?,?)').bind(hash(deviceCode), hash(userCode), now + 600000, now)
    ]);
    const display = userCode.slice(0, 4) + '-' + userCode.slice(4);
    return reply({ device_code: deviceCode, user_code: display, verification_uri: env.WEB_ORIGIN + '/device', verification_uri_complete: env.WEB_ORIGIN + '/device?user_code=' + display, expires_in: 600, interval: 5 }, 201);
  }
  if (path === '/auth/v1/device/confirm') {
    const actor = await user();
    if (actor.client !== 'web') fail(403, '请在浏览器中确认设备登录');
    if (!actor.termsAccepted || actor.setupRequired) fail(403, '请先完成账户设置并接受服务条款');
    await rateLimit(env, 'device-confirm:' + actor.id, 10, 900000, '设备码尝试过于频繁');
    const normalized = code(input.user_code);
    if (!/^[A-Z2-9]{8}$/.test(normalized) || !['approve', 'deny'].includes(input.decision)) return error('invalid_request');
    const session = (request.headers.get('authorization') || '').match(/^Bearer ([^\s]+)$/)?.[1]
      || (request.headers.get('cookie') || '').match(/(?:^|;\s*)nexa_console=([^;]+)/)?.[1] || '';
    const result = await db.prepare("UPDATE device_authorizations SET state=?,user_id=?,approved_session=? WHERE code_hash=? AND state='pending' AND expires>? RETURNING device_hash")
      .bind(input.decision === 'approve' ? 'approved' : 'denied', actor.id, hash(session), hash(normalized), now).first();
    if (!result) return error('expired_token');
    return reply({ ok: true });
  }
  if (!['/auth/v1/device/token', '/auth/v1/device/cancel'].includes(path)) fail(404, '接口不存在');
  if (input.client_id !== client || typeof input.device_code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.device_code)) return error('invalid_request');
  const deviceHash = hash(input.device_code);
  if (path.endsWith('/cancel')) {
    await db.prepare("UPDATE device_authorizations SET state='denied' WHERE device_hash=? AND state IN ('pending','approved')").bind(deviceHash).run();
    return reply({ ok: true });
  }
  const row = await db.prepare('SELECT * FROM device_authorizations WHERE device_hash=?').bind(deviceHash).first();
  if (!row || row.expires <= now || row.state === 'consumed') return error('expired_token');
  if (row.state === 'denied') return error('access_denied');
  const admitted = await db.prepare('UPDATE device_authorizations SET next_poll=? WHERE device_hash=? AND next_poll<=? RETURNING state').bind(now + 5000, deviceHash, now).first();
  if (!admitted) return error('slow_down', 429);
  if (admitted.state === 'pending') return error('authorization_pending');
  const accessToken = randomBytes(32).toString('base64url'), tokenHash = hash(accessToken);
  const result = await db.batch([
    db.prepare(`INSERT INTO sessions(token_hash,user_id,scope,expires,client)
      SELECT ?,d.user_id,'console',?,'nexacl' FROM device_authorizations d JOIN users u ON u.id=d.user_id
      JOIN sessions s ON s.token_hash=d.approved_session AND s.user_id=d.user_id AND s.client='web' AND s.scope='console'
      WHERE d.device_hash=? AND d.state='approved' AND d.expires>? AND s.expires>? AND u.disabled=0`).bind(tokenHash, now + 86400000, deviceHash, now, now),
    db.prepare("UPDATE device_authorizations SET state='consumed' WHERE device_hash=? AND state='approved' AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)").bind(deviceHash, tokenHash)
  ]);
  if (result[0].meta.changes !== 1) return error('access_denied');
  return reply({ access_token: accessToken, token_type: 'Bearer', expires_in: 86400 });
}
