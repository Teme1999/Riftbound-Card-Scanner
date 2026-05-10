import { useState, useRef, useCallback, useEffect } from 'react';

const AUTO_SCAN_INTERVAL = 250;
const AUTO_SCAN_DISAPPEAR_COUNT = 4;
const AUTO_SCAN_MIN_HITS = 3;
const AUTO_SCAN_MIN_STABLE_MS = 500;
const AUTO_SCAN_HIGH_CONFIDENCE_SCORE = 0.93;
const AUTO_SCAN_HIGH_CONFIDENCE_MIN_HITS = 2;
const AUTO_SCAN_REPEAT_MIN_SIMILARITY = 0.68;
const AUTO_SCAN_CONSENSUS_MIN_SIMILARITY = 0.62;
const AUTO_SCAN_CONSENSUS_MIN_SCORE = 0.88;
const AUTO_SCAN_POST_COMMIT_COOLDOWN_MS = 1000;

/**
 * Hook for continuous auto-scan mode.
 *
 * Runs detectSingleFrame on an interval, skipping back-to-back duplicates.
 * The last accepted card stays locked until a different card is accepted.
 */
export function useAutoScan({
  cameraIsActive,
  isProcessing,
  detectSingleFrame,
  captureFrame,
  onCardDetected,
}) {
  const [enabled, setEnabled] = useState(false);
  const [debugPreview, setDebugPreview] = useState(null);

  // Session state keeps one visible card from being committed repeatedly.
  // lockedCardIdRef also prevents same-card reappears from becoming duplicates.
  const sessionRef = useRef(null);
  const lockedCardIdRef = useRef(null);
  const cooldownUntilRef = useRef(0);
  const intervalRef = useRef(null);

  const isProcessingRef = useRef(isProcessing);
  const detectRef = useRef(detectSingleFrame);
  const captureRef = useRef(captureFrame);
  const onCardDetectedRef = useRef(onCardDetected);

  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { detectRef.current = detectSingleFrame; }, [detectSingleFrame]);
  useEffect(() => { captureRef.current = captureFrame; }, [captureFrame]);
  useEffect(() => { onCardDetectedRef.current = onCardDetected; }, [onCardDetected]);

  const scoreResult = useCallback((result) => {
    const similarity = typeof result?.similarity === 'number' ? result.similarity : 0;
    const confidence = typeof result?.confidence === 'number' ? result.confidence : 0;
    const matchedBonus = result?.matched ? 0.03 : 0;
    return Math.min(1, similarity * 0.82 + confidence * 0.18 + matchedBonus);
  }, []);

  const recordCandidate = useCallback((session, result, now) => {
    const cardId = result?.cardData?.id;
    if (!session || !cardId) return null;

    const resultScore = scoreResult(result);
    const existing = session.candidates.get(cardId);
    const candidate = existing || {
      cardId,
      cardData: result.cardData,
      bestResult: result,
      bestScore: resultScore,
      totalScore: 0,
      hits: 0,
      matchedHits: 0,
      firstSeenAt: now,
      lastSeenAt: now,
    };

    candidate.hits += 1;
    candidate.totalScore += resultScore;
    candidate.lastSeenAt = now;
    if (result.matched) candidate.matchedHits += 1;

    if (resultScore >= candidate.bestScore) {
      candidate.bestResult = result;
      candidate.bestScore = resultScore;
      candidate.cardData = result.cardData;
    }

    session.candidates.set(cardId, candidate);
    session.lastSeenAt = now;
    session.noMatchStreak = 0;
    setDebugPreview(candidate.bestResult);
    return candidate;
  }, [scoreResult]);

  const startSession = useCallback((result, now) => {
    const session = {
      candidates: new Map(),
      committed: false,
      noMatchStreak: 0,
      lastSeenAt: now,
      firstSeenAt: now,
    };
    sessionRef.current = session;
    recordCandidate(session, result, now);
  }, [recordCandidate]);

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    setDebugPreview(null);
  }, []);

  const getCandidateScore = useCallback((candidate) => {
    const averageScore = candidate.totalScore / Math.max(1, candidate.hits);
    const hitBonus = Math.min(candidate.hits, 5) * 0.035;
    const matchedBonus = Math.min(candidate.matchedHits, 3) * 0.02;
    return candidate.bestScore * 0.72 + averageScore * 0.18 + hitBonus + matchedBonus;
  }, []);

  const getSessionWinner = useCallback((session) => {
    if (!session || session.candidates.size === 0) return null;

    let winner = null;
    for (const candidate of session.candidates.values()) {
      const aggregateScore = getCandidateScore(candidate);
      if (!winner || aggregateScore > winner.aggregateScore) {
        winner = { ...candidate, aggregateScore };
      }
    }

    return winner;
  }, [getCandidateScore]);

  const isWinnerReady = useCallback((session, winner, now = Date.now(), allowOnDisappear = false) => {
    if (!session || !winner) return false;

    const stableDuration = now - session.firstSeenAt;
    const bestSimilarity = winner.bestResult?.similarity || 0;

    if (winner.hits >= AUTO_SCAN_HIGH_CONFIDENCE_MIN_HITS && winner.bestScore >= AUTO_SCAN_HIGH_CONFIDENCE_SCORE) {
      return true;
    }

    if (
      winner.hits >= AUTO_SCAN_MIN_HITS &&
      winner.aggregateScore >= AUTO_SCAN_CONSENSUS_MIN_SCORE &&
      bestSimilarity >= AUTO_SCAN_REPEAT_MIN_SIMILARITY &&
      stableDuration >= AUTO_SCAN_MIN_STABLE_MS
    ) {
      return true;
    }

    if (!allowOnDisappear) {
      return false;
    }

    return (
      bestSimilarity >= 0.88 ||
      (winner.hits >= 2 && bestSimilarity >= AUTO_SCAN_REPEAT_MIN_SIMILARITY) ||
      (winner.hits >= AUTO_SCAN_MIN_HITS && bestSimilarity >= AUTO_SCAN_CONSENSUS_MIN_SIMILARITY)
    );
  }, []);

  const commitSession = useCallback((now, { allowOnDisappear = false } = {}) => {
    const session = sessionRef.current;
    const winner = getSessionWinner(session);
    if (!session || session.committed || !isWinnerReady(session, winner, now, allowOnDisappear)) {
      return false;
    }

    const result = {
      ...winner.bestResult,
      timestamp: now,
      matched: true,
      acceptedByAutoScan: true,
      autoScanConsensus: {
        hits: winner.hits,
        matchedHits: winner.matchedHits,
        aggregateScore: winner.aggregateScore,
      },
    };

    cooldownUntilRef.current = now + AUTO_SCAN_POST_COMMIT_COOLDOWN_MS;
    session.committed = true;
    session.cardId = winner.cardId;
    session.result = result;
    lockedCardIdRef.current = winner.cardId;
    onCardDetectedRef.current(result);
    setDebugPreview(result);

    session.noMatchStreak = 0;
    return true;
  }, [getSessionWinner, isWinnerReady]);

  // Start/stop interval - only depends on enabled + cameraIsActive
  useEffect(() => {
    if (!enabled || !cameraIsActive) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(async () => {
      if (isProcessingRef.current) return;

      const now = Date.now();
      const session = sessionRef.current;

      const result = await detectRef.current(captureRef.current, { includeCandidate: true });

      if (!result?.cardData) {
        if (!session) return;

        session.noMatchStreak += 1;

        if (!session.committed && session.noMatchStreak >= AUTO_SCAN_DISAPPEAR_COUNT) {
          if (!commitSession(now, { allowOnDisappear: true })) {
            clearSession();
          }
          return;
        }

        if (session.committed && session.noMatchStreak >= AUTO_SCAN_DISAPPEAR_COUNT) {
          clearSession();
        }
        return;
      }

      if (lockedCardIdRef.current === result.cardData.id) {
        if (session && session.committed && session.cardId === result.cardData.id) {
          session.lastSeenAt = now;
          session.noMatchStreak = 0;
        }
        return;
      }

      if (session && session.committed && session.cardId !== result.cardData.id) {
        clearSession();
      }

      if (cooldownUntilRef.current > now && !session) {
        return;
      }

      if (!session) {
        startSession(result, now);
        commitSession(now);
        return;
      }

      if (session.committed) {
        if (session.cardId === result.cardData.id) {
          session.lastSeenAt = now;
          session.noMatchStreak = 0;
        }
        return;
      }

      recordCandidate(session, result, now);

      commitSession(now);
    }, AUTO_SCAN_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, cameraIsActive]);

  // Auto-disable when camera stops
  useEffect(() => {
    if (!cameraIsActive && enabled) {
      setEnabled(false);
    }
  }, [cameraIsActive, enabled]);

  const toggleAutoScan = useCallback(() => {
    setEnabled(prev => {
      if (!prev) {
        cooldownUntilRef.current = 0;
        lockedCardIdRef.current = null;
        clearSession();
      } else {
        clearSession();
      }
      return !prev;
    });
  }, [clearSession]);

  const setLastCardId = useCallback((cardId) => {
    cooldownUntilRef.current = Date.now() + AUTO_SCAN_POST_COMMIT_COOLDOWN_MS;
    lockedCardIdRef.current = cardId;
    sessionRef.current = {
      cardId,
      result: null,
      candidates: new Map(),
      committed: true,
      noMatchStreak: 0,
      lastSeenAt: Date.now(),
    };
  }, []);

  return {
    autoScanEnabled: enabled,
    toggleAutoScan,
    setLastCardId,
    debugPreview,
  };
}
