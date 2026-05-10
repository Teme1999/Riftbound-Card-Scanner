/**
 * IndexedDB Storage Layer for Riftbound Scanner
 *
 * Stores:
 *   - Reference card hashes (for pHash matching)
 *   - Card metadata (from Riftcodex/Riot API)
 *   - User scan history
 */

const DB_NAME = 'riftbound-scanner';
const DB_VERSION = 4;

const STORES = {
  CARDS: 'cards',           // Card metadata
  HASHES: 'hashes',         // pHash reference hashes
  SCAN_HISTORY: 'scans',    // Scan sessions
  MATCHER_DB: 'matcher_db',  // Imported card-hashes.json payload
  PRICES: 'prices',          // Cached price snapshot records
  PRICE_SYNC_META: 'price_sync_meta', // Latest price import metadata
};

let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Cards store
      if (!db.objectStoreNames.contains(STORES.CARDS)) {
        const cardStore = db.createObjectStore(STORES.CARDS, { keyPath: 'id' });
        cardStore.createIndex('by_set', 'set', { unique: false });
        cardStore.createIndex('by_collector', ['set', 'collectorNumber'], { unique: true });
        cardStore.createIndex('by_name', 'name', { unique: false });
      }

      // Hashes store
      if (!db.objectStoreNames.contains(STORES.HASHES)) {
        const hashStore = db.createObjectStore(STORES.HASHES, { keyPath: 'cardId' });
        hashStore.createIndex('by_hash', 'hash', { unique: false });
        hashStore.createIndex('by_set', 'set', { unique: false });
      }

      // Scan history store
      if (!db.objectStoreNames.contains(STORES.SCAN_HISTORY)) {
        const scanStore = db.createObjectStore(STORES.SCAN_HISTORY, {
          keyPath: 'id',
          autoIncrement: true,
        });
        scanStore.createIndex('by_date', 'timestamp', { unique: false });
      }

      // Matcher database store
      if (!db.objectStoreNames.contains(STORES.MATCHER_DB)) {
        db.createObjectStore(STORES.MATCHER_DB, { keyPath: 'id' });
      }

      // Price cache store
      if (!db.objectStoreNames.contains(STORES.PRICES)) {
        const priceStore = db.createObjectStore(STORES.PRICES, { keyPath: 'cardId' });
        priceStore.createIndex('by_updated_at', 'updatedAt', { unique: false });
        priceStore.createIndex('by_set', 'set', { unique: false });
      }

      // Price sync metadata store
      if (!db.objectStoreNames.contains(STORES.PRICE_SYNC_META)) {
        db.createObjectStore(STORES.PRICE_SYNC_META, { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject(new Error(`IndexedDB error: ${event.target.error?.message}`));
    };
  });
}

/**
 * Generic transaction helper
 */
async function withTransaction(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);

    tx.oncomplete = () => resolve(result);
    tx.onerror = (e) => reject(e.target.error);
  });
}

function cloneMatcherDatabase(database) {
  return {
    ...database,
    cards: (database?.cards || []).map((card) => ({
      ...card,
      f: card.f instanceof Float32Array ? card.f : new Float32Array(card.f),
      d: card.d instanceof Float32Array ? card.d : (card.d ? new Float32Array(card.d) : undefined),
    })),
  };
}

// ─── Card Metadata Operations ─────────────────────────────────────────────

/**
 * Store an array of cards from the API
 */
export async function storeCards(cards) {
  const db = await openDB();
  const tx = db.transaction(STORES.CARDS, 'readwrite');
  const store = tx.objectStore(STORES.CARDS);

  for (const card of cards) {
    store.put(card);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(cards.length);
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Get all cards, optionally filtered by set
 */
export async function getCards(setId = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CARDS, 'readonly');
    const store = tx.objectStore(STORES.CARDS);

    let request;
    if (setId) {
      const index = store.index('by_set');
      request = index.getAll(setId);
    } else {
      request = store.getAll();
    }

    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Get a card by its ID
 */
export async function getCard(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CARDS, 'readonly');
    const store = tx.objectStore(STORES.CARDS);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Look up a card by set and collector number
 */
export async function getCardByCollector(set, collectorNumber) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CARDS, 'readonly');
    const store = tx.objectStore(STORES.CARDS);
    const index = store.index('by_collector');
    const request = index.get([set, collectorNumber]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

// ─── Hash Operations ──────────────────────────────────────────────────────

/**
 * Store reference hashes for cards
 * @param {Array<{cardId: string, hash: number, set: string}>} hashes
 */
export async function storeHashes(hashes) {
  const db = await openDB();
  const tx = db.transaction(STORES.HASHES, 'readwrite');
  const store = tx.objectStore(STORES.HASHES);

  for (const entry of hashes) {
    store.put(entry);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(hashes.length);
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Get all reference hashes, optionally filtered by set
 * @returns {Array<{cardId: string, hash: number, set: string}>}
 */
export async function getHashes(setId = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.HASHES, 'readonly');
    const store = tx.objectStore(STORES.HASHES);

    let request;
    if (setId) {
      const index = store.index('by_set');
      request = index.getAll(setId);
    } else {
      request = store.getAll();
    }

    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Count stored hashes
 */
export async function getHashCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.HASHES, 'readonly');
    const store = tx.objectStore(STORES.HASHES);
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

// ─── Scan History ─────────────────────────────────────────────────────────

/**
 * Save a scan session
 */
export async function saveScanSession(session) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SCAN_HISTORY, 'readwrite');
    const store = tx.objectStore(STORES.SCAN_HISTORY);
    const request = store.add({
      ...session,
      timestamp: new Date().toISOString(),
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────

/**
 * Check if the database has been populated
 */
export async function isDatabasePopulated() {
  try {
    const cards = await getCards();
    return cards.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clear all data (for debugging)
 */
export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction([STORES.CARDS, STORES.HASHES, STORES.SCAN_HISTORY, STORES.PRICES, STORES.PRICE_SYNC_META], 'readwrite');
  tx.objectStore(STORES.CARDS).clear();
  tx.objectStore(STORES.HASHES).clear();
  tx.objectStore(STORES.SCAN_HISTORY).clear();
  tx.objectStore(STORES.PRICES).clear();
  tx.objectStore(STORES.PRICE_SYNC_META).clear();
  return new Promise((resolve) => { tx.oncomplete = resolve; });
}

// ─── Matcher Database Import ──────────────────────────────────────────────

/**
 * Save a full matcher database payload locally.
 * The payload is the parsed card-hashes.json structure.
 */
export async function saveMatcherDatabase(database) {
  const normalized = cloneMatcherDatabase(database);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.MATCHER_DB, 'readwrite');
    const store = tx.objectStore(STORES.MATCHER_DB);
    store.put({
      id: 'card-hashes',
      updatedAt: new Date().toISOString(),
      database: normalized,
    });
    tx.oncomplete = () => resolve(normalized);
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Load the locally stored matcher database, if one exists.
 */
export async function loadMatcherDatabase() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.MATCHER_DB, 'readonly');
    const store = tx.objectStore(STORES.MATCHER_DB);
    const request = store.get('card-hashes');
    request.onsuccess = () => {
      const result = request.result;
      resolve(result?.database ? cloneMatcherDatabase(result.database) : null);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Remove the locally stored matcher database.
 */
export async function clearMatcherDatabase() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.MATCHER_DB, 'readwrite');
    const store = tx.objectStore(STORES.MATCHER_DB);
    store.delete('card-hashes');
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ─── Price Cache Operations ──────────────────────────────────────────────

export async function replacePriceSnapshot(records, metadata = {}) {
  const db = await openDB();
  const importedAt = new Date().toISOString();
  const snapshot = {
    id: 'latest',
    updatedAt: importedAt,
    ...metadata,
    totalRecords: records.length,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.PRICES, STORES.PRICE_SYNC_META], 'readwrite');
    const priceStore = tx.objectStore(STORES.PRICES);
    const metaStore = tx.objectStore(STORES.PRICE_SYNC_META);

    priceStore.clear();
    for (const record of records) {
      priceStore.put(record);
    }

    metaStore.put(snapshot);

    tx.oncomplete = () => resolve(snapshot);
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getPriceRecord(cardId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRICES, 'readonly');
    const store = tx.objectStore(STORES.PRICES);
    const request = store.get(cardId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function getPriceRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRICES, 'readonly');
    const store = tx.objectStore(STORES.PRICES);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function loadPriceSyncMeta() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRICE_SYNC_META, 'readonly');
    const store = tx.objectStore(STORES.PRICE_SYNC_META);
    const request = store.get('latest');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function savePriceSyncMeta(meta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRICE_SYNC_META, 'readwrite');
    const store = tx.objectStore(STORES.PRICE_SYNC_META);
    store.put({
      id: 'latest',
      updatedAt: new Date().toISOString(),
      ...meta,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getPriceCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRICES, 'readonly');
    const store = tx.objectStore(STORES.PRICES);
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = (e) => reject(e.target.error);
  });
}
