import { useState, useRef, useCallback, useEffect } from 'react';
import { getDetector, DetectorState } from '../lib/yoloDetector.js';
import { CardTextIndex } from '../lib/cardTextIdentity.js';
import { getMatcher } from '../lib/cardMatcher.js';
import { recognizeCard, buildRecognitionResult, applyTextVerification } from '../lib/cardRecognition.js';
import { hasLocalArtworkSupport } from '../lib/localArtwork.js';
import { selectGuideDetection, mapDetectionBox } from '../lib/scanGeometry.js';
import { attachScanEvidence, copyScanEvidence } from '../lib/scanEvidence.js';
import { emitScanDiagnostic } from '../lib/scanDiagnostics.js';
import { isScanFrameCancelled } from '../lib/scanQuality.js';
import { CardVisualVerifier } from '../lib/cardVisualVerifier.js';
import { hasStrongVisualProof, canReuseVisualBox } from '../lib/cardVisualProof.js';

/**
 * Hook for single-frame card detection (tap to scan).
 *
 * Orchestrates:
 *   1. YOLO detection on a captured frame
 *   2. Card matching on detected crops (via CardMatcher)
 */
export function useCardDetection({ scanSetFilter = 'all', minSimilarity = 0.90, cropRefiner = null, textVerifier = null, recognitionContext = '', cameraIsActive = true } = {}) {
  const [detectorState, setDetectorState] = useState(DetectorState.UNLOADED);
  const [detectorMode, setDetectorMode] = useState('unloaded');
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastDetection, setLastDetection] = useState(null);

  const detectorRef = useRef(null);
  const busyRef = useRef(false);
  const minSimilarityRef = useRef(minSimilarity);
  const scanSetFilterRef = useRef(scanSetFilter);
  const cropRefinerRef = useRef(cropRefiner);
  const epochRef = useRef(0);
  const textVerifierRef = useRef(textVerifier);
  const textIndexRef = useRef(null);
  const visualVerifierRef = useRef(null);
  const visualFollowupRef = useRef(null);

  const resetRecognition = useCallback(() => {
    epochRef.current++;
    visualFollowupRef.current = null;
    textVerifierRef.current?.reset();
    setLastDetection(null);
  }, []);

  // Lower floor used only by auto-scan temporal voting.
  const CANDIDATE_SIMILARITY_FLOOR = 0.62;
  const TARGET_ASPECT_RATIO = 63 / 88;
  const MAX_ASPECT_DEVIATION = 0.22;

  useEffect(() => {
    scanSetFilterRef.current = scanSetFilter;
    minSimilarityRef.current = minSimilarity;
    cropRefinerRef.current = cropRefiner;
    textVerifierRef.current?.reset();
    textVerifierRef.current = textVerifier;
    epochRef.current++;
  }, [scanSetFilter, minSimilarity, cropRefiner, textVerifier, recognitionContext, cameraIsActive]);
  useEffect(() => () => { epochRef.current++; textVerifierRef.current?.reset(); visualVerifierRef.current?.dispose(); visualVerifierRef.current=null; }, []);

  /**
   * Initialize the YOLO detector
   */
  const initDetector = useCallback(async (modelPreference = 'normal') => {
    epochRef.current++;
    try {
      const detector = getDetector();
      detectorRef.current = detector;
      setDetectorState(DetectorState.LOADING);
      setDetectorMode('loading');

      if (typeof Worker !== 'undefined') {
        visualVerifierRef.current ||= new CardVisualVerifier();
        void visualVerifierRef.current.ensureReady();
      }

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
    const epoch = epochRef.current;
    const matcherRevision = matcher.revision;
    const observation = { observedAt, frameId: frame.frameId, capturedAt: frame.capturedAt ?? observedAt,
      detectorModel:detectorRef.current.modelPreference, matcherRevision };
    const publish = result => { setLastDetection(result);emitScanDiagnostic('observation',{result}); };
    emitScanDiagnostic('processing-start',observation);
    try {
      if (frame.scanMoving || ['too-dark', 'too-bright'].includes(frame.scanQuality?.issue)) {
        visualFollowupRef.current = null;
        textVerifierRef.current?.reset();
        publish({ ...observation, matched: false, reason: frame.scanMoving ? 'moving' : frame.scanQuality.issue });
        return null;
      }
      const recognize = (detection, visualOnly = false) => recognizeCard({ source: frame, detection, matcher,
        setFilter: scanSetFilterRef.current, minSimilarity: minSimilarityRef.current,
        textCorroboration:textVerifierRef.current?.getGeometryHint?.({frame,context:`${epoch}:${matcherRevision||0}`,capturedAt:observation.capturedAt}),
        cropRefiner: cropRefinerRef.current, candidates: Boolean(textVerifierRef.current), visualOnly,
        visualVerifier: cropRefinerRef.current || textVerifierRef.current ? visualVerifierRef.current : null });
      let recognition, bestDetection, detectorReused = false, detectedAt = observedAt, detectorMs = 0, followupMissMs = 0;
      const anchor = visualFollowupRef.current;visualFollowupRef.current = null;
      if (canReuseVisualBox(anchor, frame, {epoch,revision:matcherRevision,now:observedAt})) {
        const quick = await recognize(anchor.detection, true);
        if (quick?.visualVerification?.status === 'verified' && quick.visualVerification.cardId === anchor.cardId) {
          recognition = quick;bestDetection = anchor.detection;detectorReused = true;
        }
        else followupMissMs = Date.now() - observedAt;
      }
      if (!bestDetection) {
        const detectorStart = Date.now();
        const detections = await detectorRef.current.detect(frame,{allowProposals:Boolean(visualVerifierRef.current&&(cropRefinerRef.current||textVerifierRef.current))});
        detectedAt=Date.now();
        detectorMs = detectedAt - detectorStart;
        emitScanDiagnostic('detector-result',{frameId:frame.frameId,count:detections.length,detectorMs});
        bestDetection = selectGuideDetection(detections, frame.scanRegion?.guide);
      } else emitScanDiagnostic('detector-followup',{frameId:frame.frameId,anchorFrameId:anchor.frameId});
      if (isScanFrameCancelled(frame) || epoch !== epochRef.current || matcher.revision !== matcherRevision) return null;
      if (!bestDetection) {
        textVerifierRef.current?.reset();
        publish({ ...observation, matched: false, reason: 'outside-guide' });
        return null;
      }
      const box = mapDetectionBox(bestDetection.box, frame.scanRegion);
      const base = { ...observation, box, confidence: bestDetection.confidence, matched: false,
        ...(bestDetection.detectorProposal?{detectorProposal:true}:{}) };
      const boxRatio = bestDetection.box.w / Math.max(1, bestDetection.box.h);
      const normalizedRatio = Math.min(boxRatio, 1 / boxRatio);
      if (Math.abs(normalizedRatio - TARGET_ASPECT_RATIO) > MAX_ASPECT_DEVIATION) {
        publish({ ...base, reason: 'outside-guide' });
        return null;
      }
      recognition ||= await recognize(bestDetection);
      const recognizedAt=Date.now();
      if (isScanFrameCancelled(frame) || epoch !== epochRef.current || matcher.revision !== matcherRevision) return null;
      const quality = recognition.quality;
      if (frame.scanMoving) { quality.acceptable = false; quality.issue = 'moving'; }
      if (!quality.acceptable) {
        textVerifierRef.current?.reset();
        publish({ ...base, quality, reason: quality.issue });
        return null;
      }
      const matchResult = recognition.match;
      if (!matchResult?.card) {
        textVerifierRef.current?.reset();
        publish({ ...base, quality, reason: 'low-similarity' });
        return null;
      }
      let result = buildRecognitionResult(matchResult, quality, minSimilarityRef.current, { ...base,
        visualVerification:recognition.visualVerification,
        requiresTextConfirmation:recognition.requiresTextConfirmation,
        cropMethod: recognition.cropMethod, artworkSampling: recognition.artworkSampling, geometryConflict: recognition.geometryConflict, trackingFingerprint: recognition.trackingFingerprint,
        quad: recognition.refinement?.quad?.map((p) => ({ x: p.x + (frame.scanRegion?.x || 0), y: p.y + (frame.scanRegion?.y || 0) })),
        rectificationStatus: recognition.refinement?.status || 'disabled', rectificationReason: recognition.refinement?.reason });
      const verifier = textVerifierRef.current;
      if (verifier) {
        const filterKey = JSON.stringify(scanSetFilterRef.current);
        if (textIndexRef.current?.cards !== matcher.cards || textIndexRef.current?.filterKey !== filterKey) {
          verifier.reset();
          // Read identity against the full database: a set filter must not hide
          // clear text evidence that the physical card belongs to another set.
          textIndexRef.current = { cards: matcher.cards, filterKey, index: new CardTextIndex(matcher.cards) };
        }
        const context = `${epoch}:${matcher.revision || 0}`;
        const visualReady = hasStrongVisualProof(result);
        const observedText = verifier.observe(result, recognition.textCrop, { frame, context, index: textIndexRef.current.index,
          skipRead:visualReady,
          alternativeCrops: recognition.alternateTextCrops,
          candidates: matchResult.candidates, minSimilarity: minSimilarityRef.current });
        const verification = visualReady && observedText.status === 'pending'
          ? { ...observedText, status: 'not-required', reason: 'verified-artwork-geometry' } : observedText;
        result = applyTextVerification(result, matchResult, verification);
        result.recognitionEpoch = `${context}:${verification.trackId || 0}`;
      }
      else result.recognitionEpoch = `${epoch}:${matcherRevision}:${frame.scanMotionEpoch ?? 0}`;
      if (!detectorReused && result.matched && hasStrongVisualProof(result)) visualFollowupRef.current = {
        epoch,revision:matcherRevision,motionContext:frame.scanMotionContext,motionEpoch:frame.scanMotionEpoch,
        frameId:frame.frameId,capturedAt:frame.capturedAt,cardId:result.cardData.id,
        detection:{box:{...bestDetection.box},confidence:bestDetection.confidence,detectorProposal:bestDetection.detectorProposal} };
      result.timings={detectorReused,detectorMs,followupMissMs,artworkMs:recognizedAt-detectedAt+followupMissMs,
        frameMs:Date.now()-observedAt,sourceAgeMs:Date.now()-observation.capturedAt};
      if (options.retainEvidence) attachScanEvidence(result, { frame,
        candidates: (matchResult.candidates || [matchResult]).slice(0, 5).map(entry => ({
          id: entry.card.id, name: entry.card.name, code: entry.card.code, similarity: entry.similarity,
          colorSimilarity: entry.colorSimilarity, structureSimilarity: entry.structureSimilarity,
          localStructureSimilarity: entry.localStructureSimilarity, alignedArtworkSimilarity: entry.alignedArtworkSimilarity,
          artworkAlignment: entry.artworkAlignment, similarityGap: entry.similarity - (entry.secondBestSim ?? 0),
        })) });
      publish(result);
      if (options.includeReview) result = copyScanEvidence(result, { ...result, reviewCandidates: matchResult.top3 || [] });
      if (result.matched || (options.includeCandidate && (matchResult.similarity >= CANDIDATE_SIMILARITY_FLOOR || hasLocalArtworkSupport(matchResult)))) return result;
      return null;
    } catch (error) {
      console.error('[Detection] Frame processing error:', error);
      publish({ ...observation, matched: false, reason: 'low-similarity' });
      emitScanDiagnostic('processing-error',{frameId:frame.frameId,error:String(error?.message||error)});
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
    resetRecognition,
  };
}
