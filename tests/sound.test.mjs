import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanSoundPlayer, normalizeScanSound, SCAN_SOUND_STORAGE_KEY } from '../src/lib/scanSound.js';
import { createRuntime, componentProps, nodes, button } from './helpers/runtime.mjs';

class AudioContextFixture {
  constructor() { this.state = 'suspended'; this.currentTime = 1; this.destination = {}; this.oscillators = []; this.gains = []; this.resumes = 0; }
  async resume() { this.resumes++; this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createOscillator() {
    const oscillator = { frequency:{setValueAtTime(value,time){this.value=value;this.time=time;}},
      connect() {}, disconnect(){this.disconnected=true;}, start(time){this.started=time;}, stop(time){this.stopped=time;} };
    this.oscillators.push(oscillator); return oscillator;
  }
  createGain() {
    const gain = { gain:{events:[],setValueAtTime(value,time){this.events.push({value,time});},linearRampToValueAtTime(value,time){this.events.push({value,time});}},
      connect() {},disconnect(){this.disconnected=true;} };
    this.gains.push(gain);return gain;
  }
}

test('sound preferences preserve mute and zero volume and clamp malformed storage', () => {
  assert.deepEqual(normalizeScanSound({enabled:false,volume:0}),{enabled:false,volume:0});
  assert.equal(normalizeScanSound({volume:10}).volume,1);
  assert.equal(normalizeScanSound({volume:-3}).volume,0);
  assert.equal(normalizeScanSound({volume:null}).volume,0.35);
  assert.equal(normalizeScanSound(null).enabled,true);
});

test('locked or suspended audio never queues old scan sounds for later', async () => {
  let created = 0;
  const context = new AudioContextFixture();
  const player = new ScanSoundPlayer(() => {created++;return context;});
  assert.equal(player.play(0.5),false);assert.equal(created,0);
  assert.equal(await player.unlock(),true);assert.equal(context.oscillators.length,0);
  assert.equal(player.play(0.5),true);assert.equal(created,1);
  assert.equal(context.oscillators.length,2);
  context.state='suspended';assert.equal(player.play(0.5),false);
  assert.equal(context.resumes,1);
});

test('a short two-note chime uses a bounded volume envelope and releases nodes', async () => {
  const context = new AudioContextFixture(), player = new ScanSoundPlayer(() => context);
  await player.unlock();assert.equal(player.play(0),false);assert.equal(context.oscillators.length,0);
  player.play(0.5);
  assert.deepEqual(context.oscillators.map((o) => o.frequency.value),[523.25,659.25]);
  for (let index=0;index<2;index++) {
    const oscillator=context.oscillators[index], envelope=context.gains[index].gain.events;
    assert.equal(envelope[0].value,0);assert.equal(envelope[1].value,0.09);assert.equal(envelope.at(-1).value,0);
    assert.ok(oscillator.stopped-oscillator.started < 0.16);
    oscillator.onended();assert.equal(context.gains[index].disconnected,true);
  }
  assert.equal(player.active.size,0);player.dispose();assert.equal(context.state,'closed');
});

test('missing or broken audio support fails quietly', async () => {
  for (const factory of [() => null, () => {throw new Error('No audio device');}]) {
    const player = new ScanSoundPlayer(factory);
    assert.equal(await player.unlock(),false);assert.equal(player.play(1),false);player.dispose();
  }
});

test('sound controls persist and an existing acceptance callback uses the latest mute preference', async () => {
  const gestures=new Map(), contexts=[];
  const runtime=createRuntime({storage:{[SCAN_SOUND_STORAGE_KEY]:{enabled:true,volume:0.5}},globals:{
    window:{AudioContext:class extends AudioContextFixture {constructor(){super();contexts.push(this);}}},
    document:{addEventListener:(name,handler) => gestures.set(name,handler),removeEventListener:(name) => gestures.delete(name)},
  }});
  const view=runtime.mount(runtime.load('src/hooks/useScanSound.js').useScanSound);
  let sound=view.render();const cleanups=view.runEffects();
  assert.equal(contexts.length,0);gestures.get('pointerdown')();await Promise.resolve();
  const accept=sound.playScanAccepted;assert.equal(accept(),true);
  sound.updateSettings({enabled:false,volume:0.25});sound=view.render();view.runEffects();
  assert.equal(accept(),false);
  assert.deepEqual(JSON.parse(runtime.values.get(SCAN_SOUND_STORAGE_KEY)),{enabled:false,volume:0.25});
  assert.equal(await sound.testSound(),true); // Explicit previews work while automatic sound is muted.
  cleanups.forEach((cleanup) => cleanup?.());assert.equal(contexts[0].state,'closed');
});

test('only an accepted camera result rings; unclear scans and manual bookkeeping stay silent', () => {
  let detected, rings=0;
  const runtime=createRuntime({mocks:{
    'src/hooks/useScanSound.js':{useScanSound:() => ({settings:{enabled:true,volume:0.35},playScanAccepted:() => {rings++;},updateSettings(){},testSound:async () => true})},
    'src/hooks/useAutoScan.js':{useAutoScan:({onCardDetected}) => {detected=onCardDetected;return {autoScanEnabled:false,toggleAutoScan(){},setLastCardId(){}};}},
  }});
  const app=runtime.mount(runtime.load('src/App.jsx').default,[false]);
  const scan=() => componentProps(app.render(),'ScanTab');scan();
  const result={cardData:{id:'rad-001',name:'Radiance card',set:'RAD'},matched:true,similarity:0.99,similarityGap:0.1,quality:{acceptable:true,score:0.8}};
  assert.equal(detected({...result,matched:false}),false);assert.equal(rings,0);
  assert.equal(detected({...result,quality:{acceptable:false}}),false);assert.equal(rings,0);
  assert.equal(detected({...result,acceptedByFakeScan:true}),false);assert.equal(rings,0);assert.equal(scan().pendingCards.length,0);
  assert.equal(detected(result),true);assert.equal(rings,1);assert.equal(scan().pendingCards.length,1);
  scan().onAddPendingCard({id:'manual',name:'Manual card',set:'RAD'});
  const pending=scan().pendingCards[0];scan().onConfirmPending(pending.entryId);
  assert.equal(rings,1);
});

test('settings controls expose enable, volume and an explicit preview', () => {
  const runtime=createRuntime();const edits=[];let previews=0;
  const view=runtime.mount(runtime.load('src/components/settings/SettingsTab.jsx').default);
  const tree=view.render({batchDefaults:{},scanSoundSettings:{enabled:true,volume:0.35},onUpdateScanSound:(patch) => edits.push(patch),onTestScanSound:() => previews++});
  nodes(tree,(node) => node.props?.['aria-label']==='Scan success sound')[0].props.onClick();
  nodes(tree,(node) => node.props?.id==='scan-sound-volume')[0].props.onChange({target:{value:'65'}});
  button(tree,'Play test sound').onClick();
  assert.equal(edits[0].enabled,false);assert.equal(edits[1].volume,0.65);assert.equal(previews,1);
});
