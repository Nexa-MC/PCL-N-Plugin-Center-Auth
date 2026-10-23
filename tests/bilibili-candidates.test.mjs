import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateBindingCandidates, createBindingNonces, ENGLISH_SPACES } from '../src/bilibili/binding-candidates.mjs';
import { ENGLISH_CAPACITY, englishGrammarAuditData, rankEnglish, unrankEnglish } from '../src/bilibili/english-encoder.mjs';

// Explicit ordered-distinct four-choice formula, independent of the encoder's
// recursive Newton implementation: P1^4 - 6P1²P2 + 3P2² + 8P1P3 - 6P4.
function independentCount(data) {
 const size=data.budget+1,zero=()=>Array(size).fill(0n);
 const mul=(a,b)=>{const c=zero();for(let i=0;i<size;i++)for(let j=0;j+i<size;j++)c[i+j]+=a[i]*b[j];return c;};
 const sums=Array.from({length:5},zero);
 for(const subject of data.subjects){const base=zero();for(const [length,count]of Object.entries(subject.lengths))if(+length<size)base[+length]=BigInt(count);let power=base;for(let k=1;k<=4;k++){if(k>1)power=mul(power,base);for(let i=0;i<size;i++)sums[k][i]+=power[i];}}
 const p12=mul(sums[1],sums[1]),p14=mul(p12,p12),p1p2=mul(p12,sums[2]),p22=mul(sums[2],sums[2]),p1p3=mul(sums[1],sums[3]);
 return p14.reduce((total,value,i)=>total+value-6n*p1p2[i]+3n*p22[i]+8n*p1p3[i]-6n*sums[4][i],0n);
}
test('English capacity has an independent exact count after length and distinct-subject exclusions',()=>{
 assert.equal(independentCount(englishGrammarAuditData()),ENGLISH_CAPACITY);
 assert.ok(ENGLISH_SPACES.every(space=>space>=2n**64n));
 assert.equal(independentCount({budget:8,subjects:[{lengths:{1:1}},{lengths:{1:2}},{lengths:{2:3}},{lengths:{3:4}}]}),24n*1n*2n*3n*4n);
});
test('two Chinese and two English candidates are reproducible, bounded and separated',()=>{
 const seen=new Set();
 for(let index=0;index<256;index++){
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const nonces={zh:hash('test zh '+index).slice(0,20),en:hash('test en '+index).slice(0,16)};
  const result=generateBindingCandidates(nonces);assert.deepEqual(result,generateBindingCandidates(nonces));
  assert.deepEqual(result.map(c=>c.language),['zh','zh','en','en']);
  for(const candidate of result){assert.ok(!seen.has(candidate.text));seen.add(candidate.text);assert.ok(candidate.text.length<=70);if(candidate.language==='en'){const rank=rankEnglish(candidate.text);assert.equal(Number(rank%2n),candidate.index-2);assert.equal(unrankEnglish(rank),candidate.text);}}
 }
 const nonce=createBindingNonces();assert.match(nonce.zh,/^[a-f0-9]{20}$/);assert.match(nonce.en,/^[a-f0-9]{16}$/);
 for(const rank of [0n,1n,ENGLISH_CAPACITY-2n,ENGLISH_CAPACITY-1n])assert.equal(rankEnglish(unrankEnglish(rank)),rank);
});
test('the committed 1,000-sentence audit matches the current encoder sources',async()=>{
 const report=JSON.parse(await readFile(new URL('../reports/bilibili/audit.json',import.meta.url),'utf8'));
 assert.equal(report.samples,1000);assert.equal(report.duplicates,0);assert.deepEqual(report.perLanguage,{zh:500,en:500});
 for(const [file,expected]of Object.entries(report.sourceSha256))assert.equal(createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex'),expected,file);
});

test('reviewed semantic failures and repeated subjects cannot enter English signatures',()=>{
 const suffix='; old seas rest; old stars glow; old deer nap.';
 for(const phrase of ['red isles flow','soft dews hum','clear echoes echo','navy owls nap','bare hares turn']) {
  assert.throws(()=>rankEnglish(phrase[0].toUpperCase()+phrase.slice(1)+suffix), /outside English grammar/);
 }
});
