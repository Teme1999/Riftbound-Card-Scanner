import React, { useState, useMemo } from 'react';
import { Download, Trash2, Layers, Search, X, ChevronDown } from 'lucide-react';
import ScannerCardRow from '../scanner/ScannerCardRow.jsx';

const COLLECTION_SORT_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: 'card-id', label: 'Card ID' },
  { value: 'name', label: 'Name' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'price', label: 'Price' },
  { value: 'amount', label: 'Amount' },
];

export default function CollectionTab({
  scannedCards,
  onUpdateCard,
  onRemoveCard,
  onSplitCard,
  onClearAll,
  onExport,
  priceByCardId,
  priceCurrency = 'EUR',
  priceExchangeRates,
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('original');

  // Filter cards based on search query
  const filteredCards = useMemo(() => {
    if (!searchQuery.trim()) return scannedCards;

    const query = searchQuery.toLowerCase().trim();
    return scannedCards.filter(card => {
      const name = card.cardData.name.toLowerCase();
      const collectorNumber = card.cardData.collectorNumber.toLowerCase();
      return name.includes(query) || collectorNumber.includes(query);
    });
  }, [scannedCards, searchQuery]);

  const sortedCards = useMemo(() => {
    if (sortBy === 'original') {
      return filteredCards;
    }

    const getConfidence = (card) => Number(card.similarity ?? card.confidence ?? 0);
    const getPriceValue = (card) => {
      const priceRecord = priceByCardId?.get(card.cardData.id);
      const priceValue = Number(priceRecord?.marketPrice ?? priceRecord?.price);
      return Number.isFinite(priceValue) ? priceValue : Number.NEGATIVE_INFINITY;
    };
    const getCardId = (card) => String(card.cardData.id || '');

    return [...filteredCards].sort((left, right) => {
      if (sortBy === 'card-id') {
        const idDelta = getCardId(left).localeCompare(getCardId(right), undefined, { numeric: true, sensitivity: 'base' });
        if (idDelta !== 0) return idDelta;
      }

      if (sortBy === 'name') {
        const nameDelta = left.cardData.name.localeCompare(right.cardData.name, undefined, { sensitivity: 'base' });
        if (nameDelta !== 0) return nameDelta;
      }

      if (sortBy === 'confidence') {
        const confidenceDelta = getConfidence(right) - getConfidence(left);
        if (confidenceDelta !== 0) return confidenceDelta;
      }

      if (sortBy === 'price') {
        const priceDelta = getPriceValue(right) - getPriceValue(left);
        if (priceDelta !== 0) return priceDelta;
      }

      if (sortBy === 'amount') {
        const amountDelta = (right.quantity || 0) - (left.quantity || 0);
        if (amountDelta !== 0) return amountDelta;
      }

      return left.cardData.name.localeCompare(right.cardData.name, undefined, { sensitivity: 'base' });
    });
  }, [filteredCards, sortBy, priceByCardId]);

  const totalCards = scannedCards.reduce((sum, c) => sum + c.quantity, 0);
  const filteredTotalCards = filteredCards.reduce((sum, c) => sum + c.quantity, 0);

  return (
    <div className="flex-1 overflow-y-auto pb-20">
      <div className="px-4 pt-5 pb-4 space-y-4">
        {/* Page title */}
        <div className="mb-2">
          <h1 className="text-xl font-display font-bold text-rift-100">Collection</h1>
          <p className="text-xs text-rift-400 mt-1">Your scanned cards ready for export</p>
        </div>

        {/* Search bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-rift-500 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name or number..."
            className="w-full h-10 pl-9 pr-9 bg-rift-800/50 border border-rift-600/30 rounded-xl text-sm text-rift-100 placeholder-rift-500 focus:outline-none focus:border-gold-500/60 transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-rift-500 hover:text-rift-300 hover:bg-rift-700 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Sort bar */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-gold-400/20 bg-gradient-to-r from-rift-900/80 to-rift-800/70 px-3 py-2 shadow-inner shadow-black/20">
          <span className="text-[10px] uppercase tracking-[0.22em] text-gold-300/80 whitespace-nowrap">
            Sort collection
          </span>
          <div className="relative flex-1 max-w-[180px]">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="w-full appearance-none rounded-lg border border-gold-400/20 px-3 py-1.5 pr-8 text-xs font-medium outline-none transition-colors focus:border-gold-300/50 focus:ring-1 focus:ring-gold-400/30"
              style={{
                backgroundColor: 'rgba(5, 10, 18, 0.82)',
                color: '#f3d27a',
                colorScheme: 'dark',
                WebkitAppearance: 'none',
                appearance: 'none',
              }}
              aria-label="Sort collection cards"
            >
              {COLLECTION_SORT_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gold-300/80" />
          </div>
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-4">
          <span className="text-sm font-semibold text-rift-100 mr-auto">
            {searchQuery ? (
              filteredTotalCards > 0
                ? `${filteredTotalCards} card${filteredTotalCards !== 1 ? 's' : ''} (${filteredCards.length} unique)`
                : 'No matches found'
            ) : (
              totalCards > 0
                ? `${totalCards} card${totalCards !== 1 ? 's' : ''} (${scannedCards.length} unique)`
                : 'No cards yet'
            )}
          </span>
          <button
            onClick={onExport}
            disabled={scannedCards.length === 0}
            className="btn-primary text-xs py-2 px-4 rounded-xl"
          >
            <Download className="w-4 h-4" />
            CSV
          </button>
          <button
            onClick={onClearAll}
            disabled={scannedCards.length === 0}
            className="btn-ghost text-xs py-2 px-3 text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-xl disabled:opacity-30"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        {/* Card list */}
        {scannedCards.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Layers className="w-10 h-10 text-rift-600 mb-3" />
            <p className="text-sm text-rift-400">No cards in your collection</p>
            <p className="text-xs text-rift-500 mt-1">
              Use the Scan tab to detect and add cards
            </p>
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="w-10 h-10 text-rift-600 mb-3" />
            <p className="text-sm text-rift-400">No cards match your search</p>
            <p className="text-xs text-rift-500 mt-1">
              Try a different search term
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {sortedCards.map((card) => {
                const originalIndex = scannedCards.findIndex(c => c.cardData.id === card.cardData.id && c.scanTimestamp === card.scanTimestamp);
                return (
                  <ScannerCardRow
                    key={`${card.cardData.id}-${card.scanTimestamp}`}
                    card={card}
                    index={originalIndex}
                    onUpdate={onUpdateCard}
                    onRemove={onRemoveCard}
                    onSplit={onSplitCard}
                    priceRecord={priceByCardId?.get(card.cardData.id) || null}
                    priceCurrency={priceCurrency}
                    priceExchangeRates={priceExchangeRates}
                  />
                );
              })}
            </div>
            {/* Condition abbreviations legend */}
            <p className="text-[10px] text-rift-600 text-center pt-2">
              NM = Near Mint · LP = Lightly Played · MP = Moderately Played · HP = Heavily Played · D = Damaged
            </p>
          </>
        )}
      </div>
    </div>
  );
}
