import { useState, useRef, useCallback, useEffect } from 'react';
import { getDetector, DetectorState } from '../lib/yoloDetector.js';
import { getMatcher } from '../lib/cardMatcher.js';
import { resolveCardData } from '../lib/cardData.js';
import { selectGuideDetection, mapDetectionBox } from '../lib/scanGeometry.js';
import { readCanvasQuality, MIN_SIMILARITY_GAP } from '../lib/scanQuality.js';

/**
 * Hook for single-frame card detection (tap to scan).
 *
 * Orchestrates:
 *   1. YOLO detection on a captured frame
 *   2. Card matching on detected crops (via CardMatcher)
 */
export function useCardDetection({ scanSetFilter = 'all', minSimilarity = 0.90 } = {}) {
  const [detectorState, setDetectorState] = useState(DetectorState.UNLOADED);
  const [detectorMode, setDetectorMode] = useState('unloaded');
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastDetection, setLastDetection] = useState(null);

  const detectorRef = useRef(null);
  const busyRef = useRef(false);
  const minSimilarityRef = useRef(minSimilarity);
  const scanSetFilterRef = useRef(scanSetFilter);

  // Min combined artwork similarity for a valid strict match
  const SIMILARITY_THRESHOLD = 0.68;
  // Lower floor used only by auto-scan temporal voting.
  const CANDIDATE_SIMILARITY_FLOOR = 0.62;
  // Min gap between top-1 and top-2 similarity scores; rejects partial/ambiguous views
  const SIMILARITY_GAP_THRESHOLD = MIN_SIMILARITY_GAP;
  const TARGET_ASPECT_RATIO = 63 / 88;
  const MAX_ASPECT_DEVIATION = 0.22;

  useEffect(() => {
    scanSetFilterRef.current = scanSetFilter;
    minSimilarityRef.current = minSimilarity;
  }, [scanSetFilter, minSimilarity]);

  /**
   * Initialize the YOLO detector
   */
  const initDetector = useCallback(async (modelPreference = 'normal') => {
    try {
      const detector = getDetector();
      detectorRef.current = detector;
      setDetectorState(DetectorState.LOADING);
      setDetectorMode('loading');

      await detector.initialize(modelPreference);
      setDetectorState(detector.state);
      setDetectorMode(detector.modelFormat || 'ready');
    } catch (error) {
      console.error('[Detection] Init failed:', error);
      setDetectorState(DetectorState.ERROR);
      setDetectorMode('error');
      throw error;
    }
  }, []);

  /**
   * Ensure canvas is in portrait orientation
   */
  function ensurePortrait(canvas) {
    if (canvas.width <= canvas.height) return canvas;
    const rot = document.createElement('canvas');
    rot.width = canvas.height;
    rot.height = canvas.width;
    const rctx = rot.getContext('2d');
    rctx.translate(rot.width / 2, rot.height / 2);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return rot;
  }

  /**
   * Detect cards in a single frame (tap to scan).
   * Captures one frame, runs YOLO + matching, returns result.
   */
  const detectSingleFrame = useCallback(async (captureFrame, options = {}) => {
    if (busyRef.current || !detectorRef.current || detectorRef.current.state !== DetectorState.READY) return null;
    const matcher = getMatcher();
    if (!matcher.ready) return null;
    const frame = captureFrame?.();
    if (!frame) return { skipped: true };
    busyRef.current = true;
    setIsProcessing(true);
    const observedAt = Date.now();
    const observation = { observedAt, frameId: frame.frameId, capturedAt: frame.capturedAt ?? observedAt };
    try {
      if (frame.scanMoving || ['too-dark', 'too-bright'].includes(frame.scanQuality?.issue)) {
        setLastDetection({ ...observation, matched: false, reason: frame.scanMoving ? 'moving' : frame.scanQuality.issue });
        return null;
      }
      const detections = await detectorRef.current.detect(frame);
      if (frame.scanCancelled) return null;
      const bestDetection = selectGuideDetection(detections, frame.scanRegion?.guide);
      if (!bestDetection) {
        setLastDetection({ ...observation, matched: false, reason: 'outside-guide' });
        return null;
      }
      const box = mapDetectionBox(bestDetection.box, frame.scanRegion);
      const base = { ...observation, box, confidence: bestDetection.confidence, matched: false };
      const boxRatio = bestDetection.box.w / Math.max(1, bestDetection.box.h);
      const normalizedRatio = Math.min(boxRatio, 1 / boxRatio);
      if (Math.abs(normalizedRatio - TARGET_ASPECT_RATIO) > MAX_ASPECT_DEVIATION) {
        setLastDetection({ ...base, reason: 'outside-guide' });
        return null;
      }
      const crop = ensurePortrait(bestDetection.cropCanvas);
      const quality = readCanvasQuality(crop);
      if (frame.scanMoving) { quality.acceptable = false; quality.issue = 'moving'; }
      if (!quality.acceptable) {
        setLastDetection({ ...base, quality, reason: quality.issue });
        return null;
      }
      const matchResult = matcher.identify(crop, { setFilter: scanSetFilterRef.current });
      if (!matchResult?.card) {
        setLastDetection({ ...base, quality, reason: 'low-similarity' });
        return null;
      }
      const similarityGap = matchResult.similarity - (matchResult.secondBestSim ?? 0);
      const isStrongEnough = matchResult.similarity >= Math.max(SIMILARITY_THRESHOLD, minSimilarityRef.current);
      const matched = isStrongEnough && similarityGap >= SIMILARITY_GAP_THRESHOLD;
      const result = {
        ...base,
        cardData: resolveCardData(matchResult.card),
        similarity: matchResult.similarity,
        colorSimilarity: matchResult.colorSimilarity,
        structureSimilarity: matchResult.structureSimilarity,
        similarityGap,
        minSimilarity: Math.max(SIMILARITY_THRESHOLD, minSimilarityRef.current),
        minSimilarityGap: SIMILARITY_GAP_THRESHOLD,
        quality,
        matched,
        timestamp: Date.now(),
        reason: matched ? null : quality.issue || (isStrongEnough ? 'ambiguous' : 'low-similarity'),
      };
      setLastDetection(result);
      if (matched || (options.includeCandidate && matchResult.similarity >= CANDIDATE_SIMILARITY_FLOOR)) return result;
      return null;
    } catch (error) {
      console.error('[Detection] Frame processing error:', error);
      setLastDetection({ ...observation, matched: false, reason: 'low-similarity' });
      return null;
    } finally {
      busyRef.current = false;
      setIsProcessing(false);
    }
  }, []);

  return {
    detectorState,
    detectorMode,
    isProcessing,
    lastDetection,
    initDetector,
    detectSingleFrame,
  };
}
