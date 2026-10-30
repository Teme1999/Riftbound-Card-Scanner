import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, componentProps, nodes } from './helpers/runtime.mjs';
import { assessScanAcceptance } from '../src/lib/scanAcceptance.js';
import { ScanDebugQueue } from '../src/lib/scanDebugQueue.js';

test('production ignores stored debug preferences and cannot enable diagnostic camera controls',()=>{
  let recordingCalls=0,auto;
  const runtime=createRuntime({development:false,storage:{riftbound_scanner_debug_overlay_enabled:true},mocks:{
    'src/hooks/useScanSessionRecording.js':{useScanSessionRecording:()=>{recordingCalls++;return{};}},
    'src/hooks/useAutoScan.js':{useAutoScan:options=>{auto=options;return{autoScanEnabled:false,toggleAutoScan(){},setLastCardId(){}};}},
  }});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);
  const scan=()=>componentProps(app.render(),'ScanTab');assert.equal(scan().debugEnabled,false);
  scan().onDebugChange(true);assert.equal(scan().debugEnabled,false);assert.equal(auto.debugEnabled,false);
  assert.equal(scan().scanRecording,null);assert.equal(recordingCalls,0);
  const camera=runtime.mount(runtime.load('src/components/scanner/ScannerCamera.jsx').default);
  const tree=camera.render({videoRef:{current:null},isActive:true,debugEnabled:true,captureFrame(){throw new Error('Unexpected capture');}});
  assert.equal(nodes(tree,node=>node.props?.['aria-label']==='Debug overlay').length,0);
  assert.equal(JSON.stringify(tree).includes('Save native frame'),false);
  assert.equal(nodes(tree,node=>node.type?.name==='ScanRecordingControls').length,0);
});

test('production scan overlay shows a candidate without enabling debug or capturing frames',()=>{
  let auto;
  const runtime=createRuntime({development:false,mocks:{
    'src/hooks/useAutoScan.js':{useAutoScan:options=>{auto=options;return{autoScanEnabled:false,toggleAutoScan(){},setLastCardId(){}};}},
  }});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);
  const scan=()=>componentProps(app.render(),'ScanTab');
  assert.equal(scan().scanOverlayEnabled,true);assert.equal(auto.debugEnabled,false);
  scan().onScanOverlayChange(false);assert.equal(scan().scanOverlayEnabled,false);
  scan().onScanOverlayChange(true);assert.equal(scan().debugEnabled,false);assert.equal(scan().scanRecording,null);

  const camera=runtime.mount(runtime.load('src/components/scanner/ScannerCamera.jsx').default,[{w:1280,h:720},{w:1920,h:1080}]);
  const props={videoRef:{current:null},isActive:true,autoScanEnabled:false,
    captureFrame(){throw new Error('Overlay cannot capture a frame');},
    lastDetection:{observedAt:Date.now(),matched:false,box:{cx:960,cy:540,w:300,h:420,angle:0},
      cardData:{id:'fixture-001',name:'Test Card',code:'FIX-001'}}};
  let tree=camera.render(props);
  assert.equal(nodes(tree,n=>n.props?.['aria-label']==='Tracked card outline').length,1);
  const preview=nodes(tree,n=>n.props?.['aria-label']==='Tracked card preview')[0];
  assert.ok(JSON.stringify(preview).includes('Test Card'));assert.ok(JSON.stringify(preview).includes('Checking card'));
  assert.equal(nodes(tree,n=>n.props?.['aria-label']==='Scan overlay')[0].props['aria-pressed'],true);
  assert.equal(nodes(tree,n=>n.props?.['aria-label']==='Debug overlay').length,0);
  assert.equal(JSON.stringify(tree).includes('Save native frame'),false);
  nodes(tree,n=>n.props?.['aria-label']==='Scan overlay')[0].props.onClick();
  tree=camera.render(props);
  assert.equal(nodes(tree,n=>n.props?.['aria-label']==='Tracked card preview').length,0);
  assert.equal(nodes(tree,n=>n.props?.['aria-label']==='Tracked card outline').length,0);
  assert.equal(auto.debugEnabled,false);assert.equal(auto.isProcessing,false);
});

test('the tracking preview expires on a frozen frame and late expiry cannot hide a newer card',()=>{
  let now=1000;const timers=[];
  const runtime=createRuntime({development:false,globals:{Date:class extends Date{static now(){return now;}},
    setTimeout:(expire,delay)=>{timers.push({expire,delay});return timers.length;},clearTimeout(){}}});
  const camera=runtime.mount(runtime.load('src/components/scanner/ScannerCamera.jsx').default);
  const first={observedAt:1000,box:{},cardData:{id:'first',name:'First Card'},matched:false};
  const props={videoRef:{current:null},isActive:true,lastDetection:first};
  const preview=tree=>nodes(tree,n=>n.props?.['aria-label']==='Tracked card preview');
  assert.equal(preview(camera.render(props)).length,1);camera.runEffects();assert.equal(timers[0].delay,1500);
  now=2000;const second={...first,observedAt:2000,cardData:{id:'second',name:'Second Card'},matched:true};
  const next={...props,lastDetection:second};camera.render(next);camera.runEffects();
  timers[0].expire();assert.equal(preview(camera.render(next)).length,1);
  assert.ok(JSON.stringify(preview(camera.render(next))).includes('Confirming card'));
  timers[1].expire();assert.equal(preview(camera.render(next)).length,0);
  assert.equal(preview(camera.render({...next,isActive:false})).length,0);
  assert.equal(preview(camera.render({...next,lastDetection:{reason:'outside-guide'}})).length,0);
});

test('scan overlay preference is independent of stored debug and survives a production restart',()=>{
  const key='riftbound_scanner_overlay_enabled';
  const runtime=createRuntime({development:false,storage:{[key]:false,riftbound_scanner_debug_overlay_enabled:true}});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);
  let scan=componentProps(app.render(),'ScanTab');assert.equal(scan.scanOverlayEnabled,false);assert.equal(scan.debugEnabled,false);
  scan.onScanOverlayChange(true);app.render();
  // Run only persistence effects, avoiding app initialization in this isolated test.
  const camera=runtime.mount(runtime.load('src/components/scanner/ScannerCamera.jsx').default);
  camera.render({videoRef:{current:null},isActive:false,scanOverlayEnabled:true});camera.runEffects();
  assert.equal(runtime.values.get(key),'true');
  const restarted=runtime.mount(runtime.load('src/App.jsx').default,[false]);
  scan=componentProps(restarted.render(),'ScanTab');assert.equal(scan.scanOverlayEnabled,true);assert.equal(scan.debugEnabled,false);
});

test('production debug and fake requests cannot force auto-scan, while normal auto-scan still works',()=>{
  let timers=0;const runtime=createRuntime({development:false,globals:{setInterval(){timers++;return 1;}}});
  const hook=runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan);
  const props={cameraIsActive:true,debugEnabled:true};let state=hook.render(props);hook.runEffects();
  assert.equal(state.autoScanEnabled,false);assert.equal(timers,0);state.toggleFakeScan();state=hook.render(props);assert.equal(state.fakeScanEnabled,false);
  state.toggleAutoScan();state=hook.render(props);assert.equal(state.autoScanEnabled,true);
});

test('debug exports queue every accepted source, serialize writes, and deduplicate pending retries',async()=>{
  const sizes=[],started=[],gates=[];
  const queue=new ScanDebugQueue(size=>sizes.push(size));
  const run=id=>()=>{started.push(id);return new Promise(resolve=>gates.push(resolve));};
  const first=queue.enqueue(11,run(11));
  assert.equal(queue.enqueue(11,run(99)),first);
  const second=queue.enqueue(12,run(12)),third=queue.enqueue(13,run(13));
  assert.equal(queue.size,3);assert.deepEqual(started,[11]);
  gates[0]();await first;assert.deepEqual(started,[11,12]);
  gates[1]();await second;assert.deepEqual(started,[11,12,13]);
  gates[2]();await third;assert.equal(queue.size,0);assert.equal(sizes.at(-1),0);
});

test('debug scanning continues during exports and applies backpressure only at three pending captures',async()=>{
  let auto;const writes=[],gates=[];
  const runtime=createRuntime({storage:{riftbound_scanner_debug_overlay_enabled:true},mocks:{
    'src/hooks/useAutoScan.js':{useAutoScan:options=>{auto=options;return{autoScanEnabled:true,toggleAutoScan(){},setLastCardId(){}};}},
    'src/lib/debugScanCapture.js':{saveAcceptedDebugScan:result=>{writes.push(result.frameId);return new Promise(resolve=>gates.push(resolve));}},
  }});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);const scan=()=>componentProps(app.render(),'ScanTab');scan();
  const result=id=>({frameId:id,cardData:{id:String(id),name:String(id)}});
  const a=auto.onDebugAccepted(result(1));scan();assert.equal(auto.isProcessing,false);
  const b=auto.onDebugAccepted(result(2));scan();assert.equal(auto.isProcessing,false);
  const c=auto.onDebugAccepted(result(3));assert.equal(scan().debugCapture.pendingCount,3);assert.equal(auto.isProcessing,true);
  assert.deepEqual(writes,[1]);gates[0]({path:'one.png'});await a;
  assert.equal(scan().debugCapture.pendingCount,2);assert.equal(auto.isProcessing,false);
  assert.deepEqual(writes,[1,2]);gates[1]({path:'two.png'});await b;
  assert.deepEqual(writes,[1,2,3]);gates[2]({path:'three.png'});await c;
  assert.equal(scan().debugCapture.pendingCount,0);assert.equal(scan().debugCapture.status,'saved');
});

test('automatic acceptance chooses evidence paths without changing real scores or skipping quality/conflict rules',()=>{
  const base={cardData:{id:'rad-099-167'},matched:true,similarity:.95,similarityGap:.07,minSimilarity:.9,quality:{acceptable:true}};
  assert.equal(assessScanAcceptance(base).path,'distinct-artwork');
  assert.equal(assessScanAcceptance({...base,similarity:.89}).eligible,false);
  const text={...base,similarity:.71,similarityGap:-.12,localStructureSimilarity:.7,confirmationMethod:'text',
    visualCandidates:[{id:base.cardData.id,localStructureSimilarity:.7}],textVerification:{status:'confirmed',cardId:base.cardData.id,
      nameConfidence:96,codeConfidence:96,sourceFrameIds:[11,12]}};
  const copy=structuredClone(text),decision=assessScanAcceptance(text);
  assert.equal(decision.path,'text-and-local-artwork');assert.equal(decision.requirements.standaloneArtwork,null);
  assert.deepEqual(text,copy);assert.equal(decision.independentTextFrames,2);
  for(const patch of [{quality:{acceptable:false,issue:'blurred'}},{visualCandidates:[]},{localStructureSimilarity:.54},
    {textVerification:{...text.textVerification,sourceFrameIds:[11,11]}},{textVerification:{...text.textVerification,codeConfidence:89}},
    {textVerification:{...text.textVerification,status:'conflict'}},{textVerification:{...text.textVerification,status:'pending'}}]){
    assert.equal(assessScanAcceptance({...text,...patch}).eligible,false);
  }
});

test('accepted debug export retains native source bytes and separate annotated pixels, never recapturing a later frame',async()=>{
  const calls=[],paint=[],raw=new Uint8Array([137,80,78,71,13,10,26,10,11]),overlay=new Uint8Array([137,80,78,71,13,10,26,10,99]);
  const context={fillRect(){},drawImage:source=>paint.push(source),beginPath(){},lineTo(){},moveTo(){},closePath(){},stroke(){},
    save(){},restore(){},translate(){},rotate(){},strokeRect(){},fillText(){},measureText:text=>({width:text.length*8})};
  const runtime=createRuntime({globals:{__TAURI_INTERNALS__:{},document:{createElement:()=>({getContext:()=>context,toBlob:done=>done({arrayBuffer:async()=>overlay.buffer})})}},
    mocks:{'@tauri-apps/api/core':{invoke:async(command,payload)=>{calls.push({command,payload});return{path:'raw.png',annotatedPath:'debug.png',diagnosticsPath:'scan.json'};}}}});
  const frame={width:806,height:1080,frameId:11,capturedAt:900,toBlob:done=>done({arrayBuffer:async()=>raw.buffer}),scanRegion:{x:100,y:200}};
  const result={frameId:11,timestamp:1000,acceptedByAutoScan:true,cardData:{id:'rad-099-167',name:'Suave Negotiator',code:'RAD-099/167',collection:'private'},
    quality:{acceptable:true},similarity:.71,similarityGap:-.12,colorSimilarity:.82,structureSimilarity:.73,confidence:.99,artworkSampling:'area',
    acceptanceDecision:{path:'text-and-local-artwork'},textVerification:{status:'confirmed',sourceFrameIds:[9,11]}};
  const evidence=runtime.load('src/lib/scanEvidence.js');evidence.attachScanEvidence(result,{frame,candidates:[{id:result.cardData.id,name:result.cardData.name,similarity:.71}]});
  const service=runtime.load('src/lib/debugScanCapture.js');await service.saveAcceptedDebugScan(result,{perspective:true,textVerification:true});
  assert.equal(calls.length,1);assert.equal(calls[0].command,'save_debug_scan');
  assert.deepEqual(Array.from(calls[0].payload.rawPng),Array.from(raw));assert.deepEqual(Array.from(calls[0].payload.annotatedPng),Array.from(overlay));
  assert.equal(paint[0],frame);const details=calls[0].payload.diagnostics;
  assert.equal(details.capture.frameId,11);assert.equal(details.recognition.frameId,11);assert.equal(details.event,'accepted-and-queued');
  assert.equal(details.recognition.similarityGap,-.12);assert.equal(details.recognition.card.collection,undefined);
  assert.equal(details.recognition.colorSimilarity,.82);assert.equal(details.recognition.structureSimilarity,.73);assert.equal(details.recognition.confidence,.99);
  assert.equal(details.mode,'debug-auto-scan');assert.equal(JSON.stringify(result).includes('canvas'),false);
  const changed={...result,frameId:12};evidence.attachScanEvidence(changed,{frame});
  await assert.rejects(service.saveAcceptedDebugScan(changed,{}),/accepted source frame/);assert.equal(calls.length,1);
  await assert.rejects(service.saveAcceptedDebugScan({...result},{}),/accepted source frame/);assert.equal(calls.length,1);
});

test('debug capture failure and retry do not queue another card or ring again',async()=>{
  let auto,complete,attempts=0,rings=0;
  const runtime=createRuntime({storage:{riftbound_scanner_debug_overlay_enabled:true},mocks:{
    'src/hooks/useAutoScan.js':{useAutoScan:options=>{auto=options;return{autoScanEnabled:options.debugEnabled,toggleAutoScan(){},setLastCardId(){}};}},
    'src/hooks/useScanSound.js':{useScanSound:()=>({playScanAccepted:()=>rings++,settings:{},updateSettings(){}})},
    'src/lib/debugScanCapture.js':{saveAcceptedDebugScan:()=>{attempts++;return new Promise((resolve,reject)=>{complete={resolve,reject};});}},
  }});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);const scan=()=>componentProps(app.render(),'ScanTab');scan();
  const result={cardData:{id:'rad-099-167',name:'Suave Negotiator'},frameId:11,timestamp:1000,matched:true,similarity:.99,similarityGap:.1,quality:{acceptable:true}};
  assert.equal(auto.debugEnabled,true);assert.equal(auto.onCardDetected(result),true);const saving=auto.onDebugAccepted(result);
  assert.equal(scan().pendingCards.length,1);assert.equal(auto.isProcessing,false);assert.equal(scan().debugCapture.status,'saving');
  scan().onRetryDebugCapture();assert.equal(attempts,1,'A double-click cannot create concurrent exports');
  complete.reject(new Error('Disk full'));await saving;
  assert.equal(scan().debugCapture.status,'error');assert.equal(scan().pendingCards.length,1);assert.equal(rings,1);
  scan().onRetryDebugCapture();complete.resolve({path:'raw.png',annotatedPath:'debug.png',diagnosticsPath:'details.json'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scan().debugCapture.status,'saved');assert.equal(attempts,2);assert.equal(scan().pendingCards.length,1);assert.equal(rings,1);
  componentProps(app.render(),'BottomTabBar').onTabChange('settings');const settings=componentProps(app.render(),'SettingsTab');
  assert.equal(settings.onUpdateMinConfidence,undefined);
  const view=runtime.mount(runtime.load('src/components/settings/SettingsTab.jsx').default);const tree=view.render({batchDefaults:{}});
  assert.equal(nodes(tree,node=>node.type==='input'&&node.props.type==='range'&&node.props.id!=='scan-sound-volume').length,0);
});
