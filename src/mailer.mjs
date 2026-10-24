// NCL-011 邮件抽象：业务代码只依赖此接口，具体服务商通过环境变量接入。
// SMTP takes precedence. Resend remains compatible with existing installations.
import { loginCodeTemplate } from './mail-templates.mjs';
import { smtpReady, smtpSend } from './smtp.mjs';
import { notificationTemplate } from './mail-layout.mjs';
import { reserveSmtpSend } from './mail-quota.mjs';
const FROM = 'Nexa Cloud <noreply@pcln.top>';
export const mailReady = env => smtpReady(env, env.MAIL_FROM || FROM) || Boolean(env.RESEND_API_KEY);
export async function sendEmail(env, message, idempotencyKey) {
  if (!message.html) message = { ...message, ...notificationTemplate(message.subject, message.text) };
  const headers = { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All', ...message.headers };
  if (smtpReady(env, message.from || env.MAIL_FROM || FROM)) {
    await reserveSmtpSend(env, message.from || env.MAIL_FROM || FROM);
    return smtpSend(env, { from: env.MAIL_FROM || FROM, ...message, headers });
  }
  if (!env.RESEND_API_KEY) throw new Error('Email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(12000),
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: JSON.stringify({ from: env.MAIL_FROM || FROM, ...message, headers })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  return await response.json();
}
function nullMailer() {
  const log = (kind, to) => console.info(JSON.stringify({ mail: kind, to: Boolean(to) }));
  return {
    send: async (to, subject) => log(subject, to),
    loginCode: async () => { throw new Error('Email provider is not configured'); },
    accountDeletionRequested: (to, at) => log(`account.deletion.requested:${at}`, to),
    accountDeletionCancelled: to => log('account.deletion.cancelled', to),
    accountDeletionCompleted: to => log('account.deletion.completed', to),
    securityNotice: (to, detail) => log(`security:${detail}`, to)
  };
}
export function createMailer(env) {
  if (!mailReady(env)) return nullMailer();
  const send = async (to, subject, text) => {
    if (!to) return;
    try {
      await sendEmail(env, { to, subject, text });
    } catch (error) { console.error(JSON.stringify({ mail: 'send.error', error: error.name })); }
  };
  return {
    send,
    loginCode: (to, code) => sendEmail(env, { to, ...loginCodeTemplate(code) }),
    accountDeletionRequested: (to, at) => send(to, '你的 Nexa Cloud 账户注销申请已收到', `我们已收到你的注销申请，将于 ${at} 生效。在此期间登录账户即可撤销注销。`),
    accountDeletionCancelled: to => send(to, '你的 Nexa Cloud 账户注销已撤销', '你已撤销注销申请，账户继续保持正常可用。'),
    accountDeletionCompleted: to => send(to, '你的 Nexa Cloud 账户已注销', '账户注销已完成，个人资料已删除或匿名化。依法需要保留的记录将与普通账户分离受限保存。'),
    securityNotice: (to, detail) => send(to, 'Nexa Cloud 账户安全通知', detail)
  };
}
