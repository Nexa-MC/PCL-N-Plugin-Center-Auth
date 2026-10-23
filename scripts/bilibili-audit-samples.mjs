import { createHash } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { generateBindingCandidates, ENGLISH_SPACES, BINDING_ENCODER_VERSION } from '../src/bilibili/binding-candidates.mjs';
import { capacityReport, rankCandidate, unrankCandidate } from '../src/bilibili/encoder.mjs';
import { englishCapacityReport, rankEnglish, unrankEnglish, englishSignatureSubjects } from '../src/bilibili/english-encoder.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const rows=[],seen=new Set();
for(let sample=0;sample<250;sample++) {
 const nonces={zh:hash('Nexa sample zh v1 '+sample).slice(0,20),en:hash('Nexa sample en v1 '+sample).slice(0,16)};
 for(const candidate of generateBindingCandidates(nonces)) {
  assert.equal(seen.has(candidate.text),false);seen.add(candidate.text);
  const length=Array.from(candidate.text).length;
  assert.ok(length<=70);assert.equal(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(candidate.text),false);
  assert.equal(candidate.text.normalize('NFC'),candidate.text);
  if(candidate.language==='zh') {
   assert.equal(length,39);assert.equal(unrankCandidate(candidate.index,rankCandidate(candidate.index,candidate.text)),candidate.text);
  } else {
   assert.match(candidate.text,/^[A-Z][a-z ;.]+$/);
   const rank=rankEnglish(candidate.text);assert.equal(Number(rank%2n),candidate.index-2);
   assert.equal(unrankEnglish(rank),candidate.text);
   const nouns=englishSignatureSubjects(candidate.text);
   assert.equal(new Set(nouns).size,4);
  }
  rows.push({id:rows.length+1,language:candidate.language,candidate:candidate.index+1,entropyBits:candidate.language==='zh'?80:64,length,text:candidate.text});
 }
}
assert.equal(rows.length,1000);
const chinese=capacityReport(),english=englishCapacityReport();
assert.ok(chinese.spaces.slice(0,2).every(space=>BigInt(space.capacity)>=2n**80n));
assert.ok(ENGLISH_SPACES.every(space=>space>=2n**64n));
const root=new URL('../reports/bilibili/',import.meta.url);await mkdir(root,{recursive:true});
const data=JSON.stringify(rows,null,2)+'\n';await writeFile(new URL('samples-1000.json',root),data);
await writeFile(new URL('samples-1000.txt',root),rows.map(row=>`${String(row.id).padStart(4,'0')} [${row.language}; ${row.entropyBits} bit; ${row.length} chars] ${row.text}`).join('\n')+'\n');
const report={version:BINDING_ENCODER_VERSION,samples:1000,perLanguage:{zh:500,en:500},perCandidate:250,duplicates:0,lengths:Object.fromEntries(['zh','en'].map(language=>{const values=rows.filter(row=>row.language===language).map(row=>row.length);return[language,{min:Math.min(...values),max:Math.max(...values)}]})),checks:['canonical Unicode','no invisible/control characters','length <=70','unique sampled sentences','grammar rank/unrank','English candidate spaces disjoint by parity','four distinct English subjects','exact legal-space capacity >= nonce space'],chinese:{nonceBits:80,legalSpaces:chinese.spaces.slice(0,2),reachablePerCandidate:(2n**80n).toString()},english:{...english,nonceBits:64,legalSpaces:ENGLISH_SPACES.map(String),reachablePerCandidate:(2n**64n).toString()},entropyEvidence:'Exact constrained-space counts and injective affine rank mapping; sample uniqueness is a regression check, not an entropy proof.',samplesSha256:hash(data),sourceSha256:{}};
for(const file of ['src/bilibili/lexicon.mjs','src/bilibili/encoder.mjs','src/bilibili/english-encoder.mjs','src/bilibili/binding-candidates.mjs'])report.sourceSha256[file]=hash(await readFile(new URL('../'+file,import.meta.url)));
await writeFile(new URL('audit.json',root),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({samples:report.samples,duplicates:report.duplicates,lengths:report.lengths,chineseBits:80,englishBits:64,englishLegalSpaces:report.english.legalSpaces},null,2));
