import { randomBytes, randomUUID } from 'node:crypto';
import { digest } from './password.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uidPattern = /^[1-9]\d{0,19}$/;
const idPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export const bilibiliBindingConfigured = env => env.BILIBILI_BINDING_ENABLED === 'true' && typeof env.BILIBILI_VERIFIER?.fetch === 'function' && typeof env.BILIBILI_VERIFIER_TOKEN === 'string' && env.BILIBILI_VERIFIER_TOKEN.length >= 32;
const configured = env => { if (!bilibiliBindingConfigured(env)) fail(503, 'B站绑定暂未开放'); };

export async function createBilibiliChallenge(env, user, sessionToken, input, now = Date.now()) {
  configured(env);
  if (user.setupRequired || !user.termsAccepted) fail(403, '请先完成注册并接受服务条款');
  if (!input || Object.keys(input).some(key => key !== 'uid') || typeof input.uid !== 'string' || !uidPattern.test(input.uid)) fail(422, '请输入有效的B站UID');
  const existing = await env.DB.prepare("SELECT user_id FROM external_connections WHERE provider='bilibili' AND (subject=? OR user_id=?)").bind(input.uid, user.id).first();
  if (existing) fail(409, existing.user_id === user.id ? '请先解除现有B站绑定，再重新核验' : '该B站账户已关联其他Nexa账户');
  const label = /^[a-z][a-z0-9_-]{5,19}$/.test(user.handle ?? '') ? user.handle : digest(user.id).slice(0, 10);
  const signature = `Nexa @${label} bind ${randomBytes(16).toString('base64url')}`;
  const id = randomUUID(), expiresAt = now + 900000;
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("UPDATE bilibili_binding_challenges SET state='revoked' WHERE user_id=? AND state='pending'").bind(user.id),
    env.DB.prepare(`INSERT INTO bilibili_binding_challenges(id,user_id,session_hash,uid,expected_hash,created_at,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.scope='console' AND s.expires>? AND u.disabled=0 AND u.confirmed_at IS NOT NULL)`)
      .bind(id, user.id, digest(sessionToken), input.uid, digest(signature), now, expiresAt, digest(sessionToken), user.id, now)
  ]);
  if (!inserted.meta.changes) fail(401, '验证请求已失效，请重新登录');
  return { id, uid: input.uid, signature, accountLabel: label, expiresAt, maxAttempts: 5 };
}

export async function cancelBilibiliChallenge(env, userId, sessionToken, id) {
  if (!idPattern.test(id)) fail(400, '验证请求无效');
  await env.DB.prepare("UPDATE bilibili_binding_challenges SET state='revoked' WHERE id=? AND user_id=? AND session_hash=? AND state='pending'").bind(id, userId, digest(sessionToken)).run();
}

export async function verifyBilibiliChallenge(env, user, sessionToken, id, input, now = Date.now()) {
  configured(env);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) fail(422, '验证仅接受当前挑战，不接受客户端资料');
  if (!idPattern.test(id)) fail(400, '验证请求无效');
  if (user.setupRequired || !user.termsAccepted) fail(403, '请先完成注册并接受服务条款');
  const sessionHash = digest(sessionToken);
  const row = await env.DB.prepare(`SELECT c.* FROM bilibili_binding_challenges c JOIN sessions s ON s.token_hash=c.session_hash AND s.user_id=c.user_id
    WHERE c.id=? AND c.user_id=? AND c.session_hash=? AND c.state='pending' AND c.expires_at>? AND s.expires>? AND s.scope='console'`)
    .bind(id, user.id, sessionHash, now, now).first();
  if (!row) fail(409, '验证请求已失效，请重新开始');
  if (row.attempts >= 5) fail(429, '验证次数已用完，请重新开始');
  const state = await env.DB.prepare('SELECT blocked_until FROM bilibili_provider_state WHERE id=1').first();
  if ((state?.blocked_until ?? 0) > now) fail(503, 'B站暂时限制资料读取，请稍后再试');
  const attempt = await env.DB.prepare("UPDATE bilibili_binding_challenges SET attempts=attempts+1 WHERE id=? AND state='pending' AND expires_at>? AND attempts<5").bind(id, now).run();
  if (!attempt.meta.changes) fail(409, '验证状态已变化，请重新开始');
  const requestId = randomUUID();
  let response, profile;
  try {
    response = await env.BILIBILI_VERIFIER.fetch('https://bilibili-verifier.internal/internal/v1/profile', {
      method: 'POST', headers: { authorization: 'Bearer ' + env.BILIBILI_VERIFIER_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ uid: row.uid, requestId }), signal: AbortSignal.timeout(30000)
    });
    profile = await response.json();
  } catch { fail(503, '暂时无法核验B站签名，请稍后重试'); }
  if (!response.ok) {
    if (profile?.code === 'provider_restricted') {
      await env.DB.prepare('INSERT INTO bilibili_provider_state(id,blocked_until) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET blocked_until=max(blocked_until,excluded.blocked_until)').bind(now + 600000).run();
      fail(503, 'B站暂时限制资料读取，请稍后再试');
    }
    fail(503, '暂时无法核验B站签名，请稍后重试');
  }
  if (!profile || typeof profile.checkedAt !== 'string') fail(502, 'B站核验服务返回了无效资料');
  const checked = Date.parse(profile.checkedAt), finished = Date.now();
  if (profile.uid !== row.uid || profile.requestId !== requestId || profile.source !== 'cloudflare-browser' || typeof profile.signature !== 'string' || profile.signature.length > 280 || typeof profile.name !== 'string' || profile.name.length > 160 || !Number.isFinite(checked) || checked < row.created_at || checked > finished + 5000 || finished - checked > 60000 || !(profile.level === null || Number.isInteger(profile.level) && profile.level >= 0 && profile.level <= 6) || !(profile.followers === null || Number.isSafeInteger(profile.followers) && profile.followers >= 0)) fail(502, 'B站核验服务返回了无效资料');
  if (digest(profile.signature) !== row.expected_hash) fail(422, 'B站签名尚未匹配，请检查修改后稍后重试');
  const stamp = new Date(finished).toISOString();
  const [claimed] = await env.DB.batch([
    env.DB.prepare(`UPDATE bilibili_binding_challenges SET state='verified',verified_at=? WHERE id=? AND user_id=? AND session_hash=? AND state='pending' AND expires_at>?
      AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.scope='console' AND s.expires>? AND u.disabled=0 AND u.confirmed_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM external_connections WHERE provider='bilibili' AND (subject=? OR user_id=?))`)
      .bind(stamp, id, user.id, sessionHash, finished, sessionHash, user.id, finished, row.uid, user.id),
    env.DB.prepare(`INSERT INTO external_connections(user_id,provider,subject,display_name,followers,profile_level,connected_at,checked_at)
      SELECT ?,'bilibili',?,?,?,?,?,? WHERE changes()=1`).bind(user.id, row.uid, profile.name, profile.followers, profile.level, stamp, profile.checkedAt),
    env.DB.prepare("INSERT INTO auth_audit(actor,action,created_at,detail) SELECT ?,'bilibili.linked',?,? WHERE changes()=1").bind(user.id, stamp, row.uid)
  ]);
  if (!claimed.meta.changes) fail(409, '验证状态或账户绑定已变化，请重新开始');
  return { verified: true, uid: row.uid };
}
