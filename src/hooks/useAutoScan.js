import { useState, useRef, useCallback, useEffect } from 'react';
import { isReliableScanResult } from '../lib/scanQuality.js';

const SCAN_INTERVAL_MS = 250;
const POST_COMMIT_COOLDOWN_MS = 1000;

export function useAutoScan({ cameraIsActive, isProcessing, detectSingleFrame, captureFrame, onCardDetected }) {
  const [enabled, setEnabled] = useState(false);
  const [debugPreview, setDebugPreview] = useState(null);
  const sessionRef = useRef(null);
  const lockedCardIdRef = useRef(null);
  const cooldownUntilRef = useRef(0);
  const lastFrameIdRef = useRef(null);
  const latestRef = useRef({ isProcessing, detectSingleFrame, captureFrame, onCardDetected });
  useEffect(() => {
    latestRef.current = { isProcessing, detectSingleFrame, captureFrame, onCardDetected };
  }, [isProcessing, detectSingleFrame, captureFrame, onCardDetected]);

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    setDebugPreview(null);
  }, []);

  useEffect(() => {
    if (!enabled || !cameraIsActive) return undefined;
    let cancelled = false, processing = false;
    const timer = setInterval(async () => {
      if (processing || latestRef.current.isProcessing) return;
      processing = true;
      try {
        const result = await latestRef.current.detectSingleFrame(latestRef.current.captureFrame, { includeCandidate: true });
        if (cancelled) return;
        if (result?.skipped) {
          const session = sessionRef.current;
          if (session && !session.committed && Date.now() - session.lastSeenAt > 1500) clearSession();
          return;
        }
        // A buffered image is one observation, even if it is selected twice.
        if (result?.frameId != null) {
          if (lastFrameIdRef.current != null && result.frameId <= lastFrameIdRef.current) return;
          lastFrameIdRef.current = result.frameId;
        }
        let session = sessionRef.current;
        if (!isReliableScanResult(result)) {
          if (session) {
            session.misses++;
            session.consecutive = 0;
            if (session.misses >= 4) clearSession();
          }
          return;
        }
        const now = Date.now(), cardId = result.cardData.id;
        if (lockedCardIdRef.current === cardId) {
          if (session?.committed) session.misses = 0;
          return;
        }
        if (session?.committed) { clearSession(); session = null; }
        if (!session && now < cooldownUntilRef.current) return;
        const qualityScore = Number.isFinite(result.quality.score) ? result.quality.score : 0.5;
        const score = result.similarity * 0.65 + qualityScore * 0.25 + result.confidence * 0.1;
        if (!session || session.cardId !== cardId) {
          session = { cardId, firstSeenAt: now, lastSeenAt: now, hits: 0, consecutive: 0, misses: 0, committed: false, bestScore: -1 };
          sessionRef.current = session;
        }
        session.hits++;
        session.consecutive++;
        session.misses = 0;
        session.lastSeenAt = now;
        if (score >= session.bestScore) { session.bestResult = result; session.bestScore = score; }
        setDebugPreview(session.bestResult);
        const fastReady = session.consecutive >= 2 && session.bestResult.similarity >= 0.96 && session.bestResult.similarityGap >= 0.07;
        const stableReady = session.consecutive >= 3 && now - session.firstSeenAt >= 500;
        if (!fastReady && !stableReady) return;
        const accepted = { ...session.bestResult, timestamp: now, acceptedByAutoScan: true,
          autoScanConsensus: { hits: session.hits, matchedHits: session.hits, aggregateScore: session.bestScore } };
        // Repetition can strengthen an unambiguous match, never promote an
        // ambiguous/poor-quality candidate into a valid match.
        if (latestRef.current.onCardDetected(accepted) !== true) return;
        session.committed = true;
        lockedCardIdRef.current = cardId;
        cooldownUntilRef.current = now + POST_COMMIT_COOLDOWN_MS;
        setDebugPreview(accepted);
      } finally {
        processing = false;
      }
    }, SCAN_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled, cameraIsActive, clearSession]);

  useEffect(() => {
    if (!cameraIsActive) { setEnabled(false); clearSession(); }
  }, [cameraIsActive, clearSession]);

  const toggleAutoScan = useCallback(() => {
    setEnabled((previous) => !previous);
    cooldownUntilRef.current = 0;
    lockedCardIdRef.current = null;
    lastFrameIdRef.current = null;
    clearSession();
  }, [clearSession]);

  const setLastCardId = useCallback((cardId) => {
    cooldownUntilRef.current = Date.now() + POST_COMMIT_COOLDOWN_MS;
    lockedCardIdRef.current = cardId;
    sessionRef.current = { cardId, committed: true, misses: 0, consecutive: 0 };
  }, []);

  return { autoScanEnabled: enabled, toggleAutoScan, setLastCardId, debugPreview };
}
