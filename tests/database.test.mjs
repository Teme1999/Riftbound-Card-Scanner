import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';

const card = (id, extra = {}) => ({ id, set: id.split('-')[0].toUpperCase(), f: [0.2, 0.4, 0.6], ...extra });
function fixture(local, bundled, { fetchError, saveError } = {}) {
  const saved = [];
  const runtime = createRuntime({
    mocks: { 'src/lib/indexedDB.js': {
      loadMatcherDatabase: async () => local && ({ database: local, updatedAt: 'old' }),
      saveMatcherDatabase: async (database) => {
        if (saveError) throw new Error('Storage full');
        saved.push(database);
        return { updatedAt: 'new' };
      },
    } },
    globals: { fetch: async () => {
      if (fetchError) throw new Error('Offline');
      return { ok: true, json: async () => bundled };
    }, console: { ...console, warn() {} } },
  });
  const Matcher = runtime.load('src/lib/cardMatcher.js').default;
  return { matcher: new Matcher(), saved };
}

test('a bundled update supplements later reveals inside an already imported set', async () => {
  const { matcher, saved } = fixture(
    { gridSize: 16, cards: [card('rad-001', { imageUrl: 'C:/cards/local.webp', name: 'Local' })] },
    { gridSize: 16, cards: [card('rad-001', { name: 'Old bundle' }), card('rad-219'), card('ven-001')] },
  );
  await matcher.initialize();
  assert.deepEqual(Array.from(matcher.cards, (c) => c.id), ['rad-001', 'rad-219', 'ven-001']);
  assert.equal(matcher.cards[0].imageUrl, 'C:/cards/local.webp');
  assert.equal(matcher.cards[0].name, 'Local');
  assert.equal(matcher.databaseUpdatedAt, 'new');
  assert.equal(saved.length, 1);
});

test('a current local database is not rewritten at every startup', async () => {
  const db = { gridSize: 16, cards: [card('rad-001')] };
  const { matcher, saved } = fixture(db, db);
  await matcher.initialize();
  assert.equal(saved.length, 0);
  assert.equal(matcher.databaseUpdatedAt, 'old');
});

test('incompatible feature grids are not mixed', async () => {
  const { matcher, saved } = fixture({ gridSize: 8, cards: [card('ogn-001')] }, { gridSize: 16, cards: [card('rad-001')] });
  await matcher.initialize();
  assert.equal(matcher.gridSize, 8);
  assert.equal(matcher.cards.length, 1);
  assert.equal(saved.length, 0);
});

test('missing bundled data retains the usable local database', async () => {
  const { matcher } = fixture({ gridSize: 16, cards: [card('rad-001')] }, null, { fetchError: true });
  await matcher.initialize();
  assert.equal(matcher.ready, true);
  assert.equal(matcher.cards[0].id, 'rad-001');
});

test('storage failure still makes new bundled cards available for this session', async () => {
  const { matcher } = fixture({ gridSize: 16, cards: [] }, { gridSize: 16, cards: [card('rad-001')] }, { saveError: true });
  await matcher.initialize();
  assert.equal(matcher.ready, true);
  assert.equal(matcher.cards[0].id, 'rad-001');
  assert.equal(matcher.databaseUpdatedAt, 'old');
});

test('a new installation uses the bundled database without a local import', async () => {
  const { matcher, saved } = fixture(null, { gridSize: 16, cards: [card('rad-001')] });
  await matcher.initialize();
  assert.equal(matcher.cards[0].id, 'rad-001');
  assert.equal(matcher.databaseSource, 'bundled');
  assert.equal(saved.length, 0);
});

test('an unreadable local payload falls back to bundled cards', async () => {
  const { matcher } = fixture({ gridSize: 16, cards: {} }, { gridSize: 16, cards: [card('rad-001')] });
  await matcher.initialize();
  assert.equal(matcher.cards[0].id, 'rad-001');
  assert.equal(matcher.databaseSource, 'bundled');
});
