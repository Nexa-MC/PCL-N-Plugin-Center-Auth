import test from 'node:test';
import assert from 'node:assert/strict';
import { developerConditions,fetchGithubDeveloperProfile } from '../src/developer-eligibility.mjs';

const now=Date.parse('2026-10-23T12:00:00Z');
const row={account_created_at:'2023-10-23T12:00:00Z',followers:500,org_member:0,qualifying_repository:null,checked_at:new Date(now).toISOString()};
const payload=(repos=[],extra={})=>({data:{viewer:{id:'viewer-node',databaseId:123,createdAt:'2020-01-01T00:00:00Z',followers:{totalCount:501},repositories:{nodes:repos,pageInfo:{hasNextPage:false,endCursor:null}},...extra},organization:{viewerIsAMember:true}}});
const repo=(stars=10000,language='TypeScript')=>({nameWithOwner:'owner/project',url:'https://github.com/owner/project',owner:{id:'viewer-node'},stargazerCount:stars,primaryLanguage:language===null?null:{name:language}});

test('age and follower comparisons are strict and trusted developers need three of six conditions',()=>{
  assert.equal(developerConditions(row,now).verifiedCount,0);
  const eligible=developerConditions({...row,followers:501},now+1);
  assert.equal(eligible.verifiedCount,2); assert.equal(eligible.required,2);
  const trusted=developerConditions({...row,followers:501,org_member:1},now+1,'trusted_developer');
  assert.equal(trusted.verifiedCount,3); assert.equal(trusted.required,3); assert.equal(trusted.conditions.length,6);
  assert.equal(trusted.conditions.at(-1).met,false); assert.equal(trusted.conditions.at(-1).available,false);
  assert.equal(developerConditions({...row,followers:501,org_member:1},now+86400001).verifiedCount,0);
  const leap={...row,account_created_at:'2020-02-29T12:00:00Z',checked_at:'2023-02-28T12:00:00Z'};
  assert.equal(developerConditions(leap,Date.parse('2023-02-28T12:00:00Z')).conditions[1].met,false);
});

test('GitHub facts require the OAuth viewer ID, owned repositories, 10k stars and an identified non-Markdown primary language',async()=>{
  for(const [repository,expected] of [[repo(),true],[repo(9999),false],[repo(10000,'Markdown'),false],[repo(10000,null),false]]){
    const facts=await fetchGithubDeveloperProfile('123','fixture-token',async(url,init)=>{
      assert.equal(url,'https://api.github.com/graphql'); assert.equal(init.redirect,'manual');
      assert.equal(init.headers.authorization,'Bearer fixture-token');
      assert.ok(JSON.parse(init.body).query.includes('viewerIsAMember'));
      return Response.json(payload([repository]));
    },now);
    assert.equal(Boolean(facts.qualifyingRepository),expected); assert.equal(facts.orgMember,true);
  }
  for(const invalid of [payload([],{databaseId:124}),payload([{...repo(),owner:{id:'other'}}]),{...payload(),errors:[{message:'denied'}]}]){
    await assert.rejects(fetchGithubDeveloperProfile('123','fixture-token',async()=>Response.json(invalid),now),e=>e.status===502);
  }
});

test('qualifying repositories beyond the first page are considered without following supplied URLs',async()=>{
  let calls=0;
  const facts=await fetchGithubDeveloperProfile('123','fixture-token',async(_url,init)=>{
    calls++;const result=payload(calls===1?[repo(10001,'Markdown')]:[repo()]);
    if(calls===1)result.data.viewer.repositories.pageInfo={hasNextPage:true,endCursor:'cursor-from-github'};
    else assert.equal(JSON.parse(init.body).variables.after,'cursor-from-github');
    return Response.json(result);
  },now);
  assert.equal(calls,2);assert.equal(facts.qualifyingRepository,'owner/project');
});
