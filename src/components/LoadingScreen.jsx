import React from 'react';
import { Zap, Database, Brain, ScanLine, CheckCircle2, AlertTriangle, RefreshCw, Upload } from 'lucide-react';

export default function LoadingScreen({ progress, stage, error = null, onImportCardDatabase = null }) {
  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-rift-900 px-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="relative flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-gold-400 to-gold-500 shadow-xl shadow-gold-500/20">
            <Zap className="w-8 h-8 text-rift-900" strokeWidth={2.5} />
          </div>
          <div className="flex flex-col">
            <span className="text-2xl font-display font-bold text-gold-400 tracking-wider">RIFTBOUND</span>
            <span className="text-xs font-body text-rift-400 tracking-[0.3em] uppercase">Scanner</span>
          </div>
        </div>

        <div className="w-full max-w-lg rounded-3xl border border-red-500/25 bg-red-500/10 p-5 text-center shadow-2xl shadow-black/20">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/15 text-red-300">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold text-red-200">Required scan assets are missing</h2>
          <p className="mt-2 text-sm leading-relaxed text-rift-300 whitespace-pre-line">{error}</p>

          <div className="mt-4 rounded-2xl border border-rift-600/30 bg-rift-900/60 p-4 text-left">
            <p className="text-xs font-semibold uppercase tracking-wider text-rift-400">What to do</p>
            <ol className="mt-2 space-y-2 text-sm text-rift-300 list-decimal list-inside">
              <li>Generate card images and hashes with <span className="text-gold-300">python model/cards_scraper.py</span>.</li>
              <li>Generate the detector dataset with <span className="text-gold-300">python model/data_creator.py</span>.</li>
              <li>Train and export the detector with <span className="text-gold-300">python model/train.py</span>.</li>
              <li>Reload the app after the assets are in place.</li>
            </ol>
          </div>

          <button
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 rounded-xl border border-gold-400/40 bg-gold-400/10 px-4 py-2 text-sm font-medium text-gold-300 hover:bg-gold-400/15 hover:border-gold-400/60 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Reload after fixing assets
          </button>

          {onImportCardDatabase && (
            <button
              onClick={onImportCardDatabase}
              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-blue-400/40 bg-blue-400/10 px-4 py-2 text-sm font-medium text-blue-300 hover:bg-blue-400/15 hover:border-blue-400/60 transition-colors"
            >
              <Upload className="h-4 w-4" />
              Import card database
            </button>
          )}
        </div>
      </div>
    );
  }

  const stages = [
    { key: 'db', label: 'Loading database...', icon: Database },
    { key: 'model', label: 'Warming up AI model...', icon: Brain },
    { key: 'matcher', label: 'Preparing identifier...', icon: ScanLine },
    { key: 'ready', label: 'Ready to scan!', icon: CheckCircle2 },
  ];

  const currentIndex = stages.findIndex(s => s.key === stage);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-rift-900 px-8">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <div className="relative flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-gold-400 to-gold-500 shadow-xl shadow-gold-500/20">
          <Zap className="w-8 h-8 text-rift-900" strokeWidth={2.5} />
        </div>
        <div className="flex flex-col">
          <span className="text-2xl font-display font-bold text-gold-400 tracking-wider">
            RIFTBOUND
          </span>
          <span className="text-xs font-body text-rift-400 tracking-[0.3em] uppercase">
            Scanner
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-xs mb-8">
        <div className="h-1.5 rounded-full bg-rift-700 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-gold-500 to-gold-400 transition-all duration-500 ease-out"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <p className="text-xs font-mono text-rift-500 text-center mt-2">
          {Math.round(progress * 100)}%
        </p>
      </div>

      {/* Stage indicators */}
      <div className="space-y-3">
        {stages.map((s, i) => {
          const Icon = s.icon;
          const isActive = s.key === stage;
          const isDone = i < currentIndex;

          return (
            <div
              key={s.key}
              className={`flex items-center gap-3 transition-all duration-300 ${
                isActive ? 'opacity-100' : isDone ? 'opacity-50' : 'opacity-20'
              }`}
            >
              <Icon className={`w-4 h-4 ${
                isDone ? 'text-green-400' : isActive ? 'text-gold-400' : 'text-rift-500'
              } ${isActive ? 'animate-pulse' : ''}`} />
              <span className={`text-sm font-body ${
                isActive ? 'text-rift-200' : 'text-rift-400'
              }`}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      <p className="absolute bottom-6 text-[10px] text-rift-600 text-center px-8 max-w-sm">
        Independent non-commercial scanner maintained by Teme1999.
      </p>
    </div>
  );
}
