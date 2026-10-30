import { useState, useRef, useCallback, useEffect } from 'react';
import { isReliableScanResult } from '../lib/scanQuality.js';
import { hasLocalArtworkSupport } from '../lib/localArtwork.js';
import { copyScanEvidence } from '../lib/scanEvidence.js';
import { emitScanDiagnostic } from '../lib/scanDiagnostics.js';
import { hasStrongVisualProof } from '../lib/cardVisualProof.js';
import { hasRuneArtwork, hasRuneTextArtwork } from '../lib/cardRuneVerification.js';
import { SCANNER_DIAGNOSTICS_AVAILABLE } from '../lib/scannerExperiments.js';

const SCAN_INTERVAL_MS = 50;
const POST_COMMIT_COOLDOWN_MS = 1000;

export function useAutoScan({ cameraIsActive, isProcessing, detectSingleFrame, captureFrame, onCardDetected,
  validateResult = isReliableScanResult, resetRecognition, onFakeScanAccepted, recognitionContext = '',
  debugEnabled: requestedDebug = false, onDebugAccepted }) {
  const debugEnabled=SCANNER_DIAGNOSTICS_AVAILABLE && requestedDebug;
  const [enabled, setEnabled] = useState(false);
  const [debugPreview, setDebugPreview] = useState(null);
  const [fakeEnabled, setFakeEnabled] = useState(false);
  const [fakeResult, setFakeResult] = useState(null);
  const mode = debugEnabled ? 'auto' : fakeEnabled ? 'fake' : enabled ? 'auto' : 'off';
  const modeRef = useRef(mode);
  const generationRef = useRef(0);
  const fakeResultRef = useRef(null);
  const contextRef = useRef(recognitionContext);
  const previousContextRef = useRef(recognitionContext);
  modeRef.current = mode;
  contextRef.current = recognitionContext;
  const sessionRef = useRef(null);
  const lockedCardIdRef = useRef(null);
  const cooldownUntilRef = useRef(0);
  const lastFrameIdRef = useRef(null);
  const textFramesRef = useRef({ key: null, frames: [] });
  const latestRef = useRef({ isProcessing, detectSingleFrame, captureFrame, onCardDetected, validateResult, resetRecognition, onFakeScanAccepted, onDebugAccepted });
  useEffect(() => {
    latestRef.current = { isProcessing, detectSingleFrame, captureFrame, onCardDetected, validateResult, resetRecognition, onFakeScanAccepted, onDebugAccepted };
  }, [isProcessing, detectSingleFrame, captureFrame, onCardDetected, validateResult, resetRecognition, onFakeScanAccepted, onDebugAccepted]);

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    setDebugPreview(null);
  }, []);

  const resetProgress = useCallback(() => {
    generationRef.current++;
    fakeResultRef.current = null;
    setFakeResult(null);
    lastFrameIdRef.current = null;
    textFramesRef.current = { key: null, frames: [] };
    clearSession();
    latestRef.current.resetRecognition?.();
  }, [clearSession]);

  useEffect(() => {
    if (previousContextRef.current !== recognitionContext) {
      previousContextRef.current = recognitionContext;
      resetProgress();
    }
  }, [recognitionContext, resetProgress]);

  useEffect(() => {
    if (mode === 'off' || !cameraIsActive) return undefined;
    let cancelled = false, processing = false;
    const timer = setInterval(async () => {
      if (processing || latestRef.current.isProcessing || modeRef.current !== mode ||
        contextRef.current !== recognitionContext || (mode === 'fake' && fakeResultRef.current)) return;
      processing = true;
      const generation = generationRef.current;
      try {
        const result = await latestRef.current.detectSingleFrame(latestRef.current.captureFrame, { includeCandidate: true, retainEvidence: debugEnabled });
        if (cancelled || generation !== generationRef.current || modeRef.current !== mode || contextRef.current !== recognitionContext) return;
        if (result?.skipped) {
          emitScanDiagnostic('auto-decision',{reason:'no-fresh-source'});
          const session = sessionRef.current;
          if (session && !session.committed && Date.now() - session.lastSeenAt > 1500) clearSession();
          return;
        }
        // A buffered image is one observation, even if it is selected twice.
        if (result?.frameId != null) {
          if (lastFrameIdRef.current != null && result.frameId <= lastFrameIdRef.current) {
            emitScanDiagnostic('auto-decision',{frameId:result.frameId,reason:'repeated-source'});return;
          }
          lastFrameIdRef.current = result.frameId;
        }
        let session = sessionRef.current;
        const now = Date.now();
        const textFrames = textFramesRef.current;
        if (result?.textVerification && result.frameId != null && result.quality?.acceptable) {
          if (textFrames.key !== result.recognitionEpoch) {
            textFrames.key = result.recognitionEpoch; textFrames.frames = [];
            if (session && !session.committed) { clearSession(); session = null; }
          }
          textFrames.frames.push({ frameId: result.frameId, at: result.capturedAt ?? now,
            candidates: result.visualCandidates || [], runeArtwork:result.visualVerification,geometryConflict: result.geometryConflict,requiresTextConfirmation:result.requiresTextConfirmation });
          // Compare capture times. Inference latency must not consume the
          // freshness window between independent camera observations.
          const capturedAt = result.capturedAt ?? now;
          textFrames.frames = textFrames.frames.filter((f) => capturedAt >= f.at && capturedAt - f.at <= 2000).slice(-8);
        } else { textFrames.frames = []; textFrames.key = null; }
        if (!isReliableScanResult(result) || !latestRef.current.validateResult(result)) {
          emitScanDiagnostic('auto-decision',{frameId:result?.frameId,cardId:result?.cardData?.id,reason:result?.reason || 'no-eligible-result'});
          if (session) {
            session.misses++;
            session.consecutive = 0;
            session.fastConsecutive = 0;
            session.geometryConsecutive = 0;
            session.sourceFrameIds = [];
            if (session.misses >= 4) clearSession();
          }
          return;
        }
        const cardId = result.cardData.id;
        if (mode === 'auto' && lockedCardIdRef.current === cardId) {
          emitScanDiagnostic('auto-decision',{frameId:result.frameId,cardId,reason:'duplicate-card-lock'});
          if (session?.committed) session.misses = 0;
          return;
        }
        if (session?.committed) { clearSession(); session = null; }
        if (mode === 'auto' && !session && now < cooldownUntilRef.current && !hasStrongVisualProof(result) && result.confirmationMethod!=='rune-text') {
          emitScanDiagnostic('auto-decision',{frameId:result.frameId,cardId,reason:'cooldown',remainingMs:cooldownUntilRef.current-now});return;
        }
        const qualityScore = Number.isFinite(result.quality.score) ? result.quality.score : 0.5;
        const score = result.similarity * 0.65 + qualityScore * 0.25 + result.confidence * 0.1;
        if (!session || session.cardId !== cardId || session.recognitionEpoch !== result.recognitionEpoch || (hasStrongVisualProof(result) && now-session.lastSeenAt>1000)) {
          session = { cardId, recognitionEpoch:result.recognitionEpoch, firstSeenAt: now, lastSeenAt: now, hits: 0, consecutive: 0, fastConsecutive: 0, geometryConsecutive:0, sourceFrameIds: [], misses: 0, committed: false, bestScore: -1 };
          // Reuse actual visual observations gathered while OCR was pending.
          // Text callbacks and preprocessing retries never increment this count.
          if(result.confirmationMethod==='rune-text'&&hasRuneTextArtwork(result.textVerification,cardId)){
            const sources=result.textVerification.sourceFrameIds.filter(id=>id!==result.frameId);
            session.sourceFrameIds=[...new Set(sources)];session.hits=session.consecutive=session.sourceFrameIds.length;
          } else if (result.textVerification && !hasStrongVisualProof(result)) {
            const eligible = [];
            for (let i = textFrames.frames.length - 1; i >= 0; i--) {
              const f = textFrames.frames[i], candidate = f.candidates.find((c) => c.id === cardId);
              const runeText=result.confirmationMethod==='rune-text'&&!f.geometryConflict&&hasRuneArtwork(f.runeArtwork,cardId,f.frameId);
              const localText = ['name-number-local-artwork','name-number-aligned-artwork'].includes(result.confirmationReason) && hasLocalArtworkSupport(candidate);
              if (!candidate || (!runeText&&!localText && candidate.similarity < result.minSimilarity) ||
                (!runeText&&result.confirmationMethod !== 'text' && (f.geometryConflict || f.requiresTextConfirmation || candidate.similarityGap < .05))) break;
              eligible.unshift(f);
            }
            if (eligible.length) {
              session.firstSeenAt = eligible[0].at; session.hits = eligible.length - 1; session.consecutive = eligible.length - 1;
              session.sourceFrameIds = eligible.slice(0, -1).map(value => value.frameId);
            }
          }
          sessionRef.current = session;
        }
        session.hits++;
        session.consecutive++;
        session.fastConsecutive = result.similarity >= .96 && result.similarityGap >= .07 ? (session.fastConsecutive || 0) + 1 : 0;
        session.geometryConsecutive = hasStrongVisualProof(result) && result.frameId != null ? (session.geometryConsecutive || 0) + 1 : 0;
        if (result.frameId != null) session.sourceFrameIds = [...(session.sourceFrameIds || []), result.frameId].slice(-8);
        session.misses = 0;
        session.lastSeenAt = now;
        if (result.textVerification || score >= session.bestScore) { session.bestResult = result; session.bestScore = score; }
        setDebugPreview(session.bestResult);
        const fastReady = session.fastConsecutive >= 2 || session.geometryConsecutive >= 2 || (result.confirmationMethod==='rune-text'&&session.consecutive>=2);
        const stableReady = session.consecutive >= 3 && now - session.firstSeenAt >= 500;
        if (!fastReady && !stableReady) {
          emitScanDiagnostic('auto-decision',{frameId:result.frameId,cardId,reason:'collecting-visual-frames',visualFrames:session.consecutive,sourceFrameIds:session.sourceFrameIds});return;
        }
        const accepted = copyScanEvidence(result, { ...result, timestamp: now, acceptedByAutoScan: mode === 'auto',
          ...(mode === 'fake' ? { acceptedByFakeScan: true } : {}),
          acceptanceDecision: { ...result.acceptanceDecision, phase: 'accepted', eligible: true, visualFrames: session.consecutive, sourceFrameId: result.frameId },
          autoScanConsensus: { hits: session.hits, matchedHits: session.hits, aggregateScore: session.bestScore,
            consecutiveHits: session.consecutive, sourceFrameIds: session.sourceFrameIds,
            durationMs: Math.max(0, now - session.firstSeenAt) } });
        if (mode === 'fake') {
          // The real acceptance rules have passed. Hold a diagnostic snapshot;
          // the collection-writing callback is never invoked by this mode.
          session.committed = true;
          fakeResultRef.current = accepted;
          setFakeResult(accepted);
          setDebugPreview(accepted);
          latestRef.current.onFakeScanAccepted?.(accepted);
          return;
        }
        // Repetition can strengthen an unambiguous match, never promote an
        // ambiguous/poor-quality candidate into a valid match.
        if (latestRef.current.onCardDetected(accepted) !== true) {
          emitScanDiagnostic('auto-decision',{frameId:result.frameId,cardId,reason:'queue-rejected'});return;
        }
        emitScanDiagnostic('accepted',{result:accepted});
        session.committed = true;
        lockedCardIdRef.current = cardId;
        cooldownUntilRef.current = now + POST_COMMIT_COOLDOWN_MS;
        setDebugPreview(accepted);
        if (debugEnabled) Promise.resolve(latestRef.current.onDebugAccepted?.(accepted)).catch(error => console.error('[Debug capture]', error));
      } finally {
        processing = false;
      }
    }, SCAN_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [mode, cameraIsActive, clearSession, recognitionContext, debugEnabled]);

  useEffect(() => {
    if (!cameraIsActive) {
      modeRef.current = 'off'; setEnabled(false); setFakeEnabled(false); resetProgress();
    }
  }, [cameraIsActive, resetProgress]);

  const toggleAutoScan = useCallback(() => {
    if (debugEnabled) return;
    const next = modeRef.current !== 'auto';
    modeRef.current = next ? 'auto' : 'off';
    setEnabled(next);
    setFakeEnabled(false);
    cooldownUntilRef.current = 0;
    lockedCardIdRef.current = null;
    resetProgress();
  }, [resetProgress, debugEnabled]);

  const toggleFakeScan = useCallback(() => {
    if (!SCANNER_DIAGNOSTICS_AVAILABLE || debugEnabled) return;
    const next = modeRef.current !== 'fake';
    modeRef.current = next ? 'fake' : 'off';
    setEnabled(false);
    setFakeEnabled(next);
    resetProgress();
  }, [resetProgress, debugEnabled]);

  const stopFakeScan = useCallback(() => {
    if (modeRef.current !== 'fake') return;
    modeRef.current = 'off';
    setFakeEnabled(false);
    resetProgress();
  }, [resetProgress]);

  const nextFakeScan = useCallback(() => {
    if (modeRef.current === 'fake') resetProgress();
  }, [resetProgress]);

  const setLastCardId = useCallback((cardId) => {
    cooldownUntilRef.current = Date.now() + POST_COMMIT_COOLDOWN_MS;
    lockedCardIdRef.current = cardId;
    sessionRef.current = { cardId, committed: true, misses: 0, consecutive: 0, fastConsecutive: 0, sourceFrameIds: [] };
  }, []);

  return { autoScanEnabled: enabled || debugEnabled, toggleAutoScan, setLastCardId, debugPreview,
    fakeScanEnabled: fakeEnabled, fakeScanResult: fakeEnabled && previousContextRef.current === recognitionContext ? fakeResult : null,
    toggleFakeScan, stopFakeScan, nextFakeScan };
}
