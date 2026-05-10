import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AppShell from './components/AppShell.jsx';
import BottomTabBar from './components/BottomTabBar.jsx';
import ToastNotification from './components/ToastNotification.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import ScanTab from './components/scan/ScanTab.jsx';
import ScanAddAnimation from './components/scan/ScanAddAnimation.jsx';
import CollectionTab from './components/collection/CollectionTab.jsx';
import SettingsTab from './components/settings/SettingsTab.jsx';
import { useCamera } from './hooks/useCamera.js';
import { useCardDetection } from './hooks/useCardDetection.js';
import { useAutoScan } from './hooks/useAutoScan.js';
import { downloadCSV, validateForExport, EXPORT_FORMATS } from './lib/csvExporter.js';
import { getMatcher } from './lib/cardMatcher.js';
import { buildScanSetOptions } from './lib/scanSets.js';
import { isDesktopRuntime } from './lib/runtime.js';
import { invokeDesktopCommand, openDesktopFileDialog } from './lib/desktopBridge.js';
import { fetchPriceSnapshotCsvFromGithub, importPriceSnapshotCsv, loadStoredPriceMeta, PRICE_SOURCE_LABEL, PRICE_SOURCE_URL } from './lib/priceSync.js';
import { getPriceRecords } from './lib/indexedDB.js';
import { FALLBACK_EXCHANGE_RATE_DATE, normalizeExchangeRates, normalizePriceCurrency } from './lib/priceFormat.js';
import { isFoilOnly } from './data/sampleCards.js';

// ─── State persistence helpers ──────────────────────────────
const STORAGE_KEYS = {
  SCANNED_CARDS: 'riftbound_scanned_cards',
  PENDING_CARDS: 'riftbound_pending_cards',
  BATCH_DEFAULTS: 'riftbound_batch_defaults',
  MODEL_PREFERENCE: 'riftbound_model_preference',
  EXPORT_FORMAT: 'riftbound_export_format',
  SCAN_SET_FILTER: 'riftbound_scan_set_filter',
  PRICE_CURRENCY: 'riftbound_price_currency',
  CAMERA_DEVICE_ID: 'riftbound_camera_device_id',
};

const SCAN_ADD_ANIMATION_MS = 980;

function saveToStorage(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
    console.warn('[Storage] Failed to save:', err);
  }
}

function loadFromStorage(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch (err) {
    console.warn('[Storage] Failed to load:', err);
    return fallback;
  }
}

export default function App() {
  // ─── App State ─────────────────────────────────────────────
  const [isLoading, setIsLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStage, setLoadStage] = useState('db');
  const [initError, setInitError] = useState(null);
  const [initErrorType, setInitErrorType] = useState(null);
  const [runtimeInfo, setRuntimeInfo] = useState(null);

  // Scanning
  const [pendingCards, setPendingCards] = useState(() =>
    loadFromStorage(STORAGE_KEYS.PENDING_CARDS, [])
  );
  const [scannedCards, setScannedCards] = useState(() =>
    loadFromStorage(STORAGE_KEYS.SCANNED_CARDS, [])
  );

  // UI
  const [activeTab, setActiveTab] = useState('scan');
  const [notification, setNotification] = useState(null);
  const [scanAddAnimation, setScanAddAnimation] = useState(null);

  // Scan settings
  const [minConfidence, setMinConfidence] = useState(0.90);

  // Batch defaults
  const [batchDefaults, setBatchDefaults] = useState(() =>
    loadFromStorage(STORAGE_KEYS.BATCH_DEFAULTS, {
      condition: 'Near Mint',
      language: 'English',
      foil: false,
    })
  );

  // Model preference (normal or quantized)
  const [modelPreference, setModelPreference] = useState(() =>
    loadFromStorage(STORAGE_KEYS.MODEL_PREFERENCE, 'quantized')
  );

  const [exportFormat, setExportFormat] = useState(() =>
    loadFromStorage(STORAGE_KEYS.EXPORT_FORMAT, EXPORT_FORMATS.CARDNEXUS)
  );

  const [scanSetFilter, setScanSetFilter] = useState(() => {
    const stored = loadFromStorage(STORAGE_KEYS.SCAN_SET_FILTER, []);
    if (Array.isArray(stored)) {
      return stored
        .map((value) => String(value || '').trim().toUpperCase())
        .filter((value) => value && value !== 'ALL');
    }

    const normalized = String(stored || '').trim().toUpperCase();
    return normalized && normalized !== 'ALL' ? [normalized] : [];
  });
  const [scanSetOptions, setScanSetOptions] = useState([{ value: 'all', label: 'All sets' }]);

  const [priceSyncBusy, setPriceSyncBusy] = useState(false);
  const [priceSyncMeta, setPriceSyncMeta] = useState(null);
  const [priceRecords, setPriceRecords] = useState([]);
  const [priceCurrency, setPriceCurrency] = useState(() =>
    normalizePriceCurrency(loadFromStorage(STORAGE_KEYS.PRICE_CURRENCY, 'EUR'))
  );
  const [cameraDeviceId, setCameraDeviceId] = useState(() =>
    loadFromStorage(STORAGE_KEYS.CAMERA_DEVICE_ID, '')
  );
  const [cameraDevices, setCameraDevices] = useState([]);

  // ─── Hooks ─────────────────────────────────────────────────
  const camera = useCamera({ deviceId: cameraDeviceId });
  const detection = useCardDetection({ scanSetFilter });
  const cardDatabaseInputRef = useRef(null);

  const priceByCardId = useMemo(() => new Map(priceRecords.map((record) => [record.cardId, record])), [priceRecords]);
  const priceExchangeRates = normalizeExchangeRates(priceSyncMeta?.exchangeRates || (priceSyncMeta?.usdPerEurRate ? { USD: priceSyncMeta.usdPerEurRate } : null));
  const priceExchangeRateDate = priceSyncMeta?.exchangeRateDate || priceSyncMeta?.usdPerEurRateDate || FALLBACK_EXCHANGE_RATE_DATE;
  const priceExchangeRateFallback = priceSyncMeta ? Boolean(priceSyncMeta.exchangeRateFallback ?? priceSyncMeta.usdPerEurRateFallback) : true;

  useEffect(() => {
    let cancelled = false;

    if (!isDesktopRuntime()) {
      setRuntimeInfo(null);
      return undefined;
    }

    invokeDesktopCommand('runtime_info')
      .then((info) => {
        if (!cancelled) {
          setRuntimeInfo(info);
        }
      })
      .catch((error) => {
        console.warn('[App] Desktop runtime info unavailable:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.PRICE_CURRENCY, priceCurrency);
  }, [priceCurrency]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.CAMERA_DEVICE_ID, cameraDeviceId);
  }, [cameraDeviceId]);

  const refreshCameraDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraDevices([]);
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      setCameraDevices(videoInputs);
    } catch (error) {
      console.warn('[App] Could not enumerate camera devices:', error);
      setCameraDevices([]);
    }
  }, []);

  useEffect(() => {
    refreshCameraDevices();
  }, [refreshCameraDevices, camera.isActive]);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return undefined;

    const handleDeviceChange = () => {
      refreshCameraDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refreshCameraDevices]);

  useEffect(() => {
    if (!cameraDeviceId || cameraDevices.length === 0) return;
    const deviceStillExists = cameraDevices.some((device) => device.deviceId === cameraDeviceId);
    if (!deviceStillExists) {
      setCameraDeviceId('');
    }
  }, [cameraDeviceId, cameraDevices]);

  // Restart camera when switching back to scan tab (video element was destroyed on unmount)
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (activeTab === 'scan' && prevTabRef.current !== 'scan' && camera.isActive) {
      camera.startCamera();
    }
    prevTabRef.current = activeTab;
  }, [activeTab, camera.isActive, camera.startCamera]);

  // ─── Notifications ─────────────────────────────────────────
  const notificationTimeoutRef = useRef(null);

  const showNotification = useCallback((message, type = 'info') => {
    setNotification({ message, type });
    if (notificationTimeoutRef.current) {
      clearTimeout(notificationTimeoutRef.current);
    }
    notificationTimeoutRef.current = setTimeout(() => {
      setNotification(null);
    }, 2000);
  }, []);

  useEffect(() => {
    if (!scanAddAnimation) return undefined;

    const timer = setTimeout(() => {
      setScanAddAnimation(null);
    }, SCAN_ADD_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [scanAddAnimation]);

  // ─── Initialization ────────────────────────────────────────
  const hasShownRestoreNotification = useRef(false);

  const processCardDatabaseText = useCallback(async (text) => {
    const parsed = JSON.parse(text);

    if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      throw new Error('The selected file does not look like a valid card-hashes.json database.');
    }

    const matcher = getMatcher();
    await matcher.setDatabase(parsed);
    setScanSetOptions(buildScanSetOptions(matcher.cards));

    const loadedCount = parsed.cards.length;
    showNotification(`Card database updated — ${loadedCount} cards loaded`, 'success');

    if (initErrorType !== 'model') {
      setInitError(null);
      setInitErrorType(null);
    }
  }, [initErrorType, showNotification]);

  const refreshPriceCache = useCallback(async () => {
    try {
      const [meta, records] = await Promise.all([
        loadStoredPriceMeta(),
        getPriceRecords(),
      ]);

      setPriceSyncMeta(meta);
      setPriceRecords(records);
    } catch (error) {
      console.warn('[App] Price sync metadata unavailable:', error);
    }
  }, []);

  const formatInitError = useCallback((error) => {
    const message = error?.message || 'Initialization failed.';
    if (message.includes('card hash database') || message.includes('card-hashes.json')) {
      return {
        message: `${message}\n\nThe app cannot identify cards until the generated hash file exists.`,
        type: 'hashes',
      };
    }
    if (message.includes('/models/') || message.includes('model')) {
      return {
        message: `${message}\n\nThe detector weights are missing or unreadable.`,
        type: 'model',
      };
    }
    return { message, type: 'unknown' };
  }, []);

  const initializeApp = useCallback(async () => {
    try {
      setInitError(null);
      setInitErrorType(null);

      // Stage 1: Initialize YOLO detector (warmup) with model preference
      setLoadStage('model');
      setLoadProgress(0.2);
      await detection.initDetector(modelPreference);
      setLoadProgress(0.5);

      // Stage 2: Initialize card matcher (loads card-hashes.json or local DB)
      setLoadStage('matcher');
      const matcher = getMatcher();
      await matcher.initialize();
      setScanSetOptions(buildScanSetOptions(matcher.cards));
      setLoadProgress(0.85);

      // Done
      setLoadStage('ready');
      setLoadProgress(1);
      await new Promise(r => setTimeout(r, 400));
      setIsLoading(false);
    } catch (error) {
      console.error('[App] Initialization error:', error);
      const formatted = formatInitError(error);
      setInitError(formatted.message);
      setInitErrorType(formatted.type);
      setIsLoading(false);
    }
  }, [detection.initDetector, formatInitError, modelPreference]);

  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  useEffect(() => {
    refreshPriceCache();
  }, [refreshPriceCache]);

  const handleImportCardDatabase = useCallback(async () => {
    if (isDesktopRuntime()) {
      try {
        const selectedPath = await openDesktopFileDialog({
          title: 'Select card-hashes.json',
          multiple: false,
          filters: [{ name: 'Card hashes', extensions: ['json'] }],
        });

        if (!selectedPath || Array.isArray(selectedPath)) {
          return;
        }

        const text = await invokeDesktopCommand('import_card_database', { filePath: selectedPath });
        await processCardDatabaseText(text);
        setScanSetOptions(buildScanSetOptions(getMatcher().cards));
        return;
      } catch (error) {
        console.error('[App] Desktop card database import error:', error);
        showNotification(`Card database update failed: ${error.message}`, 'error');
        return;
      }
    }

    cardDatabaseInputRef.current?.click();
  }, [processCardDatabaseText, showNotification]);

  const handleCardDatabaseFileSelected = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      await processCardDatabaseText(text);
      setScanSetOptions(buildScanSetOptions(getMatcher().cards));
    } catch (error) {
      console.error('[App] Card database import error:', error);
      showNotification(`Card database update failed: ${error.message}`, 'error');
    }
  }, [processCardDatabaseText, showNotification]);

  const handleImportPriceSnapshot = useCallback(async () => {
    if (priceSyncBusy) {
      return;
    }

    setPriceSyncBusy(true);

    try {
      const text = await fetchPriceSnapshotCsvFromGithub();
      const result = await importPriceSnapshotCsv(text, {
        sourceHint: PRICE_SOURCE_URL,
        matcher: getMatcher(),
      });
      await refreshPriceCache();
      const rateLabel = result.exchangeRate
        ? `, ${result.exchangeRate.exchangeRateFallback ? 'fallback' : 'ECB'} FX ${result.exchangeRate.exchangeRateDate || 'latest'}`
        : '';
      showNotification(`Price cache updated from GitHub — ${result.matchedRows}/${result.totalRows} cards matched${rateLabel}`, 'success');
    } catch (error) {
      console.error('[App] Price import error:', error);
      showNotification(`Price update failed: ${error.message}`, 'error');
    } finally {
      setPriceSyncBusy(false);
    }
  }, [priceSyncBusy, refreshPriceCache, showNotification]);

  // Show notification if state was restored from previous session
  useEffect(() => {
    if (!isLoading && !hasShownRestoreNotification.current) {
      const restoredCount = scannedCards.length + pendingCards.length;
      if (restoredCount > 0) {
        setTimeout(() => {
          showNotification(`Session restored — ${restoredCount} card${restoredCount !== 1 ? 's' : ''} recovered`, 'success');
        }, 500);
      }
      hasShownRestoreNotification.current = true;
    }
  }, [isLoading, scannedCards.length, pendingCards.length, showNotification]);

  // ─── State persistence ───────────────────────────────────
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SCANNED_CARDS, scannedCards);
  }, [scannedCards]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.PENDING_CARDS, pendingCards);
  }, [pendingCards]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.BATCH_DEFAULTS, batchDefaults);
  }, [batchDefaults]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.MODEL_PREFERENCE, modelPreference);
  }, [modelPreference]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.EXPORT_FORMAT, exportFormat);
  }, [exportFormat]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SCAN_SET_FILTER, scanSetFilter);
  }, [scanSetFilter]);

  useEffect(() => {
    if (scanSetFilter.length === 0) return;

    const availableSets = new Set(scanSetOptions.filter((option) => option.value !== 'all').map((option) => option.value));
    const nextSelection = scanSetFilter.filter((setCode) => availableSets.has(setCode));
    if (nextSelection.length !== scanSetFilter.length) {
      setScanSetFilter(nextSelection);
    }
  }, [scanSetFilter, scanSetOptions]);

  // Force save on page visibility change
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveToStorage(STORAGE_KEYS.SCANNED_CARDS, scannedCards);
        saveToStorage(STORAGE_KEYS.PENDING_CARDS, pendingCards);
        saveToStorage(STORAGE_KEYS.BATCH_DEFAULTS, batchDefaults);
        saveToStorage(STORAGE_KEYS.MODEL_PREFERENCE, modelPreference);
        saveToStorage(STORAGE_KEYS.EXPORT_FORMAT, exportFormat);
      }
    };

    const handleBeforeUnload = () => {
      saveToStorage(STORAGE_KEYS.SCANNED_CARDS, scannedCards);
      saveToStorage(STORAGE_KEYS.PENDING_CARDS, pendingCards);
      saveToStorage(STORAGE_KEYS.BATCH_DEFAULTS, batchDefaults);
      saveToStorage(STORAGE_KEYS.MODEL_PREFERENCE, modelPreference);
      saveToStorage(STORAGE_KEYS.EXPORT_FORMAT, exportFormat);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
    };
  }, [scannedCards, pendingCards, batchDefaults, modelPreference, exportFormat]);

  // ─── Refs for use in callbacks without stale closures ──
  const batchDefaultsRef = useRef(batchDefaults);
  useEffect(() => { batchDefaultsRef.current = batchDefaults; }, [batchDefaults]);
  const minConfidenceRef = useRef(minConfidence);
  useEffect(() => { minConfidenceRef.current = minConfidence; }, [minConfidence]);

  const passesScanThreshold = useCallback((result) => {
    const similarity = Number(result?.similarity ?? 0);
    return similarity >= minConfidenceRef.current;
  }, []);

  const getCollectionVariantKey = useCallback((card) => {
    const cardId = card?.cardData?.id || '';
    const foilKey = card?.foil ? 'foil' : 'standard';
    const promoKey = card?.promo ? 'promo' : 'regular';
    return `${cardId}::${foilKey}::${promoKey}`;
  }, []);

  const mergeCardsIntoCollection = useCallback((cardsToAdd) => {
    if (!cardsToAdd || cardsToAdd.length === 0) {
      return;
    }

    setScannedCards((prev) => {
      let updated = [...prev];

      for (const cardToAdd of cardsToAdd) {
        const existingIndex = updated.findIndex((entry) => getCollectionVariantKey(entry) === getCollectionVariantKey(cardToAdd));
        if (existingIndex >= 0) {
          updated[existingIndex] = {
            ...updated[existingIndex],
            quantity: updated[existingIndex].quantity + cardToAdd.quantity,
          };
        } else {
          updated = [...updated, { ...cardToAdd }];
        }
      }

      return updated;
    });
  }, [getCollectionVariantKey]);

  // ─── Card Detection Handler ────────────────────────────────
  const handleCardDetected = useCallback((result) => {
    const { cardData, confidence, similarity, timestamp } = result;

    if (!passesScanThreshold(result)) return;

    setPendingCards(prev => {
      const existingIndex = prev.findIndex(c => c.cardData.id === cardData.id);
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: updated[existingIndex].quantity + 1,
        };
        showNotification(`${cardData.name} — qty +1`, 'success');
        return updated;
      } else {
        const defaults = batchDefaultsRef.current;
        showNotification(`+ ${cardData.name}`, 'success');
        return [...prev, {
          cardData,
          quantity: 1,
          condition: defaults.condition,
          language: defaults.language,
          foil: isFoilOnly(cardData) || defaults.foil,
          confidence,
          similarity,
          scanTimestamp: timestamp,
        }];
      }
    });

    setScanAddAnimation({
      key: `${cardData.id}-${timestamp}`,
      cardData,
      priceRecord: priceByCardId.get(cardData.id) || null,
    });

    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
  }, [passesScanThreshold, priceByCardId, showNotification]);

  const handleAddPendingCard = useCallback((cardData, options = {}) => {
    if (!cardData) return;

    const quantity = Math.max(1, Number(options.quantity || 1));
    const foilOnly = isFoilOnly(cardData);
    const foil = foilOnly || Boolean(options.foil);
    const timestamp = Date.now();

    setPendingCards((prev) => {
      const existingIndex = prev.findIndex((entry) => entry.cardData.id === cardData.id);
      if (existingIndex >= 0) {
        const updated = [...prev];
        const existing = updated[existingIndex];
        updated[existingIndex] = {
          ...existing,
          cardData,
          quantity: existing.quantity + quantity,
          foil: existing.foil || foil,
        };
        return updated;
      }

      const defaults = batchDefaultsRef.current;
      return [...prev, {
        cardData,
        quantity,
        condition: defaults.condition,
        language: defaults.language,
        foil,
        confidence: 1,
        similarity: 1,
        scanTimestamp: timestamp,
        manualAdded: true,
      }];
    });

    setScanAddAnimation({
      key: `${cardData.id}-${timestamp}`,
      cardData,
      priceRecord: priceByCardId.get(cardData.id) || null,
    });

    showNotification(quantity > 1 ? `+ ${cardData.name} x${quantity}` : `+ ${cardData.name}`, 'success');

    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
  }, [priceByCardId, showNotification]);

  // ─── Auto-Scan ────────────────────────────────────────────
  const autoScan = useAutoScan({
    cameraIsActive: camera.isActive,
    isProcessing: detection.isProcessing,
    detectSingleFrame: detection.detectSingleFrame,
    captureFrame: camera.captureFrame,
    onCardDetected: handleCardDetected,
  });

  // ─── Snap Scan (tap to capture single frame) ──────────────
  const handleSnapScan = useCallback(async () => {
    if (!camera.isActive || detection.isProcessing) return;

    const result = await detection.detectSingleFrame(camera.captureFrame);
    if (result && result.matched) {
      handleCardDetected(result);
      autoScan.setLastCardId(result.cardData.id);
    } else {
      showNotification('No card detected — try again', 'info');
    }
  }, [camera.isActive, camera.captureFrame, detection, handleCardDetected, showNotification, autoScan]);

  // ─── Pending → Export list handlers ──────────────────────────
  const handleConfirmPending = useCallback((cardIdOrPayload) => {
    const isPayload = typeof cardIdOrPayload === 'object' && cardIdOrPayload.cardId !== undefined;
    const cardId = isPayload ? cardIdOrPayload.cardId : cardIdOrPayload;
    const payloadData = isPayload ? cardIdOrPayload : null;

    const card = pendingCards.find((entry) => entry.cardData.id === cardId);
    if (!card) return;

    const cardToAdd = payloadData ? {
      ...card,
      cardData: payloadData.cardData,
      quantity: payloadData.quantity,
      foil: payloadData.foil,
      promo: payloadData.promo,
    } : card;

    mergeCardsIntoCollection([cardToAdd]);
    setPendingCards((prev) => prev.filter((entry) => entry.cardData.id !== cardId));
    showNotification(`${cardToAdd.cardData.name} added to export`, 'success');
  }, [mergeCardsIntoCollection, pendingCards, showNotification]);

  const handleConfirmAllPending = useCallback(() => {
    if (pendingCards.length === 0) return;

    mergeCardsIntoCollection(pendingCards);
    setPendingCards([]);
    showNotification(`${pendingCards.length} card${pendingCards.length !== 1 ? 's' : ''} added to export`, 'success');
  }, [mergeCardsIntoCollection, pendingCards, showNotification]);

  const handleRemovePending = useCallback((cardId) => {
    setPendingCards(prev => prev.filter(card => card.cardData.id !== cardId));
  }, []);

  const handleAdjustPendingQuantity = useCallback((cardId, delta) => {
    if (delta === 0) return;

    setPendingCards(prev => {
      const index = prev.findIndex(card => card.cardData.id === cardId);
      if (index < 0) return prev;
      const card = prev[index];

      if (delta > 0) {
        showNotification(`${card.cardData.name} duplicate added to pending`, 'success');
        return prev.map((entry, entryIndex) => (
          entryIndex === index
            ? { ...entry, quantity: entry.quantity + delta }
            : entry
        ));
      }

      const nextQuantity = card.quantity + delta;
      if (nextQuantity > 0) {
        showNotification(`${card.cardData.name} duplicate removed from pending`, 'info');
        return prev.map((entry, entryIndex) => (
          entryIndex === index
            ? { ...entry, quantity: nextQuantity }
            : entry
        ));
      }

      showNotification(`${card.cardData.name} removed from pending`, 'info');
      return prev.filter((_, entryIndex) => entryIndex !== index);
    });
  }, [showNotification]);

  const handleClearPending = useCallback(() => {
    setPendingCards([]);
  }, []);

  // ─── Card Management ───────────────────────────────────────
  const handleUpdateCard = useCallback((index, updatedCard) => {
    setScannedCards(prev => {
      const updated = [...prev];
      updated[index] = updatedCard;
      return updated;
    });
  }, []);

  const handleRemoveCard = useCallback((index) => {
    setScannedCards(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleSplitCardVariant = useCallback((index) => {
    setScannedCards(prev => {
      const card = prev[index];
      if (!card || card.quantity < 2 || isFoilOnly(card.cardData)) {
        return prev;
      }

      const nextVariantIsFoil = !Boolean(card.foil);
      const updated = [...prev];
      updated[index] = {
        ...card,
        quantity: card.quantity - 1,
      };
      updated.splice(index + 1, 0, {
        ...card,
        quantity: 1,
        foil: nextVariantIsFoil,
        scanTimestamp: Date.now(),
      });
      return updated;
    });

    showNotification('Separated 1 copy into the other finish', 'info');
  }, [showNotification]);

  const handleClearAll = useCallback(() => {
    if (scannedCards.length === 0) return;
    if (!confirm('Delete all cards from export list?')) return;
    setScannedCards([]);
  }, [scannedCards.length]);

  // Add a single card to export list (from individual add button)
  const handleAddCardToExport = useCallback((payload) => {
    const cardData = payload.cardData || payload;
    const qty = payload.quantity || 1;
    const foilOverride = payload.foil;
    const promoOverride = payload.promo || false;
    const targetFoil = isFoilOnly(cardData) || (foilOverride !== undefined ? Boolean(foilOverride) : Boolean(batchDefaultsRef.current.foil));
    const targetPromo = Boolean(promoOverride);

    setScannedCards(prev => {
      const existingIndex = prev.findIndex(c => getCollectionVariantKey(c) === getCollectionVariantKey({ cardData, foil: targetFoil, promo: targetPromo }));
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: updated[existingIndex].quantity + qty,
        };
        return updated;
      } else {
        const defaults = batchDefaultsRef.current;
        return [...prev, {
          cardData,
          quantity: qty,
          condition: defaults.condition,
          language: defaults.language,
          foil: targetFoil,
          promo: targetPromo,
          confidence: 1,
          scanTimestamp: Date.now(),
        }];
      }
    });
    showNotification(`+ ${cardData.name}`, 'success');
  }, [showNotification]);

  // Add multiple cards to export list at once
  const handleAddCardsToExport = useCallback((cardDataArray) => {
    setScannedCards(prev => {
      let updated = [...prev];
      for (const cardData of cardDataArray) {
        const targetFoil = isFoilOnly(cardData) || Boolean(batchDefaultsRef.current.foil);
        const targetPromo = false;
        const existingIndex = updated.findIndex(c => getCollectionVariantKey(c) === getCollectionVariantKey({ cardData, foil: targetFoil, promo: targetPromo }));
        if (existingIndex >= 0) {
          updated[existingIndex] = {
            ...updated[existingIndex],
            quantity: updated[existingIndex].quantity + 1,
          };
        } else {
          const defaults = batchDefaultsRef.current;
          updated = [...updated, {
            cardData,
            quantity: 1,
            condition: defaults.condition,
            language: defaults.language,
            foil: targetFoil,
            confidence: 1,
            scanTimestamp: Date.now(),
          }];
        }
      }
      return updated;
    });
    showNotification(`${cardDataArray.length} card${cardDataArray.length !== 1 ? 's' : ''} added to export`, 'success');
  }, [showNotification]);

  // ─── CSV Export ────────────────────────────────────────────
  const handleExport = useCallback(() => {
    const { valid, errors } = validateForExport(scannedCards, exportFormat);
    if (!valid) {
      showNotification(`Error: ${errors[0]}`, 'error');
      return;
    }

    const result = downloadCSV(scannedCards, null, exportFormat);
    if (result.success) {
      showNotification(
        `CSV downloaded: ${result.filename} (${result.format}, ${scannedCards.length} cards)`,
        'success'
      );
    }
  }, [scannedCards, showNotification, exportFormat]);

  // ─── Render ────────────────────────────────────────────────
  if (initError) {
    return <LoadingScreen progress={loadProgress} stage={loadStage} error={initError} onImportCardDatabase={handleImportCardDatabase} />;
  }

  if (isLoading) {
    return <LoadingScreen progress={loadProgress} stage={loadStage} />;
  }

  return (
    <AppShell>
      <input
        ref={cardDatabaseInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleCardDatabaseFileSelected}
      />

      {/* Tab content */}
      <div className="flex-1 flex flex-col min-h-0">
        {activeTab === 'scan' && (
          <ScanTab
            camera={camera}
            detection={detection}
            onSnapScan={handleSnapScan}
            pendingCards={pendingCards}
            onAddPendingCard={handleAddPendingCard}
            onConfirmPending={handleConfirmPending}
            onConfirmAllPending={handleConfirmAllPending}
            onRemovePending={handleRemovePending}
            onAdjustPendingQuantity={handleAdjustPendingQuantity}
            onClearPending={handleClearPending}
            onAddCardToExport={handleAddCardToExport}
            onAddCardsToExport={handleAddCardsToExport}
            showNotification={showNotification}
            batchDefaults={batchDefaults}
            minConfidence={minConfidence}
            autoScanEnabled={autoScan.autoScanEnabled}
            onToggleAutoScan={autoScan.toggleAutoScan}
            exportFormat={exportFormat}
            scanSetFilter={scanSetFilter}
            scanSetOptions={scanSetOptions}
            onUpdateScanSetFilter={setScanSetFilter}
            priceByCardId={priceByCardId}
            priceCurrency={priceCurrency}
            priceExchangeRates={priceExchangeRates}
          />
        )}

        {activeTab === 'collection' && (
          <CollectionTab
            scannedCards={scannedCards}
            onUpdateCard={handleUpdateCard}
            onRemoveCard={handleRemoveCard}
            onSplitCard={handleSplitCardVariant}
            onClearAll={handleClearAll}
            onExport={handleExport}
            priceByCardId={priceByCardId}
            priceCurrency={priceCurrency}
            priceExchangeRates={priceExchangeRates}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsTab
            batchDefaults={batchDefaults}
            onUpdateDefaults={setBatchDefaults}
            minConfidence={minConfidence}
            onUpdateMinConfidence={setMinConfidence}
            modelPreference={modelPreference}
            onUpdateModelPreference={setModelPreference}
            detectorMode={detection.detectorMode}
            exportFormat={exportFormat}
            onUpdateExportFormat={setExportFormat}
            onUpdateCardDatabase={handleImportCardDatabase}
            onUpdatePriceData={handleImportPriceSnapshot}
            maintenanceBusy={priceSyncBusy}
            cardDatabaseLabel={detection.detectorState === 'ready' ? (getMatcher().databaseSource === 'local' ? 'Imported locally' : 'Bundled file') : 'Unknown'}
            priceCacheLabel={priceSyncMeta
              ? `${priceSyncMeta.matchedRows}/${priceSyncMeta.totalRows} cards matched · FX ${priceExchangeRateDate}${priceSyncMeta.sourceHint ? ` · ${priceSyncMeta.sourceHint}` : ''}`
              : `${PRICE_SOURCE_LABEL} not imported yet`}
            priceCacheUpdatedAt={priceSyncMeta?.updatedAt || null}
            priceCurrency={priceCurrency}
            priceExchangeRates={priceExchangeRates}
            priceExchangeRateDate={priceExchangeRateDate}
            priceExchangeRateFallback={priceExchangeRateFallback}
            onUpdatePriceCurrency={setPriceCurrency}
            cameraDevices={cameraDevices}
            cameraDeviceId={cameraDeviceId}
            onUpdateCameraDeviceId={setCameraDeviceId}
            onRefreshCameraDevices={refreshCameraDevices}
            runtimeLabel={runtimeInfo ? `Desktop shell (${runtimeInfo.platform}/${runtimeInfo.arch})` : (isDesktopRuntime() ? 'Desktop shell' : 'Browser build')}
          />
        )}
      </div>

      {/* Bottom navigation */}
      <BottomTabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        scannedCount={scannedCards.reduce((sum, c) => sum + c.quantity, 0)}
      />

      {scanAddAnimation && (
        <ScanAddAnimation
          key={scanAddAnimation.key}
          cardData={scanAddAnimation.cardData}
          priceRecord={scanAddAnimation.priceRecord}
          priceCurrency={priceCurrency}
          priceExchangeRates={priceExchangeRates}
        />
      )}

      {/* Toast */}
      <ToastNotification notification={notification} />
    </AppShell>
  );
}
