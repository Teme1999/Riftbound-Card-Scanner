/**
 * CSV Exporter for Riftbound Scanner.
 *
 * Supports multiple export schemas:
 *   - CardNexus / PowerTools
 *   - Piltover Archive
 */

export const EXPORT_FORMATS = {
  CARDNEXUS: 'cardnexus',
  PILTOVER: 'piltover',
};

export const EXPORT_FORMAT_OPTIONS = [
  { value: EXPORT_FORMATS.CARDNEXUS, label: 'CardNexus / PowerTools' },
  { value: EXPORT_FORMATS.PILTOVER, label: 'Piltover Archive' },
];

const CARDNEXUS_HEADERS = [
  'Quantity',
  'Card Name',
  'Collector Number',
  'Expansion',
  'Condition',
  'Language',
  'Finish',
];

const PILTOVER_HEADERS = [
  'Variant Number',
  'Card Name',
  'Set',
  'Set Prefix',
  'Rarity',
  'Variant Type',
  'Variant Label',
  'Foil',
  'Quantity',
  'Language',
  'Condition',
  'Grading Company',
  'Grading Value',
  'Grading Label',
  'Notes',
];

const FOIL_ONLY_RARITIES = new Set(['rare', 'epic', 'legendary', 'showcase', 'legend']);

/**
 * Escape a CSV field (handle commas, quotes, newlines)
 */
function escapeCSV(value) {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeExportFormat(format) {
  return format === EXPORT_FORMATS.PILTOVER ? EXPORT_FORMATS.PILTOVER : EXPORT_FORMATS.CARDNEXUS;
}

function getCardDisplaySet(cardData) {
  return cardData?.setName || cardData?.set || '';
}

function getPromoVariantLabel(cardData) {
  const displaySet = getCardDisplaySet(cardData);
  const baseSet = displaySet.replace(/\s+Set$/i, '').trim();
  return baseSet ? `${baseSet} Promo` : 'Promo';
}

function getCardPrefix(cardData) {
  if (cardData?.set) return cardData.set;
  const code = cardData?.code || '';
  const codePrefix = code.split('-')[0];
  return codePrefix || '';
}

function getCardVariantNumber(cardData) {
  const codePart = (cardData?.code || '').split('/')[0].trim();
  if (codePart) return codePart;

  const prefix = getCardPrefix(cardData);
  const collectorNumber = String(cardData?.collectorNumber || '').replace(/\*/g, '').trim();
  if (prefix && collectorNumber) return `${prefix}-${collectorNumber}`;
  return collectorNumber || prefix || '';
}

function isOvernumbered(cardData) {
  const codePart = (cardData?.code || '').split('/');
  if (codePart.length !== 2) return false;

  const collectorNumber = parseInt(String(cardData?.collectorNumber || '').replace(/\D/g, ''), 10) || 0;
  const total = parseInt(codePart[1], 10) || 0;
  return collectorNumber > 0 && total > 0 && collectorNumber > total;
}

function isRuneVariant(cardData) {
  const codePart = String(cardData?.code || '').split('/')[0];
  return /-R\d+[a-z]?$/i.test(codePart);
}

function getVariantType(card) {
  const rarity = String(card?.cardData?.rarity || '').toLowerCase();
  if (card?.promo) return 'Promo';
  if (isOvernumbered(card?.cardData)) return 'Overnumbered';
  if (rarity === 'showcase') return 'Showcase';
  return 'Standard';
}

function getVariantLabel(card) {
  const cardData = card?.cardData || {};
  const rarity = String(cardData.rarity || '').toLowerCase();

  if (card?.promo) {
    return getPromoVariantLabel(cardData);
  }

  if (isOvernumbered(cardData)) {
    return 'Overnumbered';
  }

  if (isRuneVariant(cardData)) {
    return `${getCardPrefix(cardData)} Foil`;
  }

  const code = String(cardData.code || '');
  const isAltArt = code.includes('*') || /[a-z]$/i.test(code.split('/')[0]) || rarity === 'showcase';

  if (isAltArt) {
    return 'Alt Art';
  }

  if (card?.foil) {
    return FOIL_ONLY_RARITIES.has(rarity) ? 'Standard' : 'Foil';
  }

  return 'Standard';
}

function buildCardNexusRow(card) {
  const exportName = card.cardData.name;
  const exportCollector = (card.cardData.collectorNumber || '').replace(/\*/g, '');
  const exportSet = card.promo ? 'OGNX' : (card.cardData.set || 'OGN');

  return [
    card.quantity || 1,
    escapeCSV(exportName),
    escapeCSV(exportCollector),
    escapeCSV(exportSet),
    escapeCSV(card.condition || 'Near Mint'),
    escapeCSV(card.language || 'English'),
    card.foil ? 'Foil' : 'Standard',
  ];
}

function buildPiltoverRow(card) {
  const cardData = card.cardData || {};
  let variantNumber = getCardVariantNumber(cardData);
  const variantType = getVariantType(card);
  const variantLabel = getVariantLabel(card);

  const displaySet = getCardDisplaySet(cardData);
  const setPrefix = getCardPrefix(cardData);

  return [
    escapeCSV(variantNumber),
    escapeCSV(cardData.name || ''),
    escapeCSV(displaySet),
    escapeCSV(setPrefix),
    escapeCSV(cardData.rarity ? String(cardData.rarity).replace(/\b\w/g, (m) => m.toUpperCase()) : ''),
    escapeCSV(variantType),
    escapeCSV(variantLabel),
    card.foil ? 'true' : 'false',
    card.quantity || 1,
    escapeCSV(card.language || 'English'),
    escapeCSV(card.condition || 'Near Mint'),
    '',
    '',
    '',
    '',
  ];
}

function buildRows(cards, format) {
  const normalizedFormat = normalizeExportFormat(format);
  const headers = normalizedFormat === EXPORT_FORMATS.PILTOVER ? PILTOVER_HEADERS : CARDNEXUS_HEADERS;
  const lines = [headers.join(',')];

  for (const card of cards) {
    const row = normalizedFormat === EXPORT_FORMATS.PILTOVER
      ? buildPiltoverRow(card)
      : buildCardNexusRow(card);
    lines.push(row.join(','));
  }

  return lines.join('\r\n');
}

/**
 * Generate CSV content from scanned cards
 *
 * @param {Array<ScannedCard>} cards - Array of scanned cards with metadata
 * @returns {string} CSV content as string
 *
 * ScannedCard shape:
 * {
 *   cardData: { name, collectorNumber, set, setName },
 *   quantity: number,
 *   condition: string,
 *   language: string,
 *   foil: boolean,
 * }
 */
export function generateCSV(cards, format = EXPORT_FORMATS.CARDNEXUS) {
  return buildRows(cards, format);
}

/**
 * Trigger a CSV download in the browser
 *
 * @param {Array<ScannedCard>} cards
 * @param {string} filename
 * @returns {{ success: boolean, filename: string, format: string }} Download result with metadata
 */
export function downloadCSV(cards, filename = null, format = EXPORT_FORMATS.CARDNEXUS) {
  if (!cards || cards.length === 0) {
    console.warn('[CSV] No cards to export');
    return { success: false, filename: null, format: null };
  }

  const normalizedFormat = normalizeExportFormat(format);
  const csvContent = generateCSV(cards, normalizedFormat);

  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });

  const timestamp = new Date().toISOString().slice(0, 10);
  const prefix = normalizedFormat === EXPORT_FORMATS.PILTOVER ? 'riftbound-piltover' : 'riftbound-scan';
  const finalFilename = filename || `${prefix}-${timestamp}.csv`;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = finalFilename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    document.body.removeChild(link);
  }, 100);

  const formatLabel = normalizedFormat === EXPORT_FORMATS.PILTOVER ? 'Piltover Archive' : 'CardNexus/PowerTools';
  return { success: true, filename: finalFilename, format: formatLabel };
}

/**
 * Generate a preview of the CSV content (first N rows)
 */
export function previewCSV(cards, maxRows = 5, format = EXPORT_FORMATS.CARDNEXUS) {
  const preview = cards.slice(0, maxRows);
  return generateCSV(preview, format);
}

/**
 * Validate that all required fields are present
 */
export function validateForExport(cards, format = EXPORT_FORMATS.CARDNEXUS) {
  const errors = [];
  const normalizedFormat = normalizeExportFormat(format);

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card.cardData?.name) {
      errors.push(`Row ${i + 1}: Missing card name`);
    }
    if (!card.cardData?.collectorNumber) {
      errors.push(`Row ${i + 1}: Missing collector number`);
    }
    if (!card.quantity || card.quantity < 1) {
      errors.push(`Row ${i + 1}: Invalid quantity`);
    }

    if (normalizedFormat === EXPORT_FORMATS.PILTOVER && !getCardVariantNumber(card.cardData)) {
      errors.push(`Row ${i + 1}: Missing Piltover variant number`);
    }
  }

  return { valid: errors.length === 0, errors };
}
