import { randomUUID } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const FRESH_MS = 86400000;
const QUERY = `query DeveloperEligibility($after:String) {
  viewer { id databaseId login createdAt followers { totalCount }
    repositories(first:100,after:$after,affiliations:[OWNER],ownerAffiliations:[OWNER],orderBy:{field:STARGAZERS,direction:DESC}) {
      nodes { nameWithOwner url owner { id } stargazerCount primaryLanguage { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
  organization(login:"Nexa-MC") { viewerIsAMember }
}`;

export async function fetchGithubDeveloperProfile(subject, token, fetcher = fetch, now = Date.now()) {
  const signal = AbortSignal.timeout(10000);
  let after = null, facts;
  for (let page = 0; page < 10; page++) {
    let payload;
    try {
      const response = await fetcher('https://api.github.com/graphql', {
        method: 'POST', redirect: 'manual', signal,
        headers: { authorization: 'Bearer ' + token, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Nexa-Developer-Eligibility/1.0' },
        body: JSON.stringify({ query: QUERY, variables: { after } })
      });
      if (!response.ok) throw new Error();
      const raw = await response.text();
      if (raw.length > 1048576) throw new Error();
      payload = JSON.parse(raw);
    } catch { fail(503, '暂时无法核验GitHub开发者条件，请稍后重新授权'); }
    const viewer = payload?.data?.viewer, organization = payload?.data?.organization, repos = viewer?.repositories;
    if (payload?.errors?.length || !Number.isSafeInteger(viewer?.databaseId) || String(viewer.databaseId) !== subject || typeof viewer.id !== 'string' || !Number.isFinite(Date.parse(viewer.createdAt)) || Date.parse(viewer.createdAt) > now || !Number.isSafeInteger(viewer.followers?.totalCount) || viewer.followers.totalCount < 0 || typeof organization?.viewerIsAMember !== 'boolean' || !Array.isArray(repos?.nodes) || repos.nodes.length > 100 || typeof repos.pageInfo?.hasNextPage !== 'boolean') fail(502, 'GitHub开发者资料无效，请确认已授权读取组织成员身份');
    facts ??= { accountCreatedAt: viewer.createdAt, followers: viewer.followers.totalCount, orgMember: organization.viewerIsAMember, qualifyingRepository: null };
    let previousStars = Infinity;
    for (const repo of repos.nodes) {
      if (!repo || repo.owner?.id !== viewer.id || !Number.isSafeInteger(repo.stargazerCount) || repo.stargazerCount < 0 || repo.stargazerCount > previousStars || !/^[\w.-]+\/[\w.-]+$/.test(repo.nameWithOwner) || repo.url !== 'https://github.com/' + repo.nameWithOwner || !(repo.primaryLanguage === null || typeof repo.primaryLanguage?.name === 'string')) fail(502, 'GitHub开发者仓库资料无效');
      previousStars = repo.stargazerCount;
      if (repo.stargazerCount >= 10000 && repo.primaryLanguage?.name && repo.primaryLanguage.name.toLowerCase() !== 'markdown') facts.qualifyingRepository ??= repo.nameWithOwner;
    }
    if (facts.qualifyingRepository || !repos.pageInfo.hasNextPage || repos.nodes.at(-1)?.stargazerCount < 10000) return facts;
    if (!repos.nodes.length || typeof repos.pageInfo.endCursor !== 'string' || !repos.pageInfo.endCursor || repos.pageInfo.endCursor === after) fail(502, 'GitHub开发者仓库分页无效');
    after = repos.pageInfo.endCursor;
  }
  fail(503, 'GitHub仓库过多，暂时无法完成开发者条件核验');
}

export async function saveGithubDeveloperProfile(env, state, userId, subject, token, fetcher = fetch) {
  const identity = await env.DB.prepare("SELECT created_at FROM oauth_identities WHERE user_id=? AND provider='github' AND subject=?").bind(userId, subject).first();
  if (!identity) fail(409, 'GitHub绑定已改变，请重新授权');
  const facts = await fetchGithubDeveloperProfile(subject, token, fetcher);
  const stamp = new Date().toISOString();
  const result = await env.DB.prepare(`INSERT INTO github_developer_profiles(user_id,subject,linked_at,profile_version,account_created_at,followers,qualifying_repository,org_member,checked_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM oauth_states os JOIN sessions s ON s.token_hash=os.session_hash AND s.user_id=os.user_id AND s.scope=os.session_scope
      JOIN users u ON u.id=os.user_id JOIN oauth_identities i ON i.user_id=u.id AND i.provider='github'
      WHERE os.state=? AND os.user_id=? AND os.developer_check=1 AND os.consumed=1 AND os.expires>? AND s.expires>? AND u.disabled=0 AND u.confirmed_at IS NOT NULL AND i.subject=? AND i.created_at=?)
    ON CONFLICT(user_id) DO UPDATE SET subject=excluded.subject,linked_at=excluded.linked_at,profile_version=excluded.profile_version,account_created_at=excluded.account_created_at,
      followers=excluded.followers,qualifying_repository=excluded.qualifying_repository,org_member=excluded.org_member,checked_at=excluded.checked_at,
      core_verified_at=CASE WHEN subject=excluded.subject AND linked_at=excluded.linked_at THEN core_verified_at ELSE NULL END,
      core_reviewer=CASE WHEN subject=excluded.subject AND linked_at=excluded.linked_at THEN core_reviewer ELSE NULL END`)
    .bind(userId,subject,identity.created_at,randomUUID(),facts.accountCreatedAt,facts.followers,facts.qualifyingRepository,Number(facts.orgMember),stamp,state,userId,Date.now(),Date.now(),subject,identity.created_at).run();
  if (!result.meta.changes) fail(409, '授权会话或GitHub绑定已改变，请重新开始');
}

export function developerConditions(row, now = Date.now(), kind = 'developer') {
  const fresh = Boolean(row?.checked_at && Date.parse(row.checked_at) <= now + 5000 && now - Date.parse(row.checked_at) <= FRESH_MS);
  const anniversary = new Date(row?.account_created_at ?? NaN);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 3);
  const conditions = [
    { id: 'core', label: 'NexaCL核心贡献者（管理员审核）', met: Boolean(row?.core_verified_at), value: null },
    { id: 'account-age', label: 'GitHub账号注册超过3年', met: fresh && now > anniversary.getTime(), value: row?.account_created_at ?? null },
    { id: 'repository', label: '拥有至少10000 Star且主要语言不是Markdown的仓库', met: fresh && Boolean(row?.qualifying_repository), value: fresh ? row?.qualifying_repository ?? null : null },
    { id: 'followers', label: 'GitHub关注者超过500人', met: fresh && row.followers > 500, value: fresh ? row?.followers ?? null : null },
    { id: 'organization', label: 'Nexa-MC组织成员', met: fresh && row.org_member === 1, value: null }
  ];
  if (kind === 'trusted_developer') conditions.push({ id:'plugin',label:'拥有下载量超过1000且评分至少3.0的插件',met:false,value:null,available:false });
  return { required: kind === 'trusted_developer' ? 3 : 2, verifiedCount: conditions.filter(c=>c.met).length, githubFresh: fresh, githubCheckedAt: row?.checked_at ?? null, conditions };
}

export async function loadDeveloperEligibility(env, userId, now = Date.now(), kind = 'developer') {
  const identity = await env.DB.prepare("SELECT subject,created_at FROM oauth_identities WHERE user_id=? AND provider='github'").bind(userId).first();
  const row = identity ? await env.DB.prepare('SELECT * FROM github_developer_profiles WHERE user_id=? AND subject=? AND linked_at=?').bind(userId,identity.subject,identity.created_at).first() : null;
  return { ...developerConditions(row, now, kind), githubLinked: Boolean(identity), subject: identity?.subject ?? null, linkedAt: identity?.created_at ?? null, profileVersion: row?.profile_version ?? null };
}

export async function submitDeveloperApplication(env, user, input, now = Date.now()) {
  if(user.setupRequired || !user.termsAccepted) fail(403,'请先完成注册并接受服务条款');
  if (Object.keys(input).some(k=>!['kind','coreContributor'].includes(k)) || typeof input.coreContributor !== 'boolean') fail(422, '开发者申请需要coreContributor布尔值，不接受客户端核验结果');
  const kind = input.kind;
  if (!['developer','trusted_developer'].includes(kind)) fail(422,'无效的开发者申请类型');
  const eligibility = await loadDeveloperEligibility(env,user.id,now,kind);
  if (!eligibility.githubFresh) fail(403, '请先重新授权GitHub并核验开发者条件');
  const automatic = eligibility.verifiedCount >= eligibility.required;
  if (!automatic && !(input.coreContributor && !eligibility.conditions[0].met && eligibility.verifiedCount + 1 >= eligibility.required)) fail(403, '尚未满足足够的申请条件，核心贡献者须经管理员确认');
  const id = randomUUID(), stamp = new Date(now).toISOString(), state = automatic ? 'approved' : 'pending';
  let inserted;
  try { [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO applications(id,user_id,kind,state,created_at,reviewed_at,reviewer,core_contributor_claimed,github_subject,github_linked_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users u JOIN oauth_identities i ON i.user_id=u.id AND i.provider='github'
        JOIN github_developer_profiles p ON p.user_id=u.id AND p.subject=i.subject AND p.linked_at=i.created_at
        WHERE u.id=? AND u.disabled=0 AND ${kind === 'trusted_developer' ? 'u.developer=1 AND u.trusted_developer=0' : 'u.developer=0'} AND u.confirmed_at IS NOT NULL AND p.profile_version=?)`)
      .bind(id,user.id,kind,state,stamp,automatic?stamp:null,automatic?'system:github':null,Number(input.coreContributor),eligibility.subject,eligibility.linkedAt,user.id,eligibility.profileVersion),
    ...(automatic ? [env.DB.prepare(`UPDATE users SET ${kind === 'trusted_developer' ? 'trusted_developer' : 'developer'}=1 WHERE id=? AND changes()=1`).bind(user.id)] : []),
    env.DB.prepare("INSERT INTO auth_audit(actor,action,created_at,detail) SELECT ?,?,?,? WHERE changes()=1").bind(user.id,automatic?'developer.auto_granted':'application.submitted',stamp,kind),
    ...(automatic ? [env.DB.prepare("UPDATE applications SET state='rejected',note='资格已由新申请授予',reviewed_at=?,reviewer='system:github' WHERE user_id=? AND kind=? AND state='pending'").bind(stamp,user.id,kind)] : [])
  ]); } catch(error) {
    if(String(error?.message ?? error).includes('UNIQUE')) fail(409,'已有同类型的待审申请');
    throw error;
  }
  if (!inserted.meta.changes) fail(409,'账户或GitHub核验资料已改变，请刷新后重试');
  return { ok:true,id,kind,state };
}

export async function approveDeveloperApplication(env, app, reviewer, input, now = Date.now()) {
  const eligibility = await loadDeveloperEligibility(env,app.user_id,now,app.kind);
  if (!eligibility.githubFresh || eligibility.subject !== app.github_subject || eligibility.linkedAt !== app.github_linked_at) fail(409,'申请的GitHub绑定或核验资料已失效，请申请人重新核验');
  const confirmCore = app.core_contributor_claimed === 1 && input.coreContributorConfirmed === true && !eligibility.conditions[0].met;
  if (eligibility.verifiedCount + Number(confirmCore) < eligibility.required) fail(403,'尚未满足足够的申请条件，核心贡献者须经管理员确认');
  const stamp = new Date(now).toISOString(), role = app.kind === 'trusted_developer' ? 'trusted_developer' : 'developer';
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE applications SET state='approved',note=?,reviewed_at=?,reviewer=? WHERE id=? AND state='pending'
      AND EXISTS(SELECT 1 FROM users u JOIN oauth_identities i ON i.user_id=u.id AND i.provider='github'
        JOIN github_developer_profiles p ON p.user_id=u.id AND p.subject=i.subject AND p.linked_at=i.created_at
        WHERE u.id=? AND u.disabled=0 AND ${role === 'trusted_developer' ? 'u.developer=1 AND' : ''} p.profile_version=? AND i.subject=? AND i.created_at=?)`)
      .bind(typeof input.note==='string'?input.note.slice(0,400):null,stamp,reviewer.id,app.id,app.user_id,eligibility.profileVersion,app.github_subject,app.github_linked_at),
    ...(confirmCore ? [env.DB.prepare('UPDATE github_developer_profiles SET core_verified_at=?,core_reviewer=? WHERE user_id=? AND changes()=1').bind(stamp,reviewer.id,app.user_id)] : []),
    env.DB.prepare(`UPDATE users SET ${role}=1 WHERE id=? AND changes()=1`).bind(app.user_id),
    env.DB.prepare("INSERT INTO auth_audit(actor,action,created_at,detail) SELECT ?,'application.reviewed',?,? WHERE changes()=1").bind(reviewer.id,stamp,app.kind+':approved'+(confirmCore?':core-confirmed':''))
  ]);
  if (!updated.meta.changes) fail(409,'申请或GitHub核验资料已改变，请刷新后重试');
  return {ok:true,state:'approved'};
}
