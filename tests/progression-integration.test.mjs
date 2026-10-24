import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { loadLevel, loadProgression, recordActivity, selectLevelDisplay, computeLevel, activityDay } from '../src/progression.mjs';
import { digest } from '../src/password.mjs';
import { syncAfdianDonations } from '../src/afdian-donations.mjs';
import { syncBilibiliBadgeProfile, syncNexaContributors, NEXACL_REPOSITORY } from '../src/community-badges.mjs';
import { privacyForAcceptedTerms } from '../src/index.mjs';
import { createConnectionAuthorization, completeConnectionAuthorization, exchangeConnection, listConnections, unlinkConnection } from '../src/connections.mjs';

test('progression and community bindings use atomic D1 writes', async t => {
  const root = new URL('../', import.meta.url), certificate = 'a'.repeat(64), now = Date.parse('2026-09-30T03:00:00Z');
  const modules = ['index.mjs', ...(await readdir(new URL('src/', root), { recursive: true })).filter(f => f.endsWith('.mjs') && f !== 'index.mjs')];
  const mf = new Miniflare(convertV4MiniflareOptions({ modulesRoot: fileURLToPath(root), modules: modules.map(f => ({ type: 'ESModule', path: fileURLToPath(new URL('src/' + f, root)) })), compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'progression-test' }, bindings: { WEB_ORIGIN: 'https://web.test', SERVICE_TOKEN: 'service-test-token', AFDIAN_CLIENT_ID: 'afdian-fixture', AFDIAN_CLIENT_SECRET: 'secret-fixture', AFDIAN_USER_ID: 'creator', AFDIAN_API_TOKEN: 'api-token' }, outboundService: async request => {
    if (new URL(request.url).pathname === '/repos/Nexa-MC/NexaCL/contributors') return Response.json([{id:987,type:'User',contributions:1}]);
    if (new URL(request.url).href === 'https://ifdian.net/api/open/query-order') {
      const body = await request.json();
      assert.equal(body.user_id, 'creator');
      assert.equal(JSON.parse(body.params).user_id, 'worker-runtime-subject');
      return Response.json({ ec: 200, data: { total_page: 1, list: [
        { out_trade_no: 'runtime-donation', user_id: 'worker-runtime-subject', product_type: 0, status: 2, show_amount: '1000.01' },
        { out_trade_no: 'runtime-shop', user_id: 'worker-runtime-subject', product_type: 1, status: 2, show_amount: '99999' }
      ] } });
    }
    assert.equal(new URL(request.url).href, 'https://afdian.com/api/oauth2/access_token');
    assert.equal(request.method, 'POST');
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get('client_secret'), 'secret-fixture');
    assert.equal(form.get('code'), 'runtime-code');
    return Response.json({ ec: 200, data: { user_id: 'worker-runtime-subject' } });
  } }));
  t.after(() => mf.dispose()); const DB = await mf.getD1Database('DB'), env = { DB, WEB_ORIGIN: 'https://web.test', AFDIAN_CLIENT_ID: 'afdian-fixture', AFDIAN_CLIENT_SECRET: 'secret-fixture', BILIBILI_CLIENT_ID: 'bili-fixture', BILIBILI_CLIENT_SECRET: 'bili-secret-fixture' };
  for (const file of (await readdir(new URL('migrations/', root))).filter(f => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(new URL('migrations/' + file, root), 'utf8')).replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    await DB.batch(sql.map(s => DB.prepare(s)));
  }
  async function addUser(id, staff = 0) {
    await DB.prepare('INSERT INTO users(id,name,user_handle,password_hash,staff,confirmed_at,created_at) VALUES(?,?,?,?,?,?,?)').bind(id, id, id, 'oauth:test', staff, new Date().toISOString(), new Date().toISOString()).run();
    const token = 'session-' + id;
    await DB.prepare("INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,'console',?)").bind(digest(token), id, Date.now() + 3600000).run();
    return { id, staff, termsAccepted: 1, token };
  }
  const event = (type, id = randomUUID()) => ({ id, type });
  const api = (path, token, method = 'GET', data) => mf.dispatchFetch('https://web.test' + path, { method, headers: { origin: 'https://web.test', 'x-nexa-request': '1', authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  await t.test('all level boundaries and the first-game gate', async () => {
    for (const [xp, expected] of [[0,1],[1999,1],[2000,2],[5000,3],[10000,4],[20000,5],[50000,6],[100000,7]]) {
      assert.equal(computeLevel(xp, true), expected); assert.equal(computeLevel(xp, false), 0);
    }
    const user = await addUser('newlevel');
    assert.deepEqual((await loadLevel(env, user.id)).next, { level: 1, threshold: null, remaining: null, requirement: 'game.start' });
    await recordActivity(env, user, certificate, event('launcher.login'), now);
    assert.equal((await loadLevel(env, user.id)).level, 0);
    await recordActivity(env, user, certificate, event('game.start'), now);
    assert.equal((await loadLevel(env, user.id)).level, 1);
  });
  await t.test('replay, concurrent daily rewards and client-supplied XP', async () => {
    const user = await addUser('duplicates'), login = event('launcher.login');
    const replay = await Promise.all([1,2,3].map(() => recordActivity(env, user, certificate, login, now)));
    assert.equal(replay.filter(r => r.created).length, 1);
    await Promise.all([1,2,3].map(() => recordActivity(env, user, certificate, event('launcher.login'), now)));
    await Promise.all([1,2,3].map(() => recordActivity(env, user, certificate, event('game.start'), now)));
    assert.equal((await loadLevel(env, user.id)).xp, 50);
    assert.equal((await DB.prepare('SELECT sum(amount) AS n FROM xp_events WHERE user_id=?').bind(user.id).first()).n, 50);
    await assert.rejects(recordActivity(env, user, certificate, { ...event('game.start'), xp: 9999 }, now), e => e.status === 422);
    await assert.rejects(recordActivity(env, user, certificate, { ...event('game.start'), occurredAt: '2020-01-01' }, now), e => e.status === 422);
    await assert.rejects(recordActivity(env, user, 'b'.repeat(64), event('game.heartbeat'), now), e => e.status === 409);
    await assert.rejects(recordActivity(env, user, certificate, { ...login, type: 'game.start' }, now), e => e.status === 409);
  });
  await t.test('online time has no overlap, excludes long gaps and counts independently from the XP cap', async () => {
    const user = await addUser('online');
    await recordActivity(env, user, certificate, event('launcher.login'), now);
    await recordActivity(env, user, certificate, event('game.start'), now);
    for (let n = 1; n <= 5; n++) await recordActivity(env, user, certificate, event('game.heartbeat'), now + n * 60000);
    let progress = await loadProgression(env, user, now);
    assert.equal(progress.xp, 56); assert.equal(progress.activity.gameSeconds, 300); assert.equal(progress.activity.launcherSeconds, 300);
    await Promise.all([1,2].map(() => recordActivity(env, user, certificate, event('game.heartbeat'), now + 300000)));
    assert.equal((await loadProgression(env, user, now)).activity.gameSeconds, 300);
    await recordActivity(env, user, certificate, event('game.heartbeat'), now + 3600000);
    progress = await loadProgression(env, user, now); assert.equal(progress.activity.gameSeconds, 300);
    await DB.prepare('UPDATE launcher_activity_days SET xp_earned=499 WHERE user_id=?').bind(user.id).run();
    await recordActivity(env, user, certificate, event('game.heartbeat'), now + 3660000);
    await recordActivity(env, user, certificate, event('game.heartbeat'), now + 3720000);
    progress = await loadProgression(env, user, now);
    assert.equal(progress.activity.todayXp, 500); assert.equal(progress.activity.gameSeconds, 420); assert.equal(progress.xp, 57);
    const gated = await addUser('capped');
    await DB.prepare('INSERT INTO launcher_activity_days(user_id,day,xp_earned) VALUES(?,?,500)').bind(gated.id, activityDay(now)).run();
    await recordActivity(env, gated, certificate, event('launcher.login'), now);
    await recordActivity(env, gated, certificate, event('game.start'), now);
    assert.equal((await loadLevel(env, gated.id)).level, 1); assert.equal((await loadLevel(env, gated.id)).xp, 0);
  });
  await t.test('daily rewards use Shanghai dates and streaks require consecutive launch days', async () => {
    const user = await addUser('midnight'), before = Date.parse('2026-09-29T15:59:59Z');
    await recordActivity(env, user, certificate, event('launcher.login'), before);
    await recordActivity(env, user, certificate, event('game.start'), before);
    await recordActivity(env, user, certificate, event('launcher.login'), before + 2000);
    await recordActivity(env, user, certificate, event('game.start'), before + 2000);
    const progress = await loadProgression(env, user, now); assert.equal(progress.xp, 100); assert.equal(progress.activity.currentStreak, 2);
    const streak = await addUser('streak');
    for (let n = 1; n <= 99; n++) await DB.prepare('INSERT INTO launcher_activity_days(user_id,day,game_started) VALUES(?,?,1)').bind(streak.id, activityDay(now - n * 86400000)).run();
    assert.equal((await loadProgression(env, streak, now)).badges.find(b => b.id === 'mc-streak').earned, false);
    await recordActivity(env, streak, certificate, event('launcher.login'), now);
    await recordActivity(env, streak, certificate, event('game.start'), now);
    assert.equal((await loadProgression(env, streak, now)).badges.find(b => b.id === 'mc-streak').earned, true);
    await selectLevelDisplay(env, streak, { badgeId: 'mc-streak' });
    assert.equal((await loadProgression(env, streak, now + 2 * 86400000)).activity.currentStreak, 0);
    assert.equal((await loadProgression(env, streak, now + 2 * 86400000)).display.label, 'LvMC');
  });
  await t.test('badge replacement never changes numeric level and infinity cannot bypass the missing quiz', async () => {
    const staff = await addUser('staffbadge', 1);
    assert.equal((await selectLevelDisplay(env, staff, { badgeId: 'administrator' })).display.label, 'Lv-1');
    assert.equal((await loadProgression(env, { ...staff, staff: 0 })).display.label, 'Lv0');
    assert.equal((await loadLevel(env, staff.id)).level, 0);
    await assert.rejects(selectLevelDisplay(env, staff, { badgeId: 'donor' }), e => e.status === 422);
    await DB.prepare('INSERT INTO user_levels(user_id,xp,launched,updated_at) VALUES(?,100000,1,?)').bind(staff.id, new Date().toISOString()).run();
    await DB.prepare('INSERT INTO launcher_presence(user_id,game_ms,updated_at) VALUES(?,360000000,?)').bind(staff.id, new Date().toISOString()).run();
    const infinity = (await loadProgression(env, staff)).badges.find(b => b.id === 'infinity');
    assert.equal(infinity.conditions.level, true); assert.equal(infinity.conditions.gameTime, true); assert.equal(infinity.earned, false);
    await assert.rejects(selectLevelDisplay(env, staff, { badgeId: 'infinity' }), e => e.status === 403);
  });
  await t.test('public-source badges reject manual verification and ignore historical manual records', async () => {
    const staff = await addUser('reviewer', 1), user = await addUser('recipient');
    const path = '/auth/v1/users/recipient/badge-verifications/bilibili-million', proof = { value: 1000000, sourceAccount: 'bilibili-user', evidence: '人工复核B站粉丝凭证记录' };
    assert.equal((await api(path, user.token, 'PUT', proof)).status, 403);
    assert.equal((await api('/auth/v1/users/reviewer/badge-verifications/bilibili-million', staff.token, 'PUT', proof)).status, 403);
    assert.equal((await api(path, staff.token, 'PUT', proof)).status, 422);
    assert.equal((await api('/auth/v1/users/recipient/badge-verifications/bilibili-level', staff.token, 'PUT', { ...proof, value: 6 })).status, 422);
    assert.equal((await api('/auth/v1/users/recipient/badge-verifications/nexacl-contributor', staff.token, 'PUT', proof)).status, 422);
    assert.equal((await api('/auth/v1/users/recipient/badge-verifications/donor', staff.token, 'PUT', proof)).status, 422);
    await DB.prepare("INSERT INTO badge_verifications(user_id,badge_id,verified_value,source_account,evidence,reviewer,verified_at) VALUES(?,'donor',999999,'legacy','legacy manual proof',?,?)").bind(user.id, staff.id, new Date().toISOString()).run();
    assert.equal((await loadProgression(env, user)).badges.find(b => b.id === 'donor').earned, false);
    for (const [badgeId, value] of [['bilibili-level', 6], ['bilibili-million', 1000001]]) {
      await DB.prepare('INSERT INTO badge_verifications(user_id,badge_id,verified_value,source_account,evidence,reviewer,verified_at) VALUES(?,?,?,?,?,?,?)').bind(user.id,badgeId,value,'legacy','legacy manual proof',staff.id,new Date().toISOString()).run();
      assert.equal((await loadProgression(env, user)).badges.find(b => b.id === badgeId).earned, false);
    }
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM auth_audit WHERE action='badge.verified'").first()).n, 0);
    assert.equal((await api('/auth/v1/users/recipient/badge-verifications/infinity', staff.token, 'PUT', proof)).status, 422);
  });
  await t.test('Bilibili badges require proven ownership and trusted public facts, with inclusive boundaries', async () => {
    const user = await addUser('bilibadges'), stamp = new Date().toISOString();
    await DB.prepare("INSERT INTO external_connections(user_id,provider,subject,profile_level,followers,connected_at,checked_at) VALUES(?,'bilibili','900',6,1000000,?,?)").bind(user.id,stamp,stamp).run();
    const badges = async () => (await loadProgression(env, user)).badges.filter(b=>b.id.startsWith('bilibili-'));
    assert.ok((await badges()).every(b=>!b.earned));
    await DB.prepare("UPDATE external_connections SET ownership_verified_at=?,profile_source='client-json' WHERE user_id=?").bind(stamp,user.id).run();
    assert.ok((await badges()).every(b=>!b.earned));
    await DB.prepare("UPDATE external_connections SET profile_source='cloudflare-browser',profile_level=5,followers=999999 WHERE user_id=?").bind(user.id).run();
    assert.ok((await badges()).every(b=>!b.earned));
    await DB.prepare('UPDATE external_connections SET profile_level=6,followers=1000000 WHERE user_id=?').bind(user.id).run();
    assert.ok((await badges()).every(b=>b.earned));
    await unlinkConnection(env,user.id,'bilibili');
    assert.ok((await badges()).every(b=>!b.earned));
  });
  await t.test('Bilibili refresh is cached, updates downward changes and cannot cross a rebind', async () => {
    const user = await addUser('bilirefresh'), stamp = new Date().toISOString();
    const link = subject => DB.prepare("INSERT INTO external_connections(user_id,provider,subject,connected_at,checked_at,ownership_verified_at) VALUES(?,'bilibili',?,?,?,?)").bind(user.id,subject,stamp,stamp,stamp).run();
    await link('901'); let calls=0, followers=1000000, failed=false, beforeRead;
    const biliEnv={...env,BILIBILI_BINDING_ENABLED:'true',BILIBILI_VERIFIER_TOKEN:'test-verifier-token-that-is-long-enough',BILIBILI_VERIFIER:{fetch:async (_url,init)=>{
      calls++; const {uid,requestId}=JSON.parse(init.body);
      if(beforeRead) await beforeRead();
      if(failed) return Response.json({code:'unavailable'},{status:503});
      return Response.json({uid,requestId,source:'cloudflare-browser',signature:'',name:'Bili',avatar:null,level:6,followers,checkedAt:new Date().toISOString()});
    }}};
    const badge=async()=>(await loadProgression(env,user)).badges.find(b=>b.id==='bilibili-million');
    await Promise.all([1,2,3].map(()=>syncBilibiliBadgeProfile(biliEnv,user.id,now)));
    assert.equal(calls,1); assert.equal((await badge()).earned,true);
    await syncBilibiliBadgeProfile(biliEnv,user.id,now+899999); assert.equal(calls,1);
    failed=true; await syncBilibiliBadgeProfile(biliEnv,user.id,now+900000);
    assert.equal((await badge()).earned,true); assert.match((await badge()).progress,/上次同步失败/);
    failed=false; followers=999999; await syncBilibiliBadgeProfile(biliEnv,user.id,now+1800000);
    assert.equal((await badge()).earned,false);
    beforeRead=async()=>{await unlinkConnection(env,user.id,'bilibili'); await link('902');};
    followers=1000000; await syncBilibiliBadgeProfile(biliEnv,user.id,now+2700000);
    assert.equal((await badge()).earned,false);
    assert.equal((await DB.prepare("SELECT profile_source FROM external_connections WHERE user_id=? AND provider='bilibili'").bind(user.id).first()).profile_source,null);
  });
  await t.test('NexaCL contributors use a shared snapshot and the linked immutable GitHub ID', async () => {
    const user=await addUser('contributor'), other=await addUser('noncontributor'), stamp=new Date().toISOString();
    const identity=(who,subject)=>DB.prepare("INSERT INTO oauth_identities(provider,subject,user_id,email,created_at,updated_at) VALUES('github',?,?,?, ?,?)").bind(subject,who.id,'same@example.test',stamp,stamp).run();
    await identity(user,'456'); await identity(other,'457');
    let calls=0, failed=false, members=[{id:456,type:'User',login:'old-name',contributions:1}];
    const fetcher=async url=>{calls++; assert.equal(url,`https://api.github.com/repos/${NEXACL_REPOSITORY}/contributors?anon=false&per_page=100&page=1`); return failed?new Response('',{status:403}):Response.json(members);};
    const badge=async who=>(await loadProgression(env,who)).badges.find(b=>b.id==='nexacl-contributor');
    await Promise.all([user,other,user].map(who=>syncNexaContributors(env,who.id,fetcher,now)));
    assert.equal(calls,1); assert.equal((await badge(user)).earned,true); assert.equal((await badge(other)).earned,false);
    await syncNexaContributors(env,user.id,fetcher,now+3599999); assert.equal(calls,1);
    failed=true; await syncNexaContributors(env,user.id,fetcher,now+3600000);
    assert.equal((await badge(user)).earned,true); assert.match((await badge(user)).progress,/GitHub同步失败/);
    failed=false; members=[]; await syncNexaContributors(env,user.id,fetcher,now+4500000);
    assert.equal((await badge(user)).earned,false);
    members=[{id:456,type:'User',login:'renamed',contributions:2}]; await syncNexaContributors(env,user.id,fetcher,now+8100000);
    assert.equal((await badge(user)).earned,true);
    await DB.prepare("DELETE FROM oauth_identities WHERE user_id=? AND provider='github'").bind(user.id).run();
    assert.equal((await badge(user)).earned,false);
    await identity(user,'458'); assert.equal((await badge(user)).earned,false);
    await assert.rejects(selectLevelDisplay(env,user,{badgeId:'nexacl-contributor'}),e=>e.status===422);
  });
  await t.test('the account API automatically loads GitHub contributor facts in the Worker runtime', async () => {
    const user=await addUser('runtimecontributor'), stamp=new Date().toISOString();
    await DB.prepare("INSERT INTO oauth_identities(provider,subject,user_id,created_at,updated_at) VALUES('github','987',?,?,?)").bind(user.id,stamp,stamp).run();
    const response=await api('/auth/v1/account/level',user.token);
    assert.equal(response.status,200);
    assert.equal((await response.json()).badges.find(b=>b.id==='nexacl-contributor').earned,true);
  });
  const donationEnv = { ...env, AFDIAN_USER_ID: 'creator', AFDIAN_API_TOKEN: 'api-token' };
  async function linkAfdian(user, subject = user.id + '-afdian') {
    await DB.prepare("INSERT INTO external_connections(user_id,provider,subject,connected_at,checked_at) VALUES(?,'afdian',?,?,?)").bind(user.id, subject, new Date().toISOString(), new Date().toISOString()).run();
    return subject;
  }
  const donationBadge = async user => (await loadProgression(donationEnv, user)).badges.find(b => b.id === 'donor');
  const donationOrders = (subject, amount) => Response.json({ ec: 200, data: { total_page: 1, list: [
    { out_trade_no: 'donation', user_id: subject, product_type: 0, status: 2, show_amount: amount },
    { out_trade_no: 'shop', user_id: subject, product_type: 1, status: 2, show_amount: '99999' }
  ] } });
  await t.test('linked donations strictly exceed 1000 CNY, refresh once and survive failures without counting shop orders', async () => {
    const user = await addUser('donationtotal'), subject = await linkAfdian(user);
    assert.equal((await loadProgression(env, user)).badges.find(b => b.id === 'donor').progress, '爱发电订单统计暂未配置');
    await syncAfdianDonations(donationEnv, user.id, async () => donationOrders(subject, '1000.00'), now);
    assert.equal((await donationBadge(user)).earned, false);
    let calls = 0;
    const fetcher = async () => { calls++; return donationOrders(subject, '1000.01'); };
    await Promise.all([1,2,3].map(() => syncAfdianDonations(donationEnv, user.id, fetcher, now + 900000)));
    assert.equal(calls, 1); assert.equal((await donationBadge(user)).earned, true);
    await syncAfdianDonations(donationEnv, user.id, fetcher, now + 900001);
    assert.equal(calls, 1);
    await syncAfdianDonations(donationEnv, user.id, async () => { throw new Error('temporary failure'); }, now + 1800000);
    assert.equal((await donationBadge(user)).earned, true);
    assert.match((await donationBadge(user)).progress, /1000\.01.*上次同步失败/);
    await syncAfdianDonations(donationEnv, user.id, async () => donationOrders(subject, '0.00'), now + 2700000);
    assert.equal((await donationBadge(user)).earned, false);
    assert.doesNotMatch((await donationBadge(user)).progress, /同步失败/);
  });
  await t.test('unlinking and replacing the account cannot inherit a donor badge, including a query in flight', async () => {
    const user = await addUser('donationunlink'), subject = await linkAfdian(user);
    await syncAfdianDonations(donationEnv, user.id, async () => donationOrders(subject, '2000.00'), now);
    assert.equal((await donationBadge(user)).earned, true);
    await unlinkConnection(env, user.id, 'afdian');
    assert.equal((await donationBadge(user)).earned, false);
    assert.equal((await donationBadge(user)).progress, '请先绑定爱发电账户');
    await linkAfdian(user, 'new-subject');
    assert.equal((await donationBadge(user)).earned, false);
    await syncAfdianDonations(donationEnv, user.id, async () => {
      await unlinkConnection(env, user.id, 'afdian');
      await linkAfdian(user, 'replacement-subject');
      return donationOrders('new-subject', '2000');
    }, now + 900000);
    assert.equal((await donationBadge(user)).earned, false);
    assert.equal((await DB.prepare("SELECT donation_cents FROM external_connections WHERE user_id=? AND provider='afdian'").bind(user.id).first()).donation_cents, null);
  });
  await t.test('Afdian accepts the official user-id-only response and never exposes credentials', async () => {
    const user = await addUser('afdianuser');
    const authorize = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const state = new URL(authorize.url).searchParams.get('state');
    assert.equal(new URL(authorize.url).hostname, 'afdian.com');
    const incoming = new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=test-code&state=' + state, { headers: { cookie: authorize.cookie.split(';')[0] } });
    let calls = 0;
    const fetcher = async (url, init) => {
      calls++; assert.equal(url, 'https://afdian.com/api/oauth2/access_token'); assert.equal(init.method, 'POST');
      assert.equal(init.body.get('redirect_uri'), 'https://auth.pcln.top/auth/v1/connections/afdian/callback');
      assert.equal(init.body.get('client_secret'), 'secret-fixture');
      return Response.json({ ec: 200, data: { user_id: 'afdian-subject-1', user_private_id: 'private-subject-1' } });
    };
    const wrongCookie = await completeConnectionAuthorization(new Request(incoming.url), env, 'afdian', fetcher);
    assert.ok(new URL(wrongCookie.headers.get('location')).searchParams.has('connection_error')); assert.equal(calls, 0);
    const result = await completeConnectionAuthorization(incoming, env, 'afdian', fetcher);
    assert.equal(result.status, 303); assert.equal(new URL(result.headers.get('location')).searchParams.get('connection_success'), 'afdian'); assert.equal(calls, 1);
    await completeConnectionAuthorization(incoming, env, 'afdian', fetcher); assert.equal(calls, 1);
    const row = await DB.prepare('SELECT * FROM external_connections WHERE user_id=?').bind(user.id).first();
    assert.equal(row.subject, 'afdian-subject-1'); assert.ok(!JSON.stringify(row).includes('secret-fixture'));
    const duplicate = await addUser('afdianduplicate'), second = await createConnectionAuthorization(env, duplicate, duplicate.token, 'afdian');
    const conflict = await completeConnectionAuthorization(new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=other&state=' + new URL(second.url).searchParams.get('state'), { headers: { cookie: second.cookie.split(';')[0] } }), env, 'afdian', fetcher);
    assert.ok(new URL(conflict.headers.get('location')).searchParams.has('connection_error'));
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM external_connections WHERE subject='afdian-subject-1'").first()).n, 1);
  });
  await t.test('logout invalidates an OAuth binding even during the platform exchange', async () => {
    const user = await addUser('revokedlink'), authorization = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const incoming = new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=c&state=' + new URL(authorization.url).searchParams.get('state'), { headers: { cookie: authorization.cookie.split(';')[0] } });
    const result = await completeConnectionAuthorization(incoming, env, 'afdian', async () => {
      await DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
      return Response.json({ ec: 200, data: { user_id: 'revoked-subject' } });
    });
    assert.ok(new URL(result.headers.get('location')).searchParams.has('connection_error'));
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM external_connections WHERE user_id=?').bind(user.id).first()).n, 0);
  });
  await t.test('policy revisions require explicit confirmation and repair privacy independently', async () => {
    const user = await addUser('policyrev');
    await DB.prepare("INSERT INTO terms_acceptances(user_id,policy_id,accepted_at) VALUES(?,'terms-1.0','2026-09-29T00:00:00Z')").bind(user.id).run();
    const status = await (await api('/auth/v1/policies/status', user.token)).json();
    assert.equal(status.policies.find(p => p.kind === 'terms').version, '1.2');
    assert.equal(status.policies.find(p => p.kind === 'terms').acceptedAt, null);
    const oldPage = await api('/auth/v1/policies/accept', user.token, 'POST', {});
    assert.equal(oldPage.status, 409); assert.match((await oldPage.json()).detail, /刷新页面.*v1\.2/);
    assert.equal((await privacyForAcceptedTerms(env, 'terms-1.0')).id, 'privacy-1.0');
    assert.equal((await privacyForAcceptedTerms(env, 'terms-1.1')).id, 'privacy-1.1');
    assert.equal(await privacyForAcceptedTerms(env, 'missing-version'), null);
    assert.equal((await api('/auth/v1/policies/accept', user.token, 'POST', { termsVersion: '1.0', privacyVersion: '1.0' })).status, 409);
    const input = { termsVersion: '1.2', privacyVersion: '1.2' };
    const first = await (await api('/auth/v1/policies/accept', user.token, 'POST', input)).json();
    await DB.prepare("DELETE FROM privacy_notice_receipts WHERE user_id=? AND policy_id='privacy-1.2'").bind(user.id).run();
    const second = await (await api('/auth/v1/policies/accept', user.token, 'POST', input)).json();
    assert.equal(second.terms.acceptedAt, first.terms.acceptedAt);
    const after = await (await api('/auth/v1/policies/status', user.token)).json();
    assert.ok(after.policies.find(p => p.kind === 'privacy').acceptedAt);
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM auth_audit WHERE actor=? AND action='terms.accepted'").bind(user.id).first()).n, 1);
    const exported = await (await api('/auth/v1/account/export', user.token)).json();
    assert.ok(Array.isArray(exported.activityDays)); assert.ok(Array.isArray(exported.activityEvents));
    assert.ok(!JSON.stringify(exported).includes(user.token));
  });
  await t.test('Afdian callback uses request options supported by the actual Worker runtime', async () => {
    const user = await addUser('afdruntime'), authorization = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const state = new URL(authorization.url).searchParams.get('state');
    const result = await mf.dispatchFetch('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=runtime-code&state=' + state, { redirect: 'manual', headers: { cookie: authorization.cookie.split(';')[0] } });
    assert.equal(result.status, 303);
    assert.equal(new URL(result.headers.get('location')).searchParams.get('connection_success'), 'afdian');
    assert.equal((await DB.prepare('SELECT subject FROM external_connections WHERE user_id=?').bind(user.id).first()).subject, 'worker-runtime-subject');
    const level = await api('/auth/v1/account/level', user.token);
    assert.equal(level.status, 200);
    const badge = (await level.json()).badges.find(b => b.id === 'donor');
    assert.equal(badge.earned, true); assert.equal(badge.progress, '累计有效发电 ¥1000.01（不含电铺）');
  });
  await t.test('Bilibili remains closed even when old OAuth credentials exist', async () => {
    const user = await addUser('biliuser');
    const list = await listConnections(env, user.id);
    assert.equal(list.connections.find(c => c.provider === 'bilibili').configured, false);
    await assert.rejects(createConnectionAuthorization(env, user, user.token, 'bilibili'), { status: 503 });
    await assert.rejects(exchangeConnection(env, 'bilibili', 'code', () => { throw new Error('must not fetch'); }), { status: 503 });
  });
  await t.test('unlink cancels an OAuth exchange already in flight', async () => {
    const user = await addUser('unlinkrace'), authorization = await createConnectionAuthorization(env, user, user.token, 'afdian');
    const incoming = new Request('https://auth.pcln.top/auth/v1/connections/afdian/callback?code=c&state=' + new URL(authorization.url).searchParams.get('state'), { headers: { cookie: authorization.cookie.split(';')[0] } });
    const result = await completeConnectionAuthorization(incoming, env, 'afdian', async () => {
      await unlinkConnection(env, user.id, 'afdian');
      return Response.json({ ec: 200, data: { user_id: 'cancelled-subject' } });
    });
    assert.ok(new URL(result.headers.get('location')).searchParams.has('connection_error'));
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM external_connections WHERE user_id=?').bind(user.id).first()).n, 0);
  });
});
