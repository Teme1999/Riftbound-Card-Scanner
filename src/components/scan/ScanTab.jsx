import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Camera, Upload, Loader2, RotateCcw, ScanLine, Download, Plus, CheckSquare, Square, Trash2, ChevronsRight, ChevronDown, Search } from 'lucide-react';
import ScannerCamera from '../scanner/ScannerCamera.jsx';
import CardCounter from '../scanner/CardCounter.jsx';
import ImageDropZone from '../identify/ImageDropZone.jsx';
import DetectionCanvas, { DETECTION_COLORS } from '../identify/DetectionCanvas.jsx';
import CardDetailPanel from '../identify/CardDetailPanel.jsx';
import { getDetector } from '../../lib/yoloDetector.js';
import { getMatcher, filterCardsBySet } from '../../lib/cardMatcher.js';
import { downloadCSV, validateForExport } from '../../lib/csvExporter.js';
import { formatPrice } from '../../lib/priceFormat.js';
import { isFoilOnly } from '../../data/sampleCards.js';

const PENDING_SORT_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: 'card-id', label: 'Card ID' },
  { value: 'name', label: 'Name' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'price', label: 'Price' },
  { value: 'amount', label: 'Amount' },
];

// --- Card matching utilities ---

function equalizeHistogram(data) {
  for (let ch = 0; ch < 3; ch++) {
    const hist = new Uint32Array(256);
    for (let i = ch; i < data.length; i += 4) hist[data[i]]++;
    const cdf = new Uint32Array(256);
    cdf[0] = hist[0];
    for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
    let cdfMin = 0;
    for (let i = 0; i < 256; i++) { if (cdf[i] > 0) { cdfMin = cdf[i]; break; } }
    const denom = data.length / 4 - cdfMin;
    if (denom > 0) {
      for (let i = ch; i < data.length; i += 4) {
        data[i] = ((cdf[data[i]] - cdfMin) * 255 / denom + 0.5) | 0;
      }
    }
  }
}

function computeColorGrid(canvas, gridSize) {
  // Equalize at full resolution first (matches Python pipeline)
  const w = canvas.width, h = canvas.height;
  const eq = document.createElement('canvas');
  eq.width = w;
  eq.height = h;
  const eqCtx = eq.getContext('2d');
  eqCtx.drawImage(canvas, 0, 0);
  const fullData = eqCtx.getImageData(0, 0, w, h);
  equalizeHistogram(fullData.data);
  eqCtx.putImageData(fullData, 0, 0);

  // Resize equalized image to grid
  const tmp = document.createElement('canvas');
  tmp.width = gridSize;
  tmp.height = gridSize;
  tmp.getContext('2d').drawImage(eq, 0, 0, gridSize, gridSize);
  const data = tmp.getContext('2d').getImageData(0, 0, gridSize, gridSize).data;
  const features = new Float32Array(gridSize * gridSize * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    features[j++] = data[i] / 255;
    features[j++] = data[i + 1] / 255;
    features[j++] = data[i + 2] / 255;
  }
  return features;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function rotateCanvas90(canvas) {
  const rot = document.createElement('canvas');
  rot.width = canvas.height;
  rot.height = canvas.width;
  const rctx = rot.getContext('2d');
  rctx.translate(rot.width / 2, rot.height / 2);
  rctx.rotate(Math.PI / 2);
  rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return rot;
}

function cropRotated(img, cx, cy, w, h, angle) {
  // Use card diagonal (not image diagonal) for intermediate canvas — saves memory
  const cardDiag = Math.sqrt(w * w + h * h);
  const size = Math.ceil(cardDiag) + 4;
  const big = document.createElement('canvas');
  big.width = size;
  big.height = size;
  const bctx = big.getContext('2d');
  const bcx = size / 2;
  const bcy = size / 2;
  bctx.translate(bcx, bcy);
  bctx.rotate(-angle);
  bctx.drawImage(img, -cx, -cy);

  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  c.getContext('2d').drawImage(big, bcx - w / 2, bcy - h / 2, w, h, 0, 0, w, h);

  if (w > h) {
    const rot = document.createElement('canvas');
    rot.width = Math.round(h);
    rot.height = Math.round(w);
    const rctx = rot.getContext('2d');
    rctx.translate(rot.width / 2, rot.height / 2);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(c, -c.width / 2, -c.height / 2);
    return rot;
  }
  return c;
}

// Artwork crop region (portrait card) — excludes frame, name bar, text/stats
const ART_TOP = 0.05;
const ART_BOTTOM = 0.55;
const ART_LEFT = 0.05;
const ART_RIGHT = 0.95;

function cropArtwork(canvas) {
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

function identifyCard(cropCanvas, matcher, setFilter = 'all') {
  if (!matcher || !matcher.cards || matcher.cards.length === 0) return null;

  const art = cropArtwork(cropCanvas);
  const artRotated = cropArtwork(rotateCanvas90(cropCanvas));
  const candidateCards = filterCardsBySet(matcher.cards, setFilter);

  const featNormal = computeColorGrid(art, matcher.gridSize);
  const featRotated = computeColorGrid(artRotated, matcher.gridSize);

  // Pure color grid ranking (most reliable for real photos)
  const ranked = [];
  for (const c of candidateCards) {
    const s1 = cosineSimilarity(featNormal, c.f);
    const s2 = cosineSimilarity(featRotated, c.f);
    ranked.push({ card: c, sim: Math.max(s1, s2) });
  }
  ranked.sort((a, b) => b.sim - a.sim);

  const toCardData = (r) => ({
    id: r.card.id,
    name: r.card.name,
    collectorNumber: ((r.card.code || '').split('/')[0].includes('-')
      ? (r.card.code || '').split('/')[0].split('-').slice(1).join('-')
      : String(r.card.number).padStart(3, '0')),
    code: r.card.code,
    set: r.card.set,
    setName: r.card.setName,
    domain: r.card.domain,
    domains: r.card.domains,
    rarity: r.card.rarity,
    type: r.card.type,
    energy: r.card.energy,
    might: r.card.might,
    tags: r.card.tags,
    illustrator: r.card.illustrator,
    text: r.card.text,
    sim: (r.sim * 100).toFixed(1),
    similarity: r.sim,
  });

  return {
    card: ranked[0]?.card || null,
    similarity: ranked[0]?.sim || 0,
    top3: ranked.slice(0, 3).map(toCardData),
  };
}

function resolveMatchCardData(det) {
  const cardId = det.activeCardId || det.matchResult?.card?.id;
  if (!cardId) return null;
  const matchEntry = det.matchResult?.top3?.find(m => m.id === cardId);
  if (!matchEntry) return null;
  return {
    id: matchEntry.id,
    name: matchEntry.name,
    collectorNumber: matchEntry.collectorNumber,
    code: matchEntry.code,
    set: matchEntry.set,
    setName: matchEntry.setName,
    domain: matchEntry.domain,
    domains: matchEntry.domains,
    rarity: matchEntry.rarity,
    type: matchEntry.type,
    energy: matchEntry.energy,
    might: matchEntry.might,
    tags: matchEntry.tags,
    illustrator: matchEntry.illustrator,
    text: matchEntry.text,
  };
}

/** Resize image to fit within maxDim, returns a new Image element */
const MAX_IMAGE_DIM = 2048;
function resizeImage(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w <= MAX_IMAGE_DIM && h <= MAX_IMAGE_DIM) return img;
  const scale = MAX_IMAGE_DIM / Math.max(w, h);
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = nw;
  canvas.height = nh;
  canvas.getContext('2d').drawImage(img, 0, 0, nw, nh);
  const resized = new Image();
  resized.src = canvas.toDataURL('image/png');
  resized.width = nw;
  resized.height = nh;
  return resized;
}

/** Convert a pending card to CardDetailPanel's detection format */
function pendingToDetection(card) {
  const sim = card.similarity || card.confidence || 1;
  return {
    matchResult: {
      card: { id: card.cardData.id },
      similarity: sim,
      top3: [{
        id: card.cardData.id,
        name: card.cardData.name,
        collectorNumber: card.cardData.collectorNumber,
        code: card.cardData.code,
        set: card.cardData.set,
        setName: card.cardData.setName,
        domain: card.cardData.domain,
        domains: card.cardData.domains,
        rarity: card.cardData.rarity,
        type: card.cardData.type,
        energy: card.cardData.energy,
        might: card.cardData.might,
        tags: card.cardData.tags,
        illustrator: card.cardData.illustrator,
        text: card.cardData.text,
        sim: (sim * 100).toFixed(1),
        similarity: sim,
      }],
    },
    cropCanvas: null,
    confidence: card.confidence || 1,
  };
}

function resolveMatcherCardData(card) {
  if (!card) return null;

  const codePart = (card.code || '').split('/')[0];
  const collectorNumber = codePart.includes('-')
    ? codePart.split('-').slice(1).join('-')
    : String(card.number || '').padStart(3, '0');

  return {
    id: card.id,
    name: card.name,
    collectorNumber,
    code: card.code,
    set: card.set,
    setName: card.setName,
    domain: card.domain,
    domains: card.domains,
    rarity: card.rarity,
    type: card.type,
    energy: card.energy,
    might: card.might,
    tags: card.tags,
    illustrator: card.illustrator,
    text: card.text,
  };
}

// --- Component ---

export default function ScanTab({
  camera,
  detection,
  onSnapScan,
  pendingCards,
  onAddPendingCard,
  onConfirmPending,
  onConfirmAllPending,
  onRemovePending,
  onAdjustPendingQuantity,
  onClearPending,
  onAddCardToExport,
  onAddCardsToExport,
  showNotification,
  batchDefaults,
  minConfidence,
  autoScanEnabled,
  onToggleAutoScan,
  exportFormat,
  scanSetFilter,
  scanSetOptions,
  onUpdateScanSetFilter,
  priceByCardId,
  priceCurrency = 'EUR',
  priceExchangeRates,
}) {
  const [scanMode, setScanMode] = useState('camera');
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [checkedPendingIds, setCheckedPendingIds] = useState(new Set());
  const [pendingSort, setPendingSort] = useState('original');
  const [manualCardQuery, setManualCardQuery] = useState('');
  const [manualSelectedCard, setManualSelectedCard] = useState(null);
  const [manualQuantity, setManualQuantity] = useState(1);
  const [manualFoil, setManualFoil] = useState(false);

  // Upload mode state
  const [uploadedImage, setUploadedImage] = useState(null);
  const [fileName, setFileName] = useState('');
  const [detections, setDetections] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedDetection, setSelectedDetection] = useState(null);
  const [checkedIndices, setCheckedIndices] = useState(new Set());

  const mobileDetectionRefs = useRef([]);
  const desktopDetectionRefs = useRef([]);
  const originalImageRef = useRef(null);

  const totalPending = pendingCards.reduce((sum, c) => sum + c.quantity, 0);
  const totalPendingValue = pendingCards.reduce((sum, card) => {
    const priceRecord = priceByCardId?.get(card.cardData.id);
    const priceValue = Number(priceRecord?.marketPrice ?? priceRecord?.price);

    if (!Number.isFinite(priceValue)) {
      return sum;
    }

    return sum + (priceValue * card.quantity);
  }, 0);
  const totalPendingValueLabel = formatPrice(totalPendingValue, priceCurrency, priceExchangeRates) || (priceCurrency === 'USD' ? '$0.00' : '€0.00');

  const recentPendingCards = useMemo(() => {
    return [...pendingCards]
      .filter((card) => !card.manualAdded)
      .sort((left, right) => (Number(right.scanTimestamp || 0) - Number(left.scanTimestamp || 0)))
      .slice(0, 3);
  }, [pendingCards]);

  const manualCardResults = useMemo(() => {
    const matcher = getMatcher();
    if (!matcher.ready || !matcher.cards?.length) return [];

    const query = manualCardQuery.trim().toLowerCase();
    if (query.length < 2) return [];

    const candidates = filterCardsBySet(matcher.cards, scanSetFilter);
    const matches = candidates.filter((card) => {
      const fields = [card.name, card.id, card.code, card.set, card.setName, card.collectorNumber, String(card.number || '')];
      return fields.some((field) => String(field || '').toLowerCase().includes(query));
    });

    const scoreMatch = (card) => {
      const fields = [card.name, card.id, card.code, card.set, card.setName, card.collectorNumber, String(card.number || '')];
      return fields.some((field) => String(field || '').toLowerCase().startsWith(query)) ? 1 : 0;
    };

    return matches
      .sort((left, right) => {
        const scoreDelta = scoreMatch(right) - scoreMatch(left);
        if (scoreDelta !== 0) return scoreDelta;

        const nameDelta = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        if (nameDelta !== 0) return nameDelta;

        return String(left.id).localeCompare(String(right.id), undefined, { numeric: true, sensitivity: 'base' });
      })
      .slice(0, 12);
  }, [manualCardQuery, scanSetFilter]);

  const manualSelectedFoilOnly = manualSelectedCard ? isFoilOnly(manualSelectedCard) : false;

  const selectManualCard = useCallback((card) => {
    const cardData = resolveMatcherCardData(card);
    if (!cardData) return;
    setManualSelectedCard(cardData);
    setManualQuantity(1);
    setManualFoil(isFoilOnly(cardData));
    setManualCardQuery('');
  }, []);

  const clearManualSelection = useCallback(() => {
    setManualSelectedCard(null);
    setManualQuantity(1);
    setManualFoil(false);
  }, []);

  const handleManualAdd = useCallback(() => {
    if (!manualSelectedCard || !onAddPendingCard) return;
    onAddPendingCard(manualSelectedCard, {
      quantity: manualQuantity,
      foil: manualFoil,
    });
    clearManualSelection();
  }, [clearManualSelection, manualFoil, manualQuantity, manualSelectedCard, onAddPendingCard]);

  const manualAddPanel = (
    <div className="rounded-xl border border-gold-400/20 bg-rift-900/70 px-3 py-3 shadow-inner shadow-black/20">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-gold-300/80">
            Manual add
          </div>
          <div className="text-[11px] text-rift-400">
            Search by card name or ID, then set quantity and finish.
          </div>
        </div>
        {manualSelectedCard && (
          <button
            type="button"
            onClick={clearManualSelection}
            className="rounded-full border border-rift-600/40 bg-rift-800/60 px-2 py-0.5 text-[10px] font-medium text-rift-300 hover:text-rift-100"
          >
            Clear
          </button>
        )}
      </div>

      {!manualSelectedCard ? (
        <div className="mt-3 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-rift-500" />
            <input
              type="text"
              value={manualCardQuery}
              onChange={(e) => setManualCardQuery(e.target.value)}
              placeholder="Search by name or ID"
              className="w-full rounded-lg border border-rift-600/40 bg-rift-800/70 py-2 pl-9 pr-3 text-sm text-rift-100 placeholder-rift-500 outline-none transition-colors focus:border-gold-400/50 focus:ring-1 focus:ring-gold-400/20"
            />
          </div>

          {manualCardQuery.trim().length >= 2 && manualCardResults.length === 0 && (
            <p className="text-[10px] text-rift-400">No cards found</p>
          )}
          {manualCardQuery.trim().length < 2 && (
            <p className="text-[10px] text-rift-400">Type at least 2 characters</p>
          )}

          {manualCardResults.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg bg-rift-800/40 p-1.5">
              {manualCardResults.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => selectManualCard(card)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-rift-600/30 bg-rift-800/60 px-3 py-2 text-left transition-colors hover:border-gold-400/40 hover:bg-rift-700/70"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-rift-100">{card.name}</div>
                    <div className="text-[10px] uppercase tracking-wider text-rift-400">
                      ID {card.id} · {card.setName || card.set}
                    </div>
                  </div>
                  <div className="shrink-0 rounded-full border border-rift-600/40 bg-rift-700/60 px-2 py-0.5 text-[10px] font-medium text-rift-300">
                    Select
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3 rounded-lg border border-rift-600/30 bg-rift-800/55 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-rift-100">{manualSelectedCard.name}</div>
              <div className="text-[10px] uppercase tracking-wider text-rift-400">
                ID {manualSelectedCard.id} · {manualSelectedCard.setName || manualSelectedCard.set}
              </div>
            </div>
            <div className="rounded-full border border-gold-400/20 bg-gold-400/10 px-2 py-0.5 text-[10px] font-medium text-gold-300">
              Selected
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wider text-rift-400">Qty</span>
              <button
                type="button"
                onClick={() => setManualQuantity((value) => Math.max(1, value - 1))}
                className="h-7 w-7 rounded-lg border border-rift-600/40 bg-rift-800/80 text-rift-300 transition-colors hover:bg-rift-700"
              >
                -
              </button>
              <input
                type="text"
                inputMode="numeric"
                value={manualQuantity}
                onChange={(e) => {
                  const nextValue = parseInt(e.target.value, 10);
                  if (!Number.isNaN(nextValue)) {
                    setManualQuantity(Math.min(99, Math.max(1, nextValue)));
                  }
                }}
                className="h-7 w-12 rounded-lg border border-rift-600/40 bg-rift-800/80 text-center text-xs font-mono text-rift-100 outline-none focus:border-gold-400/50"
              />
              <button
                type="button"
                onClick={() => setManualQuantity((value) => Math.min(99, value + 1))}
                className="h-7 w-7 rounded-lg border border-rift-600/40 bg-rift-800/80 text-rift-300 transition-colors hover:bg-rift-700"
              >
                +
              </button>
            </div>

            <button
              type="button"
              onClick={() => !manualSelectedFoilOnly && setManualFoil((value) => !value)}
              disabled={manualSelectedFoilOnly}
              className={`h-7 rounded-lg border px-3 text-[10px] font-medium transition-colors ${
                manualFoil || manualSelectedFoilOnly
                  ? 'border-purple-400/40 bg-purple-500/20 text-purple-300'
                  : 'border-rift-600/40 bg-rift-800/80 text-rift-400 hover:bg-rift-700 hover:text-rift-200'
              } ${manualSelectedFoilOnly ? 'cursor-not-allowed opacity-70' : ''}`}
            >
              {manualFoil || manualSelectedFoilOnly ? 'Foil' : 'Non-foil'}
            </button>

            {manualSelectedFoilOnly && (
              <span className="text-[10px] text-rift-400">Foil only</span>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleManualAdd}
              className="flex-1 rounded-xl bg-gradient-to-r from-gold-500 to-gold-400 px-3 py-2 text-xs font-semibold text-black transition-colors hover:brightness-105"
            >
              Add to pending
            </button>
            <button
              type="button"
              onClick={clearManualSelection}
              className="rounded-xl border border-rift-600/40 bg-rift-800/70 px-3 py-2 text-xs font-medium text-rift-300 transition-colors hover:text-rift-100"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const pendingFooter = (
    <div className="flex-shrink-0 space-y-2 border-t border-rift-600/20 bg-rift-900/80 px-3 py-3 backdrop-blur-sm">
      {manualAddPanel}
      <div className="rounded-xl border border-rift-600/30 bg-rift-700/40 px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-wider text-rift-400">Total value</span>
        <span className="text-sm font-semibold text-emerald-300">{totalPendingValueLabel}</span>
      </div>
    </div>
  );

  const getPendingCardPriceLabel = useCallback((card) => {
    const priceRecord = priceByCardId?.get(card.cardData.id);
    const priceValue = Number(priceRecord?.marketPrice ?? priceRecord?.price);
    if (!Number.isFinite(priceValue)) {
      return null;
    }

    return formatPrice(priceValue, priceCurrency, priceExchangeRates);
  }, [priceByCardId, priceCurrency, priceExchangeRates]);

  const sortedPendingCards = useMemo(() => {
    if (pendingSort === 'original') {
      return pendingCards;
    }

    const getConfidence = (card) => Number(card.similarity ?? card.confidence ?? 0);
    const getPriceValue = (card) => {
      const priceRecord = priceByCardId?.get(card.cardData.id);
      const priceValue = Number(priceRecord?.marketPrice ?? priceRecord?.price);
      return Number.isFinite(priceValue) ? priceValue : Number.NEGATIVE_INFINITY;
    };
    const getCardId = (card) => String(card.cardData.id || '');

    return [...pendingCards].sort((left, right) => {
      if (pendingSort === 'card-id') {
        const idDelta = getCardId(left).localeCompare(getCardId(right), undefined, { numeric: true, sensitivity: 'base' });
        if (idDelta !== 0) return idDelta;
      }

      if (pendingSort === 'name') {
        const nameDelta = left.cardData.name.localeCompare(right.cardData.name, undefined, { sensitivity: 'base' });
        if (nameDelta !== 0) return nameDelta;
      }

      if (pendingSort === 'confidence') {
        const confidenceDelta = getConfidence(right) - getConfidence(left);
        if (confidenceDelta !== 0) return confidenceDelta;
      }

      if (pendingSort === 'price') {
        const priceDelta = getPriceValue(right) - getPriceValue(left);
        if (priceDelta !== 0) return priceDelta;
      }

      if (pendingSort === 'amount') {
        const amountDelta = (right.quantity || 0) - (left.quantity || 0);
        if (amountDelta !== 0) return amountDelta;
      }

      return left.cardData.name.localeCompare(right.cardData.name, undefined, { sensitivity: 'base' });
    });
  }, [pendingCards, pendingSort, priceByCardId]);

  const pendingCardIds = useMemo(
    () => new Set(pendingCards.map(card => card.cardData.id)),
    [pendingCards]
  );

  // Clear checked pending cards when the set changes
  useEffect(() => {
    setCheckedPendingIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter(cardId => pendingCardIds.has(cardId)));
      return next.size === prev.size ? prev : next;
    });
  }, [pendingCardIds]);

  const togglePendingCheck = useCallback((cardId) => {
    setCheckedPendingIds(prev => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const handleConfirmCheckedPending = useCallback(() => {
    for (const cardId of checkedPendingIds) {
      onConfirmPending(cardId);
    }
    setCheckedPendingIds(new Set());
  }, [checkedPendingIds, onConfirmPending]);

  // Clean switch between modes
  const handleModeChange = useCallback((mode) => {
    const wasActive = camera.isActive;
    camera.stopCamera();
    setScanMode(mode);
    if (mode === 'camera' && wasActive) {
      camera.startCamera();
    }
  }, [camera]);

  // Scroll to selected detection (delayed to allow card expansion first)
  useEffect(() => {
    if (selectedDetection == null) return;
    const timer = setTimeout(() => {
      for (const refs of [desktopDetectionRefs, mobileDetectionRefs]) {
        const el = refs.current[selectedDetection];
        if (el && el.offsetParent !== null) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [selectedDetection]);

  // --- Upload mode handlers ---

  const handleImageSelected = useCallback((file) => {
    setFileName(file.name);
    setDetections([]);
    setSelectedDetection(null);
    setCheckedIndices(new Set());
    const img = new Image();
    img.onload = () => {
      originalImageRef.current = img;
      const resized = resizeImage(img);
      if (resized === img) {
        setUploadedImage(img);
        runDetection(img);
      } else {
        resized.onload = () => {
          setUploadedImage(resized);
          runDetection(resized);
        };
      }
    };
    img.src = URL.createObjectURL(file);
  }, []);

  const runDetection = async (imageElement) => {
    setIsProcessing(true);
    setDetections([]);
    setCheckedIndices(new Set());
    try {
      const canvas = document.createElement('canvas');
      canvas.width = imageElement.naturalWidth;
      canvas.height = imageElement.naturalHeight;
      canvas.getContext('2d').drawImage(imageElement, 0, 0);

      const detector = getDetector();
      if (detector.state !== 'ready') {
        showNotification('Detector not ready', 'error');
        setIsProcessing(false);
        return;
      }
      const rawDetections = await detector.detect(canvas);
      if (!rawDetections || rawDetections.length === 0) {
        showNotification('No cards detected in the image', 'info');
        setIsProcessing(false);
        return;
      }

      // Crop from original full-resolution image for better matching quality
      const originalImage = originalImageRef.current || imageElement;
      const origW = originalImage.naturalWidth || originalImage.width;
      const dispW = imageElement.naturalWidth || imageElement.width;
      const cropScale = origW / dispW;

      const matcher = getMatcher();
      const results = [];
      for (const det of rawDetections) {
        const crop = cropRotated(
          originalImage,
          det.box.cx * cropScale,
          det.box.cy * cropScale,
          det.box.w * cropScale,
          det.box.h * cropScale,
          det.box.angle
        );
        let matchResult = null;
        if (matcher.ready) matchResult = identifyCard(crop, matcher, scanSetFilter);
        results.push({
          cx: det.box.cx, cy: det.box.cy, w: det.box.w, h: det.box.h,
          angle: det.box.angle, confidence: det.confidence, cropCanvas: crop, matchResult,
        });
      }

      const matched = matcher.ready
        ? results.filter(r => r.matchResult && r.matchResult.similarity >= minConfidence)
        : results;
      setDetections(matched);
      if (matched.length > 0) {
        showNotification(`${matched.length} card${matched.length !== 1 ? 's' : ''} detected`, 'success');
        setSelectedDetection(0);
      }
    } catch (error) {
      console.error('[ScanTab] Detection error:', error);
      showNotification('Error during detection', 'error');
    }
    setIsProcessing(false);
  };

  const handleReset = () => {
    setUploadedImage(null);
    setFileName('');
    setDetections([]);
    setSelectedDetection(null);
    setCheckedIndices(new Set());
    originalImageRef.current = null;
  };

  const handleAddToExport = useCallback((cardData) => {
    onAddCardToExport(cardData);
  }, [onAddCardToExport]);

  const toggleCheck = useCallback((idx) => {
    setCheckedIndices(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const matchedIndices = detections
      .map((det, i) => (det.matchResult && det.matchResult.similarity > 0.55) ? i : -1)
      .filter(i => i >= 0);
    if (checkedIndices.size === matchedIndices.length) {
      setCheckedIndices(new Set());
    } else {
      setCheckedIndices(new Set(matchedIndices));
    }
  }, [detections, checkedIndices]);

  const addCheckedToExport = useCallback(() => {
    const cardDataArray = [];
    for (const idx of checkedIndices) {
      const det = detections[idx];
      if (!det?.matchResult?.card) continue;
      const cardData = resolveMatchCardData(det);
      if (cardData) cardDataArray.push(cardData);
    }
    if (cardDataArray.length > 0) onAddCardsToExport(cardDataArray);
    setCheckedIndices(new Set());
  }, [checkedIndices, detections, onAddCardsToExport]);

  const exportCheckedCSV = useCallback(() => {
    const exportCards = [];
    for (const idx of checkedIndices) {
      const det = detections[idx];
      if (!det?.matchResult?.card) continue;
      const cardData = resolveMatchCardData(det);
      if (cardData) {
        exportCards.push({
          cardData, quantity: 1,
          condition: batchDefaults.condition,
          language: batchDefaults.language,
          foil: batchDefaults.foil,
        });
      }
    }
    if (exportCards.length === 0) { showNotification('Select at least one card', 'error'); return; }
    const { valid, errors } = validateForExport(exportCards, exportFormat);
    if (!valid) { showNotification(`Error: ${errors[0]}`, 'error'); return; }
    downloadCSV(exportCards, null, exportFormat);
    showNotification(`CSV exported — ${exportCards.length} cards`, 'success');
  }, [checkedIndices, detections, batchDefaults, showNotification, exportFormat]);

  const handleMatchChange = useCallback((detectionIndex, cardId) => {
    setDetections(prev => {
      const updated = [...prev];
      updated[detectionIndex] = { ...updated[detectionIndex], activeCardId: cardId };
      return updated;
    });
  }, []);

  // --- Shared JSX ---

  const matchedCount = detections.filter(d => d.matchResult && d.matchResult.similarity > 0.55).length;
  const allChecked = matchedCount > 0 && checkedIndices.size === matchedCount;

  const bulkActionsBar = matchedCount > 0 && (
    <div className="flex items-center gap-2">
      <button onClick={toggleSelectAll} className="btn-ghost text-xs py-1.5 px-2.5 rounded-xl">
        {allChecked ? <CheckSquare className="w-3.5 h-3.5 text-gold-400" /> : <Square className="w-3.5 h-3.5" />}
        {allChecked ? 'Deselect' : 'Select all'}
      </button>
      <div className="flex-1" />
      {checkedIndices.size > 0 && (
        <>
          <button onClick={addCheckedToExport} className="btn-primary text-xs py-1.5 px-3 rounded-xl">
            <Plus className="w-3.5 h-3.5" />
            Add ({checkedIndices.size})
          </button>
          <button onClick={exportCheckedCSV} className="btn-secondary text-xs py-1.5 px-3 rounded-xl">
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
        </>
      )}
    </div>
  );

  const renderDetectionCards = (refsArray) => (
    <div className="space-y-2">
      {detections.map((det, idx) => {
        const color = DETECTION_COLORS[idx % DETECTION_COLORS.length];
        return (
          <div key={idx} ref={el => { if (refsArray) refsArray.current[idx] = el; }}>
            <CardDetailPanel
              detection={det}
              index={idx}
              onAddToScanner={handleAddToExport}
              isChecked={checkedIndices.has(idx)}
              onToggleCheck={() => toggleCheck(idx)}
              onMatchChange={handleMatchChange}
              color={color}
              isSelected={selectedDetection === idx}
              onSelect={() => setSelectedDetection(selectedDetection === idx ? null : idx)}
            />
          </div>
        );
      })}
    </div>
  );

  // --- Mode switcher ---

  const modeSwitcher = (
    <div className="flex gap-1 p-1 rounded-xl bg-rift-800/80 backdrop-blur-md border border-rift-600/30 w-fit flex-shrink-0">
      <button
        onClick={() => handleModeChange('camera')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          scanMode === 'camera'
            ? 'bg-gold-400/20 text-gold-400 border border-gold-400/30'
            : 'text-rift-400 hover:text-rift-200 border border-transparent'
        }`}
      >
        <Camera className="w-3.5 h-3.5" />
        Camera
      </button>
      <button
        onClick={() => handleModeChange('upload')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          scanMode === 'upload'
            ? 'bg-gold-400/20 text-gold-400 border border-gold-400/30'
            : 'text-rift-400 hover:text-rift-200 border border-transparent'
        }`}
      >
        <Upload className="w-3.5 h-3.5" />
        Upload
      </button>
    </div>
  );

  const selectedSetCodes = Array.isArray(scanSetFilter) ? scanSetFilter : [];
  const allSetsSelected = selectedSetCodes.length === 0;

  const toggleScanSet = (setCode) => {
    if (!onUpdateScanSetFilter) return;

    if (setCode === 'all') {
      onUpdateScanSetFilter([]);
      return;
    }

    const next = selectedSetCodes.includes(setCode)
      ? selectedSetCodes.filter((value) => value !== setCode)
      : [...selectedSetCodes, setCode];
    onUpdateScanSetFilter(next);
  };

  const setSelector = (
    <div className="rounded-xl border border-rift-600/30 bg-rift-800/80 px-3 py-2 backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-rift-400">
            Sets
          </span>
          <span className="text-[9px] leading-tight text-rift-400">
            The archive sees more clearly when the pool is smaller.
          </span>
        </div>
        <button
          type="button"
          onClick={() => onUpdateScanSetFilter?.([])}
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
            allSetsSelected
              ? 'border-gold-400/40 bg-gold-400/15 text-gold-300'
              : 'border-rift-600/40 bg-rift-700/60 text-rift-400 hover:text-rift-200'
          }`}
        >
          All sets
        </button>
      </div>
      <div className="flex max-w-[18rem] flex-wrap gap-1.5">
        {scanSetOptions
          .filter((option) => option.value !== 'all')
          .map((option) => {
            const active = selectedSetCodes.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => toggleScanSet(option.value)}
                className={`rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors ${
                  active
                    ? 'border-gold-400/50 bg-gold-400/15 text-gold-300'
                    : 'border-rift-600/40 bg-rift-700/60 text-rift-400 hover:text-rift-200'
                }`}
                title={option.label}
              >
                {option.label}
              </button>
            );
          })}
      </div>
    </div>
  );

  // ═══════════════════════════════════════════
  // CAMERA MODE
  // ═══════════════════════════════════════════
  if (scanMode === 'camera') {
    return (
      <div key="camera" className="flex-1 relative overflow-hidden lg:flex lg:flex-row">
        {/* Camera area */}
        <div className="absolute inset-0 lg:relative lg:flex-1">
          <ScannerCamera
            videoRef={camera.videoRef}
            isActive={camera.isActive}
            error={camera.error}
            isProcessing={detection.isProcessing}
            lastDetection={detection.lastDetection}
            onStartCamera={camera.startCamera}
            onStopCamera={camera.stopCamera}
            onToggleFacing={camera.toggleFacing}
            onSnapScan={onSnapScan}
            detectorState={detection.detectorState}
            hasTorch={camera.hasTorch}
            hasFocusControl={camera.hasFocusControl}
            torchOn={camera.torchOn}
            onToggleTorch={camera.toggleTorch}
            onRefocus={camera.refocus}
            autoScanEnabled={autoScanEnabled}
            onToggleAutoScan={onToggleAutoScan}
            captureFrame={camera.captureFrame}
            detectSingleFrame={detection.detectSingleFrame}
          />

          {/* Mode switcher floating on camera */}
          <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
            {setSelector}
            {modeSwitcher}
          </div>

          {/* Floating card counter (mobile only) */}
          {!sheetExpanded && totalPending > 0 && (
            <CardCounter
              count={totalPending}
              uniqueCount={pendingCards.length}
              onTap={() => setSheetExpanded(true)}
            />
          )}
        </div>

        {/* ── Backdrop to close sheet on mobile ── */}
        {pendingCards.length > 0 && sheetExpanded && (
          <div
            className="absolute inset-0 bg-black/40 z-20 backdrop-blur-sm lg:hidden transition-opacity duration-300 fade-in"
            onClick={() => setSheetExpanded(false)}
          />
        )}

        {/* ── Pending cards: mobile bottom overlay ── */}
        {pendingCards.length > 0 && (
          <div
            className="absolute bottom-0 left-0 right-0 z-30 bg-rift-800/95 backdrop-blur-xl border-t border-rift-600/30 rounded-t-2xl transition-[height] duration-300 ease-out flex flex-col lg:hidden"
            style={{ height: sheetExpanded ? '50dvh' : 56 }}
          >
            <div className="flex items-center justify-between px-4 py-3 flex-shrink-0 gap-3">
              <button
                type="button"
                onClick={() => setSheetExpanded((prev) => !prev)}
                className="relative flex flex-1 items-center justify-center py-1"
              >
              <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-rift-500/60" />
              <span className="text-sm font-semibold text-gold-400 mt-1">
                {totalPending} pending
              </span>
              </button>
              <div className="flex items-center gap-4 mt-1 flex-shrink-0">
                {checkedPendingIds.size > 0 ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleConfirmCheckedPending(); }}
                    className="btn-primary text-xs py-2 px-4 rounded-lg"
                  >
                    <ChevronsRight className="w-4 h-4" />
                    Add ({checkedPendingIds.size})
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onConfirmAllPending(); }}
                    className="btn-primary text-xs py-2 px-4 rounded-lg"
                  >
                    <ChevronsRight className="w-4 h-4" />
                    Add all
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onClearPending(); }}
                  className="btn-ghost text-xs py-2 px-3 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-400/10"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {sheetExpanded && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-2">
                {recentPendingCards.length > 0 && (
                  <div className="rounded-xl border border-gold-400/20 bg-rift-900/70 px-3 py-3 shadow-inner shadow-black/20">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-gold-300/80">
                          Last 3 scanned
                        </div>
                        <div className="text-[11px] text-rift-400">
                          Most recent cards added to pending.
                        </div>
                      </div>
                      <span className="rounded-full border border-gold-400/20 bg-gold-400/10 px-2 py-0.5 text-[10px] font-medium text-gold-300">
                        {recentPendingCards.length}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2">
                      {recentPendingCards.map((card) => (
                        <div
                          key={`${card.cardData.id}-${card.scanTimestamp}`}
                          className="flex items-center justify-between gap-3 rounded-lg border border-rift-600/30 bg-rift-800/70 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-rift-100">
                              {card.cardData.name}
                            </div>
                            <div className="text-[10px] uppercase tracking-wider text-rift-400">
                              ID {card.cardData.id}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-right">
                            <span className="rounded-full border border-rift-600/40 bg-rift-700/60 px-2 py-0.5 text-[10px] font-medium text-rift-300">
                              x{card.quantity}
                            </span>
                            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                              {getPendingCardPriceLabel(card) || 'No price'}
                            </span>
                            <span className="text-[10px] text-gold-300/90">
                              {card.confidence ? `${Math.round(card.confidence * 100)}%` : 'scan'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 rounded-xl border border-gold-400/20 bg-gradient-to-r from-rift-900/80 to-rift-800/70 px-3 py-2 shadow-inner shadow-black/20">
                  <span className="text-[10px] uppercase tracking-[0.22em] text-gold-300/80 whitespace-nowrap">
                    Sort pending
                  </span>
                  <div className="relative flex-1 max-w-[180px]">
                    <select
                      value={pendingSort}
                      onChange={(e) => setPendingSort(e.target.value)}
                      className="w-full appearance-none rounded-lg border border-gold-400/20 px-3 py-1.5 pr-8 text-xs font-medium outline-none transition-colors focus:border-gold-300/50 focus:ring-1 focus:ring-gold-400/30"
                      style={{
                        backgroundColor: 'rgba(5, 10, 18, 0.82)',
                        color: '#f3d27a',
                        colorScheme: 'dark',
                        WebkitAppearance: 'none',
                        appearance: 'none',
                      }}
                      aria-label="Sort pending cards"
                    >
                      {PENDING_SORT_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gold-300/80" />
                  </div>
                </div>

                {sortedPendingCards.map((card, index) => (
                  <CardDetailPanel
                    key={`${card.cardData.id}-${card.scanTimestamp}`}
                    detection={pendingToDetection(card)}
                    index={index}
                    onAddToScanner={(payload) => onConfirmPending({ cardId: card.cardData.id, ...payload })}
                    onRemove={() => onRemovePending(card.cardData.id)}
                    onQuickAddDuplicate={() => onAdjustPendingQuantity?.(card.cardData.id, 1)}
                    onQuickRemoveDuplicate={() => onAdjustPendingQuantity?.(card.cardData.id, -1)}
                    quantity={card.quantity}
                    isChecked={checkedPendingIds.has(card.cardData.id)}
                    onToggleCheck={() => togglePendingCheck(card.cardData.id)}
                    priceRecord={priceByCardId?.get(card.cardData.id) || null}
                    priceCurrency={priceCurrency}
                    priceExchangeRates={priceExchangeRates}
                  />
                ))}
                </div>
                {pendingFooter}
              </div>
            )}
          </div>
        )}

        {/* ── Pending cards: desktop side panel ── */}
        <div className="hidden lg:flex flex-col w-[450px] flex-shrink-0 border-l border-rift-600/30 bg-rift-800/95 backdrop-blur-xl">
          <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0 border-b border-rift-600/20">
            <h3 className="text-xs font-semibold text-gold-400 flex-1">
              Pending ({pendingCards.length})
            </h3>
            <div className="relative">
              <select
                value={pendingSort}
                onChange={(e) => setPendingSort(e.target.value)}
                className="appearance-none rounded-lg border border-gold-400/20 px-3 py-2 pr-8 text-xs font-medium outline-none transition-colors focus:border-gold-300/50 focus:ring-1 focus:ring-gold-400/30"
                style={{
                  backgroundColor: 'rgba(5, 10, 18, 0.82)',
                  color: '#f3d27a',
                  colorScheme: 'dark',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                }}
                aria-label="Sort pending cards"
              >
                {PENDING_SORT_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gold-300/80" />
            </div>
            {pendingCards.length > 0 && (
              <>
                {checkedPendingIds.size > 0 ? (
                  <button onClick={handleConfirmCheckedPending} className="btn-primary text-xs py-2 px-4 rounded-lg">
                    <ChevronsRight className="w-4 h-4" />
                    Add ({checkedPendingIds.size})
                  </button>
                ) : (
                  <button onClick={onConfirmAllPending} className="btn-primary text-xs py-2 px-4 rounded-lg">
                    <ChevronsRight className="w-4 h-4" />
                    Add all
                  </button>
                )}
                <button onClick={onClearPending} className="btn-ghost text-xs py-2 px-3 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-400/10">
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
            {pendingCards.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-sm text-rift-400">No pending cards</p>
                <p className="text-xs text-rift-500 mt-1">Point the camera at a card to start</p>
              </div>
            ) : (
              <>
                {recentPendingCards.length > 0 && (
                  <div className="rounded-xl border border-gold-400/20 bg-rift-900/70 px-3 py-3 shadow-inner shadow-black/20">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-gold-300/80">
                          Last 3 scanned
                        </div>
                        <div className="text-[11px] text-rift-400">
                          Most recent cards added to pending.
                        </div>
                      </div>
                      <span className="rounded-full border border-gold-400/20 bg-gold-400/10 px-2 py-0.5 text-[10px] font-medium text-gold-300">
                        {recentPendingCards.length}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2">
                      {recentPendingCards.map((card) => (
                        <div
                          key={`${card.cardData.id}-${card.scanTimestamp}`}
                          className="flex items-center justify-between gap-3 rounded-lg border border-rift-600/30 bg-rift-800/70 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-rift-100">
                              {card.cardData.name}
                            </div>
                            <div className="text-[10px] uppercase tracking-wider text-rift-400">
                              ID {card.cardData.id}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-right">
                            <span className="rounded-full border border-rift-600/40 bg-rift-700/60 px-2 py-0.5 text-[10px] font-medium text-rift-300">
                              x{card.quantity}
                            </span>
                            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                              {getPendingCardPriceLabel(card) || 'No price'}
                            </span>
                            <span className="text-[10px] text-gold-300/90">
                              {card.confidence ? `${Math.round(card.confidence * 100)}%` : 'scan'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {sortedPendingCards.map((card, index) => (
                  <CardDetailPanel
                    key={`${card.cardData.id}-${card.scanTimestamp}`}
                    detection={pendingToDetection(card)}
                    index={index}
                    onAddToScanner={(payload) => onConfirmPending({ cardId: card.cardData.id, ...payload })}
                    onRemove={() => onRemovePending(card.cardData.id)}
                    onQuickAddDuplicate={() => onAdjustPendingQuantity?.(card.cardData.id, 1)}
                    onQuickRemoveDuplicate={() => onAdjustPendingQuantity?.(card.cardData.id, -1)}
                    quantity={card.quantity}
                    isChecked={checkedPendingIds.has(card.cardData.id)}
                    onToggleCheck={() => togglePendingCheck(card.cardData.id)}
                    priceRecord={priceByCardId?.get(card.cardData.id) || null}
                    priceCurrency={priceCurrency}
                    priceExchangeRates={priceExchangeRates}
                  />
                ))}
              </>
            )}

            </div>
            {pendingFooter}
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // UPLOAD MODE
  // ═══════════════════════════════════════════

  const desktopResultsContent = detections.length > 0 ? (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-rift-100">Results ({detections.length})</h2>
        <button onClick={() => runDetection(uploadedImage)} disabled={isProcessing} className="btn-ghost text-xs py-1 px-2 rounded-lg">
          <RotateCcw className="w-3 h-3" />
          Re-detect
        </button>
      </div>
      {bulkActionsBar}
      {renderDetectionCards(desktopDetectionRefs)}
    </div>
  ) : (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center py-12">
        <p className="text-sm text-rift-400">No results yet</p>
        <p className="text-xs text-rift-500 mt-1">Upload an image to detect cards</p>
      </div>
    </div>
  );

  return (
    <div key="upload" className="flex-1 relative overflow-hidden lg:flex lg:flex-row">
      {/* Left column: upload + canvas + mobile results */}
      {/* Mode switcher - absolutely positioned to match camera mode */}
      <div className="absolute top-3 left-3 z-10">
        <div className="flex flex-col gap-2">
          {setSelector}
          {modeSwitcher}
        </div>
      </div>

      {/* Left column: upload + canvas + mobile results */}
      <div className={`h-full overflow-y-auto pb-4 lg:flex-1 lg:min-w-0 ${!uploadedImage ? 'flex flex-col' : ''}`}>
        <div className={`px-4 pt-14 pb-4 space-y-4 ${!uploadedImage ? 'flex-1 flex flex-col' : ''}`}>
          {/* Upload area or canvas */}
          {!uploadedImage ? (
            <div className="flex-1 flex items-center justify-center">
              <ImageDropZone onImageSelected={handleImageSelected} isProcessing={isProcessing} />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <ScanLine className="w-4 h-4 text-gold-400 flex-shrink-0" />
                  <span className="text-xs text-rift-300 truncate">{fileName}</span>
                </div>
                <button onClick={handleReset} className="btn-ghost text-xs py-1.5 px-3 rounded-xl flex-shrink-0">
                  <RotateCcw className="w-3.5 h-3.5" />
                  New
                </button>
              </div>

              <DetectionCanvas
                image={uploadedImage}
                detections={detections}
                selectedIndex={selectedDetection}
                onSelectDetection={(idx) => setSelectedDetection(idx)}
              />

              {isProcessing && (
                <div className="flex items-center justify-center gap-2 py-4">
                  <Loader2 className="w-5 h-5 text-gold-400 animate-spin" />
                  <span className="text-sm text-rift-300">Detecting cards...</span>
                </div>
              )}
            </div>
          )}

          {/* Detection results — mobile only */}
          {detections.length > 0 && (
            <div className="space-y-3 lg:hidden">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-rift-100">Results ({detections.length})</h2>
                <button onClick={() => runDetection(uploadedImage)} disabled={isProcessing} className="btn-ghost text-xs py-1 px-2 rounded-lg">
                  <RotateCcw className="w-3 h-3" />
                  Re-detect
                </button>
              </div>
              {bulkActionsBar}
              {renderDetectionCards(mobileDetectionRefs)}
            </div>
          )}

          {/* Empty detection state */}
          {uploadedImage && !isProcessing && detections.length === 0 && (
            <div className="text-center py-6">
              <p className="text-sm text-rift-400">No cards detected in this image</p>
              <p className="text-xs text-rift-500 mt-1">Try with a clearer image or better lighting</p>
            </div>
          )}
        </div>
      </div>

      {/* Desktop results panel */}
      <div className="hidden lg:flex flex-col w-[450px] flex-shrink-0 border-l border-rift-600/30 bg-rift-800/95 backdrop-blur-xl">
        {desktopResultsContent}
      </div>
    </div>
  );
}
