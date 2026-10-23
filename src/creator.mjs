import {randomUUID} from 'node:crypto';
import {digest} from './password.mjs';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};

export async function applyCreator(env,user,sessionToken,input,now=Date.now()) {
  if(!input || Array.isArray(input) || input.kind!=='creator' || Object.keys(input).some(k=>k!=='kind')) fail(422,'创作者申请仅接受kind字段');
  if(user.setupRequired || !user.termsAccepted) fail(403,'请先完成注册并接受服务条款');
  const id=randomUUID(),stamp=new Date(now).toISOString(),sessionHash=digest(sessionToken);
  const [inserted]=await env.DB.batch([
    env.DB.prepare(`INSERT INTO applications(id,user_id,kind,state,created_at,reviewed_at,reviewer)
      SELECT ?,?,'creator','approved',?,?,'system:creator' WHERE EXISTS(
        SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=? AND u.disabled=0 AND u.confirmed_at IS NOT NULL AND u.creator=0
          AND s.token_hash=? AND s.scope='console' AND s.expires>?
          AND EXISTS(SELECT 1 FROM terms_acceptances ta JOIN policy_documents pd ON pd.id=ta.policy_id
            WHERE ta.user_id=u.id AND pd.kind='terms' AND pd.current=1))`)
      .bind(id,user.id,stamp,stamp,user.id,sessionHash,now),
    env.DB.prepare('UPDATE users SET creator=1 WHERE id=? AND changes()=1').bind(user.id),
    env.DB.prepare("INSERT INTO auth_audit(actor,action,created_at,detail) SELECT ?,'creator.auto_granted',?,? WHERE changes()=1").bind(user.id,stamp,id)
  ]);
  if(inserted.meta.changes) return {ok:true,id,kind:'creator',state:'approved',creator:true,created:true};
  const current=await env.DB.prepare(`SELECT u.creator FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE u.id=? AND u.disabled=0 AND u.confirmed_at IS NOT NULL AND s.token_hash=? AND s.scope='console' AND s.expires>?`)
    .bind(user.id,sessionHash,now).first();
  if(!current?.creator) fail(409,'账户状态已改变，请刷新后重试');
  const existing=await env.DB.prepare("SELECT id FROM applications WHERE user_id=? AND kind='creator' AND state='approved' ORDER BY created_at DESC LIMIT 1").bind(user.id).first();
  return {ok:true,id:existing?.id??null,kind:'creator',state:'approved',creator:true,created:false};
}
