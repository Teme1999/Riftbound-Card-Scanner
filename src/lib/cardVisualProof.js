import { compareFeatures } from './cardSimilarity.js';

export const VISUAL_PROOF_VERSION = 'orb-homography-v1';
export const VISUAL_PROOF_LIMITS = Object.freeze({ inliers: 32, ratio: .65, coverage: .20,
  span: .40, error: 1.5, separation: 20, runnerRatio: 2 });

export function strongVisualGeometry(value) {
  const t = VISUAL_PROOF_LIMITS;
  if (!value || !['inliers','ratio','coverage','referenceCoverage','spanX','spanY','error'].every(key => Number.isFinite(value[key]))) return false;
  const broad = value && value.inliers >= t.inliers && value.ratio >= t.ratio &&
    value.coverage >= t.coverage && value.referenceCoverage >= t.coverage &&
    value.spanX >= t.span && value.spanY >= t.span;
  // Smooth illustrations may concentrate their distinctive texture in one
  // character. Accept a smaller footprint only with twice as many inliers and
  // much higher agreement. Shared card graphics are excluded by the extractor.
  const detailed = value && value.inliers >= 64 && value.ratio >= .85 &&
    value.coverage >= .10 && value.referenceCoverage >= .10 && value.spanX >= .35 && value.spanY >= .35;
  return Boolean((broad || detailed) && value.error <= t.error && value.validProjection === true);
}

// This is deliberately conservative. A visual match identifies artwork, not a
// collector printing. Check the FULL database even when a set filter is active.
export function visualIdentityAmbiguities(card, cards) {
  const name = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!name(card?.name)) return ['missing-name'];
  return cards.filter(other => {
    if (other.id === card.id) return false;
    if (name(other.name) === name(card.name)) return true;
    if (!card.f?.length || card.f.length !== other.f?.length) return false;
    const similarity = compareFeatures(card.f, other.f, card.featureStats, other.featureStats);
    return similarity.similarity >= .93 && similarity.structureSimilarity >= .90;
  }).map(other => other.id);
}

export function selectVisualProof(comparisons, { frameId, uniqueIdentity, allReferencesAvailable = true } = {}) {
  const ranked = [...comparisons].sort((a, b) => b.inliers - a.inliers);
  const [best, second] = ranked, runnerInliers = second?.inliers || 0;
  const separated = best && best.inliers - runnerInliers >= VISUAL_PROOF_LIMITS.separation &&
    best.inliers >= Math.max(1, runnerInliers) * VISUAL_PROOF_LIMITS.runnerRatio;
  const verified = frameId != null && allReferencesAvailable && comparisons.length >= 2 &&
    uniqueIdentity && strongVisualGeometry(best) && separated;
  return { version: VISUAL_PROOF_VERSION, status: verified ? 'verified' : 'unconfirmed',
    cardId: best?.id, sourceFrameId: frameId, uniqueIdentity: Boolean(uniqueIdentity),
    allReferencesAvailable, comparedCandidates: comparisons.length, ...(best || {}), runnerInliers, runnerCardId: second?.id,
    reason: verified ? null : !allReferencesAvailable ? 'reference-unavailable' : !uniqueIdentity ? 'printing-needs-text' : 'insufficient-geometry' };
}

export function hasStrongVisualProof(result) {
  const proof = result?.visualVerification;
  return proof?.version === VISUAL_PROOF_VERSION && proof.status === 'verified' &&
    proof.cardId === result.cardData?.id && proof.sourceFrameId != null && proof.sourceFrameId === result.frameId &&
    proof.uniqueIdentity === true && proof.allReferencesAvailable === true && proof.comparedCandidates >= 2 && strongVisualGeometry(proof) &&
    Number.isFinite(proof.runnerInliers) && proof.inliers - proof.runnerInliers >= VISUAL_PROOF_LIMITS.separation &&
    proof.inliers >= Math.max(1, proof.runnerInliers) * VISUAL_PROOF_LIMITS.runnerRatio;
}

// Exactly one follow-up may reuse a detector box. Its identity is recomputed
// from NEW pixels; scene motion/context changes invalidate the box immediately.
export function canReuseVisualBox(anchor, frame, { epoch, revision, now } = {}) {
  return Boolean(anchor && frame?.scanMotionContext && !frame.scanCancelled && !frame.scanMoving &&
    anchor.motionContext === frame.scanMotionContext && anchor.motionEpoch === frame.scanMotionEpoch &&
    frame.scanMotionContext.epoch === frame.scanMotionEpoch && anchor.epoch === epoch && anchor.revision === revision &&
    frame.frameId !== anchor.frameId && Number.isFinite(frame.capturedAt) && frame.capturedAt > anchor.capturedAt &&
    now >= anchor.capturedAt && now - anchor.capturedAt <= 750);
}
