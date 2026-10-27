import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRuntime } from './helpers/runtime.mjs';
import { compareFeatures } from '../src/lib/cardSimilarity.js';
import { isReliableScanResult } from '../src/lib/scanQuality.js';

test('installed card assets include the latest sets and complete matching data', async () => {
  const db = JSON.parse(await fs.readFile(new URL('../public/card-hashes.json', import.meta.url), 'utf8'));
  const ids = new Set();
  const counts = {};
  for (const card of db.cards) {
    assert.ok(card.id && !ids.has(card.id), `Duplicate or empty ID: ${card.id}`);
    ids.add(card.id);
    counts[card.set] = (counts[card.set] || 0) + 1;
    assert.equal(card.f.length, db.gridSize ** 2 * 3, card.id);
    assert.ok(card.f.every((v) => Number.isFinite(v) && v >= 0 && v <= 1), card.id);
    const image = await fs.stat(new URL(`../public/cards/${card.id}.webp`, import.meta.url));
    assert.ok(image.size > 0, `Missing image: ${card.id}`);
  }
  // Minimum coverage verified against the official gallery on 2026-10-26.
  for (const [set, count] of Object.entries({ OGN: 352, OGS: 24, SFD: 288, UNL: 288, RAD: 219, VEN: 237 })) {
    assert.ok(counts[set] >= count, `${set}: expected at least ${count}, got ${counts[set] || 0}`);
  }
  console.log('Installed card coverage:', counts);
});

test('Suave Negotiator screenshot features pass against the complete installed database', async () => {
  const db = JSON.parse(await fs.readFile(new URL('../public/card-hashes.json', import.meta.url), 'utf8'));
  const query = JSON.parse(await fs.readFile(new URL('./fixtures/suave-query-features.json', import.meta.url), 'utf8'));
  const Matcher = createRuntime().load('src/lib/cardMatcher.js').default;
  const matcher = new Matcher();
  matcher._applyDatabase(db);
  // The fixture isolates the artwork ranking from browser resampling and ONNX.
  matcher._cropArtwork = (canvas) => canvas;
  matcher._computeColorGrid = () => new Float32Array(query.features);
  const match = matcher.identify({});
  assert.equal(match.card.id, query.id);
  const result = { cardData: match.card, matched: true, quality: { acceptable: true },
    similarity: match.similarity, similarityGap: match.similarity - match.secondBestSim };
  assert.equal(isReliableScanResult(result, 0.9), true);
  assert.equal(isReliableScanResult(result, 0.98), false, 'The user similarity setting still applies');
  const oldScores = matcher.cards.map((card) => ({ id: card.id,
    similarity: compareFeatures(query.features, card.f).colorSimilarity })).sort((a, b) => b.similarity - a.similarity);
  assert.equal(oldScores[0].id, query.id);
  assert.ok(oldScores[0].similarity - oldScores[1].similarity < 0.05, 'Reproduces the original ambiguous rejection');
  console.log('Suave screenshot artwork:', { similarity: result.similarity, gap: result.similarityGap });
});
