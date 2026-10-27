import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createRuntime, componentProps, button, nodes } from './helpers/runtime.mjs';
import { createCardEntry } from '../src/lib/collection.js';
import { resolveCardData } from '../src/lib/cardData.js';
import * as csvExporter from '../src/lib/csvExporter.js';

const card = resolveCardData({ id: 'fixture-001', name: 'Fixture Card', code: 'FIX-001/100', set: 'FIX', rarity: 'common' });
const pendingKey = 'riftbound_pending_cards';
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
