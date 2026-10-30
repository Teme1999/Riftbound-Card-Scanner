import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createRuntime, componentProps, button, nodes } from './helpers/runtime.mjs';
import { createCardEntry } from '../src/lib/collection.js';
import { resolveCardData } from '../src/lib/cardData.js';
import * as csvExporter from '../src/lib/csvExporter.js';

const card = resolveCardData({ id: 'fixture-001', name: 'Fixture Card', code: 'FIX-001/100', set: 'FIX', rarity: 'common' });
const pendingKey = 'riftbound_pending_cards';

test('borderless detector proposals are opt-in, in-guide, lazily cropped and never replace a primary detection',async()=>{
  const runtime=createRuntime(),{default:Detector,DetectorState}=runtime.load('src/lib/yoloDetector.js');
  const detector=new Detector();detector.state=DetectorState.READY;detector.onnxSession={};
  const source={width:800,height:1000,scanRegion:{guide:{x:100,y:100,width:600,height:800}}};
  const proposal={confidence:.42,box:{cx:400,cy:500,w:300,h:420,angle:0}},
    outside={confidence:.7,box:{cx:20,cy:20,w:300,h:420,angle:0}};
  const candidates=[];Object.defineProperty(candidates,'proposals',{value:[proposal,outside]});
  let crops=0,calls=0;detector._onnxDetect=async()=>{calls++;return candidates;};
  detector._cropRotated=()=>{crops++;return {width:300,height:420};};
  assert.equal(detector.confidenceThreshold,.75);
  assert.equal((await detector.detect(source)).length,0);assert.equal(crops,0);
  const result=await detector.detect(source,{allowProposals:true});
  assert.equal(result.length,1);assert.equal(result[0].confidence,.42);
  assert.equal(result[0].detectorProposal,true);assert.equal(crops,1);
  assert.equal((await detector.detect({...source,scanRegion:undefined},{allowProposals:true})).length,0);
  const primary={...proposal,confidence:.95};detector._onnxDetect=async()=>{calls++;return [primary];};
  calls=0;assert.equal((await detector.detect(source,{allowProposals:true}))[0],primary);
  assert.equal(calls,1);assert.equal(crops,1);
});

test('ONNX decoding preserves the primary threshold and excludes very weak or non-card proposals',async()=>{
  const context={fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(640*640*4)})};
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>context})}},
    mocks:{'onnxruntime-web/wasm':{env:{wasm:{}},Tensor:class{}}}});
  const Detector=runtime.load('src/lib/yoloDetector.js').default,detector=new Detector();
  // Four independent locations: primary, candidate, below the proposal floor, square.
  const output=new Float32Array([100,250,400,550, 320,320,320,320, 60,60,60,80, 88,88,88,80,
    .8,.4,.2,.5, 0,0,0,0]);
  detector.onnxSession={run:async()=>({output0:{data:output,dims:[1,6,4]}})};
  let crops=0;detector._cropRotated=()=>{crops++;return {};};
  const result=await detector._onnxDetect({},640,640);
  assert.equal(result.length,1);assert.ok(Math.abs(result[0].confidence-.8)<1e-6);
  assert.equal(result.proposals.length,1);assert.ok(Math.abs(result.proposals[0].confidence-.4)<1e-6);
  assert.equal(result.proposals[0].cropCanvas,undefined);assert.equal(crops,1);
  assert.equal(Object.keys(result).includes('proposals'),false);
});
function appFixture(pending = [], collection = []) {
  const runtime = createRuntime({ storage: { [pendingKey]: pending, riftbound_scanned_cards: collection } });
  const app = runtime.mount(runtime.load('src/App.jsx').default, [false]);
  const scan = () => componentProps(app.render(), 'ScanTab');
  const collected = () => {
    componentProps(app.render(), 'BottomTabBar').onTabChange('collection');
    return componentProps(app.render(), 'CollectionTab');
  };
  return { runtime, app, scan, collected };
}

test('single pending confirmation retains five copies and foil status', () => {
  const fixture = appFixture([{ cardData: card, quantity: 5, foil: true }]);
  const scan = fixture.scan();
  const entry = scan.pendingCards[0];
  scan.onConfirmPending(entry.entryId);
  assert.equal(fixture.scan().pendingCards.length, 0);
  const rows = fixture.collected().scannedCards;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 5);
  assert.equal(rows[0].foil, true);
});

test('confirming one finish leaves the other pending row intact', () => {
  const fixture = appFixture([{ cardData: card, quantity: 5, foil: false }, { cardData: card, quantity: 2, foil: true }]);
  const initial = fixture.scan();
  initial.onConfirmPending(initial.pendingCards[0].entryId);
  assert.equal(fixture.scan().pendingCards.length, 1);
  assert.equal(fixture.scan().pendingCards[0].foil, true);
  assert.equal(fixture.collected().scannedCards[0].quantity, 5);
});

test('manual pending additions keep standard and foil separate', () => {
  const fixture = appFixture();
  fixture.scan().onAddPendingCard(card, { quantity: 2, foil: false });
  fixture.scan().onAddPendingCard(card, { quantity: 3, foil: true });
  const rows = fixture.scan().pendingCards;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].foil, false);
  assert.equal(rows[1].quantity, 3);
  assert.equal(rows[1].foil, true);
});

test('edits are used by confirm-all as well as individual confirmation', () => {
  const fixture = appFixture([{ cardData: card, quantity: 5, foil: false }]);
  const entryId = fixture.scan().pendingCards[0].entryId;
  fixture.scan().onUpdatePendingCard(entryId, { quantity: 7, foil: true, promo: true });
  fixture.scan().onConfirmAllPending();
  const row = fixture.collected().scannedCards[0];
  assert.equal(row.quantity, 7);
  assert.equal(row.foil, true);
  assert.equal(row.promo, true);
});

test('collection adds retain separate language and condition rows', () => {
  const fixture = appFixture([], [{ cardData: card, quantity: 1, foil: false, language: 'English', condition: 'Near Mint' }]);
  fixture.scan().onAddCardsToExport([{ cardData: card, quantity: 2, foil: false, language: 'Chinese', condition: 'Damaged' }]);
  const rows = fixture.collected().scannedCards;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].quantity, 2);
  assert.equal(rows[1].language, 'Chinese');
  assert.equal(rows[1].condition, 'Damaged');
});

test('a split preserves the total quantity and merges into the matching finish', () => {
  const fixture = appFixture([], [{ cardData: card, quantity: 5, foil: false }, { cardData: card, quantity: 2, foil: true }]);
  fixture.collected().onSplitCard(0);
  const rows = fixture.collected().scannedCards;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].quantity, 4);
  assert.equal(rows[1].quantity, 3);
});

test('card details submit the actual controlled quantity, foil and promo values', () => {
  const runtime = createRuntime();
  const panel = runtime.mount(runtime.load('src/components/identify/CardDetailPanel.jsx').default, [true]);
  let entry = createCardEntry({ cardData: card, quantity: 5, foil: true, promo: true });
  let submitted;
  const render = () => panel.render({ detection: { matchResult: { top3: [card], similarity: 0.99 } }, entry, quantity: entry.quantity,
    onEntryChange: (patch) => { entry = createCardEntry({ ...entry, ...patch }); }, onAddToScanner: (payload) => { submitted = payload; } });
  const tree = render();
  const quantity = nodes(tree, (node) => node.type === 'input' && node.props.inputMode === 'numeric')[0];
  assert.equal(quantity.props.value, 5);
  quantity.props.onChange({ target: { value: '7' } });
  button(render(), 'Add to collection').onClick();
  assert.equal(submitted.quantity, 7);
  assert.equal(submitted.foil, true);
  assert.equal(submitted.promo, true);
});

test('collection rows with the same card and timestamp address their own stable ids', () => {
  const runtime = createRuntime();
  const view = runtime.mount(runtime.load('src/components/collection/CollectionTab.jsx').default);
  const rows = [createCardEntry({ cardData: card, foil: false, scanTimestamp: 100 }), createCardEntry({ cardData: card, foil: true, scanTimestamp: 100 })];
  const tree = view.render({ scannedCards: rows });
  const renderedRows = nodes(tree, (node) => node.props?.card && node.props?.index !== undefined);
  assert.equal(renderedRows[0].props.index, 0);
  assert.equal(renderedRows[1].props.index, 1);
});

test('photo review carries cached images and manual edits through actual bulk actions', async () => {
  const cachedPath = 'C:\\AppData\\cards\\fixture.webp';
  const reference = { ...card, imageUrl: cachedPath, f: [1, 1, 1] };
  const context2d = {
    drawImage() {}, translate() {}, rotate() {}, putImageData() {},
    getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
  };
  class FakeImage {
    naturalWidth = 4; naturalHeight = 6;
    set src(_value) { this.onload?.(); }
  }
  let exported, added;
  const runtime = createRuntime({
    mocks: {
      'src/lib/cardMatcher.js': { getMatcher: () => ({ cards: [reference], ready: true,
        rank: () => [{ card: reference, similarity: 0.99 }] }) },
      'src/lib/yoloDetector.js': { getDetector: () => ({ state: 'ready', detect: async () => [{ box: { cx: 2, cy: 3, w: 4, h: 6, angle: 0 }, confidence: 0.99 }] }) },
      'src/lib/csvExporter.js': { ...csvExporter, downloadCSV: (rows) => { exported = rows; } },
    },
    globals: { Image: FakeImage, URL: class extends URL { static createObjectURL() { return 'blob:fixture'; } },
      document: { createElement: () => ({ getContext: () => context2d }) } },
  });
  const view = runtime.mount(runtime.load('src/components/scan/ScanTab.jsx').default, ['upload']);
  const props = { camera: { isActive: false }, detection: {}, pendingCards: [], recentPendingScanEvents: [], scanSetOptions: [],
    scanSetFilter: [], batchDefaults: { foil: false, condition: 'Near Mint', language: 'English' }, minConfidence: 0.9,
    showNotification() {}, onAddCardsToExport: (rows) => { added = rows; }, exportFormat: 'piltover' };
  componentProps(view.render(props), 'ImageDropZone').onImageSelected({ name: 'fixture.png' });
  await nextTurn();
  let panel = componentProps(view.render(props), 'CardDetailPanel');
  assert.equal(panel.entry.cardData.imageUrl, cachedPath);
  assert.equal(panel.detection.matchResult.top3[0].imageUrl, cachedPath);
  const manual = { ...card, id: 'outside-the-top-three', name: 'Corrected Card', imageUrl: cachedPath };
  panel.onEntryChange({ cardData: manual, quantity: 5, foil: true, promo: true });
  panel = componentProps(view.render(props), 'CardDetailPanel');
  panel.onToggleCheck();
  const selected = view.render(props);
  button(selected, 'CSV').onClick();
  button(selected, 'Add (1)').onClick();
  for (const rows of [exported, added]) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cardData.id, manual.id);
    assert.equal(rows[0].quantity, 5);
    assert.equal(rows[0].foil, true);
    assert.equal(rows[0].promo, true);
    assert.equal(rows[0].cardData.imageUrl, cachedPath);
  }
  assert.match(csvExporter.generateCSV(exported, 'piltover'), /true,5,English,Near Mint/);
});

function autoFixture(onCardDetected) {
  let now = 0, interval;
  let result;
  const runtime = createRuntime({ globals: {
    Date: class extends Date { static now() { return now; } },
    setInterval: (fn) => { interval = fn; return 1; },
  } });
  const mounted = runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan, [true]);
  mounted.render({ cameraIsActive: true, isProcessing: false, captureFrame: () => ({}),
    detectSingleFrame: () => typeof result === 'function' ? result() : Promise.resolve(result), onCardDetected });
  const cleanups = mounted.runEffects();
  return {
    async tick(nextResult) { result = nextResult; now += 250; await interval(); },
    stop() { cleanups.forEach((cleanup) => cleanup?.()); },
  };
}

function testScanFixture() {
  let now=0, result, detectCalls=0, resets=0, timerId=0;
  const timers=new Map(),real=[],fake=[],options=[];
  const runtime=createRuntime({globals:{
    Date:class extends Date{static now(){return now;}},
    setInterval:fn=>{timers.set(++timerId,fn);return timerId;},clearInterval:id=>timers.delete(id),
  }});
  const mounted=runtime.mount(runtime.load('src/hooks/useAutoScan.js').useAutoScan);
  const props={cameraIsActive:true,isProcessing:false,recognitionContext:'RAD:camera-1:database-1',captureFrame:()=>({}),
    detectSingleFrame:async(_capture,opts)=>{options.push(opts);detectCalls++;return typeof result==='function'?result():result;},
    validateResult:r=>r.confirmationMethod==='text'||r.similarity>=.9,
    resetRecognition:()=>resets++,onCardDetected:r=>{real.push(r);return true;},onFakeScanAccepted:r=>fake.push(r)};
  let cleanups=[];
  const render=()=>mounted.render(props);
  const refresh=patch=>{Object.assign(props,patch);cleanups.forEach(fn=>fn?.());const value=render();cleanups=mounted.runEffects();return value;};
  refresh();
  return {real,fake,render,refresh,runtime,options,get calls(){return detectCalls;},get resets(){return resets;},
    async tick(value){result=value;now+=250;await Promise.all([...timers.values()].map(fn=>fn()));},
    stop(){cleanups.forEach(fn=>fn?.());},
  };
}

const reliableFrame=id=>({cardData:card,confidence:.99,similarity:.99,similarityGap:.08,minSimilarity:.9,
  matched:true,quality:{acceptable:true,score:.8},frameId:id,capturedAt:id*250});

test('frames that deferred geometry to OCR cannot seed a later standalone artwork confirmation',async()=>{
  const f=testScanFixture();
  const frame=(id,deferred)=>({...reliableFrame(id),similarity:.94,requiresTextConfirmation:deferred,matched:!deferred,
    recognitionEpoch:'same-track',confirmationMethod:'artwork',
    textVerification:deferred?{status:'pending',artworkFallbackAllowed:true}:{status:'unavailable'},
    visualCandidates:[{id:card.id,similarity:.94,similarityGap:.08,localStructureSimilarity:.8}]});
  try{
    f.render().toggleAutoScan();f.refresh();
    await f.tick(frame(1,true));await f.tick(frame(2,true));await f.tick(frame(3,false));
    assert.equal(f.real.length,0);await f.tick(frame(4,false));assert.equal(f.real.length,0);
    await f.tick(frame(5,false));assert.equal(f.real.length,1);
    assert.deepEqual(Array.from(f.real[0].autoScanConsensus.sourceFrameIds),[3,4,5]);
  }finally{f.stop();}
});

test('debug forces real auto-scan and exports the exact accepted frame once, after queuing',async()=>{
  const f=testScanFixture(),saved=[],order=[];
  const evidence=f.runtime.load('src/lib/scanEvidence.js');
  try{
    f.refresh({debugEnabled:true,onCardDetected:r=>{f.real.push(r);order.push('queued');return true;},
      onDebugAccepted:r=>{saved.push({result:r,frame:evidence.getScanEvidence(r)?.frame});order.push('saved');}});
    assert.equal(f.render().autoScanEnabled,true);
    f.render().toggleAutoScan();assert.equal(f.render().autoScanEnabled,true,'Debug auto-scan cannot be silently disabled');
    const first=evidence.attachScanEvidence(reliableFrame(1),{frame:{frameId:1}});
    const second=evidence.attachScanEvidence({...reliableFrame(2),similarity:.96},{frame:{frameId:2}});
    await f.tick(first);assert.equal(saved.length,0);await f.tick(second);
    assert.equal(f.real.length,1);assert.equal(saved.length,1);assert.equal(saved[0].result.frameId,2);
    assert.equal(saved[0].result.similarity,.96,'The exported values describe the accepted source, not an earlier better image');
    assert.equal(saved[0].frame.frameId,2);assert.equal(saved[0].result.acceptanceDecision.sourceFrameId,2);
    assert.deepEqual(Array.from(saved[0].result.autoScanConsensus.sourceFrameIds),[1,2]);
    assert.deepEqual(order,['queued','saved']);assert.ok(f.options.every(value=>value.retainEvidence));
    await f.tick(reliableFrame(3));for(let i=0;i<5;i++)await f.tick(null);await f.tick(reliableFrame(4));
    assert.equal(f.real.length,1);assert.equal(saved.length,1,'The duplicate lock also suppresses duplicate files');
  }finally{f.stop();}
});

test('the fast acceptance path needs two independently strong frames, while moderate artwork needs the stable sequence',async()=>{
  const f=testScanFixture();
  try{
    f.render().toggleAutoScan();f.refresh();
    await f.tick(reliableFrame(1));await f.tick({...reliableFrame(2),similarity:.91,similarityGap:.06});
    assert.equal(f.real.length,0);
    await f.tick({...reliableFrame(3),similarity:.92,similarityGap:.06});assert.equal(f.real.length,1);
    assert.equal(f.real[0].autoScanConsensus.consecutiveHits,3);
    assert.deepEqual(Array.from(f.real[0].autoScanConsensus.sourceFrameIds),[1,2,3]);
  }finally{f.stop();}
});

test('debug exports nothing for rejected queue callbacks or debug-off scans',async()=>{
  for(const debugEnabled of [true,false]){
    const f=testScanFixture();let saves=0;
    try{
      f.refresh({debugEnabled,onDebugAccepted:()=>saves++,onCardDetected:()=>false});
      if(!debugEnabled){f.render().toggleAutoScan();f.refresh();}
      await f.tick(reliableFrame(1));await f.tick(reliableFrame(2));await f.tick(reliableFrame(3));
      assert.equal(saves,0);
      if(!debugEnabled){f.refresh({onCardDetected:()=>true});await f.tick(reliableFrame(4));assert.equal(saves,0);}
    }finally{f.stop();}
  }
});

test('fake scan uses real fresh-frame acceptance, locks once and never calls the collection callback',async()=>{
  const f=testScanFixture();
  try{
    f.render().toggleFakeScan();let state=f.refresh();
    assert.equal(state.fakeScanEnabled,true);assert.equal(state.autoScanEnabled,false);assert.equal(f.resets,1);
    await f.tick(reliableFrame(1));assert.equal(f.render().fakeScanResult,null);
    await f.tick(reliableFrame(1));assert.equal(f.fake.length,0,'A frozen image does not satisfy consensus');
    await f.tick({...reliableFrame(2),matched:false,reason:'ambiguous',similarityGap:.01});
    await f.tick(reliableFrame(3));assert.equal(f.fake.length,0);
    await f.tick(reliableFrame(4));
    const locked=f.render().fakeScanResult;
    assert.equal(locked.cardData.id,card.id);assert.equal(locked.acceptedByFakeScan,true);assert.equal(locked.acceptedByAutoScan,false);
    assert.equal(locked.autoScanConsensus.matchedHits,3);assert.equal(f.fake.length,1);assert.equal(f.real.length,0);
    const count=f.calls;await f.tick({...reliableFrame(5),cardData:{...card,id:'next-card'}});
    assert.equal(f.calls,count,'A locked result does not keep running hidden inference');
    assert.equal(f.render().fakeScanResult,locked);
    f.render().nextFakeScan();f.refresh();assert.equal(f.render().fakeScanResult,null);
    await f.tick(reliableFrame(6));assert.equal(f.fake.length,1);
    await f.tick(reliableFrame(7));assert.equal(f.fake.length,2);assert.equal(f.real.length,0);
    f.render().stopFakeScan();state=f.refresh();assert.equal(state.fakeScanEnabled,false);assert.equal(state.fakeScanResult,null);
  }finally{f.stop();}
});

test('fake scan honors the user threshold, quality and independent OCR proof without promoting scores',async()=>{
  const f=testScanFixture();
  try{
    f.render().toggleFakeScan();f.refresh();
    for(const patch of [{similarity:.89},{quality:{acceptable:false}},{matched:false,textVerification:{status:'pending'}}]){
      await f.tick({...reliableFrame(1),...patch});await f.tick({...reliableFrame(2),...patch});
      assert.equal(f.fake.length,0);
      f.render().nextFakeScan();f.refresh();
    }
    const proof={status:'confirmed',cardId:card.id,nameConfidence:96,codeConfidence:96,sourceFrameIds:[1]};
    const text={...reliableFrame(3),similarity:.71,similarityGap:-.12,confirmationMethod:'text',
      confirmationReason:'name-number-local-artwork',localStructureSimilarity:.7,
      visualCandidates:[{id:card.id,similarity:.71,localStructureSimilarity:.7}],textVerification:proof};
    await f.tick(text);await f.tick({...text,frameId:4});assert.equal(f.fake.length,0);
    await f.tick({...text,frameId:5,textVerification:{...proof,sourceFrameIds:[1,2]}});
    await f.tick({...text,frameId:6,textVerification:{...proof,sourceFrameIds:[1,2]}});
    await f.tick({...text,frameId:7,textVerification:{...proof,sourceFrameIds:[1,2]}});
    assert.equal(f.fake.length,1);assert.equal(f.fake[0].similarity,.71);assert.equal(f.fake[0].similarityGap,-.12);
    assert.equal(f.real.length,0);
  }finally{f.stop();}
});

test('mode changes, retry, camera stop and recognition context changes discard late fake results',async()=>{
  for(const action of ['stop','next','auto','context','camera']){
    const f=testScanFixture();let finish;
    try{
      f.render().toggleFakeScan();f.refresh();await f.tick(reliableFrame(1));
      const pending=f.tick(()=>new Promise(resolve=>{finish=resolve;}));
      if(action==='stop')f.render().stopFakeScan();
      if(action==='next')f.render().nextFakeScan();
      if(action==='auto')f.render().toggleAutoScan();
      f.refresh(action==='context'?{recognitionContext:'RAD:camera-2:database-2'}:action==='camera'?{cameraIsActive:false}:{});
      finish(reliableFrame(2));await pending;
      assert.equal(f.fake.length,0,action);assert.equal(f.real.length,0,action);assert.equal(f.render().fakeScanResult,null);
      if(action==='auto'){assert.equal(f.render().autoScanEnabled,true);assert.equal(f.render().fakeScanEnabled,false);}
    }finally{f.stop();}
  }
});

test('fake and live modes are exclusive and a fake lock cannot consume the real duplicate-card lock',async()=>{
  const f=testScanFixture();
  try{
    f.render().setLastCardId(card.id);
    f.render().toggleFakeScan();f.refresh();
    await f.tick(reliableFrame(1));await f.tick(reliableFrame(2));assert.equal(f.fake.length,1);assert.equal(f.real.length,0);
    f.refresh({recognitionContext:'OGN:camera-1:database-1'});assert.equal(f.render().fakeScanResult,null);
    f.render().toggleAutoScan();let state=f.refresh();assert.equal(state.autoScanEnabled,true);assert.equal(state.fakeScanEnabled,false);
    await f.tick(reliableFrame(3));await f.tick(reliableFrame(4));assert.equal(f.real.length,1);assert.equal(f.fake.length,1);
    await f.tick(reliableFrame(5));await f.tick(null);await f.tick(reliableFrame(6));assert.equal(f.real.length,1);
    f.render().toggleFakeScan();state=f.refresh();assert.equal(state.autoScanEnabled,false);assert.equal(state.fakeScanEnabled,true);
  }finally{f.stop();}
});

test('auto-scan retries a rejected candidate and accepts a later clearer frame', async () => {
  let accepted = 0, rejected = 0;
  const fixture = autoFixture((result) => {
    if (result.similarity < 0.9) { rejected++; return false; }
    accepted++; return true;
  });
  const result = { cardData: card, confidence: 0.95, similarity: 0.86, matched: true, similarityGap: 0.08, quality: { acceptable: true, score: 0.8 } };
  for (let index = 0; index < 3; index++) await fixture.tick(result);
  assert.ok(rejected > 0);
  for (let index = 0; index < 5; index++) await fixture.tick({ ...result, similarity: 0.99 });
  assert.equal(accepted, 1);
});

test('accepted cards stay locked across disappearance until a different card is accepted', async () => {
  const accepted = [];
  const fixture = autoFixture((result) => { accepted.push(result.cardData.id); return true; });
  const result = { cardData: card, confidence: 0.99, similarity: 0.99, matched: true, similarityGap: 0.08, quality: { acceptable: true, score: 0.8 } };
  for (let i = 0; i < 3; i++) await fixture.tick(result);
  for (let i = 0; i < 5; i++) await fixture.tick(null);
  for (let i = 0; i < 3; i++) await fixture.tick(result);
  assert.deepEqual(accepted, [card.id]);
  for (let i = 0; i < 4; i++) await fixture.tick({ ...result, cardData: { ...card, id: 'other-card' } });
  assert.deepEqual(accepted, [card.id, 'other-card']);
});

test('stopping auto-scan discards an inference still in flight', async () => {
  let finish, accepted = 0, calls = 0;
  const fixture = autoFixture(() => { accepted++; return true; });
  const inFlight = fixture.tick(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  await fixture.tick(() => { calls++; return Promise.resolve(null); });
  assert.equal(calls, 1);
  fixture.stop();
  finish({ cardData: card, confidence: 0.99, similarity: 0.99, matched: true, similarityGap: 0.08, quality: { acceptable: true, score: 0.8 } });
  await inFlight;
  assert.equal(accepted, 0);
});


test('auto-scan never promotes a repeating ambiguous or unusable image', async () => {
  let accepted = 0;
  const fixture = autoFixture(() => { accepted++; return true; });
  const result = { cardData: card, confidence: 0.99, similarity: 0.952, matched: false,
    similarityGap: 0, quality: { acceptable: true, score: 0.8 } };
  for (let i = 0; i < 12; i++) await fixture.tick(result);
  for (let i = 0; i < 5; i++) await fixture.tick({ ...result, matched: true });
  for (let i = 0; i < 5; i++) await fixture.tick({ ...result, matched: true, similarityGap: 0.1, quality: { acceptable: false, score: 0.1 } });
  assert.equal(accepted, 0);
  for (let i = 0; i < 3; i++) await fixture.tick({ ...result, matched: true, similarity: 0.99, similarityGap: 0.08 });
  assert.equal(accepted, 1);
});

test('a buffered frame cannot count as multiple independent observations', async () => {
  let accepted = 0;
  const fixture = autoFixture(() => { accepted++; return true; });
  const result = { cardData: card, confidence: 0.99, similarity: 0.99, matched: true,
    similarityGap: 0.08, quality: { acceptable: true, score: 0.8 }, frameId: 10 };
  for (let i = 0; i < 10; i++) await fixture.tick(result);
  assert.equal(accepted, 0);
  await fixture.tick({ ...result, frameId: 11 });
  assert.equal(accepted, 1);
});

test('unclear observations break the streak of independent reliable matches', async () => {
  let accepted = 0;
  const fixture = autoFixture(() => { accepted++; return true; });
  const result = { cardData: card, confidence: 0.99, similarity: 0.99, matched: true,
    similarityGap: 0.08, quality: { acceptable: true, score: 0.8 } };
  await fixture.tick(result);
  await fixture.tick({ ...result, matched: false, similarityGap: 0 });
  await fixture.tick(result);
  assert.equal(accepted, 0);
  await fixture.tick(result);
  assert.equal(accepted, 1);
});

test('low-frame-rate capture can confirm independent frames without counting empty polls', async () => {
  let accepted = 0;
  const fixture = autoFixture(() => { accepted++; return true; });
  const result = { cardData: card, confidence: 0.99, similarity: 0.99, matched: true,
    similarityGap: 0.08, quality: { acceptable: true, score: 0.8 }, frameId: 1 };
  await fixture.tick(result);
  for (let i = 0; i < 3; i++) await fixture.tick({ skipped: true });
  assert.equal(accepted, 0);
  await fixture.tick({ ...result, frameId: 2 });
  assert.equal(accepted, 1);
});

test('a long capture interruption clears old uncommitted confirmation evidence', async () => {
  let accepted = 0;
  const fixture = autoFixture(() => { accepted++; return true; });
  const result = { cardData: card, confidence: 0.99, similarity: 0.99, matched: true,
    similarityGap: 0.08, quality: { acceptable: true, score: 0.8 }, frameId: 1 };
  await fixture.tick(result);
  for (let i = 0; i < 8; i++) await fixture.tick({ skipped: true });
  await fixture.tick({ ...result, frameId: 2 });
  assert.equal(accepted, 0);
  await fixture.tick({ ...result, frameId: 3 });
  assert.equal(accepted, 1);
});
