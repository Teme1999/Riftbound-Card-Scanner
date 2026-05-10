import React, { useEffect, useState } from 'react';
import { Camera, CameraOff, RotateCw, Zap, ZapOff, AlertCircle, ScanLine, Radar } from 'lucide-react';

const DEBUG_OVERLAY_STORAGE_KEY = 'riftbound_scanner_debug_overlay_enabled';

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
  captureFrame,
  detectSingleFrame,
}) {
  const [dimensions, setDimensions] = useState({ w: 0, h: 0 });
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [showDebugOverlay, setShowDebugOverlay] = useState(() => loadStoredBoolean(DEBUG_OVERLAY_STORAGE_KEY, false));

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
    saveStoredBoolean(DEBUG_OVERLAY_STORAGE_KEY, showDebugOverlay);
  }, [showDebugOverlay]);

  const cardAspect = 63 / 88;
  const guideMaxW = dimensions.w * 0.9;
  const guideMaxH = dimensions.h * 0.8;
  let guideW = guideMaxW;
  let guideH = guideW / cardAspect;
  if (guideH > guideMaxH) {
    guideH = guideMaxH;
    guideW = guideH * cardAspect;
  }
  const guideX = (dimensions.w - guideW) / 2;
  const guideY = (dimensions.h - guideH) / 2;

  const hasDetection = Boolean(lastDetection?.box);
  const detectionLabel = lastDetection?.matched
    ? 'Tracked card'
    : hasDetection
      ? 'Tracking card'
      : null;
  const debugOverlayEnabled = showDebugOverlay;
  const recognizedDetection = debugOverlayEnabled ? (lastDetection?.matched ? lastDetection : null) : null;

  useEffect(() => {
    if (!debugOverlayEnabled || !isActive || !detectSingleFrame || !captureFrame) {
      return undefined;
    }

    let cancelled = false;
    let inFlight = false;

    const interval = setInterval(async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await detectSingleFrame(captureFrame);
      } finally {
        inFlight = false;
      }
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [debugOverlayEnabled, isActive, detectSingleFrame, captureFrame]);

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
        <div className="absolute inset-0" onClick={isProcessing ? undefined : onSnapScan}>
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
          {debugOverlayEnabled && detectionOverlay && (
            <div
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
          {debugOverlayEnabled && detectionOverlay && (
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
                {autoScanEnabled ? 'Auto-scanning...' : 'Tap to scan card'}
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
        <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-2" onClick={e => e.stopPropagation()}>
          {recognizedDetection?.cardData && (
            <div className="min-w-[11rem] max-w-[14rem] rounded-xl border border-gold-400/30 bg-black/70 px-3 py-2 backdrop-blur-sm shadow-lg shadow-black/30 pointer-events-auto">
              <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-gold-300/90">Recognized card</div>
              <div className="mt-1 truncate text-xs font-semibold text-rift-50">
                {recognizedDetection.cardData.name}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-rift-300">
                {recognizedDetection.cardData.setName || recognizedDetection.cardData.set}
                {typeof recognizedDetection.similarity === 'number' && (
                  <span className="text-rift-500"> · {(recognizedDetection.similarity * 100).toFixed(1)}%</span>
                )}
              </div>
            </div>
          )}
          {debugOverlayEnabled && !recognizedDetection?.cardData && (
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
              className={`w-11 h-11 rounded-xl backdrop-blur-sm border flex items-center justify-center transition-all ${
                autoScanEnabled
                  ? 'bg-green-500/30 border-green-400/50 text-green-400 animate-pulse'
                  : 'bg-black/50 border-white/10 text-white/60'
              }`}
              title={autoScanEnabled ? 'Stop auto-scan' : 'Start auto-scan'}
            >
              <Radar className="w-4.5 h-4.5" />
            </button>
            <button
              onClick={onStopCamera}
              className="w-11 h-11 rounded-xl bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-red-400 hover:bg-red-500/20 transition-colors"
              title="Stop camera"
            >
              <CameraOff className="w-4.5 h-4.5" />
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShowDebugOverlay(prev => !prev)}
              className={`min-w-[8.5rem] rounded-xl border px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.18em] backdrop-blur-sm transition-all ${
                showDebugOverlay
                  ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'
                  : 'bg-black/50 border-white/10 text-white/60 hover:bg-black/70 hover:text-white/80'
              }`}
            >
              <span className="block leading-none">Debug overlay</span>
              <span className="mt-1 block text-[9px] font-bold tracking-[0.24em]">
                {showDebugOverlay ? 'ON' : 'OFF'}
              </span>
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
