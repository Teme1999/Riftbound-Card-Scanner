import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createRuntime, button, nodes, componentProps } from './helpers/runtime.mjs';

function fixture({writeFailure=false,startGate,chunkGate,startDelay=0}={}) {
  let now=0, originalStops=0, cloneStops=0, recorder, intervalId=0;
  const calls=[],states=[],timers=new Map(),polls=new Map();
  const original={readyState:'live',stop:()=>originalStops++,clone:()=>({stop:()=>cloneStops++,addEventListener(){}})};
  class Recorder {
    static isTypeSupported(type){return type==='video/webm;codecs=vp8';}
    constructor(stream,options){recorder=this;this.stream=stream;this.options=options;this.state='inactive';this.starts=0;}
    start(slice){assert.equal(slice,1000);this.starts++;this.state='recording';now+=startDelay;this.onstart();}
    chunk(bytes=[26,69,223,163,1]){this.ondataavailable({data:{size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer}});}
    stop(){this.state='inactive';queueMicrotask(()=>{this.chunk([2,3]);this.onstop();});}
  }
  class Stream {constructor(tracks){this.tracks=tracks;}getAudioTracks(){return[];}}
  const paths={id:'session-1',videoPath:'local/session.webm',eventsPath:'local/session.jsonl'};
  const invoke=async(command,args)=>{calls.push({command,args});if(command==='start_debug_recording'){await startGate;return paths;}return paths;};
  const invokeBinary=async(command,bytes,headers)=>{
    calls.push({command,bytes:Array.from(bytes),headers});await chunkGate;if(writeFailure)throw new Error('Disk full');
  };
  const runtime=createRuntime({globals:{Date:class extends Date{static now(){return now;}},
    setInterval:fn=>{polls.set(++intervalId,fn);return intervalId;},clearInterval:id=>polls.delete(id)}});
  const Recording=runtime.load('src/lib/scanSessionRecording.js').ScanSessionRecording;
  const recording=new Recording({invoke,invokeBinary,Recorder,Stream,now:()=>now,onState:s=>states.push(s),
    every:fn=>{timers.set('every',fn);return'every';},clearEvery:id=>timers.delete(id),
    later:(fn,ms)=>{timers.set(ms,fn);return ms;},clearLater:id=>timers.delete(id)});
  const video={srcObject:{getVideoTracks:()=>[original]},currentTime:20,videoWidth:1920,videoHeight:1080};
  const emit=runtime.load('src/lib/scanDiagnostics.js').emitScanDiagnostic;
  return {recording,video,calls,states,timers,polls,runtime,emit,paths,setNow:value=>{now=value;},get recorder(){return recorder;},
    get originalStops(){return originalStops;},get cloneStops(){return cloneStops;},get state(){return states.at(-1);}};
}

test('a recording streams video and a sanitized monotonic timeline through the final video chunk',async()=>{
  const f=fixture();
  await f.recording.start(f.video,{perspective:true,cameraSettings:{width:1920,deviceId:'private-device'},collection:'private-collection'});
  assert.equal(f.state.status,'recording');assert.equal(f.recorder.stream.tracks.length,1);assert.equal(f.recorder.stream.getAudioTracks().length,0);
  f.recorder.chunk();f.setNow(100);
  f.emit('observation',{result:{frameId:17,cardData:{id:'rad-099-167',name:'Suave Negotiator',privateCollection:'private'},matched:false,reason:'reading-text',canvas:{secret:'pixels'}}});
  f.setNow(200);f.emit('accepted',{result:{frameId:18,cardData:{id:'rad-099-167'},matched:true}});
  f.setNow(900);await f.recording.stop();
  assert.equal(f.state.status,'saved');assert.equal(f.state.elapsedMs,900);assert.equal(f.originalStops,0);assert.equal(f.cloneStops,1);
  const video=f.calls.filter(c=>c.command==='append_debug_recording');
  assert.deepEqual(video.map(c=>c.headers['x-chunk-index']),['0','1']);assert.deepEqual(video[1].bytes,[2,3]);
  const events=f.calls.filter(c=>c.command==='record_debug_events').flatMap(c=>c.args.events);
  assert.deepEqual(events.map(e=>e.type),['video-start-request','video-start','observation','accepted','video-stop']);
  assert.equal(events[2].tMs,100);assert.equal(events[2].result.reason,'reading-text');assert.equal(events[3].tMs,200);
  assert.doesNotMatch(JSON.stringify(f.calls),/private-device|private-collection|privateCollection|pixels/);
  assert.equal(f.calls.at(-1).command,'finish_debug_recording');assert.equal(f.calls.at(-1).args.summary.videoBytes,7);
  const count=f.calls.length;f.emit('observation',{frameId:99});await f.recording.stop();assert.equal(f.calls.length,count);
  assert.equal(f.timers.size,0);
});

test('delayed encoder notifications cannot move the timeline origin after video capture started',async()=>{
  const f=fixture({startDelay:350});await f.recording.start(f.video,{});f.recorder.chunk();f.setNow(1000);await f.recording.stop();
  const events=f.calls.filter(c=>c.command==='record_debug_events').flatMap(c=>c.args.events);
  assert.equal(events[0].tMs,0);assert.equal(events[1].tMs,350);assert.equal(events[1].notificationDelayMs,350);
  assert.equal(f.state.elapsedMs,1000);
});

test('duplicate starts cannot allocate another recording and stopping waits for slow binary writes',async()=>{
  let release;const f=fixture({chunkGate:new Promise(resolve=>{release=resolve;})});
  await Promise.all([f.recording.start(f.video,{}),f.recording.start(f.video,{})]);
  f.recorder.chunk();await tick();const stopping=f.recording.stop();await tick();
  assert.equal(f.state.status,'stopping');assert.equal(f.calls.filter(c=>c.command==='start_debug_recording').length,1);
  assert.equal(f.calls.some(c=>c.command==='finish_debug_recording'),false);
  release();await stopping;assert.equal(f.state.status,'saved');
});

test('a write failure stops recording, retains file paths and reports an error instead of success',async()=>{
  const f=fixture({writeFailure:true});await f.recording.start(f.video,{});f.recorder.chunk();await tick();await f.recording.stop();
  assert.equal(f.state.status,'error');assert.match(f.state.error,/Disk full/);assert.equal(f.state.partial,true);
  assert.equal(f.state.eventsPath,f.paths.eventsPath);assert.equal(f.cloneStops,1);assert.equal(f.originalStops,0);
  assert.equal(f.calls.filter(c=>c.command==='finish_debug_recording').length,1);
});

test('leaving the camera during startup never starts an orphaned recorder',async()=>{
  let release;const f=fixture({startGate:new Promise(resolve=>{release=resolve;})});
  const starting=f.recording.start(f.video,{});const stopped=f.recording.stop('camera-or-debug-stopped');
  release();await starting;await stopped;
  assert.equal(f.recorder.starts,0);assert.equal(f.cloneStops,1);assert.equal(f.originalStops,0);
  assert.equal(f.calls.at(-1).args.summary.reason,'camera-or-debug-stopped');assert.equal(f.state.status,'error');
});

test('the five-minute cap stops and flushes without changing the live camera',async()=>{
  const f=fixture();await f.recording.start(f.video,{});f.recorder.chunk();f.setNow(300000);
  f.timers.get(300000)();await f.recording.stop();
  assert.equal(f.state.status,'saved');assert.equal(f.state.stopReason,'duration-limit');assert.equal(f.state.elapsedMs,300000);
  assert.equal(f.originalStops,0);assert.equal(f.timers.size,0);
});

test('an inactive encoder still delivers its last data event before finalization',async()=>{
  const f=fixture();await f.recording.start(f.video,{});f.recorder.chunk();
  f.recorder.state='inactive';const stopping=f.recording.stop('encoder-error');await tick();
  assert.equal(f.calls.some(c=>c.command==='finish_debug_recording'),false);
  f.recorder.chunk([8,9]);f.recorder.onstop();await stopping;
  assert.deepEqual(f.calls.filter(c=>c.command==='append_debug_recording').at(-1).bytes,[8,9]);
  assert.equal(f.state.status,'saved');
});

test('late callbacks from a previous encoder cannot stop the next recording',async()=>{
  const f=fixture();await f.recording.start(f.video,{});const previous=f.recorder;previous.chunk();await f.recording.stop();
  await f.recording.start(f.video,{});const current=f.recorder;
  previous.onerror({error:new Error('Old encoder error')});previous.ondataavailable({data:{size:1}});previous.onstart();
  assert.equal(f.state.status,'recording');current.chunk();await f.recording.stop();assert.equal(f.state.status,'saved');
});

test('camera/debug deactivation and context changes finalize an active hook recording',async()=>{
  for(const patch of [{active:false},{contextKey:'another-camera'}]){
    let current,closed=0;
    const runtime=createRuntime({mocks:{'src/lib/scanSessionRecording.js':{recordingMimeType:()=>true,
      ScanSessionRecording:class{constructor(){current=this;}start(){this.running=true;}stop(reason){if(this.running){closed++;this.reason=reason;this.running=false;}}}},
    },globals:{window:{addEventListener(){},removeEventListener(){}}}});
    const view=runtime.mount(runtime.load('src/hooks/useScanSessionRecording.js').useScanSessionRecording);
    const props={videoRef:{current:{}},active:true,contextKey:'camera-1',metadata:{}};
    view.render(props);view.runEffects();view.render(props).start();
    view.render({...props,...patch});view.runEffects();
    assert.equal(closed,1);assert.equal(current.reason,patch.active===false?'camera-or-debug-stopped':'context-changed');
  }
});

test('recording real auto-scan decisions preserves acceptance and consecutive-card blocking',async()=>{
  const f=fixture(),accepted=[];await f.recording.start(f.video,{});
  const hook=f.runtime.mount(f.runtime.load('src/hooks/useAutoScan.js').useAutoScan,[true]);let current;
  hook.render({cameraIsActive:true,isProcessing:false,captureFrame:()=>({}),detectSingleFrame:async()=>current,
    onCardDetected:result=>{accepted.push(result);return true;}});const cleanup=hook.runEffects();
  const frame=id=>({frameId:id,capturedAt:id*250,cardData:{id:'rad-099-167'},confidence:.99,similarity:.99,similarityGap:.1,matched:true,quality:{acceptable:true}});
  try{
    for(let id=1;id<=3;id++){f.setNow(id*250);current=frame(id);await Promise.all([...f.polls.values()].map(fn=>fn()));}
    assert.equal(accepted.length,1);f.recorder.chunk();await f.recording.stop();
    const events=f.calls.filter(c=>c.command==='record_debug_events').flatMap(c=>c.args.events);
    assert.equal(events.filter(e=>e.type==='accepted').length,1);
    assert.ok(events.some(e=>e.reason==='collecting-visual-frames'));assert.ok(events.some(e=>e.reason==='duplicate-card-lock'));
  }finally{cleanup.forEach(fn=>fn?.());await f.recording.stop();}
});

test('recording controls start and stop explicitly and expose the saved folder',()=>{
  const runtime=createRuntime(),view=runtime.mount(runtime.load('src/components/scanner/ScanRecordingControls.jsx').default);
  let starts=0,stops=0;const recording={supported:true,state:{status:'idle'},start:()=>starts++,stop:()=>stops++};
  let tree=view.render({recording});button(tree,'Start scan recording').onClick();assert.equal(starts,1);
  recording.state={status:'recording',elapsedMs:65000};tree=view.render({recording});button(tree,'Stop and save recording').onClick();assert.equal(stops,1);
  assert.ok(nodes(tree,n=>n.props?.role==='status').length);
  recording.state={status:'saved',eventsPath:'session.jsonl',videoPath:'session.webm'};tree=view.render({recording});
  assert.ok(button(tree,'Open recordings folder'));assert.equal(button(tree,'Start scan recording').disabled,false);
});
