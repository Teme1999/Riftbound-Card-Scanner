import React, { useRef } from 'react';
import { Shield, Sparkles, RotateCcw, Info, ExternalLink, Cpu, Download, Database, Search, RefreshCcw, Camera } from 'lucide-react';
import { CONDITIONS, LANGUAGES } from '../../data/sampleCards.js';
import { EXPORT_FORMAT_OPTIONS } from '../../lib/csvExporter.js';
import { openDesktopUrl } from '../../lib/desktopBridge.js';
import { FALLBACK_EXCHANGE_RATE_DATE, FALLBACK_ECB_EUR_RATES, PRICE_CURRENCY_OPTIONS, normalizeExchangeRates, normalizePriceCurrency } from '../../lib/priceFormat.js';

const APP_VERSION_LABEL = __APP_RELEASE_VERSION__ || __APP_VERSION__;

export default function SettingsTab({
  batchDefaults,
  onUpdateDefaults,
  minConfidence,
  onUpdateMinConfidence,
  modelPreference,
  onUpdateModelPreference,
  detectorMode = 'unknown',
  exportFormat,
  onUpdateExportFormat,
  onUpdateCardDatabase,
  onUpdatePriceData,
  maintenanceBusy = false,
  appUpdateState = null,
  onCheckAppUpdate,
  onInstallAppUpdate,
  cardDatabaseLabel = 'Bundled database',
  cardDatabaseUpdatedAt = null,
  cardDatabaseSetCoverage = { label: 'No sets loaded', fullLabel: 'No sets loaded', count: 0 },
  priceCacheLabel = 'No cached price data yet',
  priceCacheUpdatedAt = null,
  priceCurrency = 'EUR',
  priceExchangeRates = FALLBACK_ECB_EUR_RATES,
  priceExchangeRateDate = FALLBACK_EXCHANGE_RATE_DATE,
  priceExchangeRateFallback = false,
  onUpdatePriceCurrency,
  cameraDevices = [],
  cameraDeviceId = '',
  onUpdateCameraDeviceId,
  onRefreshCameraDevices,
  runtimeLabel = 'Browser build',
}) {
  const scrollRef = useRef(null);
  const normalizedPriceCurrency = normalizePriceCurrency(priceCurrency);
  const normalizedExchangeRates = normalizeExchangeRates(priceExchangeRates);
  const selectedExchangeRate = normalizedExchangeRates[normalizedPriceCurrency] || 1;

  const detectorStatusLabel = (() => {
    switch (detectorMode) {
      case 'onnx': return 'ONNX';
      case 'loading': return 'Loading';
      case 'error': return 'Error';
      case 'ready': return 'Ready';
      default: return 'Unknown';
    }
  })();

  const priceConversionLabel = normalizedPriceCurrency === 'EUR'
    ? `Base currency: EUR${priceExchangeRateFallback ? ' (fallback FX data)' : ''} from ${priceExchangeRateDate || FALLBACK_EXCHANGE_RATE_DATE}`
    : `Display converts using ${priceExchangeRateFallback ? 'fallback' : 'ECB'} rates from ${priceExchangeRateDate || FALLBACK_EXCHANGE_RATE_DATE}: 1 EUR = ${selectedExchangeRate} ${normalizedPriceCurrency}`;

  const priceCacheUpdatedAtLabel = priceCacheUpdatedAt
    ? (() => {
        const parsed = new Date(priceCacheUpdatedAt);
        return Number.isNaN(parsed.getTime())
          ? priceCacheUpdatedAt
          : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
      })()
    : 'Never updated';

  const cardDatabaseUpdatedAtLabel = cardDatabaseUpdatedAt
    ? (() => {
        const parsed = new Date(cardDatabaseUpdatedAt);
        return Number.isNaN(parsed.getTime())
          ? cardDatabaseUpdatedAt
          : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
      })()
    : 'Never synced';

  const appUpdateStatus = appUpdateState?.status || 'idle';
  const appUpdateIsBusy = ['checking', 'downloading', 'installing', 'relaunching'].includes(appUpdateStatus);
  const appUpdateAvailable = appUpdateStatus === 'available' && appUpdateState?.update;
  const appUpdateMessage = appUpdateState?.message || 'App update checks are available in the desktop build.';
  const appUpdateProgress = appUpdateState?.progress?.percent;
  const appUpdateProgressLabel = Number.isFinite(appUpdateProgress) ? `${appUpdateProgress}%` : null;
  const appUpdateCheckedAtLabel = appUpdateState?.checkedAt
    ? (() => {
        const parsed = new Date(appUpdateState.checkedAt);
        return Number.isNaN(parsed.getTime())
          ? appUpdateState.checkedAt
          : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
      })()
    : 'Not checked this session';
  const appUpdateStatusTone = appUpdateStatus === 'available'
    ? 'border-gold-400/30 bg-gold-500/10 text-gold-200'
    : appUpdateStatus === 'error'
      ? 'border-red-400/30 bg-red-500/10 text-red-200'
      : 'border-rift-600/20 bg-rift-950/40 text-rift-200';

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto pb-20">
      <div className="px-4 pt-5 pb-4 space-y-4">
        <div className="mb-2">
          <h1 className="text-xl font-display font-bold text-rift-100">Settings</h1>
          <p className="text-xs text-rift-400 mt-1">Configure default values and app options</p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-rift-600/30 bg-rift-900/40 px-3 py-1 text-[11px] text-rift-300">
            <Info className="w-3.5 h-3.5 text-gold-400" />
            Runtime: <span className="text-rift-100">{runtimeLabel}</span>
          </div>
        </div>

        <section className="rounded-2xl border border-gold-500/20 bg-gradient-to-br from-gold-500/10 via-rift-800/80 to-rift-900/80 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <Info className="w-4 h-4 text-gold-400" />
            How To Use Riftbound Scanner
          </h2>
          <div className="space-y-2 text-xs leading-relaxed text-rift-300">
            <p>
              1. Open <span className="text-rift-100 font-medium">Scan</span> to use your camera or upload a card image.
            </p>
            <p>
              2. Confirm the detected card details, then add it to your pending list or collection.
            </p>
            <p>
              3. Review everything in <span className="text-rift-100 font-medium">Collection</span>, where you can search, edit, and export your cards.
            </p>
            <p>
              4. Use this page to choose your camera, tune scan sensitivity, set defaults, and refresh card or price data.
            </p>
          </div>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <Camera className="w-4 h-4 text-gold-400" />
            Camera Input
          </h2>
          <p className="text-xs text-rift-400 leading-relaxed">
            Choose which connected webcam the scanner should use when the camera starts.
          </p>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-[11px] font-medium text-rift-300 uppercase tracking-wider block">
                Active webcam
              </label>
              <button
                type="button"
                onClick={() => onRefreshCameraDevices?.()}
                className="text-[10px] font-medium text-gold-300 hover:text-gold-200 transition-colors"
              >
                Refresh list
              </button>
            </div>
            <select
              value={cameraDeviceId}
              onChange={(e) => onUpdateCameraDeviceId?.(e.target.value)}
              className="select-field rounded-xl"
            >
              <option value="">System default camera</option>
              {cameraDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-rift-500 leading-relaxed">
              {cameraDevices.length > 0
                ? 'Picking a device saves across app restarts.'
                : 'Connect a webcam and allow camera access to see device names here.'}
            </p>
          </div>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <Shield className="w-4 h-4 text-gold-400" />
            Default Values
          </h2>
          <p className="text-xs text-rift-400">
            Will be applied automatically to new scanned cards.
          </p>

          <div>
            <label className="text-[11px] font-medium text-rift-300 uppercase tracking-wider mb-1.5 block">
              Condition
            </label>
            <select
              value={batchDefaults.condition}
              onChange={(e) => onUpdateDefaults({ ...batchDefaults, condition: e.target.value })}
              className="select-field rounded-xl"
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-rift-300 uppercase tracking-wider mb-1.5 block">
              Language
            </label>
            <select
              value={batchDefaults.language}
              onChange={(e) => onUpdateDefaults({ ...batchDefaults, language: e.target.value })}
              className="select-field rounded-xl"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-rift-300 uppercase tracking-wider mb-1.5 block">
              Foil
            </label>
            <button
              onClick={() => onUpdateDefaults({ ...batchDefaults, foil: !batchDefaults.foil })}
              className={`w-full rounded-xl border py-2.5 text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                batchDefaults.foil
                  ? 'bg-gradient-to-r from-purple-500/20 to-blue-500/20 border-purple-400/50 text-purple-300'
                  : 'bg-rift-700 border-rift-600/40 text-rift-400'
              }`}
            >
              <Sparkles className="w-4 h-4" />
              {batchDefaults.foil ? 'All Foil' : 'No Foil'}
            </button>
          </div>

          <button
            onClick={() => onUpdateDefaults({
              condition: 'Near Mint',
              language: 'English',
              foil: false,
            })}
            className="btn-ghost w-full text-xs text-rift-400 rounded-xl"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Restore defaults
          </button>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <Search className="w-4 h-4 text-gold-400" />
            Scan Sensitivity
          </h2>
          <p className="text-xs text-rift-400 leading-relaxed">
            Controls how strict the scanner is before a detected card is accepted into the pending list.
          </p>

          <div className="rounded-xl border border-rift-600/20 bg-rift-900/40 px-3 py-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium uppercase tracking-wider text-rift-400">
                Minimum similarity
              </span>
              <span className="text-xs font-mono text-gold-400">
                {Math.round(minConfidence * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="50"
              max="100"
              value={Math.round(minConfidence * 100)}
              onChange={(e) => onUpdateMinConfidence(Number(e.target.value) / 100)}
              className="range-slider"
            />
            <div className="flex items-center justify-between text-[10px] text-rift-500">
              <span>More cards</span>
              <span>Fewer false positives</span>
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <Download className="w-4 h-4 text-gold-400" />
            Export Format
          </h2>
          <p className="text-xs text-rift-400">
            Choose the CSV layout used when exporting your collection or scan results.
          </p>

          <div className="space-y-2">
            {EXPORT_FORMAT_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => onUpdateExportFormat(option.value)}
                className={`w-full rounded-xl border p-3 text-left transition-all ${
                  exportFormat === option.value
                    ? 'bg-gradient-to-r from-gold-500/20 to-gold-400/10 border-gold-400/60 text-gold-300'
                    : 'bg-rift-700/40 border-rift-600/40 text-rift-300 hover:bg-rift-700 hover:border-rift-500/60'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{option.label}</p>
                    <p className="text-[10px] text-rift-400 mt-0.5">
                      {option.value === 'cardnexus'
                        ? 'Quantity, name, collector number, expansion, condition, language, finish'
                        : 'Variant number, set metadata, rarity, variant labels, and grading fields'}
                    </p>
                  </div>
                  {exportFormat === option.value && (
                    <div className="w-2 h-2 rounded-full bg-gold-400 flex-shrink-0" />
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <RefreshCcw className="w-4 h-4 text-gold-400" />
            Price Cache
          </h2>
          <p className="text-xs text-rift-400 leading-relaxed">
            Import the latest <span className="text-gold-300">cards.csv</span> snapshot from cristian-bravo/riftbound-prices into the local database. The snapshot values are sourced in USD.
          </p>

          <div>
            <label className="text-[11px] font-medium text-rift-300 uppercase tracking-wider mb-1.5 block">
              Display currency
            </label>
            <select
              value={priceCurrency}
              onChange={(e) => onUpdatePriceCurrency?.(e.target.value)}
              className="select-field rounded-xl"
            >
              {PRICE_CURRENCY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-rift-500">
              Prices are stored in USD. Display converts using {priceExchangeRateFallback ? 'fallback' : 'ECB'} rates from {priceExchangeRateDate || FALLBACK_EXCHANGE_RATE_DATE}: 1 EUR = {selectedExchangeRate} {normalizedPriceCurrency}.
            </p>
          </div>

          <div className="rounded-xl border border-rift-600/20 bg-rift-900/40 px-3 py-2 text-xs text-rift-400">
            Current cache: <span className="text-rift-200">{priceCacheLabel}</span>
          </div>

          <div className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400">
            Currency conversion: <span className="text-rift-200">{priceConversionLabel}</span>
          </div>

          <div className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400">
            Last price cache update: <span className="text-rift-200">{priceCacheUpdatedAtLabel}</span>
          </div>

          <button
            onClick={onUpdatePriceData}
            className="btn-primary w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2"
            disabled={maintenanceBusy}
          >
            <Download className="w-4 h-4" />
            Press to update
          </button>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <RefreshCcw className="w-4 h-4 text-gold-400" />
            App Updates
          </h2>
          <p className="text-xs text-rift-400 leading-relaxed">
            Checks the signed GitHub Release feed and installs newer Windows desktop builds in place.
          </p>

          <div className={`rounded-xl border px-3 py-2 text-xs leading-relaxed ${appUpdateStatusTone}`}>
            {appUpdateMessage}
          </div>

          <div className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400">
            Last update check: <span className="text-rift-200">{appUpdateCheckedAtLabel}</span>
          </div>

          {appUpdateAvailable && (
            <div className="rounded-xl border border-gold-400/20 bg-rift-900/40 px-3 py-2 text-xs text-rift-400">
              Available version: <span className="text-gold-300">v{appUpdateState.update.version}</span>
            </div>
          )}

          {appUpdateIsBusy && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-rift-700">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-gold-500 to-gold-400 transition-all duration-300"
                  style={{ width: appUpdateProgressLabel || (appUpdateStatus === 'checking' ? '35%' : '65%') }}
                />
              </div>
              <div className="text-right text-[10px] text-rift-500">
                {appUpdateProgressLabel || (appUpdateStatus === 'checking' ? 'Checking' : 'Working')}
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onCheckAppUpdate?.()}
              className="btn-ghost w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2"
              disabled={maintenanceBusy || appUpdateIsBusy}
            >
              <RefreshCcw className="w-4 h-4" />
              Check for updates
            </button>
            <button
              type="button"
              onClick={() => onInstallAppUpdate?.()}
              className="btn-primary w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2"
              disabled={maintenanceBusy || appUpdateIsBusy || !appUpdateAvailable}
            >
              <Download className="w-4 h-4" />
              Install update
            </button>
          </div>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-gold-400" />
            Card & Detector
          </h2>
          <p className="text-xs text-rift-400">
            Use this section when you import a new card database or switch the startup model export. Quantized is the recommended default.
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-rift-600/20 bg-rift-900/40 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-rift-100">
                <Database className="w-4 h-4 text-gold-400" />
                Matcher database
              </div>
              <p className="text-[11px] text-rift-400 leading-relaxed">
                Press <span className="text-rift-200 font-medium">Update Card Database</span> to scrape Riot's card gallery, regenerate <span className="text-gold-300">card-hashes.json</span>, and refresh the matcher. For a new DLC drop, this is usually the only step you need.
              </p>

              <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/90 leading-relaxed">
                Detector retraining is handled by the local model scripts outside the app. After publishing new generated assets, reload the app so it picks up the updated files.
              </div>

              <div
                className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400"
                title="This tells you which matcher database the app is currently using. If it says Bundled file, the app is still using the built-in database. If it says Imported locally, your local card-hashes.json is active."
              >
                Current source: <span className="text-rift-200">{cardDatabaseLabel}</span>
              </div>

              <div className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400">
                Last sync: <span className="text-rift-200">{cardDatabaseUpdatedAtLabel}</span>
              </div>

              <div
                className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400"
                title={cardDatabaseSetCoverage.fullLabel}
              >
                Sets in database ({cardDatabaseSetCoverage.count}): <span className="text-rift-200">{cardDatabaseSetCoverage.label}</span>
              </div>

              <button
                onClick={onUpdateCardDatabase}
                className="btn-primary w-full rounded-xl py-3 text-sm flex items-center justify-center gap-2"
                disabled={maintenanceBusy}
                title="Scrapes the Riot card gallery, regenerates card-hashes.json, and refreshes the matcher database."
              >
                <RefreshCcw className="w-4 h-4" />
                Update Card Database
              </button>
            </div>

            <div className="rounded-xl border border-rift-600/20 bg-rift-900/40 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-rift-100">
                <Cpu className="w-4 h-4 text-gold-400" />
                Detector model
              </div>
              <p className="text-[11px] text-rift-400 leading-relaxed">
                Pick which export the app loads on startup. Use <span className="text-rift-200 font-medium">Quantized</span> for normal use. Use <span className="text-rift-200 font-medium">Standard</span> only if you want to compare the non-quantized build.
              </p>

              <div
                className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-xs text-rift-400"
                title="This shows whether the local ONNX detector is ready, still loading, or failed to initialize."
              >
                Detector status: <span className="text-rift-200">{detectorStatusLabel}</span>
              </div>

              <div className="rounded-xl border border-rift-600/20 bg-rift-950/40 px-3 py-2 text-[11px] text-rift-400 leading-relaxed">
                New DLC drop? Usually just press <span className="text-rift-200 font-medium">Update Card Database</span>. Regenerate detector files from the model pipeline only when recognition quality actually drops.
              </div>

              <div className="space-y-2">
                <button
                  onClick={() => onUpdateModelPreference('normal')}
                  className={`w-full rounded-xl border p-3 text-left transition-all ${
                    modelPreference === 'normal'
                      ? 'bg-gradient-to-r from-gold-500/20 to-gold-400/10 border-gold-400/60 text-gold-300'
                      : 'bg-rift-700/40 border-rift-600/40 text-rift-300 hover:bg-rift-700 hover:border-rift-500/60'
                  }`}
                  title="Use this only if you want the standard non-quantized export. It is larger and mainly useful for comparison or troubleshooting."
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Standard</p>
                      <p className="text-[10px] text-rift-400 mt-0.5">
                        Larger export • compare against the quantized model
                      </p>
                    </div>
                    {modelPreference === 'normal' && (
                      <div className="w-2 h-2 rounded-full bg-gold-400" />
                    )}
                  </div>
                </button>

                <button
                  onClick={() => onUpdateModelPreference('quantized')}
                  className={`w-full rounded-xl border p-3 text-left transition-all ${
                    modelPreference === 'quantized'
                      ? 'bg-gradient-to-r from-gold-500/20 to-gold-400/10 border-gold-400/60 text-gold-300'
                      : 'bg-rift-700/40 border-rift-600/40 text-rift-300 hover:bg-rift-700 hover:border-rift-500/60'
                  }`}
                  title="Use this for normal day-to-day scanning. It is the recommended default because it loads faster and uses less memory."
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Quantized <span className="text-gold-300">recommended</span></p>
                      <p className="text-[10px] text-rift-400 mt-0.5">
                        Smaller export • faster startup and lower memory use
                      </p>
                    </div>
                    {modelPreference === 'quantized' && (
                      <div className="w-2 h-2 rounded-full bg-gold-400" />
                    )}
                  </div>
                </button>
              </div>

              <button
                onClick={() => window.location.reload()}
                className="btn-ghost w-full text-xs text-rift-300 rounded-xl"
                title="Press this after you generate new ONNX files so the app reloads and picks up the updated detector on startup."
              >
                Reload app after building
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-rift-800/60 border border-rift-600/20 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-rift-100 flex items-center gap-2">
            <Info className="w-4 h-4 text-gold-400" />
            About
          </h2>

          <div className="flex items-center gap-3">
            <img
              src="/images/riftboundscanner.ico"
              alt="Riftbound Scanner icon"
              className="w-10 h-10 object-contain"
            />
            <div>
              <p className="text-sm font-display font-bold text-gold-400">Riftbound Scanner</p>
              <p className="text-[10px] text-rift-500">v{APP_VERSION_LABEL}</p>
            </div>
          </div>

          <p className="text-xs text-rift-400 leading-relaxed">
            Independent non-commercial desktop-first scanner maintained by Teme1999.
          </p>

          <div className="p-3 rounded-xl bg-rift-700/40 border border-rift-600/20">
            <p className="text-[10px] text-rift-500 leading-relaxed">
              Runs local scanner and collection data on this device. Price refresh and app update checks are the only in-app network update actions.
            </p>
          </div>

          <a
            href="https://github.com/Teme1999/riftbound-scanner"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              openDesktopUrl('https://github.com/Teme1999/riftbound-scanner');
            }}
            className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-gradient-to-r from-pink-500/10 to-red-500/10 border border-pink-500/30 text-pink-300 hover:border-pink-400/50 hover:from-pink-500/20 hover:to-red-500/20 transition-all text-xs font-medium"
          >
            View project on GitHub
            <ExternalLink className="w-3 h-3" />
          </a>
        </section>

      </div>
    </div>
  );
}
