import { useState, useRef, useCallback, useEffect } from 'react';
import { getDetector, DetectorState } from '../lib/yoloDetector.js';
import { getMatcher } from '../lib/cardMatcher.js';

/**
 * Hook for single-frame card detection (tap to scan).
 *
 * Orchestrates:
 *   1. YOLO detection on a captured frame
 *   2. Card matching on detected crops (via CardMatcher)
 */
export function useCardDetection({ scanSetFilter = 'all' } = {}) {
  const [detectorState, setDetectorState] = useState(DetectorState.UNLOADED);
  const [detectorMode, setDetectorMode] = useState('unloaded');
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastDetection, setLastDetection] = useState(null);

  const detectorRef = useRef(null);
  const scanSetFilterRef = useRef(scanSetFilter);

  // Min cosine similarity for a valid strict match
  const SIMILARITY_THRESHOLD = 0.68;
  // Lower floor used only by auto-scan temporal voting.
  const CANDIDATE_SIMILARITY_FLOOR = 0.62;
  // Min gap between top-1 and top-2 similarity scores; rejects partial/ambiguous views
  const SIMILARITY_GAP_THRESHOLD = 0.05;
  const TARGET_ASPECT_RATIO = 63 / 88;
  const MAX_ASPECT_DEVIATION = 0.22;

  useEffect(() => {
    scanSetFilterRef.current = scanSetFilter;
  }, [scanSetFilter]);

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
   * Resolve card data from a matcher card to full card format.
   */
  function resolveCardData(matcherCard) {
    if (!matcherCard) return null;

    // Extract collector number from code (e.g. "OGN-089a/298" → "089a", "OGN-309*/298" → "309*")
    const codePart = (matcherCard.code || '').split('/')[0]; // "OGN-089a"
    const collectorNumber = codePart.includes('-')
      ? codePart.split('-').slice(1).join('-')              // "089a"
      : String(matcherCard.number).padStart(3, '0');        // fallback: "089"
    return {
      id: matcherCard.id,
      name: matcherCard.name,
      collectorNumber,
      code: matcherCard.code,
      set: matcherCard.set,
      setName: matcherCard.setName,
      domain: matcherCard.domain,
      domains: matcherCard.domains,
      rarity: matcherCard.rarity,
      type: matcherCard.type,
      energy: matcherCard.energy,
      might: matcherCard.might,
      tags: matcherCard.tags,
      illustrator: matcherCard.illustrator,
      text: matcherCard.text,
      imageUrl: matcherCard.imageUrl,
    };
  }

  /**
   * Detect cards in a single frame (tap to scan).
   * Captures one frame, runs YOLO + matching, returns result.
   */
  const detectSingleFrame = useCallback(async (captureFrame, options = {}) => {
    if (isProcessing) return null;
    if (!detectorRef.current || detectorRef.current.state !== DetectorState.READY) return null;

    const includeCandidate = Boolean(options.includeCandidate);
    const matcher = getMatcher();
    if (!matcher.ready) return null;

    const frame = captureFrame?.();
    if (!frame) return null;

    setIsProcessing(true);

    try {
      // Step 1: YOLO detection
      const detections = await detectorRef.current.detect(frame);

      if (detections.length === 0) {
        setLastDetection(null);
        return null;
      }

      const bestDetection = detections[0];

      // Step 2: Ensure portrait orientation
      let crop = bestDetection.cropCanvas;
      crop = ensurePortrait(crop);

      const boxRatio = bestDetection.box.w / Math.max(1, bestDetection.box.h);
      const normalizedRatio = Math.min(boxRatio, 1 / boxRatio);
      const aspectDeviation = Math.abs(normalizedRatio - TARGET_ASPECT_RATIO);

      if (aspectDeviation > MAX_ASPECT_DEVIATION) {
        setLastDetection({
          box: bestDetection.box,
          confidence: bestDetection.confidence,
          matched: false,
          reason: 'aspect-mismatch',
        });
        return null;
      }

      // Step 3: Match using card matcher
      const matchResult = matcher.identify(crop, { setFilter: scanSetFilterRef.current });

      if (!matchResult) {
        setLastDetection({
          box: bestDetection.box,
          confidence: bestDetection.confidence,
          matched: false,
        });
        return null;
      }

      // Step 4: Resolve full card data
      const cardData = resolveCardData(matchResult.card);
      if (!cardData) return null;

      const similarityGap = matchResult.similarity - (matchResult.secondBestSim ?? 0);
      const isStrongEnough = matchResult.similarity >= SIMILARITY_THRESHOLD;
      const isUnambiguous = similarityGap >= SIMILARITY_GAP_THRESHOLD;
      const isMatched = isStrongEnough && isUnambiguous;

      const result = {
        cardData,
        similarity: matchResult.similarity,
        confidence: bestDetection.confidence,
        box: bestDetection.box,
        matched: isMatched,
        similarityGap,
        timestamp: Date.now(),
      };

      if (!isMatched) {
        setLastDetection({
          box: bestDetection.box,
          confidence: bestDetection.confidence,
          matched: false,
          reason: isStrongEnough ? 'ambiguous' : 'low-similarity',
        });

        if (includeCandidate && matchResult.similarity >= CANDIDATE_SIMILARITY_FLOOR) {
          return result;
        }

        return null;
      }

      setLastDetection(result);
      return result;
    } catch (error) {
      console.error('[Detection] Frame processing error:', error);
      return null;
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing]);

  return {
    detectorState,
    detectorMode,
    isProcessing,
    lastDetection,
    initDetector,
    detectSingleFrame,
  };
}
