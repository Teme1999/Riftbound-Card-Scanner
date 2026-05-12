/**
 * Card Matcher — Identifies detected cards using color grid cosine similarity.
 * Used by both camera mode (useCardDetection) and upload mode (ScanTab).
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { loadMatcherDatabase, saveMatcherDatabase } from './indexedDB.js';
import { isDesktopRuntime, resolveAppUrl } from './runtime.js';

const HASHES_URL = resolveAppUrl(`/card-hashes.json?v=${__BUILD_TIME__}`);
const isDevelopment = import.meta.env.DEV;
const debugLog = (...args) => {
  if (isDevelopment) {
    console.log(...args);
  }
};

const summarizeMatcherSets = (cards = []) => {
  const bySet = new Map();

  for (const card of cards) {
    const setCode = String(card?.set || '').trim().toUpperCase();
    if (!setCode || bySet.has(setCode)) continue;

    const setName = String(card?.setName || '').trim();
    bySet.set(setCode, {
      value: setCode,
      label: setName ? `${setCode} · ${setName}` : setCode,
    });
  }

  const labels = [...bySet.values()]
    .sort((left, right) => left.value.localeCompare(right.value))
    .map((entry) => entry.label);

  return {
    count: labels.length,
    fullLabel: labels.length > 0 ? labels.join(', ') : 'No sets loaded',
    label: labels.length > 0 ? labels.slice(0, 6).join(', ') : 'No sets loaded',
  };
};

// Artwork crop region (portrait card) — excludes frame, name bar, text/stats
const ART_TOP = 0.05;
const ART_BOTTOM = 0.55;
const ART_LEFT = 0.05;
const ART_RIGHT = 0.95;

/**
 * Get the local image URL for a card by its ID.
 * @param {string} cardId - The card ID (e.g., "ogn-001-298")
 * @returns {string} - Local image path (e.g., "/cards/ogn-001-298.webp")
 */
export function getCardImageUrl(cardId) {
  return `/cards/${cardId}.webp`;
}

export function resolveCardImageSource(source, cardId = null) {
  const fallback = cardId ? getCardImageUrl(cardId) : '';
  const candidate = source || fallback;
  if (!candidate) return '';

  if (/^https?:/i.test(candidate)) {
    return fallback ? resolveAppUrl(fallback) : '';
  }

  if (/^(data:|blob:|asset:|tauri:)/i.test(candidate)) {
    return candidate;
  }

  if (candidate.startsWith('/')) {
    return resolveAppUrl(candidate);
  }

  if (isDesktopRuntime()) {
    return convertFileSrc(candidate);
  }

  return candidate;
}

export function normalizeScanSetFilter(setFilter) {
  if (!setFilter) return [];

  if (Array.isArray(setFilter)) {
    return setFilter
      .map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => value && value !== 'ALL');
  }

  if (setFilter instanceof Set) {
    return [...setFilter]
      .map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => value && value !== 'ALL');
  }

  const normalized = String(setFilter || '').trim().toUpperCase();
  if (!normalized || normalized === 'ALL') return [];
  return [normalized];
}

export function filterCardsBySet(cards, setFilter) {
  const selectedSets = normalizeScanSetFilter(setFilter);
  if (selectedSets.length === 0) {
    return cards;
  }

  const selectedSetLookup = new Set(selectedSets);
  return cards.filter((card) => selectedSetLookup.has(String(card.set || '').toUpperCase()));
}

class CardMatcher {
  constructor() {
    this.cards = [];
    this.gridSize = 8;
    this.ready = false;
    this._tmpCanvas = null;
    this.databaseSource = 'bundled';
    this.databaseUpdatedAt = null;
    this.databaseSetCoverage = summarizeMatcherSets();
  }

  async initialize() {
    this.ready = false;
    this.cards = [];
    this.databaseSource = 'bundled';
    this.databaseUpdatedAt = null;
    this.databaseSetCoverage = summarizeMatcherSets();

    try {
      const localDatabase = await loadMatcherDatabase();
      if (localDatabase) {
        this._applyDatabase(localDatabase.database);
        this.databaseSource = 'local';
        this.databaseUpdatedAt = localDatabase.updatedAt || null;
        debugLog(`[CardMatcher] Loaded ${this.cards.length} cards from local database (${this.gridSize}x${this.gridSize} grid)`);
        return;
      }
    } catch (error) {
      console.warn('[CardMatcher] Could not load local database, falling back to bundled asset:', error);
    }

    let resp;
    try {
      resp = await fetch(HASHES_URL);
    } catch (error) {
      throw new Error('Missing card hash database at /card-hashes.json. Use the Update Card Database button to import a generated card-hashes.json file from this PC.');
    }

    if (!resp.ok) {
      throw new Error(`Missing card hash database at /card-hashes.json (HTTP ${resp.status}). Use the Update Card Database button to import a generated card-hashes.json file from this PC.`);
    }

    const data = await resp.json();
    this._applyDatabase(data);
    this.databaseSource = 'bundled';
    debugLog(`[CardMatcher] Loaded ${this.cards.length} cards from bundled asset (${this.gridSize}x${this.gridSize} grid)`);
  }

  _applyDatabase(database) {
    this.gridSize = database.gridSize;
    this.cards = (database.cards || []).map((card) => {
      const f = card.f instanceof Float32Array ? card.f : new Float32Array(card.f);
      let normSq = 0;
      for (let i = 0; i < f.length; i++) normSq += f[i] * f[i];
      return { ...card, f, norm: Math.sqrt(normSq) };
    });
    this.databaseSetCoverage = summarizeMatcherSets(this.cards);
    this.ready = true;
  }

  async setDatabase(database) {
    const normalized = {
      gridSize: database.gridSize || this.gridSize,
      cards: database.cards || [],
    };

    const savedRecord = await saveMatcherDatabase(normalized);
    this._applyDatabase(normalized);
    this.databaseSource = 'local';
    this.databaseUpdatedAt = savedRecord.updatedAt || null;
    debugLog(`[CardMatcher] Database updated locally (${this.cards.length} cards)`);
  }

  /**
   * Identify a card from a cropped canvas using color grid similarity.
   *
   * @param {HTMLCanvasElement} cropCanvas - De-rotated card crop
   * @returns {{ card: object, similarity: number, secondBestSim: number } | null}
   */
  identify(cropCanvas, options = {}) {
    if (!this.ready || this.cards.length === 0) return null;

    const candidateCards = filterCardsBySet(this.cards, options.setFilter);
    if (candidateCards.length === 0) return null;

    const art = this._cropArtwork(cropCanvas);
    const features = this._computeColorGrid(art);
    const featureNorm = this._vectorNorm(features);
    if (featureNorm <= 0) return null;

    let bestCard = null;
    let bestSim = -1;
    let secondBestSim = -1;
    for (const card of candidateCards) {
      const sim = this._cosineSimilarity(features, card.f, featureNorm, card.norm);
      if (sim > bestSim) {
        secondBestSim = bestSim;
        bestSim = sim;
        bestCard = card;
      } else if (sim > secondBestSim) {
        secondBestSim = sim;
      }
    }
    return bestCard ? { card: bestCard, similarity: bestSim, secondBestSim } : null;
  }

  _cropArtwork(canvas) {
    const w = canvas.width, h = canvas.height;
    const sx = Math.round(w * ART_LEFT);
    const sy = Math.round(h * ART_TOP);
    const sw = Math.round(w * (ART_RIGHT - ART_LEFT));
    const sh = Math.round(h * (ART_BOTTOM - ART_TOP));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    c.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return c;
  }

  _equalizeHistogram(data) {
    for (let ch = 0; ch < 3; ch++) {
      const hist = new Uint32Array(256);
      for (let i = ch; i < data.length; i += 4) hist[data[i]]++;
      const cdf = new Uint32Array(256);
      cdf[0] = hist[0];
      for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
      let cdfMin = 0;
      for (let i = 0; i < 256; i++) {
        if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
      }
      const totalPixels = data.length / 4;
      const denom = totalPixels - cdfMin;
      if (denom > 0) {
        for (let i = ch; i < data.length; i += 4) {
          data[i] = ((cdf[data[i]] - cdfMin) * 255 / denom + 0.5) | 0;
        }
      }
    }
  }

  _computeColorGrid(canvas) {
    const w = canvas.width, h = canvas.height;
    if (!this._eqCanvas) this._eqCanvas = document.createElement('canvas');
    this._eqCanvas.width = w;
    this._eqCanvas.height = h;
    const eqCtx = this._eqCanvas.getContext('2d');
    eqCtx.drawImage(canvas, 0, 0);
    const fullData = eqCtx.getImageData(0, 0, w, h);
    this._equalizeHistogram(fullData.data);
    eqCtx.putImageData(fullData, 0, 0);

    if (!this._tmpCanvas) {
      this._tmpCanvas = document.createElement('canvas');
      this._tmpCanvas.width = this.gridSize;
      this._tmpCanvas.height = this.gridSize;
    }
    const ctx = this._tmpCanvas.getContext('2d');
    ctx.drawImage(this._eqCanvas, 0, 0, this.gridSize, this.gridSize);
    const data = ctx.getImageData(0, 0, this.gridSize, this.gridSize).data;
    const features = new Float32Array(this.gridSize * this.gridSize * 3);
    for (let i = 0, j = 0; i < data.length; i += 4) {
      features[j++] = data[i] / 255;
      features[j++] = data[i + 1] / 255;
      features[j++] = data[i + 2] / 255;
    }
    return features;
  }

  _vectorNorm(vector) {
    let normSq = 0;
    for (let i = 0; i < vector.length; i++) {
      normSq += vector[i] * vector[i];
    }
    return Math.sqrt(normSq);
  }

  _cosineSimilarity(a, b, normA, normB) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    const denom = normA * normB;
    return denom > 0 ? dot / denom : 0;
  }
}

let matcherInstance = null;

export function getMatcher() {
  if (!matcherInstance) {
    matcherInstance = new CardMatcher();
  }
  return matcherInstance;
}


export default CardMatcher;
