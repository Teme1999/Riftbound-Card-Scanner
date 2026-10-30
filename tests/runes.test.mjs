import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { buildRuneArtworkProof, hasRuneArtwork, resolveRuneText, strongRegisteredRuneArtwork } from '../src/lib/cardRuneVerification.js';
import { CardTextIndex } from '../src/lib/cardTextIdentity.js';
import { CardTextVerification } from '../src/lib/cardTextVerification.js';
import { buildRecognitionResult, applyTextVerification } from '../src/lib/cardRecognition.js';
import { assessScanAcceptance } from '../src/lib/scanAcceptance.js';
import { prepareTextPixels } from '../src/lib/cardTextImage.js';
import { createRuntime } from './helpers/runtime.mjs';
import { registeredCardQuad, nativeRegistrationScale } from '../src/lib/cardArtworkRegistration.js';
import { cardHomography } from '../src/lib/cardPerspective.js';

const cards=[{id:'rad-base',set:'RAD',name:'Order Rune',type:'rune',code:'RAD-R06'},
  {id:'rad-alt',set:'RAD',name:'Order Rune',type:'rune',code:'RAD-R06a'},
  {id:'ogn-base',set:'OGN',name:'Order Rune',type:'rune',code:'OGN-214/298'}];
const geometry={good:90,inliers:80,ratio:.9,coverage:.55,referenceCoverage:.5,spanX:.8,spanY:.8,error:.8,validProjection:true};
const comparisons=[{...geometry,id:'rad-base'},{id:'rad-alt',inliers:8},{...geometry,id:'ogn-base'}];
const artwork=id=>buildRuneArtworkProof(comparisons,cards,id),index=new CardTextIndex(cards);
const lines=(text,confidence=96)=>[{text,confidence}];
const read=(id,patch={})=>resolveRuneText(index,{nameLines:lines('Order Rune'),setLines:lines('RAD'),artwork:artwork(id),...patch});
const pair=()=>({...read(2),sourceFrameIds:[1,2],sourceArtwork:[1,2].map(id=>({frameId:id,proof:artwork(id)}))});
const match={card:cards[0],similarity:.65,secondBestSim:.8,candidates:cards.map(card=>({card,similarity:.65,secondBestSim:.8}))};
const observation=id=>buildRecognitionResult(match,{acceptable:true,score:.9},.9,{frameId:id,capturedAt:id*200,confidence:.99,
  requiresTextConfirmation:true,visualVerification:artwork(id)});

test('rune set text resolves shared art across sets without inventing a collector reading',()=>{
  const r=read(1);assert.equal(r.status,'confirmed');assert.equal(r.cardId,'rad-base');assert.equal(r.readSet,'RAD');assert.equal(r.codeConfidence,0);assert.equal(r.code,'');
  const foreign=read(1,{setLines:lines('OGN')});assert.equal(foreign.cardId,'ogn-base');
  assert.equal(hasRuneArtwork(artwork(1),'rad-base',2),false);
});

test('same-set rune ambiguity and missing printing references always require a full code',()=>{
  const ambiguous=buildRuneArtworkProof([comparisons[0],{...geometry,id:'rad-alt'},comparisons[2]],cards,1);
  assert.equal(read(1,{artwork:ambiguous}).reason,'rune-printing-needs-full-code');
  const missing=buildRuneArtworkProof([comparisons[0],comparisons[2]],cards,1);
  assert.equal(missing.completeFamily,false);assert.equal(read(1,{artwork:missing}).status,'unreadable');
  const maskedRival=buildRuneArtworkProof([comparisons[0],{id:'rad-alt',inliers:8,maxInliers:75},comparisons[2]],cards,1);
  assert.equal(read(1,{artwork:maskedRival}).status,'unreadable','A weaker mask cannot hide the other mask\'s strong rival');
  assert.equal(index.resolve({nameLines:lines('Order Rune'),footerLines:lines('RAD R06')}).reason,'variant-unclear');
});

test('rune reading requires every name character and a high-confidence complete set token',()=>{
  for(const patch of [{nameLines:lines('Order')},{nameLines:lines('Rune')},{nameLines:lines('Order Rune',89)},
    {setLines:lines('RA')},{setLines:lines('RAD',89)},{setLines:[]},{artwork:null}])assert.notEqual(read(1,patch).status,'confirmed');
  assert.equal(read(1,{setLines:[...lines('RAD'),...lines('OGN')]}).status,'conflict');
  const extra=new CardTextIndex([...cards,{id:'body',name:'Body Rune',type:'rune',set:'RAD',code:'RAD-R04'}]);
  assert.equal(resolveRuneText(extra,{nameLines:[...lines('Order Rune'),...lines('Body Rune')],setLines:lines('RAD'),artwork:artwork(1)}).status,'conflict');
  assert.equal(read(1,{nameLines:[{text:'Order Rune',confidence:96,partial:true}]}).status,'confirmed','Only the complete rune title is accepted from a high-confidence word run');
});

test('rune joint acceptance keeps original scores and needs two independent name/set proofs',()=>{
  const proof=pair();
  const result=applyTextVerification(observation(3),match,proof);
  assert.equal(result.matched,true);assert.equal(result.acceptanceDecision.path,'rune-name-set-artwork');
  assert.equal(result.similarity,.65);assert.ok(result.similarityGap<0);assert.equal(result.textVerification.codeConfidence,0);
  assert.equal(assessScanAcceptance({...result,visualVerification:null}).eligible,true,'The two actual OCR source geometries survive a weak later visual observation');
  for(const patch of [{quality:{acceptable:false}},{geometryConflict:true},{cardData:{...cards[0],type:'unit'}},
    {textVerification:{...proof,sourceArtwork:undefined}},{textVerification:{...proof,sourceArtwork:[{frameId:1,proof:artwork(2)}]}},
    {textVerification:{...proof,sourceArtwork:[{frameId:1,proof:artwork(1)},{frameId:2,proof:buildRuneArtworkProof([comparisons[0],{...geometry,id:'rad-alt'},comparisons[2]],cards,2)}]}},
    {textVerification:{...proof,setConfidence:undefined}},{textVerification:{...proof,setConfidence:89}},
    {textVerification:{...proof,sourceFrameIds:[1,1]}},{textVerification:{...proof,sourceFrameIds:[NaN,2]}},
    {textVerification:{...proof,readSet:'OGN'}},{textVerification:{...proof,status:'conflict'}}])assert.equal(assessScanAcceptance({...result,...patch}).eligible,false);
});

test('Rune OCR gets geometry from its own frame; mixed proof types cannot manufacture two full code readings',async()=>{
  let now=0;const jobs=[];
  const verifier=new CardTextVerification({read:(_crop,options)=>new Promise(resolve=>jobs.push({resolve,options}))},{now:()=>now});
  const frame={scanMotionContext:{epoch:1},scanMotionEpoch:1};
  const observe=id=>{now=id*200;return verifier.observe(observation(id),{}, {frame,context:'camera',index,candidates:match.candidates});};
  try{
    observe(1);await tick();assert.equal(jobs[0].options.runeArtwork.sourceFrameId,1);jobs[0].resolve(read(1));await tick();
    observe(2);await tick();jobs[1].resolve({...read(2),evidenceType:undefined,codeConfidence:96,code:'RAD R06',artworkSourceFrameId:undefined});await tick();
    assert.notEqual(observe(3).status,'confirmed','One rune set proof is not a second full code proof');await tick();
    jobs[2].resolve(read(99));await tick();assert.notEqual(observe(4).status,'confirmed','Late geometry from another source cannot confirm');
  }finally{verifier.dispose();jobs.forEach(job=>job.resolve({status:'unreadable'}));await tick();}
});

test('rune auto-scan uses actual waiting visual frames and preserves the same-card lock',async()=>{
  let now=0,run,result;const accepted=[];
  const runtime=createRuntime({globals:{Date:class extends Date{static now(){return now;}},setInterval:fn=>{run=fn;return 1;}}});
  const mounted=runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan);
  mounted.render({cameraIsActive:true,isProcessing:false,debugEnabled:true,captureFrame:()=>({}),detectSingleFrame:async()=>result,onCardDetected:r=>{accepted.push(r);return true;}});
  const cleanups=mounted.runEffects();
  const frame=id=>({...applyTextVerification(observation(id),match,{status:'pending'}),recognitionEpoch:'same-rune'});
  const step=async r=>{result=r;now+=200;await run();};
  try{
    await step(frame(1));await step(frame(2));assert.equal(accepted.length,0);
    const confirmed=id=>({...applyTextVerification({...observation(id),visualVerification:null},match,pair()),recognitionEpoch:'same-rune'});
    await step(confirmed(3));assert.equal(accepted.length,1);assert.equal(accepted[0].confirmationMethod,'rune-text');
    await step(confirmed(4));assert.equal(accepted.length,1);
  }finally{cleanups.forEach(fn=>fn?.());}
});

test('rune OCR skips unsupported geometry and rejects late evidence after motion changes',async()=>{
  let now=0;const jobs=[];
  const verifier=new CardTextVerification({read:(_crop,options)=>new Promise(resolve=>jobs.push({options,resolve}))},{now:()=>now});
  const motion={epoch:1},frame={scanMotionContext:motion,scanMotionEpoch:1};
  const observe=(id,proof=artwork(id))=>{now=id*200;return verifier.observe({...observation(id),visualVerification:proof},{},{frame,context:'camera',index,candidates:match.candidates});};
  try{
    const weak=buildRuneArtworkProof(comparisons.map(c=>({...c,inliers:5})),cards,1);
    assert.equal(observe(1,weak).reason,'rune-artwork-insufficient');await tick();assert.equal(jobs.length,0);
    observe(2);await tick();motion.epoch=frame.scanMotionEpoch=2;observe(3);await tick();
    assert.equal(jobs[0].options.signal.aborted,true);jobs[0].resolve(read(2));await tick();
    assert.equal(verifier.verdict().confirmedReads,0);
    jobs[1].resolve(read(3));await tick();assert.notEqual(observe(4).status,'confirmed');
  }finally{verifier.dispose();jobs.forEach(job=>job.resolve({status:'unreadable'}));await tick();}
});

test('rune cancellation discards the reply without restarting warm OCR; its deadline still terminates a stuck job',async()=>{
  const Reader=createRuntime({globals:{setTimeout,clearTimeout}}).load('src/lib/cardTextReader.js').CardTextReader;
  let finish,terminated=0;const reader=new Reader();reader.worker={terminate:async()=>{terminated++;}};
  reader.readWithinBudget=()=>new Promise(resolve=>{finish=resolve;});
  const abort=new AbortController();
  const pending=reader.read({}, {hint:cards[0],index,runeArtwork:artwork(1),signal:abort.signal,deadline:Date.now()+2000});
  const cancelled=assert.rejects(pending,/cancelled/);abort.abort();assert.equal(terminated,0);
  finish(read(1));await cancelled;assert.equal(terminated,0);
  await assert.rejects(reader.read({}, {hint:cards[0],index,runeArtwork:artwork(2),deadline:Date.now()+25}),/cancelled/);
  assert.equal(terminated,1);finish(read(2));reader.dispose();
});

test('an exact full collector reading can resolve same-set rune ambiguity with strong source geometry',()=>{
  const ambiguous=buildRuneArtworkProof([comparisons[0],{...geometry,id:'rad-alt'},comparisons[2]],cards,3);
  const result=applyTextVerification({...observation(3),visualVerification:ambiguous},match,
    {status:'confirmed',cardId:'rad-base',nameConfidence:96,codeConfidence:96,code:'RAD-R06',sourceFrameIds:[1,2]});
  assert.equal(result.matched,true);assert.equal(result.confirmationMethod,'text');
  assert.equal(assessScanAcceptance({...result,visualVerification:null}).eligible,false);
});

test('smooth rune artwork can use registered pixels only with two real name/set reads and separated printing appearance',()=>{
  const dense={registeredGeometry:{inliers:28,ratio:.8,error:1,validProjection:true},
    registeredArtwork:{correlation:.7,validCoverage:.9,tilesCompared:12,tilesMatched:6,outerTilesMatched:2,columnsMatched:4,rowsMatched:2}};
  const entries=[{id:'rad-base',inliers:28,...dense},{id:'rad-alt',inliers:15,registeredArtwork:{correlation:.3}},{id:'ogn-base',inliers:28,...dense}];
  const proof=id=>buildRuneArtworkProof(entries,cards,id);
  assert.equal(hasRuneArtwork(proof(1),'rad-base',1),true);
  const result=applyTextVerification({...observation(3),visualVerification:proof(3)},match,{...read(2),sourceFrameIds:[1,2],sourceArtwork:[1,2].map(id=>({frameId:id,proof:proof(id)}))});
  assert.equal(result.matched,true);assert.equal(result.similarity,.65);
  assert.equal(buildRecognitionResult(match,{acceptable:true},.9,{frameId:3,visualVerification:proof(3),requiresTextConfirmation:true}).matched,false);
  const tied=buildRuneArtworkProof([entries[0],{...entries[1],registeredArtwork:{correlation:.6}},entries[2]],cards,1);
  assert.equal(hasRuneArtwork(tied,'rad-base',1),false);
  for(const patch of [{correlation:.44},{validCoverage:.74},{tilesCompared:7},{tilesMatched:3},{outerTilesMatched:0},{columnsMatched:2},{rowsMatched:1},{correlation:NaN}])
    assert.equal(strongRegisteredRuneArtwork({...dense,registeredArtwork:{...dense.registeredArtwork,...patch}}),false);
  assert.equal(strongRegisteredRuneArtwork({...dense,registeredGeometry:{...dense.registeredGeometry,inliers:19}}),false);
});

test('rune title polarity is selected from the lettering band, leaving the normal preprocessing unchanged',()=>{
  const width=80,height=80,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const ink=y>=35&&y<46&&x>=15&&x<65&&x%8<3;const value=y>=30&&y<52&&!ink?230:20;data.set([value,value,value,255],(y*width+x)*4);}
  const r=prepareTextPixels({width,height,data},{localizedPolarity:true});
  const glyph=r.image.data[(40*width+16)*4],background=r.image.data[(40*width+22)*4];
  assert.ok(glyph<background);assert.ok(r.rows.top<=35&&r.rows.top+r.rows.height>=46);
});

test('alternate rune color preprocessing separates existing gold ink from illustration without changing default pixels',()=>{
  const sample=()=>({width:5,height:1,data:new Uint8ClampedArray([207,166,55,255,20,100,40,255,30,60,120,255,200,40,20,255,255,255,255,255])});
  const r=prepareTextPixels(sample(),{goldInk:true,legacy:true});
  assert.equal(r.image.data[0],0);for(let i=1;i<5;i++)assert.equal(r.image.data[i*4],255);
  const normal=prepareTextPixels(sample(),{legacy:true});assert.notEqual(normal.image.data[0],0);
});

test('artwork registration maps native card corners and cannot manufacture source text resolution',()=>{
  const identity=[1,0,0,0,1,0,0,0,1],original={width:630,height:880},padded={width:680,height:930};
  const quad=registeredCardQuad(identity,original,padded);assert.equal(quad.length,4);
  for(const [i,expected] of [[0,[25,25]],[1,[655,25]],[2,[655,905]],[3,[25,905]]]){
    assert.ok(Math.abs(quad[i].x-expected[0])<1);assert.ok(Math.abs(quad[i].y-expected[1])<1);
  }
  for(const bad of [[],Array(9).fill(0),[1,0,900,0,1,0,0,0,1],[NaN,...identity.slice(1)]])assert.equal(registeredCardQuad(bad,original,padded),null);
  const matrix=cardHomography([{x:0,y:0},{x:100,y:0},{x:100,y:200},{x:0,y:200}]),region={x:.015,y:.92,width:.13,height:.075};
  assert.equal(nativeRegistrationScale({height:401,scanRegistration:{matrix}},region),.5);
  assert.equal(nativeRegistrationScale({height:101,scanRegistration:{matrix}},region),1);
  assert.equal(nativeRegistrationScale({},region),1);
});

test('the perspective override independently controls artwork-aligned rune text crops',async()=>{
  let calls=0;const original={width:300,height:420},registered={width:300,height:420};
  const context={drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(64*88*4).map((_,i)=>i%9?50:210),width:64,height:88})};
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>context})}},
    mocks:{'src/lib/cardArtworkRegistration.js':{rectifyArtworkTextCrop:()=>{calls++;return registered;}}}});
  const recognize=runtime.load('src/lib/cardRecognition.js').recognizeCard;
  const options={source:{frameId:1},detection:{cropCanvas:original},matcher:{ready:true},candidates:true,
    visualVerifier:{verify:async()=>({proof:artwork(1),runeMatch:match})}};
  const off=await recognize({...options,cropRefiner:null});assert.equal(calls,0);assert.equal(off.textCrop,original);
  const on=await recognize({...options,cropRefiner:()=>{}});assert.equal(calls,1);assert.equal(on.textCrop,registered);assert.equal(on.alternateTextCrops[0],original);
});

test('a registered-text fallback reports the original padded crop accurately',async()=>{
  const Reader=createRuntime().load('src/lib/cardTextReader.js').CardTextReader,reader=new Reader();
  const registered={scanRegistration:{matrix:[]}},padded={scanCardBounds:{x:.04,y:.04,width:.92,height:.92}};
  reader.readCrop=async source=>source===registered?{status:'unreadable',nameConfidence:0,codeConfidence:0}:read(1);
  const result=await reader.readWithinBudget(registered,{hint:cards[0],index,deadline:Date.now()+2000,alternativeCrops:[padded]});
  assert.equal(result.status,'confirmed');assert.equal(result.textCropMethod,'obb+margin');reader.dispose();
});
