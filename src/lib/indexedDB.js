/**
 * IndexedDB Storage Layer for Riftbound Scanner
 *
 * Stores the local matcher database and optional price cache.
 * Legacy cards/hash/scan stores remain in the schema for existing users.
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

function cloneMatcherDatabase(database) {
  return {
    ...database,
    cards: (database?.cards || []).map((card) => ({
      ...card,
      f: card.f instanceof Float32Array ? card.f : new Float32Array(card.f),
    })),
  };
}

// ─── Matcher Database Import ──────────────────────────────────────────────

/**
 * Save a full matcher database payload locally.
 * The payload is the parsed card-hashes.json structure.
 */
export async function saveMatcherDatabase(database) {
  const normalized = cloneMatcherDatabase(database);
  const db = await openDB();
  const snapshot = {
    id: 'card-hashes',
    updatedAt: new Date().toISOString(),
    database: normalized,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.MATCHER_DB, 'readwrite');
    const store = tx.objectStore(STORES.MATCHER_DB);
    store.put(snapshot);
    tx.oncomplete = () => resolve(snapshot);
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
      resolve(result?.database
        ? {
            id: result.id || 'card-hashes',
            updatedAt: result.updatedAt || null,
            database: cloneMatcherDatabase(result.database),
          }
        : null);
    };
    request.onerror = (e) => reject(e.target.error);
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

