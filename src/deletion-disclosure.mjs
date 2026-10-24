const domain = 'nexa:store-publisher-forfeiture:v1:';
export async function verifyDeletionDisclosure(token, secret, userId, now = Math.floor(Date.now()/1000)) {
  try {
    if (!secret || typeof token!=='string' || token.length>4096) return null;
    const parts=token.split('.');if(parts.length!==2||parts.some(part=>! /^[A-Za-z0-9_-]+$/.test(part)))return null;
    const decode=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),char=>char.charCodeAt(0));
    const claims=JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if(claims.policy!==1||claims.ledger!=='store_ntoken_v1'||claims.sub!==userId||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)
      ||claims.iat>now+30||claims.exp<=now||claims.exp-claims.iat!==300||typeof claims.nonce!=='string')return null;
    if(['earnedUnits','pendingUnits','approvedUnits'].some(field=>!Number.isSafeInteger(claims[field])||claims[field]<0)
      ||claims.pendingUnits+claims.approvedUnits>claims.earnedUnits)return null;
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    return await crypto.subtle.verify('HMAC',key,decode(parts[1]),new TextEncoder().encode(domain+parts[0]))?claims:null;
  }catch{return null;}
}
