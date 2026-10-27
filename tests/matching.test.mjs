import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFeatures, compareFeatures } from '../src/lib/cardSimilarity.js';
import { isReliableScanResult } from '../src/lib/scanQuality.js';
import { createRuntime, nodes } from './helpers/runtime.mjs';

const pattern = new Float32Array([0.4, 0.5, 0.6, 0.6, 0.7, 0.8, 0.45, 0.55, 0.65, 0.65, 0.75, 0.85]);
const rearranged = new Float32Array([0.6, 0.7, 0.8, 0.4, 0.5, 0.6, 0.65, 0.75, 0.85, 0.45, 0.55, 0.65]);

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
