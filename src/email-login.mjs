import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { digest } from './password.mjs';
import { mailReady } from './mailer.mjs';
const failure = (status, message) => Object.assign(new Error(message), { status });
const key = env => env.EMAIL_OTP_SECRET || env.MFA_ENC_KEY;
export const emailLoginReady = env => Boolean(mailReady(env) && key(env));
export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw failure(400, '请输入有效邮箱地址');
  return email;
}
const mac = (env, challenge, emailHash, code) => createHmac('sha256', key(env)).update(`nexa-email-login-v1\0${challenge}\0${emailHash}\0${code}`).digest('hex');
export async function requestEmailLogin(env, email, mailer) {
  if (!emailLoginReady(env)) throw failure(503, '邮箱登录暂不可用，请使用其他登录方式');
  const candidates = await env.DB.prepare('SELECT id FROM users WHERE lower(email)=? AND disabled=0 AND confirmed_at IS NOT NULL LIMIT 2').bind(email).all();
  // Ambiguous addresses never select, merge or expose an account.
  const userId = candidates.results.length === 1 ? candidates.results[0].id : null;
  const challenge = randomBytes(32).toString('base64url'), code = String(randomInt(1000000)).padStart(6, '0');
  const challengeHash = digest(challenge), emailHash = digest(email), now = Date.now();
  await env.DB.prepare('INSERT INTO email_login_challenges(challenge_hash,user_id,email_hash,code_mac,expires,created_at) VALUES(?,?,?,?,?,?)').bind(challengeHash, userId, emailHash, mac(env, challengeHash, emailHash, code), now + 300000, now).run();
  return {
    challenge, expiresIn: 300, retryAfter: 60,
    async deliver() {
      if (!userId) return;
      try { await mailer.loginCode(email, code); }
      catch { await env.DB.prepare('UPDATE email_login_challenges SET consumed=1 WHERE challenge_hash=?').bind(challengeHash).run(); console.error(JSON.stringify({ mail: 'login.delivery_failed' })); }
    }
  };
}
export async function verifyEmailLogin(env, challenge, code) {
  if (!emailLoginReady(env)) throw failure(503, '邮箱登录暂不可用，请使用其他登录方式');
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw failure(401, '邮箱验证码无效或已过期');
  const row = await env.DB.prepare('UPDATE email_login_challenges SET attempts=attempts+1 WHERE challenge_hash=? AND consumed=0 AND expires>? AND attempts<5 RETURNING *').bind(digest(challenge), Date.now()).first();
  if (!row) throw failure(401, '邮箱验证码无效或已过期');
  const expected = mac(env, row.challenge_hash, row.email_hash, code);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(row.code_mac, 'hex')) || !row.user_id) throw failure(401, '邮箱验证码无效或已过期');
  const user = await env.DB.prepare('SELECT id,COALESCE(display_name,name) AS name,email FROM users WHERE id=? AND disabled=0 AND confirmed_at IS NOT NULL').bind(row.user_id).first();
  if (!user?.email || digest(user.email.toLowerCase()) !== row.email_hash) throw failure(401, '邮箱验证码无效或已过期');
  const unique = await env.DB.prepare('SELECT count(*) AS n FROM users WHERE lower(email)=lower(?) AND disabled=0 AND confirmed_at IS NOT NULL').bind(user.email).first();
  if (unique.n !== 1) throw failure(401, '邮箱验证码无效或已过期');
  const consumed = await env.DB.prepare('UPDATE email_login_challenges SET consumed=1 WHERE challenge_hash=? AND consumed=0 AND expires>?').bind(row.challenge_hash, Date.now()).run();
  if (!consumed.meta.changes) throw failure(401, '邮箱验证码无效或已过期');
  return user;
}
