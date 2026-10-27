import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, componentProps } from './helpers/runtime.mjs';
import { convertUsdPrice, formatPrice, getPriceValue } from '../src/lib/priceFormat.js';

const anchor = { id:'rad-001', name:'Anchor', set:'RAD', setName:'Radiance', code:'RAD-001/167' };
const flash = { id:'ogs-011', name:'Flash', set:'OGS', setName:'Proving Grounds', code:'OGS-011/024' };
const header = 'name,set,number,price,marketPrice,updatedAt\n';
const baseRow = 'Anchor,Radiance,#001/167,1.10,1.25,17:45:16 26/10/2026\n';
function fixture() {
  let stored;
  const runtime = createRuntime({ mocks:{ 'src/lib/indexedDB.js':{
    replacePriceSnapshot:async (records, meta) => { stored = { records, meta }; return meta; },
    getPriceRecords:async () => stored?.records || [], loadPriceSyncMeta:async () => stored?.meta || null,
  } } });
  return { runtime, sync:runtime.load('src/lib/priceSync.js'), stored:() => stored };
}

test('price identity requires both the right set and full collector number', () => {
  const { sync } = fixture();
  const cards = [anchor, flash, { ...anchor, id:'rad-002', code:'RAD-002/167' }];
  const result = sync.buildPriceSnapshot(header + baseRow +
    'Flash,Riftbound Organized Play Promotional Cards,#011/024,200,300,\n' +
    'Anchor,Radiance,#999/167,200,300,\n' + 'Anchor,Vendetta,#001/167,200,300,\n', cards);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].marketPrice, 1.25);
  assert.equal(result.unmatchedRows, 3);
});

test('the Proving Grounds source name maps explicitly without treating promos as the base set', () => {
  const { sync } = fixture();
  const result = sync.buildPriceSnapshot(header + baseRow + 'Flash,Origins: Proving Grounds,#011/024,1,2,\n', [anchor,flash]);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[1].cardId, flash.id);
});

test('champion subtitles and printing labels match only an exact printing identity', () => {
  const { sync } = fixture();
  const graves = { id:'graves', name:'Graves', set:'RAD', setName:'Radiance', code:'RAD-085/167' };
  const rune = {id:'rune',name:'Chaos Rune',set:'RAD',code:'RAD-R05a'};
  const result = sync.buildPriceSnapshot(header + baseRow +
    '"Graves, Blasting Through (Alternate Art)",Radiance,#085/167,5,6,\n' +
    'Chaos Rune (R05a),RAD,#R05a,7,8,\n' +
    '"Graves, Blasting Through",Radiance,#086/167,50,60,\n', [anchor,graves,rune]);
  assert.deepEqual(Array.from(result.records,(r) => r.cardId),[anchor.id,'graves','rune']);
  assert.equal(result.unmatchedRows,1);
});

test('rune, star and alternate collector identifiers remain distinct', () => {
  const { sync } = fixture();
  const cards = [anchor, ...['R05a', 'R05b', '002', '002*'].map((code) => ({ id:code, name:'Variant', set:'RAD', code:`RAD-${code}/167` }))];
  const result = sync.buildPriceSnapshot(header + baseRow + 'Variant,RAD,#R05b/167,5,6,\nVariant,RAD,#002*/167,7,8,\n', cards);
  assert.deepEqual(Array.from(result.records, (r) => r.cardId), ['rad-001','R05b','002*']);
});

test('conflicting prices and indistinguishable printings are left unpriced', () => {
  const { sync } = fixture();
  const result = sync.buildPriceSnapshot(header + baseRow +
    'Flash,OGS,#011/024,1,2,\nFlash,OGS,#011/024,10,20,\n', [anchor,flash]);
  assert.equal(result.records.length, 1);
  assert.equal(result.conflictingCards, 1);
  const ambiguous = sync.buildPriceSnapshot(header + baseRow + 'Flash,OGS,#011/024,1,2,\n', [anchor,flash,{...flash,id:'duplicate-printing'}]);
  assert.equal(ambiguous.records.length, 1);
});

test('missing, malformed or negative prices cannot turn into a zero value', () => {
  const { sync } = fixture();
  const result = sync.buildPriceSnapshot(header + baseRow + 'Flash,OGS,#011/024,-4,0,\n', [anchor,flash]);
  assert.equal(result.records.length, 1);
  assert.equal(result.unpricedRows, 1);
  assert.equal(getPriceValue({ price:null, marketPrice:null }), null);
  assert.equal(formatPrice(null), null);
  assert.equal(formatPrice(undefined), null);
  assert.equal(convertUsdPrice(-1), null);
});

test('currency conversion retains cents above ten and reports a source date', () => {
  assert.equal(formatPrice(12.34, 'USD', { USD:1.2 }), '$12.34');
  assert.equal(formatPrice(12, 'EUR', { USD:1.2 }), '€10.00');
  assert.equal(convertUsdPrice(12, 'JPY', { USD:1.2, JPY:160 }), 1600);
  const { sync } = fixture();
  const result = sync.buildPriceSnapshot(header + baseRow, [anchor]);
  assert.equal(result.sourceNewestDate, '2026-10-26');
  assert.equal(result.records[0].variantSpecific, false);
});

test('bad CSV fails before replacing a saved snapshot', async () => {
  const { sync, stored } = fixture();
  await assert.rejects(sync.importPriceSnapshotCsv('name,price\nAnchor,3', {cards:[anchor]}), /columns/);
  await assert.rejects(sync.importPriceSnapshotCsv(header + '"Anchor,RAD,001,3', {cards:[anchor]}), /unterminated/);
  assert.equal(stored(), undefined);
});

test('provided fallback rates keep their provenance', async () => {
  const { sync, stored } = fixture();
  await sync.importPriceSnapshotCsv(header + baseRow, {cards:[anchor], exchangeRates:{USD:1.2}, exchangeRateDate:'2026-10-23', exchangeRateFallback:true});
  assert.equal(stored().meta.exchangeRateFallback, true);
  assert.equal(stored().meta.exchangeRateDate, '2026-10-23');
  assert.equal(sync.isPriceSnapshotCurrent(stored().meta), true);
  assert.equal(sync.isPriceSnapshotCurrent({matchedRows:859}), false);
});

test('an ECB outage does not discard a valid downloaded price update', async () => {
  let saved;
  const runtime = createRuntime({ mocks:{'src/lib/indexedDB.js':{
    replacePriceSnapshot:async (records,meta) => {saved={records,meta}; return meta;},
    getPriceRecords:async () => saved?.records || [], loadPriceSyncMeta:async () => saved?.meta || null,
  }}, globals:{fetch:async (url) => {
    if (url.includes('ecb.europa.eu')) throw new Error('ECB unavailable');
    return {ok:true,text:async () => header + baseRow};
  }, console:{...console,warn(){}}} });
  runtime.load('src/lib/cardMatcher.js').getMatcher()._applyDatabase({gridSize:16,cards:[{...anchor,f:[1,2,3]}]});
  const app = runtime.mount(runtime.load('src/App.jsx').default,[false]);
  componentProps(app.render(),'BottomTabBar').onTabChange('settings');
  await componentProps(app.render(),'SettingsTab').onUpdatePriceData();
  assert.equal(saved.records.length, 1);
  assert.equal(saved.meta.exchangeRateFallback, true);
});
