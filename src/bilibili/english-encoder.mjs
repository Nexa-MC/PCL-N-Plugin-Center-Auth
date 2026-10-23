// Frozen English vocabulary and semantic rules. No remote generation or translation.
export const ENGLISH_ENCODER_VERSION = 'bili-english-v2';
export const ENGLISH_MAX_LENGTH = 70;
const adjectives = 'soft pale calm cool warm blue grey gold deep dim vast wide thin lush wild free slow late new old long near far low high bare open fair fine mild pure rich safe true tame keen airy damp dry wet icy dark cold faint still quiet light bright clear fresh small lone shy red pink teal jade navy rose neat bold rare sweet brisk'.split(' ').filter(word=>!['free','fair','fine','safe','true','tame','keen','neat','bold','rare','shy'].includes(word));
const subjects = [
  ['light', 'stars suns moons rays beams gleams lights sparks dawns dusks days nights skies'],
  ['water', 'seas bays lakes ponds pools rills brooks streams rivers waves tides shores coves isles sands'],
  ['plant', 'oaks elms firs pines reeds ferns roses seeds roots vines buds leaves trees woods fields hills'],
  ['weather', 'winds gales rains snows dews mists fogs frosts clouds storms'],
  ['bird', 'owls wrens larks doves gulls terns birds crows'],
  ['animal', 'deer hares harts stags'],
  ['insect', 'bees moths flies'],
  ['sound', 'bells songs notes echoes words dreams hopes tales rhymes chimes'],
].flatMap(([tag,words])=>words.split(' ').map(word=>({word,tag})));
const green = new Set(['lush','green','jade']);
const CLAUSES = 4, BUDGET = ENGLISH_MAX_LENGTH - ((CLAUSES - 1) * 2 + 1);
const groups = new Map(subjects.map(({word}) => [word, new Map()]));
const temporal = 'now then soon here there still again today tonight softly slowly gently calmly briefly freely quietly often always'.split(' ');
const lists = {
 light:'glow shine gleam glint blink dim wane rise fall fade rest sleep wake wait set',
 water:'flow run roll rise fall glide move drift swell ebb stir gleam shine glint glow rest sleep wake sing hum sigh cool warm',
 standing:'gleam shine glint glow dim fade freeze thaw cool warm rest sleep wake stir',
 land:'rest sleep wake wait fade glow shine gleam',
 tree:'sway bend lean nod bow grow bloom rest sleep wake sing sigh',
 seed:'grow sprout rest sleep wake fall drift',
 root:'grow rest sleep wake',
 bud:'grow bloom swell rest sleep wake sway',
 leaf:'sway drift fall turn glow shine gleam fade rest grow',
 wind:'stir rise fall sweep pass fade ebb sigh sing hum pause rest sleep wake',
 rain:'fall pass fade pause ebb',
 dew:'shine gleam glint glow fade rest',
 snow:'fall drift glow gleam shine glint melt thaw fade',
 frost:'grow shine gleam glint melt thaw fade',
 fog:'drift float move pass rise fall fade glow gleam dim',
 time:'fade rise fall rest sleep wake wait end come go',
 sound:'ring chime hum sing echo fade rise fall rest sleep wake wait',
 hope:'rise fall fade grow wait sleep wake come go',
 bird:'fly soar glide drift rest wait nap feed sleep wake turn sing',
 animal:'run roam move rest wait nap feed sleep wake pause',
 insect:'fly drift float rest sleep wake hum',
};
function kind(subject) {
 const noun=subject.word;
 if(['bays','lakes','ponds','pools'].includes(noun))return 'standing';
 if(['shores','coves','isles','sands','hills','fields','woods'].includes(noun))return 'land';
 if(['seeds','roots','buds','leaves'].includes(noun))return {seeds:'seed',roots:'root',buds:'bud',leaves:'leaf'}[noun];
 if(subject.tag==='plant')return 'tree';
 if(['winds','gales'].includes(noun))return 'wind';
 if(['rains','storms'].includes(noun))return 'rain';
 if(['dews','snows','frosts'].includes(noun))return {dews:'dew',snows:'snow',frosts:'frost'}[noun];
 if(['mists','fogs','clouds'].includes(noun))return 'fog';
 if(['days','nights','dawns','dusks','skies'].includes(noun))return 'time';
 if(['dreams','hopes'].includes(noun))return 'hope';
 return subject.tag;
}
for (const subject of subjects) {
 const category=kind(subject),allowedVerbs=lists[category].split(' ');
 for (const verb of allowedVerbs) {
  if(subject.word===verb+'s'||({leaves:'leaf',flies:'fly',echoes:'echo'}[subject.word]===verb))continue;
  if(verb==='set'&&!['suns','moons','stars'].includes(subject.word))continue;
  if(subject.word==='skies'&&['come','go','end'].includes(verb))continue;
  const group=groups.get(subject.word);
  const add=phrase=>{const list=group.get(phrase.length)??[];list.push(phrase);group.set(phrase.length,list);};
  for (const adjective of adjectives) {
   if(adjective===verb)continue;
   if(['cold','icy'].includes(adjective)&&['warm','melt'].includes(verb))continue;
   if(adjective==='warm'&&['freeze','cool'].includes(verb))continue;
   if(['animal','bird','insect'].includes(category)&&!'old new small wild lone soft pale dark grey red gold calm cool warm cold wet damp dry light still quiet'.split(' ').includes(adjective))continue;
   if(['sound','hope'].includes(category)&&!'soft calm low high deep faint quiet clear light bright slow old new long rich warm cold sweet pure dark mild'.split(' ').includes(adjective))continue;
   if(['near','far'].includes(adjective)&&!['land','water','standing'].includes(category))continue;
   if(green.has(adjective)&&!['tree','seed','root','bud','leaf','land'].includes(category))continue;
   if(['navy','teal','blue','pink','rose'].includes(adjective)&&['animal','tree','seed','root','bud','leaf'].includes(category))continue;
   if(['wet','damp','dry'].includes(adjective)&&category==='light')continue;
   if(adjective==='dry'&&['water','standing','wind','rain','dew','snow','frost','fog'].includes(category))continue;
   if(['vast','wide','deep','high','low','long','open'].includes(adjective)&&['seed','root','bud','leaf','light'].includes(category))continue;
   if(['navy','teal','rose'].includes(adjective)&&!['water','standing','land','fog','time'].includes(category))continue;
   if(adjective==='open'&&!['water','standing','land'].includes(category)&&subject.word!=='skies')continue;
   if(adjective==='brisk'&&!['water','wind','rain'].includes(category))continue;
   if(adjective==='sweet'&&!['tree','bud','sound'].includes(category))continue;
   add(`${adjective} ${subject.word} ${verb}`);
  }
  for(const determiner of ['no','all','few','some','most','both','our','these','those']) add(`${determiner} ${subject.word} ${verb}`);
  for(const adverb of ['just','only','even']) { add(`${adverb} ${subject.word} ${verb}`); add(`${subject.word} ${adverb} ${verb}`); }
  for(const adverb of temporal) {
   add(`${adverb} ${subject.word} ${verb}`);
   add(`${subject.word} ${adverb} ${verb}`);
   add(`${subject.word} ${verb} ${adverb}`);
  }
 }
}
for (const group of groups.values()) for (const [length,list] of group) group.set(length,[...new Set(list)].sort());
const nounNames = [...groups.keys()].sort();
const lengths = [...new Set([...groups.values()].flatMap(group=>[...group.keys()]))].sort((a,b)=>a-b);
const zero = () => Array(BUDGET + 1).fill(0n);
function multiply(a,b) {
  const result = zero();
  for (let i=0;i<a.length;i++) if(a[i]) for(let j=0;j+i<=BUDGET;j++) if(b[j]) result[i+j]+=a[i]*b[j];
  return result;
}
const powers = new Map(), sums = Array.from({length:CLAUSES+1},zero);
for (const [noun,group] of groups) {
  const base = zero(); for(const [length,list] of group) if(length<=BUDGET) base[length]=BigInt(list.length);
  const value=[zero(),base];
  for(let power=2;power<=CLAUSES;power++)value[power]=multiply(value[power-1],base);
  powers.set(noun,value);
  for(let power=1;power<=CLAUSES;power++) for(let i=0;i<=BUDGET;i++)sums[power][i]+=value[power][i];
}
const onePrefixes = new Map();
for (const noun of nounNames) { let total=0n;onePrefixes.set(noun,Array.from({length:BUDGET+1},(_,length)=>{total+=BigInt(groups.get(noun).get(length)?.length??0);return total;})); }
const allPrefix=Array.from({length:BUDGET+1},(_,length)=>nounNames.reduce((n,noun)=>n+onePrefixes.get(noun)[length],0n));
const memo = new Map();
// Newton's identities count ordered clauses with distinct nouns, after all
// local semantic exclusions and the total 70-character limit. No rejection sampling.
function distribution(remaining,used) {
  const key=remaining+':'+used.slice().sort().join(','); if(memo.has(key))return memo.get(key);
  const elementary=[zero()];elementary[0][0]=1n;
  for(let k=1;k<=remaining;k++) {
    const current=zero();
    for(let j=1;j<=k;j++) {
      const power=sums[j].map((value,index)=>value-used.reduce((n,noun)=>n+powers.get(noun)[j][index],0n));
      const term=multiply(elementary[k-j],power),sign=j%2?1n:-1n;
      for(let i=0;i<=BUDGET;i++)current[i]+=sign*term[i];
    }
    elementary[k]=current.map(value=>value/BigInt(k));
  }
  let factorial=1n;for(let i=2;i<=remaining;i++)factorial*=BigInt(i);
  const prefix=zero();let total=0n;
  for(let i=0;i<=BUDGET;i++){total+=elementary[remaining][i]*factorial;prefix[i]=total;}
  memo.set(key,prefix);return prefix;
}
function count(remaining,budget,used=[]) {
  if(budget<0)return 0n;
  if(!remaining)return 1n;
  if(budget<remaining*lengths[0])return 0n;
  if(remaining===1){const index=Math.min(budget,BUDGET);return allPrefix[index]-used.reduce((total,noun)=>total+onePrefixes.get(noun)[index],0n);}
  return distribution(remaining,used)[Math.min(budget,BUDGET)];
}
export const ENGLISH_CAPACITY=count(CLAUSES,BUDGET);
export function englishCapacityReport() {
 return {encoderVersion:ENGLISH_ENCODER_VERSION,maxLength:ENGLISH_MAX_LENGTH,clauses:CLAUSES,adjectives:adjectives.length,subjects:subjects.length,verbs:new Set(Object.values(lists).flatMap(value=>value.split(' '))).size,distinctSubjects:true,legalPhrases:[...groups.values()].reduce((n,g)=>n+[...g.values()].reduce((v,list)=>v+list.length,0),0),legalSentences:ENGLISH_CAPACITY.toString(),entropyBitsFloor:ENGLISH_CAPACITY.toString(2).length-1};
}
export function unrankEnglish(rank) {
 if(typeof rank!=='bigint'||rank<0n||rank>=ENGLISH_CAPACITY)throw new RangeError('English rank outside grammar');
 let budget=BUDGET;const result=[],used=[];
 for(let remaining=CLAUSES;remaining>0;remaining--){
  let selected=false;
  for(const length of lengths){
   for(const noun of nounNames){
    if(used.includes(noun))continue;
    const list=groups.get(noun).get(length)??[],suffix=count(remaining-1,budget-length,[...used,noun]),block=BigInt(list.length)*suffix;
    if(rank>=block){rank-=block;continue;}
    result.push(list[Number(rank/suffix)]);rank%=suffix;budget-=length;used.push(noun);selected=true;break;
   }
   if(selected)break;
  }
  if(!selected)throw new Error('English count mismatch');
 }
 const text=result.join('; ')+'.';return text[0].toUpperCase()+text.slice(1);
}
export function rankEnglish(text) {
 if(typeof text!=='string'||text.length>ENGLISH_MAX_LENGTH||!text.endsWith('.')||text[0]!==text[0].toUpperCase())throw new Error('Noncanonical English signature');
 const pieces=(text[0].toLowerCase()+text.slice(1,-1)).split('; ');if(pieces.length!==CLAUSES)throw new Error('Invalid English clause count');
 let result=0n,budget=BUDGET;const used=[];
 for(let position=0;position<CLAUSES;position++){
  const phrase=pieces[position],noun=phrase.split(' ').find(word=>groups.has(word)),remaining=CLAUSES-position-1;
  if(used.includes(noun)||!groups.has(noun))throw new Error('Repeated or unknown English subject');
  for(const length of lengths){
   for(const alternative of nounNames){
    if(used.includes(alternative))continue;
    if(length>phrase.length || length===phrase.length && alternative>=noun)break;
    result+=BigInt((groups.get(alternative).get(length)??[]).length)*count(remaining,budget-length,[...used,alternative]);
   }
   if(length>=phrase.length)break;
  }
  const index=groups.get(noun).get(phrase.length)?.indexOf(phrase)??-1;if(index<0)throw new Error('Phrase outside English grammar');
  result+=BigInt(index)*count(remaining,budget-phrase.length,[...used,noun]);budget-=phrase.length;used.push(noun);
 }
 if(budget<0||unrankEnglish(result)!==text)throw new Error('Noncanonical English signature');return result;
}

// Static word-count metadata for independent offline capacity verification.
export function englishGrammarAuditData() {
  return { clauses: CLAUSES, budget: BUDGET, subjects: [...groups].map(([noun,group]) => ({ noun, lengths: Object.fromEntries([...group].map(([length,list])=>[length,list.length])) })) };
}

export const englishSignatureSubjects = text => (text[0].toLowerCase()+text.slice(1,-1)).split('; ').map(phrase=>phrase.split(' ').find(word=>groups.has(word)));
