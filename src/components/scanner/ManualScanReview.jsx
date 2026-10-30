import React from 'react';
import CardImage from '../CardImage.jsx';
import { resolveCardImageSource } from '../../lib/cardMatcher.js';

export default function ManualScanReview({ result, onSelect, onClose }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Confirm scanned card">
      <div className="w-full max-w-2xl max-h-[90dvh] overflow-y-auto rounded-2xl border border-gold-400/30 bg-rift-900 p-5 shadow-xl">
        <h2 className="text-lg font-semibold text-gold-300">Confirm scanned card</h2>
        <p className="mt-2 text-sm text-rift-300">Check the name and collector number, then choose the card you are holding.</p>
        {result.textVerification?.status === 'conflict' && <p className="mt-2 text-sm text-amber-200">The printed text and image did not agree. Review the choice carefully.</p>}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(result.reviewCandidates || []).map(card => (
            <button key={card.id} type="button" onClick={() => onSelect(card)} className="rounded-xl border border-rift-600 bg-rift-800 p-3 text-left hover:border-gold-400" aria-label={`Use ${card.name}`}>
              <CardImage src={resolveCardImageSource(card.imageUrl, card.id)} alt={card.name} className="mx-auto max-h-52 rounded-lg object-contain" />
              <span className="mt-2 block text-sm font-semibold text-rift-50">{card.name}</span>
              <span className="mt-1 block text-xs text-rift-300">{card.code || card.id}</span>
              <span className="mt-3 block text-xs font-semibold text-gold-300">Use this card</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn-secondary mt-4 w-full" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
