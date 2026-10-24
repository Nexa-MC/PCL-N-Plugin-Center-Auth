import { migrationStatements } from './sql-statements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('community migrations preserve proven Bilibili ownership and existing roles while closing obsolete applications',async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-26',d1Databases:{DB:'migration-test'}}));
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB'),root=new URL('../migrations/',import.meta.url);
  const apply=async file=>DB.batch(migrationStatements(await readFile(new URL(file,root),'utf8')).map(s=>DB.prepare(s)));
  for(const file of(await readdir(root)).filter(f=>f.endsWith('.sql')&&f<'0020').sort())await apply(file);
  const stamp=new Date().toISOString();
  for(const [id,subject] of [['proven','123'],['unproven','124']]){
    await DB.prepare("INSERT INTO users(id,name,password_hash,developer) VALUES(?,?,'oauth:test',1)").bind(id,id).run();
    await DB.prepare("INSERT INTO external_connections(user_id,provider,subject,connected_at,checked_at,profile_level,followers) VALUES(?,'bilibili',?,?,?,6,1000000)").bind(id,subject,stamp,stamp).run();
  }
  await DB.prepare("INSERT INTO bilibili_binding_challenges(id,user_id,session_hash,uid,expected_hash,created_at,expires_at,state,verified_at) VALUES('proof','proven','hash','123','expected',1,2,'verified',?)").bind(stamp).run();
  for(const kind of ['developer','trusted_developer','admin'])await DB.prepare("INSERT INTO applications(id,user_id,kind,state,created_at) VALUES(?,'proven',?,'pending',?)").bind(kind,kind,stamp).run();
  await apply('0020_community_badges.sql');await apply('0021_developer_eligibility.sql');
  const rows=(await DB.prepare('SELECT user_id,ownership_verified_at,profile_source FROM external_connections ORDER BY user_id').all()).results;
  assert.equal(rows[0].user_id,'proven');assert.equal(rows[0].ownership_verified_at,stamp);assert.equal(rows[0].profile_source,'cloudflare-browser');
  assert.equal(rows[1].ownership_verified_at,null);assert.equal(rows[1].profile_source,null);
  const applications=(await DB.prepare('SELECT kind,state,reviewer FROM applications').all()).results;
  assert.equal(applications.find(a=>a.kind==='admin').state,'pending');
  for(const kind of ['developer','trusted_developer']){assert.equal(applications.find(a=>a.kind===kind).state,'rejected');assert.equal(applications.find(a=>a.kind===kind).reviewer,'system:criteria-update');}
  assert.equal((await DB.prepare("SELECT developer FROM users WHERE id='proven'").first()).developer,1);
  await DB.prepare("INSERT INTO applications(id,user_id,kind,state,note,created_at,core_contributor_claimed,github_subject,github_linked_at) VALUES('current-pending','proven','developer','pending','core proof',?,1,'123',?)").bind(stamp,stamp).run();
  const before=(await DB.prepare('SELECT * FROM applications ORDER BY id').all()).results;
  await apply('0022_creator_console.sql');
  assert.deepEqual((await DB.prepare('SELECT * FROM applications ORDER BY id').all()).results,before);
  assert.equal((await DB.prepare("SELECT creator,developer FROM users WHERE id='proven'").first()).creator,0);
  await assert.rejects(DB.prepare("INSERT INTO applications(id,user_id,kind,state,created_at) VALUES('duplicate','proven','developer','pending',?)").bind(stamp).run(),/UNIQUE/);
  await DB.prepare("INSERT INTO applications(id,user_id,kind,state,created_at) VALUES('creator','proven','creator','approved',?)").bind(stamp).run();
});
