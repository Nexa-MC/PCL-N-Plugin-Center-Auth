// Edit acknowledgement copy here. Receipts acknowledge arrival, not resolution.
import { emailLayout } from './mail-layout.mjs';
export const CONTACT_MAILBOXES = Object.freeze({
  support: { name: 'Nexa Support', subject: 'Nexa 已收到你的支持请求 / Support request received', zh: '我们已收到你的支持请求，后续会由团队通过此邮箱跟进。涉及订单时，可补充订单编号与问题描述；请勿发送密码、验证码或完整支付卡信息。', en: 'We have received your support request. Our team will follow up by email. For purchases, include the order reference and a description of the issue. Do not send passwords, verification codes or full payment card details.' },
  privacy: { name: 'Nexa Privacy', subject: 'Nexa 已收到你的隐私请求 / Privacy request received', zh: '我们已收到你的隐私或数据权利请求。团队会核对请求范围，并在必要时通过此邮箱核实身份。本回执不代表数据已经导出、更正或删除。请勿在未经要求时发送身份证件等敏感材料。', en: 'We have received your privacy or data rights request. Our team will review its scope and may verify your identity by email. This receipt does not mean data has already been exported, corrected or deleted. Do not send identity documents unless requested.' },
  security: { name: 'Nexa Security', subject: 'Nexa 已收到你的安全报告 / Security report received', zh: '我们已收到你的安全报告，团队会人工核实并通过此邮箱跟进。核实前请勿公开敏感漏洞细节、访问令牌或他人的个人信息。本回执不代表问题已经修复。', en: 'We have received your security report. Our team will review it and follow up by email. Please avoid publishing sensitive vulnerability details, access tokens or personal information while it is being reviewed. This receipt does not mean the issue has been fixed.' },
  legal: { name: 'Nexa Legal', subject: 'Nexa 已收到你的法律事务来信 / Legal correspondence received', zh: '我们已收到你的法律或知识产权事务来信。团队会核对内容，并在必要时请求补充信息。本邮件仅为自动收件确认，不表示对来信主张的认可或处理结论。', en: 'We have received your legal or intellectual property correspondence. Our team will review it and may request additional information. This automatic receipt does not indicate acceptance of a claim or a decision.' }
});
export function acknowledgementTemplate(mailbox) {
  const template = CONTACT_MAILBOXES[mailbox];
  if (!template) throw new Error('Unknown contact mailbox');
  const footer = '此为自动回执，后续回复由团队处理。 / This is an automatic receipt; follow-up is handled by our team.';
  return { subject: template.subject, ...emailLayout({ title: template.subject, paragraphs: [template.zh, template.en], footer }) };
}
export function loginCodeTemplate(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('Invalid verification code');
  const subject = 'Nexa 登录验证码 / Sign-in verification code';
  return { subject, ...emailLayout({ title: subject, code, paragraphs: ['验证码 5 分钟内有效，最多尝试 5 次，使用后失效。请勿向任何人提供验证码。若非本人操作，请忽略此邮件。', 'This code expires in 5 minutes, allows up to 5 attempts and can be used once. Do not share it. If you did not request it, ignore this email.'], footer: '系统邮件由 noreply@pcln.top 发送。 / System mail is sent from noreply@pcln.top.' }) };
}
