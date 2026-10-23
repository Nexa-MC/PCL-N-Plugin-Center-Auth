import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNexaContributors, GithubContributorsUnavailable } from '../src/community-badges.mjs';

test('GitHub contributors paginate using only the fixed repository and omit bots',async()=>{
  let calls=0;
  const result=await fetchNexaContributors(async(url,init)=>{
    calls++; assert.equal(new URL(url).searchParams.get('page'),String(calls));
    assert.equal(init.redirect,'manual'); assert.equal(new URL(url).pathname,'/repos/Nexa-MC/NexaCL/contributors');
    return Response.json(calls===1?Array.from({length:100},(_,i)=>({id:i+1,type:'User',contributions:1})):[{id:101,type:'Bot',contributions:3},{id:102,type:'User',contributions:2}]);
  });
  assert.equal(calls,2); assert.equal(result.length,101); assert.deepEqual(result.at(-1),{id:'102',contributions:2});
});

test('failed, malformed and truncated GitHub data cannot become a successful snapshot',async()=>{
  for(const response of [new Response('',{status:403}),new Response('',{status:302,headers:{location:'https://evil.test/'}}),Response.json({message:'limited'}),Response.json([{id:'123',type:'User',contributions:1}]),Response.json([{id:123,type:'User',contributions:0}])]) {
    await assert.rejects(fetchNexaContributors(async()=>response),GithubContributorsUnavailable);
  }
  let calls=0;
  await assert.rejects(fetchNexaContributors(async()=>{calls++;return Response.json(Array.from({length:100},(_,i)=>({id:i+1,type:'User',contributions:1})));}),GithubContributorsUnavailable);
  assert.equal(calls,10);
});
