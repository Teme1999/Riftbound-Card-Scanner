import test from 'node:test';
import assert from 'node:assert/strict';
import { strongVisualGeometry, selectVisualProof, visualIdentityAmbiguities, hasStrongVisualProof, canReuseVisualBox } from '../src/lib/cardVisualProof.js';
import { assessScanAcceptance } from '../src/lib/scanAcceptance.js';
import { createRuntime } from './helpers/runtime.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeCspOpenCv } from '../scripts/opencv-csp.mjs';
import { verifyVisualRuntime } from './helpers/visual-csp-runtime.mjs';
import { loadVisualReference } from '../src/lib/cardVisualReference.js';

const card={id:'rad-099',name:'Suave Negotiator'};
const geometry={id:card.id,good:70,inliers:60,ratio:.85,coverage:.55,referenceCoverage:.51,spanX:.8,spanY:.8,error:.8,validProjection:true};
const proof=(frameId=1)=>selectVisualProof([geometry,{id:'other',inliers:7}],{frameId,uniqueIdentity:true});
const frame=(id)=>({cardData:card,frameId:id,capturedAt:id*100,confidence:.99,similarity:.76,similarityGap:.01,
  minSimilarity:.9,quality:{acceptable:true,score:.9},matched:true,visualVerification:proof(id),recognitionEpoch:'camera:1',
  textVerification:{status:'pending',sourceFrameIds:[]}});

test('a detector proposal cannot use coarse artwork alone, even with very high similarity',()=>{
  const coarse={...frame(1),detectorProposal:true,similarity:.99,similarityGap:.20,
    visualVerification:undefined,textVerification:undefined};
  assert.equal(assessScanAcceptance(coarse).reason,'detector-unconfirmed');
  assert.equal(assessScanAcceptance({...coarse,detectorProposal:false}).eligible,true);
  const verified={...coarse,visualVerification:proof(1)};
  assert.equal(assessScanAcceptance(verified).path,'verified-artwork-geometry');
  assert.equal(verified.similarity,.99);
  assert.equal(assessScanAcceptance({...verified,quality:{acceptable:false}}).eligible,false);
  assert.equal(assessScanAcceptance({...verified,textVerification:{status:'conflict'}}).eligible,false);
});

test('unique alternate rune art uses global printing geometry; shared art and hidden rivals still need text',async()=>{
  const alt={id:'rad-alt',name:'Order Rune',type:'rune',set:'RAD'},
    base={id:'rad-base',name:alt.name,type:'rune',set:'RAD'},
    foreign={id:'ogn-base',name:alt.name,type:'rune',set:'OGN'},
    background={id:'background',name:'Other Card',set:'RAD'};
  const ranked=[alt,background].map(card=>({card,similarity:.71,secondBestSim:.8}));
  const family=[alt,base,foreign].map(card=>({card,similarity:.71,secondBestSim:.8}));
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>({drawImage(){},
    getImageData:()=>({data:new Uint8ClampedArray(4)})})})}}});
  const {CardVisualVerifier}=runtime.load('src/lib/cardVisualVerifier.js');
  for(const scenario of ['unique','shared','other-mask','missing','foreign-winner','near-art-outside-family']){
    const all=[alt,base,foreign,background];
    if(scenario==='near-art-outside-family'){
      alt.f=new Float32Array([.1,.2,.4,.8,.3,.2]);
      all.push({id:'hidden-lookalike',name:'Different Name',f:new Float32Array(alt.f),set:'VEN'});
    }else delete alt.f;
    const verifier=new CardVisualVerifier();verifier.ready=true;const requests=[];
    verifier.request=async data=>{requests.push(data);return {workerMs:1,comparisons:data.candidates
      .filter(c=>scenario!=='missing'||c.id!==foreign.id).map(c=>{
        if(c.id===alt.id)return {...geometry,id:c.id};
        if(scenario==='foreign-winner'&&c.id===foreign.id)return {...geometry,id:c.id,inliers:100};
        return {id:c.id,inliers:scenario==='shared'&&c.id===foreign.id?60:3,
          maxInliers:scenario==='other-mask'&&c.id===base.id?55:3};
      })};};
    const result=await verifier.verify({width:630,height:880},{matcher:{cards:all,
      rank:(_crop,options)=>options.requiredIds?family:ranked},setFilter:['RAD'],frameId:1});
    assert.equal(requests.length,2);
    assert.ok(requests[1].candidates.some(c=>c.id===foreign.id));
    if(scenario==='unique'){
      assert.equal(result.proof.status,'verified');assert.equal(result.match.card.id,alt.id);
      assert.equal(result.match.similarity,.71);assert.equal(result.match.secondBestSim,.8);
      assert.equal(result.proof.printingIdentity,'compared');
    }else{
      assert.notEqual(result.proof.status,'verified',scenario);assert.equal(result.match,undefined,scenario);
    }
  }
});

test('the shipped WASM extractor verifies an actual projective image and rejects an unrelated one',async()=>{
  const cv=(await import('@techstark/opencv-js')).default;
  await verifyVisualRuntime(cv);
});

test('the pinned OpenCV adapter runs actual matching with all JavaScript code generation disabled',async()=>{
  const source=await fs.readFile(new URL('../node_modules/@techstark/opencv-js/dist/opencv.js',import.meta.url),'utf8');
  assert.throws(()=>makeCspOpenCv(source+'\n'),/source changed/);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'riftbound-csp-')),file=path.join(directory,'opencv.cjs');
  try{
    await fs.writeFile(file,makeCspOpenCv(source));
    const child=spawnSync(process.execPath,['--disallow-code-generation-from-strings',fileURLToPath(new URL('./helpers/visual-csp-runtime.mjs',import.meta.url)),file],{encoding:'utf8',timeout:30000});
    assert.equal(child.status,0,child.stderr||child.stdout);
    const cv=(await import('@techstark/opencv-js')).default;
    assert.deepEqual(JSON.parse(child.stdout),await verifyVisualRuntime(cv),'Static bindings preserve the upstream matching result');
  }finally{await fs.rm(file,{force:true});await fs.rmdir(directory);}
});

test('keypoint geometry is independent of coarse scores and can bypass pending OCR',()=>{
  const result=frame(1),decision=assessScanAcceptance(result);
  assert.equal(decision.eligible,true);assert.equal(decision.path,'verified-artwork-geometry');
  assert.equal(result.similarity,.76);assert.equal(result.similarityGap,.01);
  for(const patch of [{quality:{acceptable:false,issue:'blurred'}},{geometryConflict:true},{textVerification:{status:'conflict'}},
    {frameId:2},{cardData:{id:'other'}},{visualVerification:{...proof(),uniqueIdentity:false}},
    {visualVerification:{...proof(),allReferencesAvailable:false}}])assert.equal(assessScanAcceptance({...result,...patch}).eligible,false);
});

test('clustered, weak, reflected, or ambiguous correspondences cannot verify identity',()=>{
  for(const patch of [{inliers:31},{ratio:.64},{coverage:.19},{referenceCoverage:.19},{spanX:.39},{spanY:.39},{error:1.6},{validProjection:false},
    {error:NaN},{coverage:NaN}])assert.equal(strongVisualGeometry({...geometry,...patch}),false);
  for(const options of [{uniqueIdentity:false},{allReferencesAvailable:false},{frameId:null}])
    assert.equal(selectVisualProof([geometry,{id:'b',inliers:2}],{frameId:1,uniqueIdentity:true,...options}).status,'unconfirmed');
  assert.equal(selectVisualProof([geometry,{id:'b',inliers:40}],{frameId:1,uniqueIdentity:true}).status,'unconfirmed');
  assert.equal(selectVisualProof([geometry],{frameId:1,uniqueIdentity:true}).status,'unconfirmed');
});

test('printing guards inspect other sets and preserve same-art or same-name ambiguity',()=>{
  const f=new Float32Array([0,.1,.3,.2,.9,.4,.8,.4,.1]);
  const base={...card,f};
  assert.deepEqual(visualIdentityAmbiguities(base,[base,{id:'other-set',name:'SUAVE  Negotiator!',set:'OGN'}]),['other-set']);
  assert.deepEqual(visualIdentityAmbiguities(base,[base,{id:'same-art',name:'A different name',f:new Float32Array(f)}]),['same-art']);
  assert.deepEqual(visualIdentityAmbiguities(base,[base,{id:'different',name:'Different Card',f:new Float32Array([.8,.1,.2,.1,.3,.8,.1,.8,.9])}]),[]);
  assert.deepEqual(visualIdentityAmbiguities({id:'nameless'},[]),['missing-name']);
});

test('a missing or undecodable cached image uses only that card\'s bundled reference',async()=>{
  const entry={id:'ven-r06',url:'asset:missing.webp',fallbackUrl:'http://localhost/cards/ven-r06.webp'},calls=[];
  const bitmap={close(){}};
  for(const failure of ['missing','fetch','decode']){
    calls.length=0;
    const result=await loadVisualReference(entry,{fetcher:async url=>{
      calls.push(url);if(url===entry.url&&failure==='fetch')throw new Error('Failed to fetch');
      return {ok:url!==entry.url||failure==='decode',status:404,blob:async()=>url};
    },decode:async blob=>{if(blob===entry.url)throw new Error('Invalid image');return bitmap;}});
    assert.equal(result.bitmap,bitmap);assert.equal(result.source,'bundled-fallback');assert.deepEqual(calls,[entry.url,entry.fallbackUrl]);
  }
  await assert.rejects(loadVisualReference(entry,{fetcher:async()=>({ok:false,status:404})}),error=>error.referenceId==='ven-r06');
});

test('same-name printings require actual geometry against every hidden rival; identical art still needs text',async()=>{
  const base={...card,set:'RAD'},alternate={id:'other-printing',name:card.name,set:'OGN'},background={id:'background',name:'Different',set:'RAD'};
  const ranked=[base,background].map(card=>({card,similarity:.75,secondBestSim:.8}));
  const all=[...ranked,{card:alternate,similarity:.7,secondBestSim:.8}];
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)})})})}}});
  const {CardVisualVerifier}=runtime.load('src/lib/cardVisualVerifier.js');
  const matcher={cards:[base,alternate,background],rank:(_crop,options)=>options.requiredIds?all:ranked};
  for(const [rival,expected] of [[4,'verified'],[60,'unconfirmed'],[null,'unconfirmed']]){
    const verifier=new CardVisualVerifier();verifier.ready=true;const requests=[];
    verifier.request=async data=>{requests.push(data);return {workerMs:10,comparisons:data.candidates.filter(c=>rival!==null||c.id!==alternate.id).map(c=>
      c.id===base.id?{...geometry,id:base.id}:c.id===alternate.id?{...geometry,id:c.id,inliers:rival}:{id:c.id,inliers:1})};};
    const result=await verifier.verify({width:720,height:1000},{matcher,setFilter:['RAD'],frameId:1});
    assert.equal(result.proof.status,expected);assert.equal(requests.length,2);
    assert.ok(requests[1].candidates.some(c=>c.id===alternate.id),'The set filter cannot hide a printing rival');
    assert.ok(requests[1].candidates.every(c=>c.fallbackUrl.endsWith('/cards/'+c.id+'.webp')));
    if(expected==='verified'){assert.equal(result.match.card.id,base.id);assert.equal(result.match.similarity,.75);assert.equal(result.proof.printingIdentity,'compared');}
    else assert.equal(result.match,undefined);
  }
});

test('fast visual consensus needs two fresh verified sources; motion, conflict and duplicates cannot bypass it',async()=>{
  let now=0,run,result;const accepted=[];
  const runtime=createRuntime({globals:{Date:class extends Date{static now(){return now;}},setInterval:fn=>{run=fn;return 1;}}});
  const mounted=runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan);
  mounted.render({cameraIsActive:true,isProcessing:false,debugEnabled:true,captureFrame:()=>({}),
    detectSingleFrame:async()=>result,onCardDetected:r=>{accepted.push(r);return true;}});
  const cleanups=mounted.runEffects();
  const tick=async value=>{result=value;now+=100;await run();};
  try{
    await tick(frame(1));assert.equal(accepted.length,0);
    for(let i=0;i<5;i++)await tick(frame(1));assert.equal(accepted.length,0);
    await tick({...frame(2),recognitionEpoch:'camera:2'});assert.equal(accepted.length,0);
    await tick({...frame(3),recognitionEpoch:'camera:2',textVerification:{status:'conflict'}});assert.equal(accepted.length,0);
    await tick({...frame(4),recognitionEpoch:'camera:2'});assert.equal(accepted.length,0);
    await tick({...frame(5),recognitionEpoch:'camera:2'});assert.equal(accepted.length,1);
    assert.deepEqual(Array.from(accepted[0].autoScanConsensus.sourceFrameIds),[4,5]);
    assert.equal(hasStrongVisualProof(accepted[0]),true);
    for(let i=6;i<15;i++)await tick(frame(i));assert.equal(accepted.length,1);
  }finally{cleanups.forEach(fn=>fn?.());}
});

test('a failed visual worker returns to the original recognition path and ignores late replies',async()=>{
  let worker,expire;
  const runtime=createRuntime({globals:{setTimeout:fn=>{expire=fn;return 1;},clearTimeout(){}}});
  const {CardVisualVerifier}=runtime.load('src/lib/cardVisualVerifier.js');
  const verifier=new CardVisualVerifier({createWorker:()=>worker={postMessage(){},terminate(){this.terminated=true;}}});
  const pending=verifier.ensureReady();const reply=worker.onmessage;expire();
  assert.equal(await pending,false);assert.equal(worker.terminated,true);reply({data:{id:1,ready:true}});
  assert.equal(verifier.ready,false);
});

test('a detector follow-up requires a newer frame in the same motion epoch and expires after 750 ms',()=>{
  const motion={epoch:7};
  const anchor={motionContext:motion,motionEpoch:7,epoch:2,revision:3,frameId:1,capturedAt:1000};
  const source={scanMotionContext:motion,scanMotionEpoch:7,frameId:2,capturedAt:1250};
  const context={epoch:2,revision:3,now:1400};
  assert.equal(canReuseVisualBox(anchor,source,context),true);
  for(const patch of [{scanMoving:true},{scanCancelled:true},{frameId:1},{capturedAt:1000},{scanMotionEpoch:8},{scanMotionContext:{epoch:7}}])
    assert.equal(canReuseVisualBox(anchor,{...source,...patch},context),false);
  for(const patch of [{epoch:3},{revision:4},{now:1751},{now:999}])assert.equal(canReuseVisualBox(anchor,source,{...context,...patch}),false);
  motion.epoch++;assert.equal(canReuseVisualBox(anchor,source,context),false);
});

test('distinct geometric identities may scan consecutively without the old one-second cooldown',async()=>{
  let now=0,run,result;const accepted=[];
  const runtime=createRuntime({globals:{Date:class extends Date{static now(){return now;}},setInterval:fn=>{run=fn;return 1;}}});
  const mounted=runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan);
  mounted.render({cameraIsActive:true,isProcessing:false,debugEnabled:true,captureFrame:()=>({}),detectSingleFrame:async()=>result,
    onCardDetected:r=>{accepted.push(r);return true;}});
  const cleanups=mounted.runEffects();
  const tick=async value=>{result=value;now+=100;await run();};
  try{
    await tick(frame(1));await tick(frame(2));assert.equal(accepted.length,1);
    const next=id=>({...frame(id),cardData:{id:'different'},visualVerification:{...proof(id),cardId:'different'},recognitionEpoch:'camera:2'});
    await tick(next(3));await tick(next(4));assert.equal(accepted.length,2);
    assert.equal(now,400);assert.deepEqual(Array.from(accepted[1].autoScanConsensus.sourceFrameIds),[3,4]);
  }finally{cleanups.forEach(fn=>fn?.());}
});

test('the camera hook skips OCR for fresh visual proof and reuses a detector box only once',async()=>{
  let now=1000,detectCalls=0,textCalls=0,cancelDuringVerification=false;
  const motion={epoch:1},cards=[{...card,code:'RAD-099/167',set:'RAD'},{id:'other',name:'Other Card',code:'RAD-001/167',set:'RAD'}];
  const match={card:cards[0],similarity:.76,secondBestSim:.75,localStructureSimilarity:.8,
    candidates:[{card:cards[0],similarity:.76,localStructureSimilarity:.8},{card:cards[1],similarity:.75}]};
  const detector={state:'ready',initialize:async()=>{},detect:async()=>{detectCalls++;return[{confidence:.99,box:{cx:400,cy:450,w:300,h:420,angle:0},cropCanvas:{width:300,height:420}}];}};
  const data=new Uint8ClampedArray(64*88*4);for(let i=0;i<data.length;i+=4){const v=Math.floor((i/4)%64/4)%2?190:40;data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;}
  const runtime=createRuntime({globals:{Date:class extends Date{static now(){return now;}},Worker:function(){},
    document:{createElement:()=>({width:300,height:420,getContext:()=>({translate(){},rotate(){},drawImage(){},getImageData:()=>({width:64,height:88,data})})})}},mocks:{
    'src/lib/yoloDetector.js':{getDetector:()=>detector,DetectorState:{READY:'ready',UNLOADED:'unloaded',LOADING:'loading',ERROR:'error'}},
    'src/lib/cardMatcher.js':{getMatcher:()=>({ready:true,revision:1,cards})},
    'src/lib/cardVisualVerifier.js':{CardVisualVerifier:class{ensureReady(){return Promise.resolve(true);}dispose(){}async verify(_crop,{frameId}){if(cancelDuringVerification)motion.epoch++;return {proof:proof(frameId),match};}}},
  }});
  const {CardTextVerification}=runtime.load('src/lib/cardTextVerification.js');
  const verifier=new CardTextVerification({read:async()=>{textCalls++;throw new Error('OCR must not start');}});
  const mounted=runtime.mount(runtime.load('src/hooks/useCardDetection.js').useCardDetection);
  const detection=mounted.render({textVerifier:verifier,cropRefiner:()=>{throw new Error('No repeated geometry search');}});
  const cleanups=mounted.runEffects();
  const source=id=>({width:800,height:900,frameId:id,capturedAt:now-50,scanMotionEpoch:motion.epoch,scanMotionContext:motion});
  try{
    await detection.initDetector('quantized');
    const first=await detection.detectSingleFrame(()=>source(1));assert.equal(first.matched,true);assert.equal(first.textVerification.status,'not-required');
    now+=250;const second=await detection.detectSingleFrame(()=>source(2));assert.equal(second.matched,true);assert.equal(second.timings.detectorReused,true);assert.equal(detectCalls,1);
    now+=250;const third=await detection.detectSingleFrame(()=>source(3));assert.equal(third.timings.detectorReused,false);assert.equal(detectCalls,2);assert.equal(textCalls,0);
    cancelDuringVerification=true;now+=250;
    assert.equal(await detection.detectSingleFrame(()=>source(4)),null,'Motion while the worker runs invalidates its late proof');
  }finally{cleanups.forEach(fn=>fn?.());}
});
