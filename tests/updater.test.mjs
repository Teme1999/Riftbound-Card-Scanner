import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, componentProps, button } from './helpers/runtime.mjs';
import { persistUserSnapshot } from '../src/lib/userStorage.js';

test('update download finishes and current data is persisted before installation', async () => {
  const runtime = createRuntime();
  const { downloadAndInstallAppUpdate } = runtime.load('src/lib/appUpdater.js');
  const order = [], progress = [];
  await downloadAndInstallAppUpdate({
    download:async (emit) => {
      order.push('download'); emit({event:'Started',data:{contentLength:10}});
      emit({event:'Progress',data:{chunkLength:4}}); emit({event:'Progress',data:{chunkLength:6}}); emit({event:'Finished'});
    }, install:async () => { order.push('install'); },
  }, (value) => progress.push(value), { beforeInstall:async () => { order.push('persist'); } });
  assert.deepEqual(order,['download','persist','install']);
  assert.equal(progress.find((p) => p.percent === 40).downloadedBytes,4);
  assert.equal(progress.at(-1).status,'installing');
});

test('a persistence or download failure prevents installation', async () => {
  const runtime = createRuntime();
  const { downloadAndInstallAppUpdate } = runtime.load('src/lib/appUpdater.js');
  let installs = 0;
  await assert.rejects(downloadAndInstallAppUpdate({download:async () => {},install:async () => installs++},null,
    {beforeInstall:() => {throw new Error('Storage full');}}), /Storage full/);
  await assert.rejects(downloadAndInstallAppUpdate({download:async () => {throw new Error('Offline');},install:async () => installs++}), /Offline/);
  assert.equal(installs,0);
  assert.throws(() => persistUserSnapshot({collection:[1]}, {setItem(){throw new Error('Quota');}}), /Quota/);
});

test('collection changes during an update download are flushed before the installer exits', async () => {
  let completeDownload, installed = false;
  const runtime = createRuntime({ globals:{__TAURI_INTERNALS__:{}}, mocks:{'@tauri-apps/plugin-process':{relaunch:async () => {}}, '@tauri-apps/plugin-updater':{
    check:async () => ({version:'26.10.2601',download:() => new Promise((resolve) => {completeDownload=resolve;}),install:async () => {
      const saved = JSON.parse(runtime.values.get('riftbound_pending_cards'));
      assert.equal(saved[0].quantity,3); installed = true;
    }}),
  }} });
  const app = runtime.mount(runtime.load('src/App.jsx').default,[false]);
  componentProps(app.render(),'BottomTabBar').onTabChange('settings');
  await componentProps(app.render(),'SettingsTab').onCheckAppUpdate();
  const install = componentProps(app.render(),'SettingsTab').onInstallAppUpdate();
  componentProps(app.render(),'BottomTabBar').onTabChange('scan');
  componentProps(app.render(),'ScanTab').onAddPendingCard({id:'rad-001',name:'New scan',set:'RAD'}, {quantity:3});
  app.render(); completeDownload(); await install;
  assert.equal(installed,true);
});

test('users can check for updates when scan assets fail to load', () => {
  const runtime = createRuntime(); let checked = false;
  const screen = runtime.mount(runtime.load('src/components/LoadingScreen.jsx').default);
  const tree = screen.render({error:'Missing model',onCheckAppUpdate:() => {checked=true;},appUpdateState:{status:'idle'}});
  button(tree,'Check for updates').onClick();
  assert.equal(checked,true);
});

test('storage settings expose only the two application-managed folders', () => {
  const runtime = createRuntime(), opened = [];
  const screen = runtime.mount(runtime.load('src/components/settings/SettingsTab.jsx').default);
  const tree = screen.render({batchDefaults:{},storageInfo:{cardsDirectory:'C:/AppData/cards',profileDirectory:'C:/AppData/EBWebView'},onOpenStorageFolder:(folder) => opened.push(folder)});
  button(tree,'Open card images folder').onClick(); button(tree,'Open app data folder').onClick();
  assert.deepEqual(opened,['cards','profile']);
});
