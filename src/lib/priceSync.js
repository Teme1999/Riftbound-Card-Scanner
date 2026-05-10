import { getMatcher } from './cardMatcher.js';
import { getPriceRecord, loadPriceSyncMeta, replacePriceSnapshot } from './indexedDB.js';
import { FALLBACK_EXCHANGE_RATE_DATE, FALLBACK_ECB_EUR_RATES, normalizeExchangeRates } from './priceFormat.js';

export const PRICE_SOURCE_LABEL = 'cards.csv from cristian-bravo/riftbound-prices';
export const PRICE_SOURCE_URL = 'https://raw.githubusercontent.com/cristian-bravo/riftbound-prices/main/cards.csv';
export const ECB_EXCHANGE_RATE_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export async function fetchPriceSnapshotCsvFromGithub(sourceUrl = PRICE_SOURCE_URL) {
  const response = await fetch(sourceUrl, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Failed to fetch price snapshot from GitHub (${response.status})`);
  }

  return response.text();
}

export async function fetchExchangeRatesFromEcb(sourceUrl = ECB_EXCHANGE_RATE_URL) {
  const response = await fetch(sourceUrl, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Failed to fetch ECB exchange rate (${response.status})`);
  }

  const xmlText = await response.text();
  const dateMatch = xmlText.match(/<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']/);
  const rates = { EUR: 1 };
  const cubePattern = /<Cube\s+([^>]*currency=["'][A-Z]{3}["'][^>]*)\/?>/g;
  let match = cubePattern.exec(xmlText);

  while (match) {
    const attributes = match[1];
    const currency = attributes.match(/currency=["']([A-Z]{3})["']/)?.[1];
    const rawRate = Number.parseFloat(attributes.match(/rate=["']([^"']+)["']/)?.[1]);
    if (currency && Number.isFinite(rawRate) && rawRate > 0) {
      rates[currency] = rawRate;
    }
    match = cubePattern.exec(xmlText);
  }

  if (!Number.isFinite(rates.USD) || rates.USD <= 0) {
    throw new Error('ECB exchange rate response did not include a valid USD rate.');
  }

  return {
    exchangeRates: normalizeExchangeRates(rates),
    exchangeRateDate: dateMatch?.[1] || null,
    exchangeRateSource: sourceUrl,
    exchangeRateFallback: false,
  };
}

async function resolveExchangeRates(options = {}) {
  if (options.exchangeRates || options.usdPerEurRate) {
    const exchangeRates = normalizeExchangeRates(options.exchangeRates || { USD: options.usdPerEurRate });
    return {
      exchangeRates,
      exchangeRateDate: options.exchangeRateDate || options.usdPerEurRateDate || null,
      exchangeRateSource: options.exchangeRateSource || options.usdPerEurRateSource || 'provided',
      exchangeRateFallback: false,
    };
  }

  try {
    return await fetchExchangeRatesFromEcb(options.exchangeRateSourceUrl || ECB_EXCHANGE_RATE_URL);
  } catch (error) {
    console.warn('[PriceSync] Falling back to bundled exchange rates:', error);
    return {
      exchangeRates: FALLBACK_ECB_EUR_RATES,
      exchangeRateDate: FALLBACK_EXCHANGE_RATE_DATE,
      exchangeRateSource: ECB_EXCHANGE_RATE_URL,
      exchangeRateFallback: true,
    };
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toUpperCase();
}

function normalizeNumber(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\s*#\s*/g, '')
    .replace(/[^a-z0-9/.-]+/gi, '')
    .trim()
    .toUpperCase();
}

function parseMoney(value) {
  const parsed = Number.parseFloat(String(value || '').replace(/[$,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || '').replace(/[,\s]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsv(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (inQuotes) {
      if (char === '"') {
        if (normalized[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      if (row.some((value) => String(value || '').trim() !== '')) {
        rows.push(row);
      }
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => String(value || '').trim() !== '')) {
    rows.push(row);
  }

  if (rows.length === 0) {
    return [];
  }

  const header = rows[0].map((value) => String(value || '').trim());
  return rows.slice(1).map((values) => {
    const entry = {};
    header.forEach((key, index) => {
      entry[key] = String(values[index] || '').trim();
    });
    return entry;
  });
}

function buildCardIndex(cards = []) {
  const nameIndex = new Map();

  for (const card of cards) {
    const name = normalizeText(card.name);
    if (!name) {
      continue;
    }

    if (!nameIndex.has(name)) {
      nameIndex.set(name, []);
    }

    nameIndex.get(name).push(card);
  }

  return nameIndex;
}

function scoreCardMatch(card, row) {
  let score = 0;

  const cardName = normalizeText(card.name);
  const rowName = normalizeText(row.name);
  const cardSet = normalizeText(card.set || card.setName);
  const rowSet = normalizeText(row.set);
  const cardNumber = normalizeNumber(card.collectorNumber || card.number || card.code);
  const rowNumber = normalizeNumber(row.number);

  if (cardName && rowName) {
    if (cardName === rowName) {
      score += 60;
    } else if (cardName.includes(rowName) || rowName.includes(cardName)) {
      score += 25;
    }
  }

  if (cardSet && rowSet) {
    if (cardSet === rowSet) {
      score += 25;
    } else if (cardSet.includes(rowSet) || rowSet.includes(cardSet)) {
      score += 10;
    }
  }

  if (cardNumber && rowNumber) {
    if (cardNumber === rowNumber) {
      score += 20;
    } else if (cardNumber.includes(rowNumber) || rowNumber.includes(cardNumber)) {
      score += 8;
    }
  }

  return score;
}

function resolveCardForRow(row, cards, nameIndex) {
  const normalizedName = normalizeText(row.name);
  const indexedCards = normalizedName ? (nameIndex.get(normalizedName) || []) : [];
  const candidates = indexedCards.length > 0 ? indexedCards : cards;

  let bestCard = null;
  let bestScore = -1;

  for (const card of candidates) {
    const score = scoreCardMatch(card, row);
    if (score > bestScore) {
      bestScore = score;
      bestCard = card;
    }
  }

  if (!bestCard || bestScore <= 0) {
    return null;
  }

  return bestCard;
}

function normalizePriceRow(row) {
  return {
    name: String(row.name || '').trim(),
    set: String(row.set || '').trim(),
    rarity: String(row.rarity || '').trim(),
    number: String(row.number || '').trim(),
    listings: parseInteger(row.listings) ?? 0,
    price: parseMoney(row.price),
    marketPrice: parseMoney(row.marketPrice),
    availability: String(row.availability || '').trim(),
    updatedAt: String(row.updatedAt || '').trim(),
  };
}

export async function importPriceSnapshotCsv(csvText, options = {}) {
  const rows = parseCsv(csvText).map(normalizePriceRow).filter((row) => row.name && row.set);
  const matcher = options.matcher || getMatcher();
  const cards = options.cards || matcher.cards || [];

  if (cards.length === 0) {
    throw new Error('The local card database is not loaded yet.');
  }

  if (rows.length === 0) {
    throw new Error('The selected file does not contain any price rows.');
  }

  const nameIndex = buildCardIndex(cards);
  const recordsByCardId = new Map();
  let unmatched = 0;

  for (const row of rows) {
    const matchedCard = resolveCardForRow(row, cards, nameIndex);
    if (!matchedCard) {
      unmatched += 1;
      continue;
    }

    recordsByCardId.set(matchedCard.id, {
      cardId: matchedCard.id,
      name: matchedCard.name,
      set: matchedCard.set || matchedCard.setName || row.set,
      setName: matchedCard.setName || matchedCard.set || row.set,
      collectorNumber: matchedCard.collectorNumber || matchedCard.number || row.number,
      sourceName: row.name,
      sourceSet: row.set,
      sourceNumber: row.number,
      rarity: row.rarity,
      listings: row.listings,
      price: row.price,
      marketPrice: row.marketPrice,
      availability: row.availability,
      updatedAt: row.updatedAt,
      importedAt: new Date().toISOString(),
    });
  }

  const records = [...recordsByCardId.values()];

  if (records.length === 0) {
    throw new Error('No cards from the price snapshot matched the local card database.');
  }

  const exchangeRate = await resolveExchangeRates(options);
  const exchangeRates = normalizeExchangeRates(exchangeRate.exchangeRates);

  const snapshot = await replacePriceSnapshot(records, {
    source: PRICE_SOURCE_LABEL,
    sourceType: 'csv',
    sourceHint: options.sourceHint || null,
    priceCurrency: 'USD',
    exchangeRates,
    exchangeRateDate: exchangeRate.exchangeRateDate,
    exchangeRateSource: exchangeRate.exchangeRateSource,
    exchangeRateFallback: exchangeRate.exchangeRateFallback,
    usdPerEurRate: exchangeRates.USD,
    usdPerEurRateDate: exchangeRate.exchangeRateDate,
    usdPerEurRateSource: exchangeRate.exchangeRateSource,
    usdPerEurRateFallback: exchangeRate.exchangeRateFallback,
    importedAt: new Date().toISOString(),
    totalRows: rows.length,
    matchedRows: records.length,
    unmatchedRows: unmatched,
  });

  return {
    snapshot,
    totalRows: rows.length,
    matchedRows: records.length,
    unmatchedRows: unmatched,
    exchangeRate,
  };
}

export async function loadStoredPriceMeta() {
  return loadPriceSyncMeta();
}

export async function getStoredPriceForCard(cardId) {
  return getPriceRecord(cardId);
}
