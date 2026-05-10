import React, { memo } from 'react';
import { Trash2, Plus, Minus, Sparkles } from 'lucide-react';
import { CONDITIONS, LANGUAGES, DOMAIN_COLORS, RARITY_STYLES, isFoilOnly } from '../../data/sampleCards.js';
import { formatPrice } from '../../lib/priceFormat.js';

const ScannerCardRow = memo(function ScannerCardRow({ card, index, onUpdate, onRemove, onSplit, priceRecord, priceCurrency = 'EUR', priceExchangeRates }) {
  const { cardData, quantity, condition, language, foil, promo } = card;
  const domainStyle = DOMAIN_COLORS[cardData.domain] || DOMAIN_COLORS.colorless;
  const rarityStyle = RARITY_STYLES[cardData.rarity] || RARITY_STYLES.common;
  const foilOnly = isFoilOnly(cardData);
  const priceLabel = priceRecord ? formatPrice(priceRecord.marketPrice ?? priceRecord.price, priceCurrency, priceExchangeRates) : null;
  const canSplitVariant = Boolean(onSplit) && quantity > 1 && !foilOnly;

  const handleFieldChange = (field, value) => {
    onUpdate(index, { ...card, [field]: value });
  };

  return (
    <div className="rounded-xl bg-rift-700/50 border border-rift-600/20 p-3 fade-in">
      <div className="flex gap-3">
        {/* Card thumbnail */}
        <div className="w-12 h-16 rounded-lg overflow-hidden bg-rift-800 border border-rift-600/30 flex-shrink-0">
          <img
            src={`/cards/${cardData.id}.webp`}
            alt={cardData.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>

        <div className="flex-1 min-w-0">
          {/* Top row: name + delete */}
          <div className="flex items-start gap-2 mb-2">
            <div className="flex items-center gap-1.5 pt-0.5">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: domainStyle.hex }}
                title={cardData.domain}
              />
              <span className={`text-[10px] font-mono font-bold ${rarityStyle.color}`} title={cardData.rarity}>
                {rarityStyle.label}
              </span>
              <span className="text-[10px] font-mono text-rift-500">
                #{cardData.collectorNumber}
              </span>
            </div>
            <h4 className="flex-1 text-sm font-semibold text-rift-100 truncate pt-0.5">
              {cardData.name}
            </h4>
            <button
              onClick={() => onRemove(index)}
              title="Remove card"
              className="p-1 rounded-lg text-rift-500 hover:text-red-400 hover:bg-red-400/10 transition-colors flex-shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Bottom row: qty, condition, language, foil, variant */}
          <div className="flex items-center gap-2 flex-wrap">
            {priceLabel && (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                <span>{priceLabel}</span>
              </div>
            )}

            {/* Quantity */}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => handleFieldChange('quantity', Math.max(1, quantity - 1))}
                className="w-6 h-6 rounded-lg bg-rift-800 border border-rift-600/40 flex items-center justify-center text-rift-300 hover:bg-rift-600 transition-colors"
              >
                <Minus className="w-2.5 h-2.5" />
              </button>
              <input
                type="text"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v)) handleFieldChange('quantity', Math.min(99, Math.max(1, v)));
                }}
                className="h-6 text-center text-xs font-mono bg-rift-800 border border-rift-600/40 rounded-lg text-rift-100 focus:outline-none focus:border-gold-500/60"
                style={{ width: `${Math.max(2, String(quantity).length + 1)}ch` }}
              />
              <button
                onClick={() => handleFieldChange('quantity', Math.min(99, quantity + 1))}
                className="w-6 h-6 rounded-lg bg-rift-800 border border-rift-600/40 flex items-center justify-center text-rift-300 hover:bg-rift-600 transition-colors"
              >
                <Plus className="w-2.5 h-2.5" />
              </button>
            </div>

            {/* Condition */}
            <select
              value={condition}
              onChange={(e) => handleFieldChange('condition', e.target.value)}
              title={CONDITIONS.find(c => c.value === condition)?.label || condition}
              className="h-6 text-[10px] bg-rift-800 border border-rift-600/40 rounded-lg text-rift-200 px-1.5 focus:outline-none focus:border-gold-500/60 appearance-none cursor-pointer"
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.short}</option>
              ))}
            </select>

            {/* Language */}
            <select
              value={language}
              onChange={(e) => handleFieldChange('language', e.target.value)}
              title={LANGUAGES.find(l => l.value === language)?.label || language}
              className="h-6 text-[10px] bg-rift-800 border border-rift-600/40 rounded-lg text-rift-200 px-1.5 focus:outline-none focus:border-gold-500/60 appearance-none cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>

            {/* Standard / foil quick toggle */}
            <div className="inline-flex overflow-hidden rounded-lg border border-rift-600/40">
              <button
                onClick={() => !foilOnly && handleFieldChange('foil', false)}
                disabled={foilOnly}
                title={foilOnly ? 'Always foil (Rare/Epic)' : 'Standard copy'}
                className={`h-6 px-2 text-[10px] font-medium transition-colors ${
                  !foil && !foilOnly
                    ? 'bg-rift-600 text-rift-100'
                    : 'bg-rift-800 text-rift-500 hover:bg-rift-700 hover:text-rift-300'
                } ${foilOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
              >
                Std
              </button>
              <button
                onClick={() => handleFieldChange('foil', true)}
                title={foilOnly ? 'Always foil (Rare/Epic)' : 'Foil copy'}
                className={`h-6 px-2 text-[10px] font-medium transition-colors border-l border-rift-600/40 flex items-center gap-1 ${
                  foil || foilOnly
                    ? 'bg-purple-500/20 text-purple-300'
                    : 'bg-rift-800 text-rift-500 hover:bg-rift-700 hover:text-rift-300'
                }`}
              >
                <Sparkles className="w-2.5 h-2.5" />
                Foil
              </button>
            </div>

            {canSplitVariant && (
              <button
                onClick={() => onSplit(index)}
                title={foil ? 'Split 1 copy to standard' : 'Split 1 copy to foil'}
                className={`h-6 rounded-lg border px-2 text-[10px] font-medium transition-colors ${
                  foil
                    ? 'bg-purple-500/10 border-purple-400/30 text-purple-300 hover:bg-purple-500/20'
                    : 'bg-gold-500/10 border-gold-400/30 text-gold-300 hover:bg-gold-500/20'
                }`}
              >
                {foil ? 'Split Std' : 'Split Foil'}
              </button>
            )}

            {/* Promo toggle */}
            <button
              onClick={() => handleFieldChange('promo', !promo)}
              className={`h-6 rounded-lg border flex items-center justify-center transition-all flex-shrink-0 px-1.5 text-[10px] font-medium cursor-pointer ${
                promo
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-400 hover:bg-amber-500/30'
                  : 'bg-rift-800 border-rift-600/40 text-rift-500 hover:bg-rift-600 hover:text-rift-300'
              }`}
            >
              {promo ? 'Promo' : 'Standard'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ScannerCardRow;
