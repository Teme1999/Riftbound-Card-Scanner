/**
 * Card Matcher — Identifies cards using artwork color and spatial correlation.
 * Used by both camera mode (useCardDetection) and upload mode (ScanTab).
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { loadMatcherDatabase, saveMatcherDatabase } from './indexedDB.js';
import { isDesktopRuntime, resolveAppUrl } from './runtime.js';
import { describeFeatures, compareFeatures } from './cardSimilarity.js';

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

// Supplement an imported database after an app update, preserving newer local
// records and image paths. Different feature grids cannot be mixed.
export function supplementWithBundledCards(local, bundled) {
  if (local.gridSize !== bundled.gridSize) return local;
  const ids = new Set(local.cards.map((card) => card.id));
  const missing = bundled.cards.filter((card) => !ids.has(card.id));
  return missing.length ? { ...local, cards: [...local.cards, ...missing] } : local;
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

    let localDatabase = null;
    try {
      localDatabase = await loadMatcherDatabase();
      if (localDatabase) {
        this._applyDatabase(localDatabase.database);
        this.databaseSource = 'local';
        this.databaseUpdatedAt = localDatabase.updatedAt || null;
        debugLog(`[CardMatcher] Loaded ${this.cards.length} cards from local database (${this.gridSize}x${this.gridSize} grid)`);
      }
    } catch (error) {
      localDatabase = null;
      console.warn('[CardMatcher] Could not load local database, falling back to bundled asset:', error);
    }

    try {
      const resp = await fetch(HASHES_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (localDatabase) {
        const supplemented = supplementWithBundledCards(localDatabase.database, data);
        if (supplemented !== localDatabase.database) {
          this._applyDatabase(supplemented);
          const saved = await saveMatcherDatabase(supplemented);
          this.databaseUpdatedAt = saved.updatedAt || this.databaseUpdatedAt;
        }
      } else {
        this._applyDatabase(data);
        debugLog(`[CardMatcher] Loaded ${this.cards.length} cards from bundled asset (${this.gridSize}x${this.gridSize} grid)`);
      }
    } catch (error) {
      // Offline/missing bundles or a full local store must not hide a usable
      // imported database (including additions already loaded in memory).
      if (this.ready) {
        console.warn('[CardMatcher] Could not synchronize bundled cards:', error);
        return;
      }
      throw new Error('Missing card hash database at /card-hashes.json. Use the Update Card Database button to import a generated card-hashes.json file from this PC.');
    }
  }

  _applyDatabase(database) {
    this._tmpCanvas = null;
    this.gridSize = database.gridSize;
    this.cards = (database.cards || []).map((card) => {
      const f = card.f instanceof Float32Array ? card.f : new Float32Array(card.f);
      return { ...card, f, featureStats: describeFeatures(f) };
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
   * Identify a card from a cropped canvas using the shared artwork ranking.
   *
   * @param {HTMLCanvasElement} cropCanvas - De-rotated card crop
   * @returns {{ card: object, similarity: number, secondBestSim: number } | null}
   */
  identify(cropCanvas, options = {}) {
    const ranked = this.rank(cropCanvas, { ...options, limit: 2 });
    return ranked.length ? { ...ranked[0], secondBestSim: ranked[1]?.similarity ?? 0 } : null;
  }

  rank(cropCanvas, options = {}) {
    if (!this.ready || !this.cards.length) return [];
    return this.rankFeatures(this._computeColorGrid(this._cropArtwork(cropCanvas)), options);
  }

  rankFeatures(features, { setFilter, limit = 3 } = {}) {
    if (!this.ready) return [];
    const featureStats = describeFeatures(features);
    if (!featureStats || featureStats.structureNorm < 1e-8) return [];
    const ranked = [];
    for (const card of filterCardsBySet(this.cards, setFilter)) {
      if (!card.featureStats || card.f.length !== features.length) continue;
      const scores = compareFeatures(features, card.f, featureStats, card.featureStats);
      const entry = { card, ...scores };
      const index = ranked.findIndex((candidate) => candidate.similarity < entry.similarity);
      if (index >= 0) ranked.splice(index, 0, entry);
      else if (ranked.length < limit) ranked.push(entry);
      if (ranked.length > limit) ranked.length = limit;
    }
    return ranked;
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

}

let matcherInstance = null;

export function getMatcher() {
  if (!matcherInstance) {
    matcherInstance = new CardMatcher();
  }
  return matcherInstance;
}


export default CardMatcher;
