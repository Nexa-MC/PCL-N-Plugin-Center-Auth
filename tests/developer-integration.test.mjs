import { migrationStatements } from './sql-statements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {digest} from '../src/password.mjs';

test('developer applications use session-bound GitHub facts and enforce manual core review',async t=>{
  const root=new URL('../',import.meta.url);
  let githubId=123,followers=501,orgMember=false,beforeGraphql;
  const mf=new Miniflare(convertV4MiniflareOptions({
    modulesRoot:fileURLToPath(root),modules:['index.mjs',...(await readdir(new URL('src/',root),{recursive:true})).filter(f=>f.endsWith('.mjs')&&f!=='index.mjs')].map(f=>({type:'ESModule',path:fileURLToPath(new URL('src/'+f,root))})),
    compatibilityDate:'2026-09-26',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'developer-test'},
    bindings:{WEB_ORIGIN:'https://web.test',GITHUB_CLIENT_ID:'fixture-client',GITHUB_CLIENT_SECRET:'fixture-secret'},
    outboundService:async request=>{
      const url=new URL(request.url);
      if(url.href==='https://github.com/login/oauth/access_token')return Response.json({access_token:'fixture-token',scope:'read:user,user:email,read:org'});
      if(url.href==='https://api.github.com/user')return Response.json({id:githubId,login:'viewer',name:'Viewer'});
      assert.equal(url.href,'https://api.github.com/graphql');
      assert.equal(request.headers.get('authorization'),'Bearer fixture-token');
      if(beforeGraphql)await beforeGraphql();
      return Response.json({data:{viewer:{id:'viewer-node',databaseId:githubId,createdAt:'2020-01-01T00:00:00Z',followers:{totalCount:followers},repositories:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}},organization:{viewerIsAMember:orgMember}}});
    }
  }));t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');
  for(const file of(await readdir(new URL('migrations/',root))).filter(f=>f.endsWith('.sql')).sort()){
    await DB.batch(migrationStatements(await readFile(new URL('migrations/'+file,root),'utf8')).map(s=>DB.prepare(s)));
  }
  async function user(id,staff=0,developer=0){const stamp=new Date().toISOString(),token='session-'+id;
    await DB.prepare("INSERT INTO users(id,name,user_handle,password_hash,staff,developer,confirmed_at,created_at) VALUES(?,?,?,'oauth:test',?,?,?,?)").bind(id,id,id,staff,developer,stamp,stamp).run();
    await DB.prepare("INSERT INTO sessions(token_hash,user_id,scope,expires) VALUES(?,?,'console',?)").bind(digest(token),id,Date.now()+3600000).run();
    await DB.prepare("INSERT INTO terms_acceptances(user_id,policy_id,accepted_at) VALUES(?,'terms-1.2',?)").bind(id,stamp).run();return{id,token};
  }
  const call=(who,path,method='GET',data,extra={})=>mf.dispatchFetch('https://web.test'+path,{method,redirect:'manual',headers:{origin:'https://web.test','x-nexa-request':'1',authorization:'Bearer '+who.token,'content-type':'application/json',...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});
  async function authorize(who){
    const start=await call(who,'/auth/v1/oauth/github/start?mode=link&intent=developer&return_to=/account?section=developer');
    assert.equal(start.status,302,await start.clone().text());const target=new URL(start.headers.get('location'));
    assert.ok(target.searchParams.get('scope').includes('read:org'));
    return call(who,'/auth/v1/oauth/github/callback?code=fixture&state='+target.searchParams.get('state'),'GET',undefined,{cookie:start.headers.get('set-cookie').split(';')[0]});
  }
  const apply=(who,kind='developer',coreContributor=false,extra={})=>call(who,'/auth/v1/applications','POST',{kind,coreContributor,...extra});
  const roles=who=>DB.prepare('SELECT developer,trusted_developer FROM users WHERE id=?').bind(who.id).first();
  const reviewer=await user('reviewer',1);

  await t.test('two verified conditions grant a level-zero user and three grant trusted developer',async()=>{
    const who=await user('automatic');githubId=123;followers=501;orgMember=false;
    assert.equal((await authorize(who)).status,303);
    const saved=await DB.prepare('SELECT * FROM github_developer_profiles WHERE user_id=?').bind(who.id).first();
    assert.ok(saved);assert.ok(!JSON.stringify(saved).includes('fixture-token'));
    const status=await(await call(who,'/auth/v1/account/developer-eligibility')).json();
    assert.equal(status.developer.verifiedCount,2);assert.equal(status.trustedDeveloper.conditions.at(-1).available,false);
    assert.equal((await apply(who,'developer',false,{followers:9999})).status,422);
    const result=await apply(who);assert.equal(result.status,201,await result.clone().text());assert.equal((await result.json()).state,'approved');
    assert.equal((await roles(who)).developer,1);
    assert.equal((await apply(who,'trusted_developer')).status,403);
    orgMember=true;await authorize(who);
    const trusted=await apply(who,'trusted_developer');assert.equal(trusted.status,201,await trusted.clone().text());assert.equal((await trusted.json()).state,'approved');
    assert.equal((await roles(who)).trusted_developer,1);
  });
  await t.test('a checked core claim is pending until explicit administrator confirmation; review is single-use',async()=>{
    const who=await user('claimed');githubId=124;followers=500;orgMember=false;await authorize(who);
    assert.equal((await apply(who)).status,403);
    const response=await apply(who,'developer',true);assert.equal(response.status,201,await response.clone().text());const app=await response.json();
    assert.equal(app.state,'pending');assert.equal((await roles(who)).developer,0);
    const path='/auth/v1/applications/'+app.id+'/review';
    assert.equal((await call(who,path,'POST',{decision:'approved',coreContributorConfirmed:true})).status,403);
    assert.equal((await call(reviewer,path,'POST',{decision:'approved'})).status,403);
    const pending=await(await call(reviewer,'/auth/v1/applications/pending')).json();
    assert.equal(pending.applications[0].coreContributorClaimed,true);assert.equal(pending.applications[0].eligibility.verifiedCount,1);
    const replies=await Promise.all([1,2].map(()=>call(reviewer,path,'POST',{decision:'approved',coreContributorConfirmed:true})));
    assert.equal(replies.filter(r=>r.status===200).length,1);assert.equal((await roles(who)).developer,1);
    const profile=await DB.prepare('SELECT core_verified_at,core_reviewer FROM github_developer_profiles WHERE user_id=?').bind(who.id).first();
    assert.ok(profile.core_verified_at);assert.equal(profile.core_reviewer,reviewer.id);
    await authorize(who);
    assert.ok((await DB.prepare('SELECT core_verified_at FROM github_developer_profiles WHERE user_id=?').bind(who.id).first()).core_verified_at);
    assert.equal((await DB.prepare("SELECT count(*) AS n FROM auth_audit WHERE actor=? AND action='application.reviewed'").bind(reviewer.id).first()).n,1);
  });
  await t.test('trusted developer core claims require two other verified conditions',async()=>{
    const who=await user('trustedclaim',0,1);githubId=125;followers=501;orgMember=false;await authorize(who);
    const response=await apply(who,'trusted_developer',true);assert.equal(response.status,201);const app=await response.json();
    const approved=await call(reviewer,'/auth/v1/applications/'+app.id+'/review','POST',{decision:'approved',coreContributorConfirmed:true});
    assert.equal(approved.status,200,await approved.clone().text());assert.equal((await roles(who)).trusted_developer,1);
  });
  await t.test('stale facts and a changed GitHub binding cannot grant a queued application',async()=>{
    const who=await user('changed');githubId=126;followers=500;orgMember=false;await authorize(who);
    const app=await(await apply(who,'developer',true)).json();
    await DB.prepare("UPDATE oauth_identities SET created_at='changed-binding' WHERE user_id=? AND provider='github'").bind(who.id).run();
    assert.equal((await call(reviewer,'/auth/v1/applications/'+app.id+'/review','POST',{decision:'approved',coreContributorConfirmed:true})).status,409);
    assert.equal((await roles(who)).developer,0);
    const stale=await user('stale');githubId=127;followers=501;await authorize(stale);
    await DB.prepare("UPDATE github_developer_profiles SET checked_at='2020-01-01T00:00:00Z' WHERE user_id=?").bind(stale.id).run();
    assert.equal((await apply(stale)).status,403);
  });
  await t.test('logout while reading GitHub prevents storing eligibility; ordinary login does not request organization scope',async()=>{
    const who=await user('revoked');githubId=128;followers=501;
    const ordinary=await call(who,'/auth/v1/oauth/github/start?mode=link');
    assert.equal(new URL(ordinary.headers.get('location')).searchParams.get('scope').includes('read:org'),false);
    beforeGraphql=()=>DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(who.id).run();
    const response=await authorize(who);beforeGraphql=undefined;
    assert.ok(new URL(response.headers.get('location')).searchParams.has('oauth_error'));
    assert.equal(await DB.prepare('SELECT * FROM github_developer_profiles WHERE user_id=?').bind(who.id).first(),null);
  });
});
