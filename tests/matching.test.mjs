import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describeFeatures, compareFeatures } from '../src/lib/cardSimilarity.js';
import { areaColorGrid } from '../src/lib/cardFeatures.js';
import { describeLocalArtwork, compareLocalArtwork, compareAlignedArtwork, hasLocalArtworkSupport } from '../src/lib/localArtwork.js';
import { isReliableScanResult } from '../src/lib/scanQuality.js';
import { createRuntime, nodes, button } from './helpers/runtime.mjs';

const pattern = new Float32Array([0.4, 0.5, 0.6, 0.6, 0.7, 0.8, 0.45, 0.55, 0.65, 0.65, 0.75, 0.85]);
const rearranged = new Float32Array([0.6, 0.7, 0.8, 0.4, 0.5, 0.6, 0.65, 0.75, 0.85, 0.45, 0.55, 0.65]);

test('aligned artwork uses one bounded shift at both detail scales and rejects missing or contradictory detail', () => {
  const size=16,original=Float32Array.from({length:size*size},(_,i)=>Math.sin(i*1.7)+Math.cos(i*.31));
  const norm=Math.hypot(...original);for(let i=0;i<original.length;i++)original[i]/=norm;
  const shifted=new Float32Array(size*size);
  for(let y=0;y<size;y++)for(let x=0;x<size-1;x++)shifted[y*size+x+1]=original[y*size+x];
  const result=compareAlignedArtwork(original,shifted,original,shifted,size);
  assert.ok(result.similarity>.999);assert.equal(result.dx,1);assert.equal(result.dy,0);assert.ok(result.overlap>=.75);
  const opposite=Float32Array.from(shifted,v=>-v);
  assert.ok(Math.abs(compareAlignedArtwork(original,shifted,original,opposite,size).similarity)<1e-6);
  assert.equal(compareAlignedArtwork(original,null,original,shifted,size),null);
  assert.equal(compareAlignedArtwork(new Float32Array(256),shifted,original,shifted,size),null);
  const evidence={localStructureSimilarity:.2,alignedArtworkSimilarity:.8,artworkAlignment:{dx:1,dy:0,overlap:.9375}};
  assert.equal(Boolean(hasLocalArtworkSupport(evidence)),true);
  for(const patch of [{alignedArtworkSimilarity:.64},{alignedArtworkSimilarity:Infinity},{artworkAlignment:null},
    {artworkAlignment:{dx:3,dy:0,overlap:.8}},{artworkAlignment:{dx:1,dy:0,overlap:.7}}])assert.equal(Boolean(hasLocalArtworkSupport({...evidence,...patch})),false);
});

test('local artwork detail ignores a smooth lighting plane and rejects detail-free input', () => {
  const source=new Float32Array(768),lit=new Float32Array(768),plane=new Float32Array(768);
  for(let y=0;y<16;y++)for(let x=0;x<16;x++)for(let c=0;c<3;c++){
    const i=(y*16+x)*3+c;source[i]=.3+((x*13+y*7+c*5)%31)/100;
    const light=.005*x+.003*y;lit[i]=source[i]+light;plane[i]=.3+light;
  }
  assert.ok(compareLocalArtwork(describeLocalArtwork(source,16),describeLocalArtwork(lit,16))>.99999);
  assert.equal(describeLocalArtwork(plane,16),null);
  assert.equal(describeLocalArtwork(new Float32Array(768).fill(.5),16),null);
});

test('deterministic artwork reduction agrees with independent OpenCV area averages', async () => {
  const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/area-grid-opencv.json',import.meta.url),'utf8'));
  for(const {width,height,gridSize,expected} of fixture.samples){
    const data=new Uint8ClampedArray(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set([(x*73+y*29)%256,((x^y)*13+x*7)%256,(x*3+y*y*11)%256,255],(y*width+x)*4);
    const actual=areaColorGrid({data,width,height},gridSize);
    assert.equal(actual.length,expected.length);
    for(let i=0;i<expected.length;i++)assert.ok(Math.abs(actual[i]*255-expected[i])<=1.00001,`${width}x${height}, channel ${i}`);
  }
});

test('similar colors cannot hide different spatial artwork patterns', () => {
  const correct = compareFeatures(pattern, pattern), different = compareFeatures(pattern, rearranged);
  assert.ok(different.colorSimilarity > 0.94);
  assert.ok(correct.similarity > 0.999);
  assert.ok(correct.similarity - different.similarity > 0.3);
});

test('centered structure comparison tolerates a channel-specific lighting offset', () => {
  const shifted = pattern.map((value, index) => value + [0.1, -0.1, 0.05][index % 3]);
  const result = compareFeatures(pattern, shifted);
  assert.ok(result.structureSimilarity > 0.999);
  assert.ok(result.similarity > 0.98);
});

test('blank and invalid inputs never produce a confident artwork score', () => {
  for (const blank of [new Float32Array(12), new Float32Array(12).fill(0.8),
    new Float32Array([0.3, 0.5, 0.7, 0.3, 0.5, 0.7]), [NaN, 1, 1], []]) {
    const result = compareFeatures(pattern, blank);
    assert.equal(result.similarity, 0);
    assert.ok(Number.isFinite(result.similarity));
  }
  assert.equal(describeFeatures([0.1, Infinity, 0.5]), null);
  for (const value of [0.2, 0.7, 0.8, 1]) {
    const blank = new Float32Array(768).fill(value);
    assert.equal(compareFeatures(blank, blank).similarity, 0);
  }
});

function matcherFixture() {
  const Matcher = createRuntime().load('src/lib/cardMatcher.js').default;
  const matcher = new Matcher();
  matcher._applyDatabase({ gridSize: 2, cards: [
    { id: 'correct', set: 'RAD', f: pattern }, { id: 'similar-colors', set: 'OGN', f: rearranged },
  ] });
  matcher._cropArtwork = (canvas) => canvas;
  matcher._computeColorGrid = () => pattern;
  return matcher;
}

test('camera top-two and photo ranking use one score, with set filtering', () => {
  const matcher = matcherFixture();
  const result = matcher.identify({});
  const ranked = matcher.rank({}, { limit: 3 });
  assert.equal(result.card.id, 'correct');
  assert.equal(result.similarity, ranked[0].similarity);
  assert.equal(result.secondBestSim, ranked[1].similarity);
  assert.equal(matcher.rank({}, { setFilter: ['OGN'] })[0].card.id, 'similar-colors');
  assert.equal(matcher.rank({}, { setFilter: ['UNKNOWN'] }).length, 0);
});

test('identical artwork variants stay ambiguous under the new score', () => {
  const matcher = matcherFixture();
  matcher._applyDatabase({ gridSize: 2, cards: [
    { id: 'a', set: 'RAD', f: pattern }, { id: 'b', set: 'RAD', f: pattern },
  ] });
  const result = matcher.identify({});
  assert.equal(result.similarity - result.secondBestSim, 0);
  assert.equal(isReliableScanResult({ cardData: result.card, matched: true, quality: { acceptable: true },
    similarity: result.similarity, similarityGap: result.similarity - result.secondBestSim }, 0.9), false);
});

test('debug view names an ambiguous candidate without calling it accepted', () => {
  const runtime = createRuntime({ storage: { riftbound_scanner_debug_overlay_enabled: true } });
  const view = runtime.mount(runtime.load('src/components/scanner/ScannerCamera.jsx').default);
  const tree = view.render({ videoRef: { current: null }, isActive: true, lastDetection: {
    cardData: { id: 'rad-099-167', name: 'Suave Negotiator', code: 'RAD-099/167' },
    observedAt: Date.now(), matched: false, reason: 'ambiguous', similarity: 0.97, similarityGap: 0.035,
    minSimilarity: 0.9, minSimilarityGap: 0.05,
  } });
  const content = nodes(tree, (node) => node.props?.children).flatMap((node) => node.props.children.flat(Infinity))
    .filter((value) => typeof value === 'string').join(' ');
  assert.match(content, /Candidate · not accepted/);
  assert.match(content, /Suave Negotiator/);
  assert.match(content, /Too close to another card/);
  assert.match(content, /3.5/);
  assert.doesNotMatch(content, /Matched frame|No card locked yet/);
});

test('manual card search retains set filtering after sharing photo matching', () => {
  const runtime = createRuntime();
  const matcher = runtime.load('src/lib/cardMatcher.js').getMatcher();
  matcher._applyDatabase({ gridSize: 2, cards: [
    { id: 'rad-099-167', name: 'Suave Negotiator', set: 'RAD', f: pattern },
    { id: 'other-set', name: 'Suave Other Set', set: 'OGN', f: rearranged },
  ] });
  const view = runtime.mount(runtime.load('src/components/scan/ScanTab.jsx').default);
  const props = { camera: { isActive: false }, detection: {}, pendingCards: [], recentPendingScanEvents: [],
    scanSetOptions: [], scanSetFilter: ['RAD'], batchDefaults: { foil: false }, minConfidence: 0.9 };
  const input = nodes(view.render(props), (node) => node.type === 'input' && node.props.placeholder === 'Search by name or ID')[0];
  input.props.onChange({ target: { value: 'suave' } });
  const content = nodes(view.render(props), (node) => node.props?.children)
    .flatMap((node) => node.props.children.flat(Infinity)).filter((value) => typeof value === 'string').join(' ');
  assert.match(content, /Suave Negotiator/);
  assert.doesNotMatch(content, /Suave Other Set/);
});

test('native frame export records capture and recognition IDs separately and saves only after an explicit click', async () => {
  const calls=[],bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
  const runtime=createRuntime({storage:{riftbound_scanner_debug_overlay_enabled:true},globals:{__TAURI_INTERNALS__:{}},
    mocks:{'@tauri-apps/api/core':{invoke:async(command,payload)=>{calls.push({command,payload});return{path:'C:/frames/a.png',diagnosticsPath:'C:/frames/a.json',diagnosticsError:null};}}}});
  const frame={width:806,height:1080,frameId:12,capturedAt:1500,toBlob:done=>done({arrayBuffer:async()=>bytes.buffer})};
  const detection={frameId:11,matched:false,reason:'reading-text',cardData:{id:'suave',name:'Suave Negotiator',code:'RAD-099/167',privateCollection:'not exported'},textVerification:{status:'pending',sourceFrameIds:[]}};
  const screen=runtime.mount(runtime.load('src/components/scanner/ScannerCamera.jsx').default);
  const props={videoRef:{current:null},isActive:true,captureFrame:()=>frame,lastDetection:detection,autoScanEnabled:false};
  const tree=screen.render(props);assert.equal(calls.length,0);await button(tree,'Save native frame').onClick();
  assert.equal(calls.length,1);assert.equal(calls[0].command,'save_native_frame');
  const details=calls[0].payload.diagnostics;assert.equal(details.capture.frameId,12);assert.equal(details.recognition.frameId,11);
  assert.equal(details.mode,'debug-preview');assert.equal(details.recognition.reason,'reading-text');
  assert.equal(details.recognition.card.privateCollection,undefined);
  assert.deepEqual(Array.from(calls[0].payload.png),Array.from(bytes));
  const text=nodes(screen.render(props),node=>node.props?.children).flatMap(node=>node.props.children.flat(Infinity)).filter(value=>typeof value==='string').join(' ');
  assert.match(text,/Scan details saved beside the image/);
});

test('debug is a real auto-scan view with capture status, source evidence and session-only overrides', () => {
  let enabled, patch, intervals=0;
  const runtime=createRuntime({globals:{setInterval:()=>{intervals++;return 1;}}});
  const view=runtime.mount(runtime.load('src/components/scanner/ScannerCamera.jsx').default);
  const snap=()=>{throw new Error('Debug must not use the real snap handler');};
  const detection={cardData:{id:'rad-099-167',name:'Suave Negotiator',code:'RAD-099/167'},frameId:11,matched:false,
    similarity:.71,similarityGap:-.12,reason:'reading-text',textVerification:{status:'pending',sourceFrameIds:[9]},
    acceptanceDecision:{eligible:false,reason:'reading-text'},quality:{acceptable:true,sharpness:.12}};
  const props={videoRef:{current:null},isActive:true,debugEnabled:true,autoScanEnabled:true,lastDetection:detection,onSnapScan:snap,
    onDebugChange:value=>enabled=value,captureFrame:()=>({}),detectSingleFrame:async()=>null,
    scannerExperiments:{perspective:true,textVerification:true},onUpdateScannerExperiments:value=>patch=value,
    debugCapture:{status:'saved',card:detection.cardData,frameId:10,path:'C:/debug-scans/source.png'}};
  const tree=view.render(props);view.runEffects();
  const content=nodes(tree,node=>node.props?.children).flatMap(node=>node.props.children.flat(Infinity)).filter(value=>typeof value==='string').join(' ');
  assert.match(content,/Debug auto-scan/);assert.match(content,/Suave Negotiator/);assert.match(content,/Debug capture saved/);
  assert.doesNotMatch(content,/Fake scan|fake scan|Preview only|Minimum similarity/);
  assert.equal(nodes(tree,node=>node.props?.onClick===snap).length,0);assert.equal(intervals,0,'The shared auto loop owns detection');
  assert.equal(nodes(tree,node=>node.props?.title==='Auto-scan is active while debug is on')[0].props.disabled,true);
  nodes(tree,node=>node.props?.['aria-label']==='Perspective correction')[0].props.onClick();assert.equal(patch.perspective,false);
  nodes(tree,node=>node.props?.['aria-label']==='Debug overlay')[0].props.onClick();assert.equal(enabled,false);
});
