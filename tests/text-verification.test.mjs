import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { CardTextIndex, parsePrintedCode } from '../src/lib/cardTextIdentity.js';
import { CardTextVerification } from '../src/lib/cardTextVerification.js';
import { applyTextVerification, buildRecognitionResult, matchFromRanking } from '../src/lib/cardRecognition.js';
import { isReliableScanResult } from '../src/lib/scanQuality.js';
import { textRegions, footerTextRows, CardTextReader } from '../src/lib/cardTextReader.js';
import { prepareTextPixels, isolateTextPixels, normalizeTextLighting, textNeighborhoodExtrema } from '../src/lib/cardTextImage.js';
import { createRuntime, componentProps, nodes } from './helpers/runtime.mjs';

const cards = [
  { id:'suave', name:'Suave Negotiator', code:'RAD-099/167', set:'RAD' },
  { id:'ahri', name:'Ahri', code:'RAD-SP1/005', set:'RAD' },
  { id:'rune', name:'Chaos Rune', code:'RAD-R05', set:'RAD' },
  { id:'rune-alt', name:'Chaos Rune', code:'RAD-R05a', set:'RAD' },
  { id:'kaisa', name:"Kai'Sa", code:'OGN-027a/298', set:'OGN' },
  { id:'star', name:'Daughter of the Void', code:'OGN-299*/298', set:'OGN' },
];
const index = new CardTextIndex(cards);
const line = (text, confidence=96) => ({ text, confidence });
const reading = (name='Suave Negotiator', code='RAD · 099/167 · EN', confidence=96) => index.resolve({ nameLines:[line(name,confidence)], footerLines:[line(code,confidence)] });

test('linear-time text filters retain every pixel of the direct square-neighborhood calculation', () => {
  let seed=193;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
  for(const [width,height] of [[1,1],[1,31],[43,1],[19,23],[137,91]])for(const radius of [1,2,9,24])for(const maximum of [false,true]){
    const input=Uint8Array.from({length:width*height},random),expected=new Uint8Array(input.length);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      let value=maximum?0:255;
      for(let yy=Math.max(0,y-radius);yy<=Math.min(height-1,y+radius);yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(width-1,x+radius);xx++){
        value=maximum?Math.max(value,input[yy*width+xx]):Math.min(value,input[yy*width+xx]);
      }
      expected[y*width+x]=value;
    }
    assert.deepEqual(textNeighborhoodExtrema(input,width,height,radius,maximum),expected);
  }
});

test('local text lighting restores a shadowed strip without adding glyphs to flat pixels', () => {
  const width=120,height=30,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const background=x<60?35:175,ink=y>=10&&y<20&&x%10<3;
    const value=background+(ink?45:0); data.set([value,value,value,255],(y*width+x)*4);
  }
  const normalized=normalizeTextLighting({data,width,height},5);
  for(const x of [20,80]){
    const ink=normalized.data[(15*width+x)*4],background=normalized.data[(15*width+x+4)*4];
    assert.ok(ink-background>200);
  }
  const flat=normalizeTextLighting({data:new Uint8ClampedArray(width*height*4).fill(100),width,height},8);
  for(let i=0;i<width*height;i++)assert.equal(flat.data[i*4],0);
});

test('quarter-turns carry the padded card bounds into battlefield text coordinates', () => {
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>({translate(){},rotate(){},drawImage(){}})})}}});
  const {rotateCardCanvas}=runtime.load('src/lib/cardRecognition.js');
  const source={width:100,height:200,scanCardBounds:{x:.1,y:.2,width:.6,height:.5}};
  const expected=[[.3,.1,.5,.6],[.3,.3,.6,.5],[.2,.3,.5,.6]];
  for(let turns=1;turns<=3;turns++){
    const rotated=rotateCardCanvas(source,turns);
    assert.equal(rotated.width,turns%2?200:100);assert.equal(rotated.height,turns%2?100:200);
    for(const [i,key] of ['x','y','width','height'].entries())assert.ok(Math.abs(rotated.scanCardBounds[key]-expected[turns-1][i])<1e-9);
  }
  assert.deepEqual(source.scanCardBounds,{x:.1,y:.2,width:.6,height:.5});
});

test('collector retry straightens a sloping glyph baseline while retaining its first glyph and excluding the frame', () => {
  const width=420,height=100,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y)=>data.set([0,0,0,255],(y*width+x)*4);
  for(let x=0;x<width;x++)ink(x,4);
  for(let y=4;y<95;y++)ink(1,y);
  for(let glyph=0;glyph<12;glyph++){
    const left=30+glyph*20,top=25+Math.round(left*.08);
    for(let y=top;y<top+20;y++)for(let x=left;x<left+8;x++)ink(x,y);
  }
  const selected=isolateTextPixels({data,width,height},{footer:true,glyphHeight:20});
  let count=0,peak=0;
  for(let y=0;y<selected.height;y++){
    let row=0;for(let x=0;x<selected.width;x++)if(selected.data[(y*selected.width+x)*4]<128){count++;row++;}
    peak=Math.max(peak,row);
  }
  assert.ok(count>=12*8*20*.9,'the complete set/collector row survives');
  assert.ok(count<=12*8*20*1.1,'the unrelated frame is excluded');
  assert.ok(peak>=12*7,'the separate glyphs share a horizontal baseline');
});

test('the collector region includes the left edge without losing the right end or lower glyphs', () => {
  for (const card of [{type:'unit'}, {type:'rune'}, {type:'legend'}, {orientation:'landscape'}]) {
    const { footer }=textRegions(card);
    assert.equal(footer.x,0,'RAD can start inside the first 2.5% of a detector crop');
    assert.ok(footer.x+footer.width>=.425);
    assert.ok(footer.y+footer.height<=1);
    assert.ok(footer.y+footer.height>=.98);
  }
});

test('footer localization keeps complete glyph rows and excludes horizontal frame decoration', () => {
  const width=180,height=40,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y)=>data.set([0,0,0,255],(y*width+x)*4);
  for(let x=0;x<width;x++){ink(x,2);ink(x,38);}
  for(let y=16;y<=25;y++)for(let x=3;x<125;x+=6){ink(x,y);ink(x+1,y);}
  const rows=footerTextRows({data,width,height});
  assert.ok(rows.top<=16&&rows.top+rows.height>=26);
  assert.ok(rows.top>2&&rows.top+rows.height<38);
  assert.deepEqual(footerTextRows({data:new Uint8ClampedArray(width*height*4).fill(255),width,height}),{top:0,height});
});

test('faint footer lettering is localized without retaining long frame strokes or inventing pixels', () => {
  const width=180,height=45,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y,value)=>data.set([value,value,value,255],(y*width+x)*4);
  for(let y=0;y<height;y++)ink(0,y,0);
  for(let x=5;x<175;x++)ink(x,3+Math.floor(x/45),20);
  for(let y=20;y<=28;y++)for(let x=12;x<120;x+=6){ink(x,y,180);ink(x+1,y,180);}
  const result=prepareTextPixels({data,width,height},{footer:true,padding:3});
  assert.ok(result.rows.top<=20&&result.rows.top+result.rows.height>=29);
  assert.ok(result.rows.top>8);assert.equal(result.image.data[0],255);
  assert.ok(result.image.data[(24*width+12)*4]<224);
});

test('printed identifiers preserve set, prefix, suffix, star and denominator', () => {
  for (const [name, code, id] of [['Suave Negotiator','RAD 099/167','suave'], ['Ahri','RAD SP1/005','ahri'],
    ['Chaos Rune','RAD R05a','rune-alt'], ["Kai’Sa",'OGN 027a/298','kaisa'], ['Daughter of the Void','OGN 299*/298','star']]) {
    const result=reading(name,code);assert.equal(result.status,'confirmed',code);assert.equal(result.cardId,id);
  }
  assert.equal(reading('Suave Negotiator','RAD 099').status,'confirmed');
  assert.notEqual(reading('Suave Negotiator','RAD 099/164').status,'confirmed');
  assert.notEqual(reading('Suave Negotiator','RAD 99/167').status,'confirmed');
  assert.equal(parsePrintedCode('RAD-R05a').collector,'R05A');
  assert.equal(reading('Chaos Rune','RAD R05').reason,'variant-unclear');
});

test('a complete numerator boundary can verify a base printing while an unterminated stem stays ambiguous', () => {
  const variantIndex=new CardTextIndex([{id:'base',name:'Seraphine',code:'RAD-065/167'},{id:'alt',name:'Seraphine',code:'RAD-065a/167'}]);
  const resolve=code=>variantIndex.resolve({nameLines:[line('Seraphine')],footerLines:[line(code)]});
  assert.equal(resolve('RAD 065/167').cardId,'base');assert.equal(resolve('RAD 065a/167').cardId,'alt');
  assert.equal(resolve('RAD 065').reason,'variant-unclear');
});

test('short names require exact text and a long name allows one unique OCR error', () => {
  assert.equal(reading('Suave Negotiato').status,'confirmed');
  assert.notEqual(reading('Suav Negotiato').status,'confirmed');
  assert.notEqual(reading('Ahrl','RAD SP1/005').status,'confirmed');
  assert.equal(reading('Suave Negotiator','RAD 099/167',89).status,'unreadable');
  assert.equal(index.resolve({ nameLines:[line('When you play Suave Negotiator draw a card')], footerLines:[line('RAD 099/167')] }).status,'unreadable');
});

test('a trusted conflicting name and collector code require manual review', () => {
  assert.equal(reading('Ahri','RAD 099/167').status,'conflict');
  assert.equal(index.resolve({nameLines:[],footerLines:[],tooSmall:true}).reason,'text-too-small');
  assert.equal(index.resolve({footerLines:[line('RAD 099/167'),line('RAD SP1/005')]}).status,'conflict');
});

const quality = { acceptable:true, score:.8, fingerprint:[30,150,60,190] };
const ranked = [{card:cards[0],similarity:.93},{card:cards[1],similarity:.92}];
function fixture(reader = { read:async()=>reading() }) {
  let now=0;
  const verifier=new CardTextVerification(reader,{now:()=>now});
  const frame={scanCancelled:false};
  const observe=(id,options={})=>{
    now=options.now??now+250;
    const observation={cardData:cards[0],quality,frameId:id,capturedAt:now,box:{cx:100,cy:100,h:300},...options.observation};
    return verifier.observe(observation,options.crop??{}, {frame,context:'camera-1',index,candidates:ranked,minSimilarity:.9,...options});
  };
  return {verifier,frame,observe,setNow:(value)=>{now=value;}};
}

test('two independent source frames confirm; a repeated frame and preprocessing do not', async () => {
  const f=fixture();try{
    assert.equal(f.observe(1).status,'pending');await tick();
    assert.equal(f.observe(1).status,'pending');await tick();
    assert.equal(f.observe(2).status,'pending');await tick();
    const result=f.observe(3);assert.equal(result.status,'confirmed');assert.deepEqual(result.sourceFrameIds,[1,2]);
  }finally{f.verifier.dispose();}
});

test('a successful slow first reading gives the independent second reading a complete bounded budget',async()=>{
  const jobs=[],deadlines=[];const f=fixture({read:(_crop,options)=>new Promise(resolve=>{jobs.push(resolve);deadlines.push(options.deadline);})});
  try{
    f.observe(1,{now:0});await tick();f.observe(2,{now:1500});
    f.setNow(1700);jobs[0](reading());await tick();
    assert.deepEqual(deadlines,[2000,3700]);
    assert.equal(f.observe(3,{now:2400}).artworkFallbackAllowed,true);
    f.setNow(2600);jobs[1](reading());await tick();
    const proof=f.observe(4,{now:2800});assert.equal(proof.status,'confirmed');assert.deepEqual(proof.sourceFrameIds,[1,2]);
    assert.equal(proof.confirmationWindowMs,2000);assert.equal(proof.evidenceWindowMs,4000);
  }finally{f.verifier.dispose();jobs.forEach(resolve=>resolve(reading()));await tick();}
});

test('camera-guide tracking survives detector crop jitter while an actual scene change still invalidates text',async()=>{
  const f=fixture();const other={...quality,fingerprint:[200,10,210,20]};
  f.frame.scanQuality={fingerprint:quality.fingerprint};
  try{
    const first=f.observe(1);await tick();
    const second=f.observe(2,{observation:{trackingFingerprint:other.fingerprint,quality:other}});await tick();
    assert.equal(second.trackId,first.trackId);
    const proof=f.observe(3,{observation:{trackingFingerprint:other.fingerprint}});assert.equal(proof.status,'confirmed');
    assert.equal(proof.trackingFingerprintSource,'camera-guide');
    f.frame.scanQuality={fingerprint:other.fingerprint};
    const changed=f.observe(4);assert.notEqual(changed.trackId,proof.trackId);assert.equal(changed.status,'pending');
  }finally{f.verifier.dispose();}
});

test('a continuously tracked card can change pose without accumulating false movement against its initial pose',async()=>{
  const f=fixture();
  try{
    let first;
    for(let id=1;id<=5;id++){
      f.frame.scanQuality={fingerprint:[30+id*12,150-id*12,60+id*12,190-id*12]};
      const result=f.observe(id,{observation:{box:{cx:100+id*20,cy:100,h:300}}});await tick();
      first??=result.trackId;assert.equal(result.trackId,first);
    }
    f.frame.scanMoving=true;assert.equal(f.observe(6).status,'unreadable');
    f.frame.scanMoving=false;assert.notEqual(f.observe(7).trackId,first);
  }finally{f.verifier.dispose();}
});

test('the camera motion epoch controls continuity even when slower processed frames have different guide pixels',async()=>{
  const f=fixture(),context={epoch:1},other={...quality,fingerprint:[200,10,210,20]};
  const frame=()=>({scanMotionEpoch:context.epoch,scanMotionContext:context,scanQuality:other});
  try{
    const first=f.observe(1,{frame:frame()});await tick();
    f.observe(2,{frame:frame(),observation:{trackingFingerprint:other.fingerprint}});await tick();
    const proof=f.observe(3,{frame:frame()});assert.equal(proof.status,'confirmed');assert.equal(proof.trackId,first.trackId);
    assert.equal(proof.trackingFingerprintSource,'camera-motion');
    context.epoch++;
    assert.notEqual(f.observe(4,{frame:frame()}).trackId,first.trackId);
  }finally{f.verifier.dispose();}
});

test('a camera motion epoch change discards an old OCR job even after its source left the short frame buffer',async()=>{
  const jobs=[],f=fixture({read:()=>new Promise(resolve=>jobs.push(resolve))}),context={epoch:1};
  try{
    const frame={scanMotionEpoch:1,scanMotionContext:context};
    f.observe(1,{frame});await tick();context.epoch++;
    jobs[0](reading());await tick();
    assert.equal(f.verifier.session.reads.length,0);
  }finally{f.verifier.dispose();}
});

test('geometry work can be deferred only for a fresh printed identity in the same live camera context',async()=>{
  const f=fixture(),cursor={epoch:1},frame={scanMotionEpoch:1,scanMotionContext:cursor};
  const request={frame,context:'camera-1',capturedAt:500};
  try{
    f.observe(1,{frame});assert.equal(f.verifier.getGeometryHint(request),null);await tick();
    assert.deepEqual(f.verifier.getGeometryHint(request),{cardId:'suave'});
    assert.equal(f.verifier.getGeometryHint({...request,context:'other-camera'}),null);
    assert.equal(f.verifier.getGeometryHint({...request,capturedAt:3000}),null);
    cursor.epoch++;assert.equal(f.verifier.getGeometryHint(request),null);
  }finally{f.verifier.dispose();}
});

test('the original crop may avoid repeated homographies after text, but can never use artwork fallback without checking them',async()=>{
  const pixels=new Uint8ClampedArray(64*88*4).map((_,i)=>i%9?50:210);
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:pixels,width:64,height:88})})})}}});
  const service=runtime.load('src/lib/cardRecognition.js');
  const source={width:300,height:420};let refinements=0,ranks=0;
  const entries=[{card:cards[0],similarity:.82,secondBestSim:.7,localStructureSimilarity:.8},{card:cards[1],similarity:.7}];
  const matcher={ready:true,rank:()=>{ranks++;return entries;}};
  const options={source,detection:{box:{},cropCanvas:source},matcher,candidates:true,
    cropRefiner:async()=>{refinements++;return{status:'uncertain'};},textCorroboration:{cardId:'suave'}};
  const fast=await service.recognizeCard(options);assert.equal(refinements,0);assert.equal(ranks,1);assert.equal(fast.requiresTextConfirmation,true);
  const base=buildRecognitionResult(fast.match,quality,.9,{requiresTextConfirmation:fast.requiresTextConfirmation});
  for(const verification of [{status:'unavailable'},{status:'unreadable'},{status:'pending',artworkFallbackAllowed:true}]){
    assert.equal(applyTextVerification(base,fast.match,verification).matched,false);
    assert.equal(applyTextVerification({...base,similarity:.99},fast.match,verification).matched,false);
  }
  const proof={...reading(),cardId:'suave',sourceFrameIds:[1,2]};
  const confirmed=applyTextVerification(base,fast.match,proof);assert.equal(confirmed.matched,true);assert.equal(confirmed.similarity,.82);
  assert.equal(applyTextVerification(base,fast.match,{...proof,sourceFrameIds:[1]}).matched,false);
  assert.equal(applyTextVerification(base,fast.match,{...proof,status:'conflict'}).matched,false);
  const other=await service.recognizeCard({...options,textCorroboration:{cardId:'ahri'}});
  assert.equal(refinements,1);assert.equal(other.requiresTextConfirmation,false);
  entries[0].localStructureSimilarity=.4;
  assert.equal((await service.recognizeCard(options)).requiresTextConfirmation,false);assert.equal(refinements,2);
  entries[0].localStructureSimilarity=.8;entries[0].similarity=.98;
  assert.equal((await service.recognizeCard(options)).requiresTextConfirmation,false);assert.equal(refinements,3,'Strong original artwork retains its normal geometry checks and fallback');
});

test('slow verification never joins text frames more than two seconds apart or lets an old pair survive',async()=>{
  const jobs=[],f=fixture({read:()=>new Promise(resolve=>jobs.push(resolve))});
  try{
    f.observe(1,{now:0});await tick();
    f.observe(1,{now:1000,observation:{capturedAt:0}});
    f.setNow(1500);jobs[0](reading());await tick();
    f.observe(2,{now:2500});await tick();f.setNow(2600);jobs[1](reading());await tick();
    assert.notEqual(f.observe(3,{now:2700}).status,'confirmed');await tick();
    f.setNow(2800);jobs[2](reading());await tick();
    const valid=f.observe(4,{now:2900});assert.equal(valid.status,'confirmed');assert.deepEqual(valid.sourceFrameIds,[2,3]);
    f.observe(5,{now:4200});
    assert.notEqual(f.observe(6,{now:5000}).status,'confirmed');
  }finally{f.verifier.dispose();jobs.forEach(resolve=>resolve(reading()));await tick();}
});

test('two failed reads do not prevent later fresh frames from confirming inside the same budget', async () => {
  let calls=0;const f=fixture({read:async()=>++calls<=2?index.resolve({}):reading()});
  try {
    for(let id=1;id<=4;id++){f.observe(id);await tick();}
    const proof=f.observe(5);assert.equal(proof.status,'confirmed');
    assert.deepEqual(proof.sourceFrameIds,[3,4]);assert.equal(calls,4);
  }finally{f.verifier.dispose();}
});

test('an expired OCR attempt leaves a fallback interval then retries on fresh frames without reusing old evidence', async () => {
  let readable=false;const deadlines=[];
  const f=fixture({read:async(_crop,options)=>{deadlines.push(options.deadline);return readable?reading():index.resolve({});}});
  try{
    const first=f.observe(1,{now:0});await tick();
    for(let id=2;id<=12;id++){const state=f.observe(id,{now:(id-1)*250});if(id>=9)assert.equal(state.status,'unreadable');await tick();}
    assert.ok(deadlines.every(value=>value===2000));readable=true;
    const retry=f.observe(13,{now:3000});assert.equal(retry.status,'pending');assert.notEqual(retry.sessionId,first.sessionId);await tick();
    f.observe(14,{now:3250});await tick();
    const proof=f.observe(15,{now:3500});assert.equal(proof.status,'confirmed');assert.deepEqual(proof.sourceFrameIds,[13,14]);
    assert.ok(deadlines.slice(-2).every(value=>value===5000));
  }finally{f.verifier.dispose();}
});

test('a frozen frame cannot restart expired OCR and an intrinsic conflict cannot expire into a retry', async () => {
  let calls=0;const frozen=fixture({read:async()=>{calls++;return index.resolve({});}});
  try{
    const first=frozen.observe(1,{now:0,observation:{capturedAt:0}});await tick();
    for(let now=250;now<=5000;now+=250){const state=frozen.observe(1,{now,observation:{capturedAt:0}});assert.equal(state.sessionId,first.sessionId);await tick();}
    assert.equal(calls,1);
  }finally{frozen.verifier.dispose();}
  const conflict=fixture({read:async()=>reading('Ahri','RAD 099/167')});
  try{
    const first=conflict.observe(1,{now:0});await tick();
    for(let id=2;id<=20;id++){const state=conflict.observe(id,{now:(id-1)*250});assert.equal(state.status,'conflict');assert.equal(state.sessionId,first.sessionId);}
  }finally{conflict.verifier.dispose();}
});

test('OCR retries keep the held-card epoch and never restart the artwork fallback wait', async () => {
  const f=fixture({read:async()=>index.resolve({})});
  try {
    const first=f.observe(1,{now:0});await tick();
    assert.equal(first.artworkFallbackAllowed,false);
    f.observe(2,{now:1000});await tick();
    assert.equal(f.observe(3,{now:2000}).artworkFallbackAllowed,true);await tick();
    const retry=f.observe(4,{now:3000});await tick();
    assert.equal(retry.status,'pending');assert.notEqual(retry.sessionId,first.sessionId);
    assert.equal(retry.trackId,first.trackId);assert.equal(retry.artworkFallbackAllowed,true);
    const changed=f.observe(5,{now:3500,context:'another-camera'});
    assert.notEqual(changed.trackId,first.trackId);assert.equal(changed.artworkFallbackAllowed,false);
  } finally {f.verifier.dispose();}
});

test('pending background OCR may fall back only after the initial wait and never over a contradiction', () => {
  const match=matchFromRanking([{card:cards[0],similarity:.94},{card:cards[1],similarity:.8}]);
  const base=buildRecognitionResult(match,quality,.9);
  assert.equal(applyTextVerification(base,match,{status:'pending',artworkFallbackAllowed:false}).matched,false);
  const fallback=applyTextVerification(base,match,{status:'pending',artworkFallbackAllowed:true});
  assert.equal(fallback.matched,true);assert.equal(isReliableScanResult(fallback,.9),true);
  assert.equal(applyTextVerification(base,match,{status:'conflict',artworkFallbackAllowed:true}).matched,false);
  assert.equal(applyTextVerification({...base,similarity:.89},match,{status:'pending',artworkFallbackAllowed:true}).matched,false);
  assert.equal(applyTextVerification({...base,similarityGap:.01},match,{status:'pending',artworkFallbackAllowed:true}).matched,false);
});

test('a provisional visual disagreement is reevaluated when the visual candidate catches up', async () => {
  const partial=index.resolve({nameLines:[line('Suave Negotiator')]});const f=fixture({read:async()=>partial});
  try {
    f.observe(1,{observation:{cardData:cards[1]}});await tick();
    const conflict=f.observe(2,{observation:{cardData:cards[1]}});assert.equal(conflict.status,'conflict');
    const resolved=f.observe(3);assert.notEqual(resolved.status,'conflict');assert.equal(resolved.sessionId,conflict.sessionId);
  }finally{f.verifier.dispose();}
});

test('a local-detail identity change invalidates OCR even when candidate lists overlap', async () => {
  const jobs=[];const f=fixture({read:()=>new Promise(resolve=>jobs.push(resolve))});
  try {
    const first=f.observe(1,{candidates:[{...ranked[0],localStructureSimilarity:.8},ranked[1]]});await tick();
    const second=f.observe(2,{candidates:[{...ranked[1],localStructureSimilarity:.8},ranked[0]],observation:{cardData:cards[1]}});
    assert.notEqual(first.sessionId,second.sessionId);jobs[0](reading());await tick();
    assert.notEqual(f.observe(3,{candidates:[{...ranked[1],localStructureSimilarity:.8},ranked[0]],observation:{cardData:cards[1]}}).status,'confirmed');
  }finally{f.verifier.dispose();jobs.forEach(resolve=>resolve(reading()));await tick();}
});

test('changing the artwork crop does not reset OCR but changing the original card still does', async () => {
  const f=fixture();const trackingFingerprint=quality.fingerprint;
  try {
    f.observe(1,{observation:{trackingFingerprint}});await tick();
    const otherCrop={...quality,fingerprint:[200,10,210,20]};
    f.observe(2,{observation:{trackingFingerprint,quality:otherCrop}});await tick();
    const proof=f.observe(3,{observation:{trackingFingerprint}});
    assert.equal(proof.status,'confirmed');assert.deepEqual(proof.sourceFrameIds,[1,2]);
    const changed=f.observe(4,{observation:{trackingFingerprint:otherCrop.fingerprint}});
    assert.equal(changed.status,'pending');assert.notEqual(changed.sessionId,proof.sessionId);
  } finally {f.verifier.dispose();}
});

test('only the latest waiting frame is queued while OCR is running', async () => {
  const jobs=[];const f=fixture({read:(_crop,options)=>new Promise(resolve=>jobs.push({options,resolve}))});
  try{
    f.observe(1);await tick();f.observe(2);f.observe(3);f.observe(4);
    assert.equal(jobs.length,1);jobs[0].resolve(reading());await tick();assert.equal(jobs.length,2);
    jobs[1].resolve(reading());await tick();assert.deepEqual(f.observe(5).sourceFrameIds,[1,4]);
  }finally{f.verifier.dispose();}
});

test('late text cannot cross a camera/context change or cancelled source frame', async () => {
  const jobs=[];const f=fixture({read:()=>new Promise(resolve=>jobs.push(resolve))});
  try{
    f.observe(1);await tick();f.observe(2,{context:'camera-2'});jobs[0](reading());await tick();
    assert.notEqual(f.observe(3,{context:'camera-2'}).status,'confirmed');
    f.frame.scanCancelled=true;jobs[1]?.(reading());await tick();assert.equal(f.observe(4).status,'unreadable');
  }finally{f.verifier.dispose();}
});

test('the two-second budget falls back, errors are unavailable, and conflicts remain blocked', async () => {
  const f=fixture({read:()=>new Promise(()=>{})});try{f.observe(1);await tick();f.observe(2,{now:1000});assert.equal(f.observe(3,{now:2250}).status,'unreadable');}finally{f.verifier.dispose();}
  const broken=fixture({read:async()=>{throw new Error('worker failed');}});try{broken.observe(1);await tick();assert.equal(broken.observe(2).status,'unavailable');}finally{broken.verifier.dispose();}
  const conflict=fixture({read:async()=>reading('Ahri','RAD 099/167')});try{conflict.observe(1);await tick();assert.equal(conflict.observe(2).status,'conflict');conflict.observe(3,{now:1750});assert.equal(conflict.observe(4,{now:2300}).status,'conflict');}finally{conflict.verifier.dispose();}
});

test('text evidence resolves only the candidate gap, never the user threshold or quality gate', () => {
  const match=matchFromRanking(ranked), result=buildRecognitionResult(match,quality,.9);
  const proof={...reading(),status:'confirmed',cardId:'suave',sourceFrameIds:[1,2]};
  assert.equal(result.matched,false);
  const resolved=applyTextVerification(result,match,proof);
  assert.equal(resolved.similarity,.93);assert.ok(resolved.similarityGap<.05);
  assert.equal(isReliableScanResult(resolved,.9),true);
  assert.equal(isReliableScanResult(resolved,.95),false);
  assert.equal(isReliableScanResult({...resolved,quality:{acceptable:false}}),false);
  assert.equal(isReliableScanResult({...resolved,textVerification:{...proof,sourceFrameIds:[1,1]}}),false);
  assert.equal(applyTextVerification(result,match,{status:'conflict'}).matched,false);
  const alternative=matchFromRanking([{...ranked[0],cropMethod:'perspective'},ranked[1]]);
  assert.equal(applyTextVerification({...result,cropMethod:'obb'},alternative,proof).cropMethod,'perspective');
});

test('photo verification can show a single reading without qualifying as a camera confirmation', async () => {
  const verifier=new CardTextVerification({read:async()=>reading()});
  try{
    const proof=await verifier.verifyPhoto({}, {hint:cards[0],index,frameId:'photo-1'});
    const result=applyTextVerification(buildRecognitionResult(matchFromRanking(ranked),quality,.9),matchFromRanking(ranked),proof,{photo:true});
    assert.equal(result.matched,true);assert.equal(isReliableScanResult(result),false);
  }finally{verifier.dispose();}
});

test('OCR crop alternatives share a deadline, keep complete pairs and preserve trusted contradictions', async () => {
  const original={},corrected={},calls=[];let now=0;
  const reader=new CardTextReader({now:()=>now});
  const options={hint:cards[0],index,deadline:2000,alternativeCrops:[corrected]};
  reader.readCrop=async(source,opts)=>{calls.push({source,deadline:opts.deadline});return source===original?index.resolve({nameLines:[line('Suave Negotiator')]}):reading();};
  const result=await reader.read(original,options);
  assert.equal(result.status,'confirmed');assert.equal(result.textCropMethod,'perspective');
  assert.deepEqual(calls.map(c=>c.deadline),[2000,2000]);
  reader.readCrop=async()=>reading();calls.length=0;
  assert.equal((await reader.read(original,options)).textCropMethod,'obb');
  reader.readCrop=async source=>source===original?index.resolve({nameLines:[line('Suave Negotiator')]}):reading('Ahri','RAD SP1/005');
  assert.equal((await reader.read(original,options)).status,'conflict','An alternative cannot hide the trusted original name');
  reader.readCrop=async source=>{calls.push(source);now=2100;return index.resolve({nameLines:[line('Suave Negotiator')]});};
  calls.length=0;now=0;
  assert.equal((await reader.read(original,options)).status,'unreadable');assert.equal(calls.length,1);
});

test('two crops of one camera frame are still only one independent OCR observation', async () => {
  const original={},corrected={};const reader=new CardTextReader({now:()=>0});
  reader.readCrop=async source=>source===original?index.resolve({nameLines:[line('Suave Negotiator')]}):reading();
  const f=fixture(reader);
  try {
    f.observe(1,{crop:original,alternativeCrops:[corrected]});await tick();
    const first=f.observe(1,{crop:original,alternativeCrops:[corrected]});
    assert.equal(first.status,'pending');assert.equal(first.completedReads,1);
    f.observe(2,{crop:original,alternativeCrops:[corrected]});await tick();
    const result=f.observe(3,{crop:original,alternativeCrops:[corrected]});
    assert.equal(result.status,'confirmed');assert.deepEqual(result.sourceFrameIds,[1,2]);
  } finally {f.verifier.dispose();}
});

test('trusted fields may be reused across crops of this frame without surviving into the next read', async () => {
  const original={},corrected={},reader=new CardTextReader({now:()=>0});
  let pass=0;
  reader.readCrop=async(source,options)=>{
    if(source===original){
      assert.equal(options.cachedText.nameLines.length,0);
      return index.resolve({nameLines:[line('Suave Negotiator')]});
    }
    assert.deepEqual(options.cachedText.nameLines,[{text:'Suave Negotiator',confidence:96,partial:false}]);
    return index.resolve({nameLines:options.cachedText.nameLines,footerLines:[line(pass?'RAD SP1/005':'RAD 099/167')]});
  };
  const options={hint:cards[0],index,deadline:2000,alternativeCrops:[corrected]};
  const confirmed=await reader.read(original,options);
  assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.cardId,'suave');
  pass=1;
  assert.equal((await reader.read(original,options)).status,'conflict','A different crop cannot overwrite trusted conflicting text');
});

test('a reused OCR recipe reads both fields again and cannot reuse the previous identity or hide new conflicting text', async () => {
  let footer=false,calls=0,name='Suave Negotiator',code='RAD 099/167';
  const context={drawImage(){},fillRect(){},putImageData(){},
    getImageData:(_x,_y,width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4).fill(255)}),
    createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)})};
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>context})}}});
  const Reader=runtime.load('src/lib/cardTextReader.js').CardTextReader;
  const worker={setParameters:async settings=>{footer=Boolean(settings.tessedit_char_whitelist);},
    recognize:async()=>{
      calls++;const text=footer?code:name,bbox={x0:0,x1:220,y0:0,y1:50};
      return{data:{blocks:[{paragraphs:[{lines:[{text,confidence:96,bbox,words:[{text,confidence:96,bbox}]}]}]}]}};
    },terminate(){}};
  const reader=new Reader({now:()=>0,createWorker:async()=>worker});
  const canvas={width:500,height:700},options={hint:cards[0],index,deadline:2000};
  try{
    assert.equal((await reader.read(canvas,options)).status,'confirmed');assert.equal(calls,2);
    assert.ok(reader.recipe?.name?.region);assert.equal(JSON.stringify(reader.recipe).includes('Suave Negotiator'),false);
    const second=await reader.read(canvas,options);
    assert.equal(second.textLayout,'reused-regions');assert.equal(calls,4);
    name='Ahri';
    const conflict=await reader.read(canvas,options);assert.equal(conflict.status,'conflict');assert.equal(calls,6);
    code='RAD SP1/005';
    const changed=await reader.read(canvas,options);assert.equal(changed.status,'confirmed');assert.equal(changed.cardId,'ahri');assert.equal(calls,8);
    reader.dispose();assert.equal(reader.recipe,null);
  }finally{reader.dispose();}
});

test('a native padded camera crop starts with localized text instead of spending the budget on narrow legacy bands',async()=>{
  let footer=false,calls=0;
  const context={drawImage(){},fillRect(){},putImageData(){},getImageData:(_x,_y,width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4).fill(255)}),
    createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)})};
  const Reader=createRuntime({globals:{document:{createElement:()=>({getContext:()=>context})}}}).load('src/lib/cardTextReader.js').CardTextReader;
  const worker={setParameters:async settings=>{footer=Boolean(settings.tessedit_char_whitelist);},recognize:async()=>{
    calls++;const text=footer?'RAD 099/167':'Suave Negotiator',bbox={x0:0,x1:220,y0:0,y1:50};
    return{data:{blocks:[{paragraphs:[{lines:[{text,confidence:96,bbox,words:[{text,confidence:96,bbox}]}]}]}]}};},terminate(){}};
  const reader=new Reader({now:()=>0,createWorker:async()=>worker});
  try{
    const result=await reader.read({width:500,height:700,scanCardBounds:{x:.03,y:.03,width:.94,height:.94}},{hint:cards[0],index,deadline:2000});
    assert.equal(result.status,'confirmed');assert.equal(result.textLayout,'localized-first');assert.equal(calls,2);
  }finally{reader.dispose();}
});

test('matching text below the artwork minimum stays confirmed without a false conflict or acceptance', async () => {
  const lowRanked = [{card:cards[0],similarity:.875},{card:cards[1],similarity:.771}];
  const f=fixture();
  try {
    f.observe(1,{candidates:lowRanked});await tick();
    f.observe(2,{candidates:lowRanked});await tick();
    const proof=f.observe(3,{candidates:lowRanked});
    assert.equal(proof.status,'confirmed');
    const match=matchFromRanking(lowRanked);
    const result=applyTextVerification(buildRecognitionResult(match,quality,.9),match,proof);
    assert.equal(result.textVerification.status,'confirmed');
    assert.equal(result.reason,'text-artwork-insufficient');assert.equal(result.matched,false);
    assert.equal(result.similarity,.875);assert.equal(isReliableScanResult(result,.9),false);
    const badQuality={...quality,acceptable:false,issue:'blurred'};
    const blurred=applyTextVerification(buildRecognitionResult(match,badQuality,.9),match,proof);
    assert.equal(blurred.reason,'blurred');assert.equal(blurred.textVerification.status,'confirmed');
  } finally {f.verifier.dispose();}
});

test('authorized strong text and local detail can resolve a weak RGB score without changing the score or gap', () => {
  const match=matchFromRanking([{card:cards[0],similarity:.71,secondBestSim:.83,localStructureSimilarity:.62},ranked[1]]);
  const base=buildRecognitionResult(match,quality,.9),proof={...reading(),sourceFrameIds:[1,2]};
  const resolved=applyTextVerification(base,match,proof);
  assert.equal(isReliableScanResult(resolved,.9),true);assert.equal(resolved.similarity,.71);
  assert.equal(resolved.similarityGap,base.similarityGap);assert.equal(resolved.confirmationReason,'name-number-local-artwork');
  assert.equal(isReliableScanResult({...resolved,localStructureSimilarity:.54}),false);
  assert.equal(isReliableScanResult({...resolved,visualCandidates:[]}),false);
  for(const key of ['nameConfidence','codeConfidence'])assert.equal(isReliableScanResult({...resolved,textVerification:{...proof,[key]:89}}),false);
  assert.equal(applyTextVerification(base,match,{...proof,sourceFrameIds:[1]}).matched,false);
  assert.equal(isReliableScanResult({...resolved,quality:{acceptable:false}}),false);
});

test('recognition features start on for old profiles, live only in debug and reset when debug closes', () => {
  const runtime=createRuntime({storage:{riftbound_scanner_experiments:{perspective:false,textVerification:false}}});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);
  let scan=componentProps(app.render(),'ScanTab');
  assert.equal(scan.scannerExperiments.perspective,true);assert.equal(scan.scannerExperiments.textVerification,true);
  scan.onDebugChange(true);scan=componentProps(app.render(),'ScanTab');scan.onUpdateScannerExperiments({textVerification:false});
  assert.equal(componentProps(app.render(),'ScanTab').scannerExperiments.textVerification,false);
  componentProps(app.render(),'ScanTab').onDebugChange(false);
  assert.equal(componentProps(app.render(),'ScanTab').scannerExperiments.textVerification,true);
  componentProps(app.render(),'BottomTabBar').onTabChange('settings');
  const settings=componentProps(app.render(),'SettingsTab');assert.equal(settings.onUpdateMinConfidence,undefined);
  const view=runtime.mount(runtime.load('src/components/settings/SettingsTab.jsx').default);
  const tree=view.render({batchDefaults:{}});
  for(const label of ['Perspective correction','Card text verification'])assert.equal(nodes(tree,n=>n.props?.['aria-label']===label).length,0);
});

test('aligned corroboration retains real RGB scores and requires two text frames, bounded alignment and the same top-five card', () => {
  const alignment={dx:1,dy:0,overlap:.9375};
  const match=matchFromRanking([{card:cards[0],similarity:.72,secondBestSim:.81,localStructureSimilarity:.3,
    alignedArtworkSimilarity:.8,artworkAlignment:alignment},ranked[1]]);
  const base=buildRecognitionResult(match,quality,.9),proof={...reading(),sourceFrameIds:[1,2]};
  const result=applyTextVerification(base,match,proof);
  assert.equal(result.confirmationReason,'name-number-aligned-artwork');assert.equal(result.similarity,.72);
  assert.equal(result.similarityGap,base.similarityGap);assert.ok(result.similarityGap<0);
  assert.equal(isReliableScanResult(result,.9),true);
  for(const patch of [{alignedArtworkSimilarity:.64},{artworkAlignment:null},{artworkAlignment:{...alignment,dx:3}},{visualCandidates:[]},
    {textVerification:{...proof,sourceFrameIds:[1]}},{textVerification:{...proof,sourceFrameIds:[1,1]}},
    {textVerification:{...proof,nameConfidence:89}},{quality:{acceptable:false}}])assert.equal(isReliableScanResult({...result,...patch},.9),false);
});

test('a partial name run and an uncertain missing variant cannot veto the artwork', () => {
  const result=index.resolve({nameLines:[{...line('Ahri'),partial:true}],footerLines:[line('RAD 099/167')]});
  assert.equal(result.status,'unreadable');assert.deepEqual(result.nameCardIds,[]);
  assert.equal(reading('Chaos Rune','RAD R05').codeCardId,null);
});

test('a set filter cannot hide the physical card identity from text verification', async () => {
  const allIndex=new CardTextIndex([...cards,{...cards[0],id:'outside-filter',set:'VEN',code:'VEN-099/167'}]);
  const outside=allIndex.resolve({nameLines:[line('Suave Negotiator')],footerLines:[line('VEN 099/167')]});
  assert.equal(outside.cardId,'outside-filter');
  const f=fixture({read:async()=>outside});
  try{f.observe(1);await tick();assert.equal(f.observe(2).status,'conflict');}finally{f.verifier.dispose();}
});

test('photo evidence outside the visual candidates is visibly marked as conflicting', () => {
  const match=matchFromRanking(ranked);
  const result=applyTextVerification(buildRecognitionResult(match,quality,.9),match,
    {...reading(),status:'confirmed',cardId:'outside-filter',sourceFrameIds:['photo-1']},{photo:true});
  assert.equal(result.matched,false);assert.equal(result.textVerification.status,'conflict');
});

test('all four experiment combinations preserve independent crop and text behavior', async () => {
  const pixels=new Uint8ClampedArray(64*88*4).map((_,i)=>i%9?50:210);
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:pixels,width:64,height:88})})})}}});
  const {recognizeCard}=runtime.load('src/lib/cardRecognition.js');
  for(const perspective of [false,true])for(const text of [false,true]){
    let refinements=0;const source={width:300,height:420};const sampling=[];
    const matcher={ready:true,identify:(_crop,opts)=>{sampling.push(opts.areaSampling);return{card:cards[0],similarity:.98,secondBestSim:.8};},rank:(_crop,opts)=>{sampling.push(opts.areaSampling);return[{card:cards[0],similarity:.98},{card:cards[1],similarity:.8}];}};
    const recognized=await recognizeCard({source,detection:{box:{},cropCanvas:source},matcher,candidates:text,
      cropRefiner:perspective?async()=>{refinements++;return{status:'uncertain',reason:'test-fallback'};}:null});
    assert.equal(recognized.match.card.id,'suave');assert.equal(refinements,perspective?1:0);
    assert.equal(Boolean(recognized.match.candidates),text);assert.equal(recognized.crop,source);
    assert.ok(sampling.every(value=>value===(perspective||text)));
  }
});

test('auto-scan reuses fresh pending visual frames without inflating the real candidate gap', async () => {
  for(const entries of [ranked,[{...ranked[0],similarity:.71,secondBestSim:.83,localStructureSimilarity:.7},ranked[1]],
    [{...ranked[0],similarity:.71,secondBestSim:.83,localStructureSimilarity:.3,alignedArtworkSimilarity:.8,artworkAlignment:{dx:1,dy:0,overlap:.9375}},ranked[1]]]){
  let now=0, interval, current; const accepted=[];
  const runtime=createRuntime({globals:{Date:class extends Date{static now(){return now;}},setInterval:fn=>{interval=fn;return 1;}}});
  const hook=runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan,[true]);
  hook.render({cameraIsActive:true,isProcessing:false,captureFrame:()=>({}),detectSingleFrame:async()=>current,onCardDetected:r=>{accepted.push(r);return true;}});
  const cleanup=hook.runEffects();
  const match=matchFromRanking(entries), base=buildRecognitionResult(match,quality,.9);
  const run=async(id,status)=>{now=id*250;current={...applyTextVerification(base,match,status==='confirmed'
    ?{...reading(),status,cardId:'suave',sourceFrameIds:[1,2]}:{status,reason:'reading-text'}),
    frameId:id,capturedAt:now,confidence:.95,recognitionEpoch:'session-1'};await interval();};
  try{await run(1,'pending');await run(2,'pending');assert.equal(accepted.length,0);await run(3,'confirmed');assert.equal(accepted.length,1);
    assert.ok(accepted[0].similarityGap<.05);assert.equal(accepted[0].frameId,3);await run(4,'confirmed');assert.equal(accepted.length,1);
  }finally{cleanup.forEach(fn=>fn?.());}
  }
});

test('slow camera inference cannot starve artwork acceptance between repeated OCR deadlines', async () => {
  let now=0,interval,current;const accepted=[];
  const runtime=createRuntime({globals:{Date:class extends Date{static now(){return now;}},setInterval:fn=>{interval=fn;return 1;}}});
  const Verifier=runtime.load('src/lib/cardTextVerification.js').CardTextVerification;
  const verifier=new Verifier({read:async()=>index.resolve({})});
  const hook=runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan,[true]);
  hook.render({cameraIsActive:true,isProcessing:false,captureFrame:()=>({}),detectSingleFrame:async()=>current,
    onCardDetected:r=>{accepted.push(r);return true;}});
  const cleanup=hook.runEffects();
  const match=matchFromRanking([{card:cards[0],similarity:.94},{card:cards[1],similarity:.8}]);
  try {
    for(let id=1;id<=12;id++){
      const capturedAt=(id-1)*900;now=capturedAt+600;
      const base={...buildRecognitionResult(match,quality,.9),frameId:id,capturedAt,confidence:.95};
      const proof=verifier.observe(base,{}, {frame:{},context:'camera',index,candidates:match.candidates});
      current={...applyTextVerification(base,match,proof),recognitionEpoch:`camera:${proof.trackId}`};
      await interval();await tick();
      if(accepted.length)break;
    }
    assert.equal(accepted.length,1);
    assert.ok(now<=3600,`Artwork fallback was starved for ${now}ms`);
    assert.deepEqual(Array.from(accepted[0].autoScanConsensus.sourceFrameIds),[2,3,4]);
    assert.equal(accepted[0].confirmationMethod,'artwork');assert.equal(accepted[0].similarity,.94);
  } finally {verifier.dispose();cleanup.forEach(fn=>fn?.());}
});

test('OCR loading is bounded per job and explicit disposal prevents a late worker from returning', async () => {
  let initialize, terminated=0;
  const runtime=createRuntime({globals:{setTimeout,clearTimeout}});
  const Reader=runtime.load('src/lib/cardTextReader.js').CardTextReader;
  const reader=new Reader({createWorker:(_lang,_oem,options)=>{
    assert.match(options.workerPath,/^http:\/\/localhost\/ocr\//);assert.equal(options.cacheMethod,'none');
    return new Promise(resolve=>{initialize=resolve;});
  }});
  await assert.rejects(reader.read({}, {hint:cards[0],index,deadline:Date.now()+25}),/cancelled/);
  reader.dispose();
  initialize({terminate:async()=>{terminated++;}});await tick();
  assert.equal(terminated,1);assert.equal(reader.worker,null);reader.dispose();
});

test('a timed-out card job can leave shared initialization warm for a later fresh card', async () => {
  let initialize,terminated=0;
  const Reader=createRuntime({globals:{setTimeout,clearTimeout}}).load('src/lib/cardTextReader.js').CardTextReader;
  const reader=new Reader({createWorker:()=>new Promise(resolve=>{initialize=resolve;})});
  await assert.rejects(reader.read({}, {hint:cards[0],index,deadline:Date.now()+25}),/cancelled/);
  const worker={terminate:async()=>{terminated++;}};initialize(worker);await tick();
  assert.equal(await reader.ensureReady(),worker);assert.equal(terminated,0);
  reader.dispose();assert.equal(terminated,1);
});

function manualFixture() {
  let finish, calls=0;
  const runtime=createRuntime({mocks:{
    'src/hooks/useCamera.js':{useCamera:()=>({isActive:true,captureFrame:()=>({}),stopCamera(){}})},
    'src/hooks/useCardDetection.js':{useCardDetection:()=>({isProcessing:false,detectSingleFrame:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}})},
  }});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);
  const scan=()=>componentProps(app.render(),'ScanTab');
  return {scan,app,get calls(){return calls;},complete(result={cardData:cards[0],matched:true,similarity:.99,similarityGap:.1,quality,confidence:.99}){finish(result);}};
}

test('an uncertain manual scan requires an explicit candidate choice and cancellation adds nothing', async () => {
  const f=manualFixture(),candidate={...cards[0],similarity:.71};
  const weak={cardData:cards[0],matched:false,similarity:.71,similarityGap:-.12,quality,reviewCandidates:[candidate]};
  let job=f.scan().onSnapScan();f.complete(weak);await job;
  assert.equal(f.scan().pendingCards.length,0);
  componentProps(f.app.render(),'ManualScanReview').onClose();assert.equal(f.scan().pendingCards.length,0);
  job=f.scan().onSnapScan();f.complete(weak);await job;
  componentProps(f.app.render(),'ManualScanReview').onSelect(candidate);
  assert.equal(f.scan().pendingCards.length,1);assert.equal(f.scan().pendingCards[0].similarity,.71);
  assert.equal(f.scan().pendingCards[0].manualAdded,true);
});

test('repeated manual taps cannot start overlapping recognition or add duplicate copies', async () => {
  const f=manualFixture();const first=f.scan().onSnapScan();await f.scan().onSnapScan();assert.equal(f.calls,1);
  f.complete();await first;assert.equal(f.scan().pendingCards.length,1);assert.equal(f.scan().pendingCards[0].quantity,1);
});

test('a manual tap cannot bypass the auto-scan duplicate lock', async () => {
  const f=manualFixture();f.scan().onToggleAutoScan();assert.equal(f.scan().autoScanEnabled,true);
  await f.scan().onSnapScan();assert.equal(f.calls,0);
});

test('a camera tap cannot queue a second card while debug auto-scan owns the camera', async () => {
  const f=manualFixture();f.scan().onDebugChange(true);assert.equal(f.scan().debugEnabled,true);
  await f.scan().onSnapScan();assert.equal(f.calls,0);assert.equal(f.scan().pendingCards.length,0);
});
