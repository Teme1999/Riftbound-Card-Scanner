import React, { useEffect, useState } from 'react';
import { Camera, CameraOff, RotateCw, Zap, ZapOff, AlertCircle, ScanLine, Radar } from 'lucide-react';
import { getScanGuide } from '../../lib/scanGeometry.js';
import { getScanGuidance } from '../../lib/scanQuality.js';
import { saveNativeFrame, openNativeFrameFolder, nativeFrameDiagnostics } from '../../lib/nativeFrame.js';
import { resolveCardImageSource } from '../../lib/cardMatcher.js';
import CardImage from '../CardImage.jsx';
import { openDebugScanFolder } from '../../lib/debugScanCapture.js';
import { getScanEvidence } from '../../lib/scanEvidence.js';
import { SCANNER_DEBUG_KEY, SCANNER_OVERLAY_KEY, SCANNER_DIAGNOSTICS_AVAILABLE } from '../../lib/scannerExperiments.js';
import ScanRecordingControls from './ScanRecordingControls.jsx';

const DEBUG_OVERLAY_STORAGE_KEY = SCANNER_DEBUG_KEY;

function loadStoredBoolean(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : Boolean(JSON.parse(stored));
  } catch {
    return fallback;
  }
}

function saveStoredBoolean(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(Boolean(value)));
  } catch {
    // Ignore storage failures in private/incognito or locked-down environments.
  }
}

export default function ScannerCamera({
  videoRef,
  isActive,
  error,
  isProcessing,
  lastDetection,
  captureQuality,
  onStartCamera,
  onStopCamera,
  onToggleFacing,
  onSnapScan,
  detectorState,
  hasTorch,
  hasFocusControl,
  torchOn,
  onToggleTorch,
  onRefocus,
  autoScanEnabled,
  onToggleAutoScan,
  debugEnabled,
  onDebugChange,
  scanOverlayEnabled,
  onScanOverlayChange,
  debugCapture = { status: 'idle' },
  scanRecording,
  onRetryDebugCapture,
  scannerExperiments = { perspective: true, textVerification: true },
  onUpdateScannerExperiments,
  captureFrame,
}) {
  const [dimensions, setDimensions] = useState({ w: 0, h: 0 });
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [showDebugOverlay, setShowDebugOverlay] = useState(() => SCANNER_DIAGNOSTICS_AVAILABLE && loadStoredBoolean(DEBUG_OVERLAY_STORAGE_KEY, false));
  const [frameSave, setFrameSave] = useState({ status: 'idle', path: null, error: null });
  const [showScanOverlay, setShowScanOverlay] = useState(() => loadStoredBoolean(SCANNER_OVERLAY_KEY, true));
  const [expiredDetection, setExpiredDetection] = useState(null);
  const debugOverlayEnabled = SCANNER_DIAGNOSTICS_AVAILABLE && (debugEnabled ?? showDebugOverlay);
  const scanOverlayVisible = scanOverlayEnabled ?? showScanOverlay;
  const trackingOverlayEnabled = scanOverlayVisible || debugOverlayEnabled;

  const handleSaveNativeFrame = async () => {
    if (frameSave.status === 'saving') return;
    setFrameSave({ status: 'saving', path: null, error: null });
    try {
      const frame=captureFrame();
      const { path, diagnosticsPath, diagnosticsError } = await saveNativeFrame(frame,nativeFrameDiagnostics(frame,lastDetection,{autoScanEnabled,isProcessing}));
      setFrameSave({ status: 'saved', path, diagnosticsPath, error: diagnosticsError||null });
    } catch (error) {
      setFrameSave({ status: 'error', path: null, error: String(error?.message || error) });
    }
  };

  const handleOpenNativeFrameFolder = async () => {
    try {
      await openNativeFrameFolder();
    } catch (error) {
      setFrameSave((previous) => ({ ...previous, error: String(error?.message || error) }));
    }
  };

  useEffect(() => {
    if (!videoRef.current) return;

    const updateVideoSize = () => {
      const video = videoRef.current;
      setVideoSize({
        w: video.videoWidth || 0,
        h: video.videoHeight || 0,
      });
    };

    const video = videoRef.current;
    video.addEventListener('loadedmetadata', updateVideoSize);
    video.addEventListener('resize', updateVideoSize);

    updateVideoSize();

    return () => {
      video.removeEventListener('loadedmetadata', updateVideoSize);
      video.removeEventListener('resize', updateVideoSize);
    };
  }, [videoRef]);

  useEffect(() => {
    if (!videoRef.current) return;
    const video = videoRef.current;

    const updateDimensions = () => {
      setDimensions({ w: video.clientWidth, h: video.clientHeight });
    };

    video.addEventListener('loadedmetadata', updateDimensions);
    video.addEventListener('resize', updateDimensions);
    window.addEventListener('resize', updateDimensions);
    updateDimensions();
    const frame = requestAnimationFrame(updateDimensions);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateDimensions)
      : null;
    resizeObserver?.observe(video);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      video.removeEventListener('loadedmetadata', updateDimensions);
      video.removeEventListener('resize', updateDimensions);
      window.removeEventListener('resize', updateDimensions);
    };
  }, [videoRef]);

  useEffect(() => {
    if(SCANNER_DIAGNOSTICS_AVAILABLE)saveStoredBoolean(DEBUG_OVERLAY_STORAGE_KEY, debugOverlayEnabled);
  }, [debugOverlayEnabled]);

  useEffect(() => {
    if (!onScanOverlayChange) saveStoredBoolean(SCANNER_OVERLAY_KEY, scanOverlayVisible);
  }, [scanOverlayVisible, onScanOverlayChange]);

  useEffect(() => {
    if (!isActive || !lastDetection?.box) return;
    const observedAt = lastDetection.observedAt ?? lastDetection.timestamp ?? Date.now();
    const remaining = Math.max(0, 1500 - (Date.now() - observedAt));
    const timer = setTimeout(() => setExpiredDetection(lastDetection), remaining);
    return () => clearTimeout(timer);
  }, [isActive, lastDetection]);

  const guide = getScanGuide(dimensions.w, dimensions.h);
  const { x: guideX, y: guideY, width: guideW, height: guideH } = guide;
  const guidance = getScanGuidance(captureQuality, lastDetection);

  const hasDetection = isActive && Boolean(lastDetection?.box) && expiredDetection !== lastDetection;
  const detectionLabel = lastDetection?.matched
    ? 'Tracked card'
    : hasDetection
      ? 'Tracking card'
      : null;
  const debugDetection = debugOverlayEnabled ? lastDetection : null;
  const debugGeometry=debugDetection?.visualVerification?.candidates?.find(c=>c.cardId===debugDetection.cardData?.id)||debugDetection?.visualVerification;
  const debugCandidates = getScanEvidence(debugDetection)?.candidates || debugDetection?.visualCandidates || [];
  const handleToggleDebug = () => {
    const next = !debugOverlayEnabled;
    if (onDebugChange) onDebugChange(next);
    else setShowDebugOverlay(next);
  };
  const handleToggleScanOverlay = () => {
    const next = !scanOverlayVisible;
    if (onScanOverlayChange) onScanOverlayChange(next);
    else setShowScanOverlay(next);
  };

  const detectionOverlay = (() => {
    if (!hasDetection || !videoSize.w || !videoSize.h || !dimensions.w || !dimensions.h) return null;

    const box = lastDetection.box;
    const scale = Math.max(dimensions.w / videoSize.w, dimensions.h / videoSize.h);
    const renderedW = videoSize.w * scale;
    const renderedH = videoSize.h * scale;
    const offsetX = (dimensions.w - renderedW) / 2;
    const offsetY = (dimensions.h - renderedH) / 2;
    const centerX = offsetX + box.cx * scale;
    const centerY = offsetY + box.cy * scale;
    const isLandscapeBox = box.w > box.h;
    const portraitW = (isLandscapeBox ? box.h : box.w) * scale;
    const portraitH = (isLandscapeBox ? box.w : box.h) * scale;
    const portraitAngle = box.angle - (isLandscapeBox ? Math.PI / 2 : 0);

    return {
      centerX,
      centerY,
      width: portraitW,
      height: portraitH,
      rotate: portraitAngle,
      confidence: lastDetection.confidence,
      similarity: lastDetection.similarity,
      matched: lastDetection.matched,
      quad: lastDetection.quad?.map((p) => `${offsetX + p.x * scale},${offsetY + p.y * scale}`).join(' '),
    };
  })();

  return (
    <div className="absolute inset-0 bg-black">
      {/* Video feed */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        muted
        autoPlay
      />

      {/* Tap to scan */}
      {isActive && (
        <div className="absolute inset-0" onClick={isProcessing || autoScanEnabled || debugOverlayEnabled ? undefined : onSnapScan}>
          {/* Processing indicator */}
          {isProcessing && (
            <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
              <div className="px-5 py-2.5 rounded-full bg-black/60 backdrop-blur-sm flex items-center gap-2">
                <ScanLine className="w-4 h-4 text-gold-400 animate-pulse" />
                <span className="text-sm font-medium text-gold-400">Scanning...</span>
              </div>
            </div>
          )}

          {/* Clear guide area */}
          <div
            className="absolute pointer-events-none"
            style={{ left: guideX, top: guideY, width: guideW, height: guideH }}
          >
            {[
              'top-0 left-0 border-t-2 border-l-2 rounded-tl-xl',
              'top-0 right-0 border-t-2 border-r-2 rounded-tr-xl',
              'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-xl',
              'bottom-0 right-0 border-b-2 border-r-2 rounded-br-xl',
            ].map((pos, i) => (
              <div
                key={i}
                className={`absolute w-7 h-7 border-gold-400 ${pos}`}
              />
            ))}
          </div>

          {/* Live tracking overlay */}
          {debugOverlayEnabled && detectionOverlay?.quad && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none z-30" aria-label="Detected card edges">
              <polygon points={detectionOverlay.quad} fill="none" stroke="#67e8f9" strokeWidth="2" />
            </svg>
          )}
          {trackingOverlayEnabled && detectionOverlay && (
            <div
              aria-label="Tracked card outline"
              className="absolute pointer-events-none z-30"
              style={{
                left: detectionOverlay.centerX,
                top: detectionOverlay.centerY,
                width: detectionOverlay.width,
                height: detectionOverlay.height,
                transform: `translate(-50%, -50%) rotate(${detectionOverlay.rotate}rad)`,
                transformOrigin: 'center center',
              }}
            >
              <div
                className={`absolute inset-0 rounded-xl border-2 ${
                  detectionOverlay.matched ? 'border-green-300' : 'border-gold-300'
                }`}
                style={{ boxShadow: '0 0 18px rgba(255, 209, 102, 0.25)' }}
              />
            </div>
          )}

          {/* Detection indicator — centered on screen */}
          {trackingOverlayEnabled && detectionOverlay && (
            <div className="absolute left-0 right-0 flex justify-center fade-in" style={{ top: guideY + guideH + 12 }}>
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full backdrop-blur-sm ${
                detectionOverlay.matched ? 'bg-green-500/90' : 'bg-gold-400/90'
              }`}>
                <Zap className="w-3 h-3 text-white" />
                <span className={`text-xs font-semibold whitespace-nowrap ${
                  detectionOverlay.matched ? 'text-white' : 'text-black'
                }`}>
                  {detectionLabel}
                </span>
              </div>
            </div>
          )}

          {/* Instructions */}
          {!hasDetection && !isProcessing && (
            <div className="absolute bottom-20 left-4 right-4 text-center">
              <p className="text-xs text-white/50 font-body">
                {autoScanEnabled || debugOverlayEnabled ? 'Auto-scanning...' : 'Tap to scan card'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Inactive state */}
      {!isActive && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-rift-900/95">
          <div className="w-20 h-20 rounded-3xl bg-rift-800/80 border border-rift-600/30 flex items-center justify-center">
            <Camera className="w-9 h-9 text-rift-400" />
          </div>
          <div className="text-center px-8">
            <p className="text-base font-semibold text-rift-200 mb-1">
              Camera disabled
            </p>
            <p className="text-sm text-rift-500">
              Enable the camera to scan cards
            </p>
          </div>
          <button onClick={onStartCamera} className="btn-primary text-sm mt-1 px-6 py-3 rounded-xl">
            <Camera className="w-4 h-4" />
            Enable Camera
          </button>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-rift-900/95 px-8">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <p className="text-sm text-red-300 text-center font-body">{error}</p>
          <button onClick={onStartCamera} className="btn-secondary text-sm rounded-xl">
            Retry
          </button>
        </div>
      )}

      {/* Camera controls */}
      {isActive && (
        <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 'calc(100% - 1.5rem)', maxWidth: 'calc(100% - 1.5rem)' }} onClick={e => e.stopPropagation()}>
          <div role="status" aria-live="polite" className={`max-w-[16rem] rounded-xl border px-3 py-2 text-xs backdrop-blur-sm pointer-events-none ${guidance.issue === 'ready'
            ? 'border-emerald-400/25 bg-black/70 text-emerald-100'
            : 'border-amber-400/30 bg-black/75 text-amber-100'}`}>
            {guidance.message}
          </div>
          {scanOverlayVisible && !debugOverlayEnabled && hasDetection && lastDetection.cardData && (
            <div role="status" aria-label="Tracked card preview" className="flex max-w-[17rem] items-center gap-3 rounded-xl border border-gold-400/30 bg-black/75 p-3 backdrop-blur-sm shadow-lg shadow-black/30">
              <div className="h-24 w-16 shrink-0 overflow-hidden rounded-md bg-rift-800">
                <CardImage src={resolveCardImageSource(lastDetection.cardData.imageUrl, lastDetection.cardData.id)} alt={lastDetection.cardData.name} className="h-full w-full object-contain" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold text-gold-300">{lastDetection.matched ? 'Confirming card' : 'Checking card'}</div>
                <div className="mt-1 break-words text-sm font-semibold text-white">{lastDetection.cardData.name}</div>
                <div className="mt-1 text-[10px] text-rift-300">{lastDetection.cardData.code || lastDetection.cardData.id}</div>
              </div>
            </div>
          )}
          {debugDetection?.cardData && (
            <div className="min-w-[11rem] max-w-[14rem] rounded-xl border border-gold-400/30 bg-black/70 px-3 py-2 backdrop-blur-sm shadow-lg shadow-black/30 pointer-events-auto">
              <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-gold-300/90">
                {debugDetection.matched ? 'Eligible frame · confirming' : debugDetection.textVerification?.status==='pending' ? 'Checking card' : 'Candidate · not accepted'}
              </div>
              <div className="mt-2 flex gap-2">
                <div className="h-24 w-16 shrink-0 overflow-hidden rounded-md bg-rift-800">
                  <CardImage src={resolveCardImageSource(debugDetection.cardData.imageUrl, debugDetection.cardData.id)} alt={debugDetection.cardData.name} className="h-full w-full object-contain" />
                </div>
                <div className="text-[10px] text-emerald-100">
                  <div>{debugDetection.acceptanceDecision?.path || 'Gathering evidence'}</div>
                  <div className="mt-1">Frame {debugDetection.frameId ?? '?'}</div>
                  <div className="mt-1">Detector: {debugDetection.detectorModel || detectorState}</div>
                  <div className="mt-1">Database revision: {debugDetection.matcherRevision ?? '?'}</div>
                </div>
              </div>
              <div className="mt-1 truncate text-xs font-semibold text-white">
                {debugDetection.cardData.name}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-rift-300">
                {debugDetection.cardData.code || debugDetection.cardData.id}
              </div>
              {Number.isFinite(debugDetection.similarity) && (
                <div className="mt-1 text-[10px] text-rift-200">
                  Score {(debugDetection.similarity * 100).toFixed(1)}%
                  {Number.isFinite(debugDetection.similarityGap) && (
                    <span> · gap {(debugDetection.similarityGap * 100).toFixed(1)} pp</span>
                  )}
                </div>
              )}
              {!debugDetection.matched && (
                <div className="mt-1 text-[10px] text-amber-200">
                  {debugDetection.reason === 'reading-text' ? debugDetection.cardData.type==='rune' ? 'Reading rune name and set' : 'Reading name and number' : debugDetection.reason === 'text-artwork-insufficient' ? 'Text read; artwork detail insufficient' : debugDetection.reason === 'text-conflict' ? 'Text and artwork disagree' : debugDetection.reason === 'geometry-conflict' ? 'Crop interpretations disagree' : debugDetection.reason === 'ambiguous' ? 'Too close to another card' : 'Artwork score too low'}
                  <div className="mt-0.5 text-rift-400">
                    Decision: {debugDetection.acceptanceDecision?.reason || debugDetection.reason || 'awaiting confirmation'}
                  </div>
                </div>
              )}
              {Number.isFinite(debugDetection.structureSimilarity) && (
                <div className="mt-1 text-[9px] text-rift-400">
                  Color {(debugDetection.colorSimilarity * 100).toFixed(1)}%
                  {' · structure '}{(debugDetection.structureSimilarity * 100).toFixed(1)}%
                  {debugDetection.artworkSampling && <div>Artwork grid: {debugDetection.artworkSampling}</div>}
                  {Number.isFinite(debugDetection.localStructureSimilarity) && <div>Local detail: {debugDetection.localStructureSimilarity.toFixed(2)}</div>}
                  {Number.isFinite(debugDetection.alignedArtworkSimilarity) && <div>Aligned detail: {debugDetection.alignedArtworkSimilarity.toFixed(2)}</div>}
                </div>
              )}
              {debugDetection.rectificationStatus && debugDetection.rectificationStatus !== 'disabled' && (
                <div className="mt-1 text-[9px] text-cyan-200">
                  Crop: {debugDetection.cropMethod} · {debugDetection.rectificationStatus === 'corrected' && debugDetection.cropMethod === 'obb' ? 'correction not selected' : debugDetection.rectificationStatus}
                  {debugDetection.rectificationReason && <div>{debugDetection.rectificationReason}</div>}
                </div>
              )}
              {debugDetection.visualVerification && (
                <div className="mt-1 text-[10px] text-cyan-100">
                  <div>Visual geometry: {debugDetection.visualVerification.status}</div>
                  {debugGeometry.inliers != null && <div>Inliers: {debugGeometry.inliers} / {debugGeometry.good} · runner {debugGeometry.runnerInliers}</div>}
                  {debugGeometry.registeredArtwork && <div>Registered art NCC: {debugGeometry.registeredArtwork.correlation.toFixed(2)} · runner {debugGeometry.registeredRunnerCorrelation?.toFixed(2)} · tiles {debugGeometry.registeredArtwork.tilesMatched}/{debugGeometry.registeredArtwork.tilesCompared}</div>}
                  {debugDetection.visualVerification.reason && <div>{debugDetection.visualVerification.reason}</div>}
                  {debugDetection.visualVerification.workerError && <div className="break-words">{debugDetection.visualVerification.workerError}</div>}
                  {debugDetection.visualVerification.fallbackReferenceIds?.length>0 && <div>Bundled reference fallback: {debugDetection.visualVerification.fallbackReferenceIds.join(', ')}</div>}
                </div>
              )}
              {debugDetection.textVerification && (
                <div className="mt-1 text-[10px] text-cyan-100">
                  <div>Text: {debugDetection.textVerification.status} · {debugDetection.confirmationMethod}</div>
                  <div>OCR attempt: {debugDetection.textVerification.attemptNumber || 1} · {((debugDetection.textVerification.trackAgeMs || 0)/1000).toFixed(1)} s</div>
                  {debugDetection.textVerification.artworkFallbackAllowed && debugDetection.textVerification.status === 'pending' && <div>Artwork fallback ready; text retry in background</div>}
                  {debugDetection.textVerification.textCropMethod && <div>Text crop: {debugDetection.textVerification.textCropMethod}</div>}
                  {debugDetection.textVerification.textLayout && <div>Text layout: {debugDetection.textVerification.textLayout}</div>}
                  <div>Text frames: {(debugDetection.textVerification.sourceFrameIds || []).join(', ') || 'none'}</div>
                  {debugDetection.textVerification.status === 'pending' && <div>Agreeing frames: {debugDetection.textVerification.confirmedReads||0}/{debugDetection.textVerification.requiredReads||2}</div>}
                  {['name-number-local-artwork','name-number-aligned-artwork'].includes(debugDetection.confirmationReason) && <div>Confirmed by name, number and local detail</div>}
                  {debugDetection.textVerification.name && <div className="truncate">Name: {debugDetection.textVerification.name} ({debugDetection.textVerification.nameConfidence > 0 ? Math.round(debugDetection.textVerification.nameConfidence) : 'unverified'})</div>}
                  {debugDetection.textVerification.code && <div className="truncate">Code: {debugDetection.textVerification.code} ({debugDetection.textVerification.codeConfidence > 0 ? Math.round(debugDetection.textVerification.codeConfidence) : 'unverified'})</div>}
                  {debugDetection.textVerification.readSet && <div>Set: {debugDetection.textVerification.readSet} ({Math.round(debugDetection.textVerification.setConfidence || 0)})</div>}
                  {debugDetection.confirmationMethod === 'rune-text' && <div>Rune confirmed by name, set and printing artwork</div>}
                  {debugDetection.textVerification.tooSmall && !(debugDetection.textVerification.nameConfidence>=90&&debugDetection.textVerification.codeConfidence>=90) && <div>Bring the card closer to read its number</div>}
                </div>
              )}
              {debugDetection.timings && <div className="mt-1 text-[9px] text-rift-400">Frame {debugDetection.timings.frameMs} ms · detector {debugDetection.timings.detectorMs} · artwork {debugDetection.timings.artworkMs}</div>}
              {debugDetection.quality && <div className="mt-1 text-[10px] text-rift-300">Quality: {debugDetection.quality.acceptable ? 'pass' : debugDetection.quality.issue || 'fail'} · sharpness {debugDetection.quality.sharpness?.toFixed(3) || '?'}</div>}
              {debugCandidates.length > 0 && <details className="mt-2 text-[10px] text-rift-300"><summary>Top visual candidates</summary>
                {debugCandidates.map(entry => <div key={entry.id} className="mt-1">{entry.name || entry.id} · {(entry.similarity * 100).toFixed(1)}%</div>)}
              </details>}
            </div>
          )}
          {debugOverlayEnabled && !debugDetection?.cardData && (
            <div className="min-w-[11rem] max-w-[14rem] rounded-xl border border-gold-400/20 bg-black/70 px-3 py-2 backdrop-blur-sm shadow-lg shadow-black/30 pointer-events-auto">
              <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-gold-300/90">Recognized card</div>
              <div className="mt-1 truncate text-xs font-semibold text-rift-100">Scanning...</div>
              <div className="mt-0.5 truncate text-[10px] text-rift-400">No card locked yet</div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onToggleFacing}
              className="w-11 h-11 rounded-xl bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-white/80 hover:bg-black/70 transition-colors"
              title="Flip camera"
            >
              <RotateCw className="w-4.5 h-4.5" />
            </button>
            {hasTorch && (
              <button
                onClick={onToggleTorch}
                className={`w-11 h-11 rounded-xl backdrop-blur-sm border flex items-center justify-center transition-all ${
                  torchOn
                    ? 'bg-yellow-500/30 border-yellow-400/50 text-yellow-400'
                    : 'bg-black/50 border-white/10 text-white/60'
                }`}
                title={torchOn ? 'Turn torch off' : 'Turn torch on'}
              >
                {torchOn ? <Zap className="w-4.5 h-4.5" /> : <ZapOff className="w-4.5 h-4.5" />}
              </button>
            )}
            {hasFocusControl && (
              <button
                onClick={onRefocus}
                className="w-11 h-11 rounded-xl bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-white/80 hover:bg-black/70 transition-colors"
                title="Refocus on the card"
              >
                <ScanLine className="w-4.5 h-4.5" />
              </button>
            )}
            <button
              onClick={onToggleAutoScan}
              disabled={debugOverlayEnabled}
              aria-pressed={Boolean(autoScanEnabled)}
              className={`h-11 px-3 gap-2 rounded-xl backdrop-blur-sm border flex items-center justify-center transition-all ${
                autoScanEnabled
                  ? 'bg-green-500/30 border-green-400/50 text-green-400 animate-pulse'
                  : 'bg-black/50 border-white/10 text-white/60'
              }`}
              title={debugOverlayEnabled ? 'Auto-scan is active while debug is on' : autoScanEnabled ? 'Stop auto-scan' : 'Start auto-scan'}
            >
              <Radar className="w-4.5 h-4.5" />
              <span className="text-xs font-medium">Auto-scan {autoScanEnabled ? 'on' : 'off'}</span>
            </button>
            <button
              onClick={onStopCamera}
              className="w-11 h-11 rounded-xl bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-red-400 hover:bg-red-500/20 transition-colors"
              title="Stop camera"
            >
              <CameraOff className="w-4.5 h-4.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={handleToggleScanOverlay}
            aria-label="Scan overlay"
            aria-pressed={scanOverlayVisible}
            title="Show the tracked card while scanning"
            className={`min-w-[8.5rem] self-start rounded-xl border px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.18em] backdrop-blur-sm transition-all ${
              scanOverlayVisible ? 'bg-gold-500/20 border-gold-400/40 text-gold-200' : 'bg-black/50 border-white/10 text-white/60 hover:bg-black/70'
            }`}
          >
            <span className="block leading-none">Scan overlay</span>
            <span className="mt-1 block text-[9px] font-bold tracking-[0.24em]">{scanOverlayVisible ? 'ON' : 'OFF'}</span>
          </button>
          {SCANNER_DIAGNOSTICS_AVAILABLE && <div className="flex flex-col gap-2">
            {debugOverlayEnabled && captureFrame && <>
              <div className="max-w-[20rem] rounded-xl border border-cyan-300/30 bg-black/80 px-3 py-2 text-[10px] text-cyan-100">
                <div className="font-semibold">Debug auto-scan</div>
                <div className="mt-1">Accepted cards are added to pending. Each acceptance saves original PNG + debug image + JSON.</div>
                {scanRecording && <ScanRecordingControls recording={scanRecording} />}
                {debugCapture.card && <div className="mt-2">Last added: {debugCapture.card.name} · frame {debugCapture.frameId}</div>}
                {debugCapture.status === 'saving' && <div role="status" className="mt-1">Saving accepted frame...</div>}
                {debugCapture.status === 'saved' && <div role="status" className="mt-1">Debug capture saved.<div className="break-all select-text">{debugCapture.path}</div></div>}
                {debugCapture.status === 'error' && <div role="alert" className="mt-1 text-red-200">Card was added; debug capture failed: {debugCapture.error}
                  <button type="button" onClick={onRetryDebugCapture} className="mt-1 underline">Retry debug capture</button></div>}
                <button type="button" className="mt-2 underline" onClick={() => openDebugScanFolder().catch(error => setFrameSave(previous => ({ ...previous, error: String(error?.message || error) })))}>Open debug captures folder</button>
                {onUpdateScannerExperiments && <details className="mt-2"><summary>Diagnostic overrides (this session)</summary>
                  <button type="button" role="switch" aria-label="Perspective correction" aria-checked={scannerExperiments.perspective}
                    onClick={() => onUpdateScannerExperiments({ perspective: !scannerExperiments.perspective })} className="mt-2 block underline">Perspective correction: {scannerExperiments.perspective ? 'ON' : 'OFF'}</button>
                  <button type="button" role="switch" aria-label="Card text verification" aria-checked={scannerExperiments.textVerification}
                    onClick={() => onUpdateScannerExperiments({ textVerification: !scannerExperiments.textVerification })} className="mt-2 block underline">Name + number verification: {scannerExperiments.textVerification ? 'ON' : 'OFF'}</button>
                </details>}
              </div>
              <button type="button" className="btn-secondary text-xs" disabled={frameSave.status === 'saving'} onClick={handleSaveNativeFrame}>
                {frameSave.status === 'saving' ? 'Saving frame...' : 'Save native frame'}
              </button>
              <div className="max-w-[20rem] text-[10px] text-white/70">Desktop saves PNG + scan details (JSON).</div>
              {frameSave.status === 'saved' && <div role="status" className="max-w-[20rem] rounded-xl bg-black/80 px-3 py-2 text-xs text-emerald-100">
                <div>{frameSave.path ? 'Frame saved:' : 'Frame downloaded.'}</div>
                {frameSave.path && <>
                  <div className="mt-1 break-all select-text">{frameSave.path}</div>
                  {frameSave.diagnosticsPath && <div className="mt-1">Scan details saved beside the image.</div>}
                  <button type="button" className="mt-2 underline" onClick={handleOpenNativeFrameFolder}>Open folder</button>
                </>}
              </div>}
              {frameSave.error && <div role="alert" className="max-w-[20rem] rounded-xl bg-black/80 px-3 py-2 text-xs text-red-200">{frameSave.error}</div>}
            </>}
            <button
              type="button"
              onClick={handleToggleDebug}
              aria-label="Debug overlay"
              aria-pressed={debugOverlayEnabled}
              className={`min-w-[8.5rem] rounded-xl border px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.18em] backdrop-blur-sm transition-all ${
                debugOverlayEnabled
                  ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'
                  : 'bg-black/50 border-white/10 text-white/60 hover:bg-black/70 hover:text-white/80'
              }`}
            >
              <span className="block leading-none">Debug overlay</span>
              <span className="mt-1 block text-[9px] font-bold tracking-[0.24em]">
                {debugOverlayEnabled ? 'ON' : 'OFF'}
              </span>
            </button>
          </div>}
        </div>
      )}

    </div>
  );
}
