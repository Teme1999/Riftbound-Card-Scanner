import { isFoilOnly } from '../data/sampleCards.js';

let nextEntryId = 0;

export function createEntryId() {
  return globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${++nextEntryId}`;
}

export function createCardEntry(payload, defaults = {}) {
  const entry = payload.cardData ? payload : { cardData: payload };
  const quantity = Number(entry.quantity ?? 1);
  return {
    ...entry,
    entryId: entry.entryId || createEntryId(),
    quantity: Number.isFinite(quantity) ? Math.max(1, Math.trunc(quantity)) : 1,
    condition: entry.condition || defaults.condition || 'Near Mint',
    language: entry.language || defaults.language || 'English',
    foil: isFoilOnly(entry.cardData) || Boolean(entry.foil ?? defaults.foil),
    promo: Boolean(entry.promo),
    scanTimestamp: entry.scanTimestamp ?? Date.now(),
  };
}

// Add stable row identities to older localStorage saves without merging rows.
export function restoreCardEntries(entries = []) {
  const usedIds = new Set();
  return entries.map((entry) => {
    const restored = createCardEntry(entry);
    if (usedIds.has(restored.entryId)) restored.entryId = createEntryId();
    usedIds.add(restored.entryId);
    return restored;
  });
}

export function getCardVariantKey(entry) {
  return JSON.stringify([
    entry.cardData.id,
    Boolean(entry.foil),
    Boolean(entry.promo),
    entry.condition || 'Near Mint',
    entry.language || 'English',
  ]);
}

export function mergeCardEntries(existing, incoming) {
  const updated = [...existing];
  for (const payload of incoming) {
    const entry = createCardEntry(payload);
    const key = getCardVariantKey(entry);
    const index = updated.findIndex((candidate) => getCardVariantKey(candidate) === key);
    if (index < 0) {
      // A split or corrected pending row may share an id with a collection row.
      if (updated.some((candidate) => candidate.entryId === entry.entryId)) {
        entry.entryId = createEntryId();
      }
      updated.push(entry);
    } else {
      updated[index] = { ...updated[index], quantity: updated[index].quantity + entry.quantity };
    }
  }
  return updated;
}

export function matchesPendingScan(event, entry) {
  if (event.entryId) return event.entryId === entry.entryId;
  if (event.variantKey) return event.variantKey === getCardVariantKey(entry);
  return event.cardId === entry.cardData.id;
}
