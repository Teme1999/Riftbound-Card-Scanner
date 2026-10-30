import test from 'node:test';
import assert from 'node:assert/strict';
import { findCardQuad, cardHomography, projectCardPoint, warpCard, validCardQuad } from '../src/lib/cardPerspective.js';
import { normalizeScannerExperiments } from '../src/lib/scannerExperiments.js';
import { createRuntime } from './helpers/runtime.mjs';

const bounds = { width: 340, height: 470 }, rect = { x: 40, y: 40, width: 260, height: 380 };
const tilted = [{ x: 56, y: 39 }, { x: 287, y: 55 }, { x: 310, y: 421 }, { x: 28, y: 409 }];
export function syntheticCard(quad = tilted, { occlude = false, glare = false, background = false } = {}) {
  const data = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  const inside = (x, y) => quad.every((p, i) => {
    const q = quad[(i + 1) % 4]; return (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x) >= 0;
  });
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const offset = (y * bounds.width + x) * 4;
    let color = inside(x, y) ? [200, 190, 175] : [25, 28, 32];
    if (inside(x, y) && x > 90 && x < 250 && y > 130 && y < 320) color = [(x * 7 + y * 3) % 180, (x * 3 + y * 5) % 170, 130];
    if (occlude && x < 80 && y > 180 && y < 270) color = [150, 90, 65];
    if (glare && (x - 210) ** 2 + (y - 140) ** 2 < 1700) color = [255, 255, 255];
    if (background) color = [25, 28, 32];
    data.set([...color, 255], offset);
  }
  return { ...bounds, data };
}

test('deterministic edge fitting recovers four true perspective corners', () => {
  for (const options of [{}, { occlude: true }, { glare: true }]) {
    const image = syntheticCard(tilted, options), result = findCardQuad(image, rect);
    assert.equal(result.status, 'corrected');
    for (let i = 0; i < 4; i++) assert.ok(Math.hypot(result.quad[i].x - tilted[i].x, result.quad[i].y - tilted[i].y) < 4, JSON.stringify(result));
    assert.deepEqual(findCardQuad(image, rect), result);
  }
});

test('geometry shortlist is bounded, distinct, deterministic and keeps every original geometry guard', () => {
  const image = syntheticCard(tilted, { glare: true });
  const result = findCardQuad(image, rect, { limit: 4 });
  assert.deepEqual(findCardQuad(image, rect, { limit: 4 }), result);
  assert.ok((result.alternatives || []).length <= 3);
  for (const candidate of [result, ...(result.alternatives || [])]) {
    assert.ok(validCardQuad(candidate.quad, image, rect.width * rect.height));
    assert.ok(candidate.support.every(value => value >= .6));
  }
  const straight = [{ x:40,y:40 },{ x:300,y:40 },{ x:300,y:420 },{ x:40,y:420 }];
  assert.equal(findCardQuad(syntheticCard(straight), rect, { limit: 4 }).status, 'unchanged');
  assert.equal(findCardQuad(syntheticCard(tilted, { background: true }), rect, { limit: 4 }).status, 'uncertain');
});

test('straight cards avoid resampling and absent edges keep the original crop', () => {
  const straight = [{ x:40,y:40 },{ x:300,y:40 },{ x:300,y:420 },{ x:40,y:420 }];
  assert.equal(findCardQuad(syntheticCard(straight), rect).status, 'unchanged');
  assert.equal(findCardQuad(syntheticCard(tilted, { background: true }), rect).status, 'uncertain');
});

test('an inset parallel printed frame cannot replace the physical card or remove its footer', () => {
  const image=syntheticCard(tilted,{background:true});
  // The physical border has insufficient contrast; only its printed inner
  // rectangle is visible. That is not enough evidence to warp a whole card.
  for(let y=58;y<402;y++)for(let x=58;x<282;x++)image.data.set([200,190,175,255],(y*image.width+x)*4);
  const result=findCardQuad(image,rect);
  assert.equal(result.status,'uncertain');assert.equal(result.reason,'no-perspective-evidence');
  assert.equal(result.quad,undefined);
});

test('homography maps all four corners and produces the bounded card aspect ratio', () => {
  const matrix = cardHomography(tilted);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const point = projectCardPoint(matrix, u, v);
    assert.ok(Math.hypot(point.x - tilted[i].x, point.y - tilted[i].y) < 1e-7);
  });
  const warped = warpCard(syntheticCard(), tilted);
  assert.ok(warped.width <= 720);
  assert.ok(Math.abs(warped.width / warped.height - 63 / 88) < 0.002);
  assert.ok(warped.data.every(Number.isFinite));
  assert.equal(validCardQuad([tilted[0], tilted[2], tilted[1], tilted[3]], bounds, 260 * 380), false);
  assert.equal(validCardQuad(tilted.map((p) => ({ x: p.x - 100, y: p.y })), bounds, 260 * 380), false);
});

test('recognition features start enabled and only explicit diagnostic false values disable them', () => {
  assert.deepEqual(normalizeScannerExperiments(null), { perspective: true, textVerification: true });
  assert.deepEqual(normalizeScannerExperiments({ perspective: 'true', textVerification: 1 }), { perspective: true, textVerification: true });
});

test('refinement falls back safely and two strong conflicting crops cannot auto-confirm', async () => {
  const context = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 88 * 4).map((_, i) => i % 9 ? 50 : 210), width: 64, height: 88 }) };
  const runtime = createRuntime({ globals: { document: { createElement: () => ({ getContext: () => context }) } } });
  const { recognizeCard, buildRecognitionResult } = runtime.load('src/lib/cardRecognition.js');
  const original = { width: 300, height: 420 }, corrected = { width: 300, height: 420 };
  const matcher = { ready: true, identify: (canvas) => ({ card: { id: canvas === original ? 'a' : 'b' }, similarity: .99, secondBestSim: .7 }) };
  const input = { detection: { cropCanvas: original, box: {} }, matcher, minSimilarity: .9 };
  const fallback = await recognizeCard({ ...input, cropRefiner: async () => ({ status: 'uncertain' }) });
  assert.equal(fallback.crop, original);
  const conflict = await recognizeCard({ ...input, cropRefiner: async () => ({ canvas: corrected, status: 'corrected' }) });
  assert.equal(conflict.geometryConflict, true);
  assert.equal(buildRecognitionResult(conflict.match, conflict.quality, .9, conflict).matched, false);
});

test('OCR keeps its original source even when a different crop wins the artwork comparison', async () => {
  const context={drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(64*88*4).map((_,i)=>i%9?50:210),width:64,height:88})};
  const runtime=createRuntime({globals:{document:{createElement:()=>({getContext:()=>context})}}});
  const {recognizeCard}=runtime.load('src/lib/cardRecognition.js');
  const original={width:300,height:420},corrected={width:300,height:420};
  const matcher={ready:true,rank:canvas=>[{card:{id:'suave'},similarity:canvas === corrected ? .87 : .85},{card:{id:'other'},similarity:.7}]};
  const result=await recognizeCard({detection:{cropCanvas:original,box:{}},matcher,candidates:true,cropRefiner:async()=>({canvas:corrected,status:'corrected'})});
  assert.equal(result.crop,corrected);assert.equal(result.textCrop,original);
  assert.equal(result.alternateTextCrops.length,1);assert.equal(result.alternateTextCrops[0],corrected);
});

test('a later geometry hypothesis can recover artwork but disagreement between any strong crops remains blocked', async () => {
  const context = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 88 * 4).map((_, i) => i % 9 ? 50 : 210), width: 64, height: 88 }) };
  const runtime = createRuntime({ globals: { document: { createElement: () => ({ getContext: () => context }) } } });
  const { recognizeCard, buildRecognitionResult } = runtime.load('src/lib/cardRecognition.js');
  const original = { width:300,height:420 }, first = { width:300,height:420 }, second = { width:300,height:420 };
  let conflict = false;
  const matcher = { ready:true,rank:crop => [{card:{id:conflict && crop === first ? 'wrong' : 'correct'},similarity:crop === second ? .98 : conflict && crop === first ? .97 : .80,secondBestSim:.6,localStructureSimilarity:crop === second ? .9 : .4}] };
  const options = { detection:{cropCanvas:original,box:{}},matcher,candidates:true,cropRefiner:async()=>({canvas:first,status:'corrected',quad:['first'],alternatives:[{canvas:second,status:'corrected',quad:['second']}]}) };
  const recovered = await recognizeCard(options);
  assert.equal(recovered.crop,second); assert.deepEqual(recovered.refinement.quad,['second']);
  assert.equal(recovered.textCrop,original); assert.equal(recovered.alternateTextCrops[0],second);
  assert.equal(buildRecognitionResult(recovered.match,recovered.quality,.9,recovered).matched,true);
  conflict = true;
  const blocked = await recognizeCard(options);
  assert.equal(blocked.geometryConflict,true);
  assert.equal(buildRecognitionResult(blocked.match,blocked.quality,.9,blocked).matched,false);
  assert.deepEqual(new Set(blocked.match.candidates.map(entry=>entry.card.id)),new Set(['correct','wrong']));
});
