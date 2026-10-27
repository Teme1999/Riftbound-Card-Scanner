import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardEntry, restoreCardEntries, mergeCardEntries, matchesPendingScan, getCardVariantKey } from '../src/lib/collection.js';
import { resolveCardData } from '../src/lib/cardData.js';
import { getSelectedDetectionEntries } from '../src/lib/scanEntries.js';
import { generateCSV, validateForExport, EXPORT_FORMATS } from '../src/lib/csvExporter.js';

const card = { id: 'fixture-001', name: 'Fixture Card', code: 'FIX-001/100', set: 'FIX', rarity: 'common' };
const entry = (overrides = {}) => createCardEntry({ cardData: resolveCardData(card), ...overrides });

test('standard and foil copies stay separate while identical copies combine', () => {
  const rows = mergeCardEntries([], [entry(), entry({ foil: true }), entry()]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.foil, row.quantity]), [[false, 2], [true, 1]]);
});

test('condition, language and promo each identify separate collection rows', () => {
  const rows = mergeCardEntries([], [entry(), entry({ condition: 'Damaged' }), entry({ language: 'Chinese' }), entry({ promo: true })]);
  assert.equal(rows.length, 4);
  assert.equal(rows.reduce((sum, row) => sum + row.quantity, 0), 4);
});

test('merging copies preserves the existing stable row id', () => {
  const original = entry({ quantity: 5 });
  const rows = mergeCardEntries([original], [entry({ quantity: 3 })]);
  assert.equal(rows[0].entryId, original.entryId);
  assert.equal(rows[0].quantity, 8);
  assert.equal(original.quantity, 5);
});

test('older saved rows retain their quantities and traits with unique persistent ids', () => {
  const old = [{ cardData: card, quantity: 5, foil: true, language: 'Chinese', condition: 'Damaged', scanTimestamp: 100 }, { cardData: card, quantity: 2, scanTimestamp: 100 }];
  const restored = restoreCardEntries(old);
  assert.notEqual(restored[0].entryId, restored[1].entryId);
  assert.equal(restored[0].quantity, 5);
  assert.equal(restored[0].foil, true);
  assert.equal(restored[0].language, 'Chinese');
  assert.equal(restored[0].condition, 'Damaged');
  assert.equal(restored[0].scanTimestamp, 100);
  assert.deepEqual(restoreCardEntries(JSON.parse(JSON.stringify(restored))), restored);
  assert.equal(old[0].entryId, undefined);
});

test('a split cannot reuse the source row id', () => {
  const original = entry({ quantity: 2 });
  const rows = mergeCardEntries([original], [{ ...original, quantity: 1, foil: true }]);
  assert.notEqual(rows[0].entryId, rows[1].entryId);
});

test('recent scans distinguish finishes and still resolve older card-id-only events', () => {
  const standard = entry(), foil = entry({ foil: true });
  const event = { variantKey: getCardVariantKey(foil), cardId: card.id };
  assert.equal(matchesPendingScan(event, foil), true);
  assert.equal(matchesPendingScan(event, standard), false);
  assert.equal(matchesPendingScan({ cardId: card.id }, standard), true);
});

test('card metadata conversion retains a desktop cached image and variant number', () => {
  const imageUrl = 'C:\\AppData\\cards\\fixture.webp';
  const data = resolveCardData({ ...card, code: 'FIX-001a/100', imageUrl });
  assert.equal(data.collectorNumber, '001a');
  assert.equal(data.imageUrl, imageUrl);
});

test('bulk selection includes manually corrected cards outside the original top three', () => {
  const reviewed = entry({ cardData: { ...resolveCardData(card), id: 'manually-corrected' }, quantity: 5, foil: true, promo: true });
  const rows = getSelectedDetectionEntries([{ matchResult: { top3: [{ id: 'wrong' }] }, entry: reviewed }], new Set([0, 99]));
  assert.deepEqual(rows, [reviewed]);
  assert.equal(rows[0].quantity, 5);
  assert.equal(rows[0].foil, true);
  assert.equal(rows[0].promo, true);
});

test('bulk CSV uses the reviewed quantity, finish, promo and other row metadata', () => {
  const reviewed = entry({ quantity: 5, foil: true, promo: true, language: 'Chinese', condition: 'Damaged' });
  const rows = getSelectedDetectionEntries([{ entry: reviewed }], new Set([0]));
  assert.equal(validateForExport(rows).valid, true);
  const csv = generateCSV(rows, EXPORT_FORMATS.PILTOVER);
  assert.match(csv, /Promo/);
  assert.match(csv, /true,5,Chinese,Damaged/);
});

test('foil-only normalization is identical for direct and bulk CSV paths', () => {
  const rare = entry({ cardData: resolveCardData({ ...card, rarity: 'rare' }), foil: false });
  assert.equal(rare.foil, true);
  assert.match(generateCSV(getSelectedDetectionEntries([{ entry: rare }], new Set([0]))), /Foil$/);
});
