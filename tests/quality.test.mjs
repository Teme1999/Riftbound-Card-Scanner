import test from 'node:test';
import assert from 'node:assert/strict';
import { measureImageQuality, BestFrameBuffer, frameDifference, isReliableScanResult, getScanGuidance, isScanFrameCancelled } from '../src/lib/scanQuality.js';
import { getScanGuide, getVideoScanRegion, selectGuideDetection, mapDetectionBox, getDetectorLetterbox } from '../src/lib/scanGeometry.js';
import { openCameraStream, applyCameraAutoModes, supportsTorch, normalizeCameraProfile } from '../src/lib/cameraControls.js';
import { createRuntime, componentProps } from './helpers/runtime.mjs';

function pixels(fn, width = 64, height = 88) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, value = fn(x, y);
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
  return { data, width, height };
}
const textured = () => pixels((x, y) => (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 190 : 40);
const fakeCanvasContext = (sample = textured()) => ({ drawImage() {}, translate() {}, rotate() {}, getImageData: () => sample });
const canvasDocument = (sample) => ({ createElement: () => ({ width: 0, height: 0, getContext: () => fakeCanvasContext(sample) }) });

test('equivalent portrait OBB axes produce portrait crops for artwork matching', () => {
  const runtime = createRuntime({ globals: { document: canvasDocument() } });
  const Detector = runtime.load('src/lib/yoloDetector.js').default;
  const detector = new Detector();
  for (const [width, height, angle] of [[360, 504, 0], [504, 360, Math.PI / 2]]) {
    const crop = detector._cropRotated({ width:480, height:640 }, 480, 640, 240, 320, width, height, angle);
    assert.equal(crop.width, 360);
    assert.equal(crop.height, 504);
  }
});

test('quality analysis distinguishes severe darkness, clipping and lack of detail', () => {
  for (const [value, issue] of [[0, 'too-dark'], [255, 'too-bright'], [100, 'blurred']]) {
    const result = measureImageQuality(pixels(() => value), 300, 420);
    assert.equal(result.issue, issue);
    assert.equal(result.acceptable, false);
  }
  assert.equal(measureImageQuality(textured(), 300, 420).acceptable, true);
});

test('dark artwork with visible detail is not rejected just for being dark', () => {
  const result = measureImageQuality(pixels((x, y) => (x % 12 < 4 && y % 12 < 4) ? 150 : 12), 300, 420);
  assert.equal(result.acceptable, true);
  assert.notEqual(result.issue, 'too-dark');
});

test('tiny crops request a closer card and reflected light remains advisory', () => {
  assert.equal(measureImageQuality(textured(), 40, 60).issue, 'too-small');
  const reflected = measureImageQuality(pixels((x, y) => x < 24 && y < 24 ? 255 : ((x + y) % 4 ? 60 : 100)), 300, 420);
  assert.equal(reflected.issue, null);
  assert.equal(reflected.reflectionRisk, true);
  assert.equal(reflected.acceptable, true);
});

test('brightness adjustment alone is not mistaken for card movement', () => {
  assert.equal(frameDifference([10, 20, 40, 70], [40, 50, 70, 100]), 0);
  assert.ok(frameDifference([0, 255, 0, 255], [255, 0, 255, 0]) > 0.1);
});

const buffered = (capturedAt, score, fingerprint = [0, 255, 0, 255], layoutKey = 'same') => ({
  canvas: {}, capturedAt, layoutKey, quality: { score, fingerprint },
});

test('frame selection picks the best recent image and expires old images', () => {
  const buffer = new BestFrameBuffer();
  const sharp = buffered(0, 0.9), blurred = buffered(100, 0.3);
  buffer.add(sharp); buffer.add(blurred);
  assert.equal(buffer.best(150), sharp);
  assert.equal(buffer.best(451), null);
});

test('card movement or a layout change invalidates older in-flight images', () => {
  const buffer = new BestFrameBuffer();
  const old = buffered(0, 1), next = buffered(100, 0.5, [255, 0, 255, 0]);
  buffer.add(old); buffer.add(next);
  assert.equal(old.canvas.scanCancelled, true);
  assert.equal(buffer.best(100), next);
  assert.equal(next.moving, true);
  const resized = buffered(150, 0.5, next.quality.fingerprint, 'new-layout');
  buffer.add(resized);
  assert.equal(next.canvas.scanCancelled, true);
  assert.equal(buffer.frames.length, 1);
});

test('motion also invalidates an in-flight source that has aged out of the three-frame buffer',()=>{
  const buffer=new BestFrameBuffer(),old=buffered(0,1);
  buffer.add(old);buffer.add(buffered(400,.8));
  assert.equal(buffer.frames.includes(old),false);assert.equal(isScanFrameCancelled(old.canvas),false);
  buffer.add(buffered(500,.8,[255,0,255,0]));
  assert.equal(isScanFrameCancelled(old.canvas),true);
});

test('a stable new frame takes precedence over the moving frame', () => {
  const buffer = new BestFrameBuffer();
  buffer.add(buffered(0, 1));
  const moving = buffered(100, 0.9, [255, 0, 255, 0]);
  const stable = buffered(200, 0.85, moving.quality.fingerprint);
  buffer.add(moving); buffer.add(stable);
  assert.equal(buffer.best(200), stable);
});

test('object-cover guide mapping excludes hidden webcam areas and preserves coordinates', () => {
  const region = getVideoScanRegion(1920, 1080, 360, 640);
  const guide = getScanGuide(360, 640);
  const scale = 640 / 1080, offset = (360 - 1920 * scale) / 2;
  assert.ok(region.x > 500);
  assert.ok(region.x + region.width < 1400);
  assert.ok(Math.abs((region.x + region.guide.x) * scale + offset - guide.x) < 1e-6);
  assert.ok(Math.abs(region.guide.width * scale - guide.width) < 1e-6);
  const local = { cx: 200, cy: 300, w: 100, h: 140, angle: 0.2 };
  const mapped = mapDetectionBox(local, region);
  assert.equal(mapped.cx, local.cx + region.x);
  assert.equal(mapped.cy, local.cy + region.y);
  assert.equal(mapped.angle, local.angle);
});

test('guide selection favors the intended card over a confident off-center card', () => {
  const guide = { x: 100, y: 100, width: 200, height: 280 };
  const offscreen = { confidence: 0.99, box: { cx: 50, cy: 240 } };
  const edge = { confidence: 0.99, box: { cx: 105, cy: 105 } };
  const centered = { confidence: 0.8, box: { cx: 200, cy: 240 } };
  assert.equal(selectGuideDetection([offscreen, edge, centered], guide), centered);
  assert.equal(selectGuideDetection([offscreen], guide), null);
});

test('camera context padding preserves inverse detector coordinates and the upload scale', () => {
  for (const contextScale of [1, 0.85]) {
    const transform = getDetectorLetterbox(538, 720, 640, contextScale);
    const inputX = 269 * transform.scale + transform.padX;
    const inputY = 360 * transform.scale + transform.padY;
    assert.ok(Math.abs((inputX - transform.padX) / transform.scale - 269) < 1e-6);
    assert.ok(Math.abs((inputY - transform.padY) / transform.scale - 360) < 1e-6);
  }
  assert.equal(getDetectorLetterbox(538, 720, 640).newH, 640);
  assert.equal(getDetectorLetterbox(538, 720, 640, 0.85).newH, 544);
});

test('a high similarity cannot override ambiguity or a failed quality gate', () => {
  const result = { cardData: { id: 'card' }, matched: true, similarity: 0.99, similarityGap: 0.08, quality: { acceptable: true } };
  assert.equal(isReliableScanResult(result, 0.9), true);
  assert.equal(isReliableScanResult({ ...result, similarityGap: 0 }), false);
  assert.equal(isReliableScanResult({ ...result, matched: false }), false);
  assert.equal(isReliableScanResult({ ...result, quality: { acceptable: false } }), false);
  assert.equal(isReliableScanResult({ ...result, similarity: Infinity }), false);
});

test('guidance uses recent card quality and discards stale observations', () => {
  const last = { observedAt: 100, reason: 'ambiguous' };
  assert.equal(getScanGuidance(null, last, 200).issue, 'ambiguous');
  assert.equal(getScanGuidance(null, { ...last, quality: { reflectionRisk: true } }, 200).issue, 'glare');
  assert.equal(getScanGuidance({ issue: 'too-dark' }, last, 2000).issue, 'too-dark');
  assert.equal(getScanGuidance({ issue: 'too-dark' }, { observedAt: 100, reason: 'outside-guide' }, 200).issue, 'too-dark');
  assert.equal(getScanGuidance({ issue: 'moving' }, { observedAt: 100, matched: true }, 200).issue, 'moving');
});

test('pending text confirmation asks for a steady card instead of moving an already readable candidate',()=>{
  const pending={observedAt:100,matched:false,reason:'low-similarity',quality:{acceptable:true},
    textVerification:{status:'pending',artworkFallbackAllowed:true,confirmedReads:1}};
  assert.equal(getScanGuidance(null,pending,200).issue,'reading-text');
  assert.equal(getScanGuidance({issue:'moving'},pending,200).issue,'moving');
  assert.equal(getScanGuidance(null,{...pending,reason:'text-conflict',textVerification:{status:'conflict'}},200).issue,'text-conflict');
});

test('camera profiles negotiate format hints and retain the selected camera on fallback', async () => {
  const requests = [];
  const media = { getUserMedia: async (request) => {
    requests.push(request);
    if (requests.length === 1) throw Object.assign(new Error('format'), { name: 'OverconstrainedError' });
    return 'stream';
  } };
  assert.equal(await openCameraStream(media, { deviceId: 'usb-camera', profile: 'low-light' }), 'stream');
  assert.equal(requests[0].video.frameRate.ideal, 15);
  assert.equal(requests[1].video.deviceId.exact, 'usb-camera');
  assert.equal(requests[1].video.width, undefined);
  assert.equal(normalizeCameraProfile('old-setting'), 'auto');
});

test('permission denial never causes a second camera request', async () => {
  let calls = 0;
  const media = { getUserMedia: async () => { calls++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } };
  await assert.rejects(openCameraStream(media, { profile: 'auto' }), /denied/);
  assert.equal(calls, 1);
});

test('unsupported or rejected camera controls do not prevent other automatics', async () => {
  const applied = [];
  const track = { getCapabilities: () => ({ focusMode: ['continuous'], exposureMode: ['continuous'], whiteBalanceMode: ['continuous'] }),
    applyConstraints: async (constraint) => { const property = Object.keys(constraint.advanced[0])[0]; applied.push(property); if (property === 'focusMode') throw new Error('driver'); },
    getSettings: () => ({ width: 1280, height: 720, frameRate: 15 }) };
  assert.equal((await applyCameraAutoModes(track)).width, 1280);
  assert.deepEqual(applied, ['focusMode', 'exposureMode', 'whiteBalanceMode']);
  assert.deepEqual(await applyCameraAutoModes({}), {});
  assert.equal(supportsTorch({ torch: [false] }), false);
  assert.equal(supportsTorch({ torch: [false, true] }), true);
});

test('camera capture maps the guide to native pixels and stopping invalidates buffered images', async () => {
  let stopped = 0;
  const track = { stop: () => { stopped++; }, getCapabilities: () => ({}), getSettings: () => ({ width: 1920, height: 1080 }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const runtime = createRuntime({ globals: { navigator: { mediaDevices: { getUserMedia: async () => stream } }, document: canvasDocument(textured()) } });
  const hook = runtime.mount(runtime.load('src/hooks/useCamera.js').useCamera);
  let camera = hook.render({ profile: 'auto' });
  camera.videoRef.current = { videoWidth: 1920, videoHeight: 1080, clientWidth: 360, clientHeight: 640, currentTime: 1, play: async () => {} };
  await camera.startCamera();
  camera = hook.render({ profile: 'auto' });
  const frame = camera.captureFrame();
  assert.ok(frame.width < 1000);
  assert.equal(frame.scanRegion.sourceWidth, 1920);
  assert.ok(frame.frameId > 0);
  assert.equal(camera.settings.width, 1920);
  camera.stopCamera();
  camera = hook.render({ profile: 'auto' });
  assert.equal(camera.captureFrame(), null);
  assert.equal(frame.scanCancelled, true);
  assert.equal(stopped, 1);
});

test('stopping a camera while permission is pending closes the late stream', async () => {
  let resolveStream, stopped = 0;
  const track = { stop: () => { stopped++; } };
  const runtime = createRuntime({ globals: { navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { resolveStream = resolve; }) } } } });
  const hook = runtime.mount(runtime.load('src/hooks/useCamera.js').useCamera);
  const camera = hook.render();
  const pending = camera.startCamera();
  camera.stopCamera();
  resolveStream({ getTracks: () => [track] });
  await pending;
  assert.equal(hook.render().isActive, false);
  assert.equal(stopped, 1);
});

test('a frozen webcam cannot manufacture fresh observations after its buffer expires', async () => {
  let now = 0;
  const track = { stop() {}, getSettings: () => ({}), getCapabilities: () => ({}) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const runtime = createRuntime({ globals: { Date: class extends Date { static now() { return now; } },
    navigator: { mediaDevices: { getUserMedia: async () => stream } }, document: canvasDocument(textured()) } });
  const hook = runtime.mount(runtime.load('src/hooks/useCamera.js').useCamera);
  let camera = hook.render();
  camera.videoRef.current = { videoWidth: 640, videoHeight: 480, clientWidth: 360, clientHeight: 640, currentTime: 1, play: async () => {} };
  await camera.startCamera();
  camera = hook.render();
  assert.ok(camera.captureFrame());
  now = 1000;
  assert.equal(camera.captureFrame(), null);
});

async function detectionFixture(sample = textured()) {
  let matcherCalls = 0, detectionCalls = 0;
  const crop = { width: 300, height: 420 };
  const detector = { state: 'ready', initialize: async () => {}, detect: async () => {
    detectionCalls++;
    return [{ confidence: 0.99, box: { cx: 20, cy: 40, w: 300, h: 420, angle: 0 }, cropCanvas: crop },
      { confidence: 0.9, box: { cx: 250, cy: 350, w: 300, h: 420, angle: 0 }, cropCanvas: crop }];
  } };
  const matcher = { ready: true, identify: () => { matcherCalls++; return { card: { id: 'correct', name: 'Correct', code: 'FIX-001/100' }, similarity: 0.96, secondBestSim: 0.87 }; } };
  const runtime = createRuntime({ globals: { document: canvasDocument(sample) }, mocks: {
    'src/lib/yoloDetector.js': { getDetector: () => detector, DetectorState: { READY: 'ready', UNLOADED: 'unloaded', LOADING: 'loading', ERROR: 'error' } },
    'src/lib/cardMatcher.js': { getMatcher: () => matcher },
  } });
  const hook = runtime.mount(runtime.load('src/hooks/useCardDetection.js').useCardDetection);
  let detection = hook.render({ minSimilarity: 0.9 });
  await detection.initDetector();
  detection = hook.render({ minSimilarity: 0.9 });
  const frame = { width: 800, height: 900, frameId: 1, capturedAt: Date.now(),
    scanRegion: { x: 400, y: 100, guide: { x: 100, y: 100, width: 300, height: 500 } } };
  return { hook, detection, frame, matcher, detector, get matcherCalls() { return matcherCalls; }, get detectionCalls() { return detectionCalls; } };
}

test('the camera detection path chooses the guide card and maps its overlay back to the full video', async () => {
  const fixture = await detectionFixture();
  const result = await fixture.detection.detectSingleFrame(() => fixture.frame);
  assert.equal(result.cardData.id, 'correct');
  assert.equal(result.box.cx, 650);
  assert.equal(result.box.cy, 450);
  assert.equal(result.confidence, 0.9);
  assert.equal(result.frameId, 1);
  assert.equal(result.matched, true);
  assert.equal(result.quality.acceptable, true);
});

test('an unusably dark detected card is rejected before matching', async () => {
  const fixture = await detectionFixture(pixels(() => 0));
  assert.equal(await fixture.detection.detectSingleFrame(() => fixture.frame, { includeCandidate: true }), null);
  assert.equal(fixture.matcherCalls, 0);
  assert.equal(fixture.hook.render().lastDetection.reason, 'too-dark');
});

test('severe frame darkness and movement avoid unnecessary detector retries', async () => {
  const fixture = await detectionFixture();
  fixture.frame.scanQuality = { issue: 'too-dark' };
  assert.equal(await fixture.detection.detectSingleFrame(() => fixture.frame), null);
  assert.equal(fixture.detectionCalls, 0);
  fixture.frame.scanQuality = { issue: null };
  fixture.frame.scanMoving = true;
  assert.equal(await fixture.detection.detectSingleFrame(() => fixture.frame), null);
  assert.equal(fixture.detectionCalls, 0);
});

test('near-identical candidates stay ambiguous even with a high similarity', async () => {
  const fixture = await detectionFixture();
  fixture.matcher.identify = () => ({ card: { id: 'unclear', name: 'Unclear' }, similarity: 0.952, secondBestSim: 0.952 });
  const result = await fixture.detection.detectSingleFrame(() => fixture.frame, { includeCandidate: true });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(isReliableScanResult(result), false);
});

test('parallel callers cannot start a second inference, and cancelled frames are discarded', async () => {
  const fixture = await detectionFixture();
  let finish, calls = 0;
  fixture.detector.detect = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const pending = fixture.detection.detectSingleFrame(() => fixture.frame);
  assert.equal(await fixture.detection.detectSingleFrame(() => fixture.frame), null);
  assert.equal(calls, 1);
  fixture.frame.scanCancelled = true;
  finish([]);
  assert.equal(await pending, null);
  assert.equal(fixture.matcherCalls, 0);
});

test('capture profiles are kept separately for each selected camera', () => {
  const runtime = createRuntime({ storage: { riftbound_camera_profiles: { cameraA: 'balanced' } } });
  const app = runtime.mount(runtime.load('src/App.jsx').default, [false]);
  componentProps(app.render(), 'BottomTabBar').onTabChange('settings');
  let settings = componentProps(app.render(), 'SettingsTab');
  settings.onUpdateCameraDeviceId('cameraA');
  settings = componentProps(app.render(), 'SettingsTab');
  assert.equal(settings.cameraProfile, 'balanced');
  settings.onUpdateCameraDeviceId('cameraB');
  settings = componentProps(app.render(), 'SettingsTab');
  assert.equal(settings.cameraProfile, 'auto');
  settings.onUpdateCameraProfile('low-light');
  settings = componentProps(app.render(), 'SettingsTab');
  assert.equal(settings.cameraProfile, 'low-light');
  settings.onUpdateCameraDeviceId('cameraA');
  assert.equal(componentProps(app.render(), 'SettingsTab').cameraProfile, 'balanced');
});
