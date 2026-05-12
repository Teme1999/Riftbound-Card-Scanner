import React, { useEffect, useState } from 'react';
import { CheckCircle2, ScanLine, Sparkles } from 'lucide-react';
import { DOMAIN_COLORS } from '../../data/sampleCards.js';
import { formatPrice } from '../../lib/priceFormat.js';
import { getCardImageUrl, resolveCardImageSource } from '../../lib/cardMatcher.js';

export default function ScanAddAnimation({ cardData, priceRecord, priceCurrency = 'EUR', priceExchangeRates }) {
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false);
  }, [cardData.id]);

  const domainStyle = cardData.domain ? (DOMAIN_COLORS[cardData.domain] || DOMAIN_COLORS.colorless) : DOMAIN_COLORS.colorless;
  const priceLabel = priceRecord ? formatPrice(priceRecord.marketPrice ?? priceRecord.price, priceCurrency, priceExchangeRates) : null;
  const cardMeta = [cardData.setName || cardData.set, cardData.collectorNumber ? `#${cardData.collectorNumber}` : null]
    .filter(Boolean)
    .join(' - ');

  return (
    <div className="fixed inset-0 z-50 pointer-events-none overflow-hidden">
      <div className="scan-success-card absolute left-1/2 top-[46%] w-[min(78vw,18rem)] rounded-2xl border border-gold-300/35 bg-rift-950/95 p-3 shadow-xl shadow-black/40 lg:top-1/2 lg:w-[20rem]">
        <div className={`absolute inset-0 rounded-2xl ${domainStyle.bg} opacity-10`} />
        <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_top,rgba(255,209,102,0.18),transparent_48%)]" />

        <div className="relative flex items-center gap-3">
          <div className="relative h-28 w-20 flex-shrink-0 overflow-hidden rounded-lg border border-gold-400/25 bg-rift-900 shadow-lg shadow-black/35">
            {imageError ? (
              <div className={`flex h-full w-full items-center justify-center ${domainStyle.bg} ${domainStyle.text}`}>
                <Sparkles className="h-8 w-8" />
              </div>
            ) : (
              <img
                src={resolveCardImageSource(cardData.imageUrl, cardData.id)}
                alt={cardData.name}
                className="h-full w-full object-cover"
                onError={() => setImageError(true)}
              />
            )}
            <div className="scan-success-sweep absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-transparent via-gold-200/70 to-transparent" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-1.5">
              <span className="scan-success-badge inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-300/45 bg-emerald-400/20 text-emerald-200">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-gold-400/25 bg-black/35 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-gold-200">
                <ScanLine className="h-3 w-3" />
                Scanned
              </span>
            </div>

            <p className="truncate text-base font-bold leading-tight text-rift-50">
              {cardData.name}
            </p>
            {cardMeta && (
              <p className="mt-1 truncate text-xs text-rift-300">
                {cardMeta}
              </p>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className={`truncate rounded-full border px-2 py-1 text-[10px] font-medium ${domainStyle.bg} ${domainStyle.text} ${domainStyle.border}`}>
                Added to pending
              </span>
              {priceLabel && (
                <span className="flex-shrink-0 text-xs font-semibold text-gold-200">
                  {priceLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
